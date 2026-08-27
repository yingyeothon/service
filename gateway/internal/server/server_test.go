package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/yingyeothon/service/gateway/internal/authn"
	"github.com/yingyeothon/service/gateway/internal/console"
	"github.com/yingyeothon/service/gateway/internal/redisx"
)

const tok = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func jwt(sub string) string {
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))
	p := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"sub":%q,"exp":%d}`, sub, time.Now().Unix()+600)))
	return h + "." + p + ".sig"
}

var jwtUA, jwtUB, jwtBad = jwt("ua"), jwt("ub"), jwt("bad")

type fixture struct {
	srv    *httptest.Server
	mr     *miniredis.Miniredis
	rdb    *redis.Client
	server *Server
	gone   atomic.Bool
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{}
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/c/ch_auth/verify") {
			w.WriteHeader(404)
			return
		}
		switch r.Header.Get("Authorization") {
		case "Bearer " + jwtUA:
			fmt.Fprintf(w, `{"userId":"ua","exp":%d,"channelId":"ch_auth"}`, time.Now().Unix()+600)
		case "Bearer " + jwtUB:
			fmt.Fprintf(w, `{"userId":"ub","exp":%d,"channelId":"ch_auth"}`, time.Now().Unix()+600)
		default:
			w.WriteHeader(401)
		}
	}))
	t.Cleanup(auth.Close)
	cons := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/gw/health" {
			_, _ = w.Write([]byte(`{"service":"yyt-console","gateway":true,"configured":true}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+tok {
			w.WriteHeader(401)
			return
		}
		verify := auth.URL + "/c/ch_auth/verify"
		switch r.URL.Path {
		case "/gw/channels/lobby_0123456789abcdef":
			if f.gone.Load() {
				w.WriteHeader(410)
				return
			}
			fmt.Fprintf(w, `{"id":"lobby_0123456789abcdef","kind":"lobby","name":"l","expiresAt":9999999999,
			"config":{"authChannelId":"ch_auth","capabilities":{"pos":true,"say":["zone","user"],"party":true,"event":true,"debug":false},
			"flushIntervalMs":50,"maxMoveDelta":3,"rateLimit":50,"partySizeMax":4,"defaultZone":"Zone001","mapUrl":"https://d.example.com/m.json"},
			"authVerifyUrl":%q}`, verify)
		case "/gw/channels/q_0123456789abcdef":
			fmt.Fprintf(w, `{"id":"q_0123456789abcdef","kind":"q","name":"q","expiresAt":9999999999,"config":{"authChannelId":"ch_auth"},"authVerifyUrl":%q,
			"redis":{"eventKeyPrefix":"game:test:ch_q:event:","queueKeyPrefix":"game:test:ch_q:queue:","lockKeyPrefix":"game:test:ch_q:lock:","awaiterKeyPrefix":"game:test:ch_q:awaiter:","channelPrefix":"game:out:test:ch_q:"}}`, verify)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(cons.Close)
	f.mr = miniredis.RunT(t)
	f.rdb = redis.NewClient(&redis.Options{Addr: f.mr.Addr()})
	t.Cleanup(func() { _ = f.rdb.Close() })
	f.server = New(Options{Stage: "test",
		Console:  console.New(console.Options{BaseURL: cons.URL, Token: tok, TTL: time.Minute}),
		Verifier: authn.New(authn.Options{}),
		Redis:    redisx.Wrap(f.rdb, "test"), ConfigTTL: time.Hour, OperatorToken: tok})
	f.srv = httptest.NewServer(f.server.Handler())
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fixture) dial(t *testing.T, query string, protocols ...string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	d := websocket.Dialer{Subprotocols: protocols, HandshakeTimeout: 5 * time.Second}
	c, res, err := d.Dial("ws"+strings.TrimPrefix(f.srv.URL, "http")+"/"+query, nil)
	if c != nil {
		t.Cleanup(func() { _ = c.Close() })
	}
	return c, res, err
}

func read(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, b, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("not json: %s", b)
	}
	return m
}

func readUntil(t *testing.T, c *websocket.Conn, typ string) map[string]any {
	t.Helper()
	for i := 0; i < 20; i++ {
		m := read(t, c)
		if m["type"] == typ {
			return m
		}
	}
	t.Fatalf("no %s frame", typ)
	return nil
}

func TestHandshakeRejections(t *testing.T) {
	f := newFixture(t)
	cases := []struct {
		name   string
		query  string
		protos []string
		status int
	}{
		{"no channel", "", []string{"bearer", jwtUA}, 400},
		{"unknown channel", "?channel=nope_0123456789abcdef", []string{"bearer", jwtUA}, 404},
		{"malformed channel", "?channel=../etc", []string{"bearer", jwtUA}, 404},
		{"no token", "?channel=lobby_0123456789abcdef", nil, 401},
		{"bad token", "?channel=lobby_0123456789abcdef", []string{"bearer", jwtBad}, 401},
		{"q without game", "?channel=q_0123456789abcdef", []string{"bearer", jwtUA}, 403},
		{"q not a member", "?channel=q_0123456789abcdef&gameId=g1", []string{"bearer", jwtUB}, 403},
	}
	f.mr.Set("game:test:ch_q:event:g1", `{"gameId":"g1","members":[{"memberId":"ua","name":"A","email":"a@example.com"}]}`)
	for _, tc := range cases {
		_, res, err := f.dial(t, tc.query, tc.protos...)
		if err == nil || res == nil || res.StatusCode != tc.status {
			code := 0
			if res != nil {
				code = res.StatusCode
			}
			t.Errorf("%s: status %d err %v", tc.name, code, err)
		}
	}
	res, _ := http.Get(f.srv.URL + "/?channel=lobby_0123456789abcdef")
	if res.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("plain GET: %d", res.StatusCode)
	}
	if f.server.reg.Counters.ConnectionsRejected.Load() < int64(len(cases)) || f.server.reg.Counters.Rejected401.Load() != 2 {
		t.Fatal("rejections not counted by status")
	}
	// Handshake limiter: the burst is per address.
	for i := 0; i < handshakeBurst+5; i++ {
		_, res, _ = f.dial(t, "?channel=nope_0123456789abcdef", "bearer", jwtUA)
		if res != nil && res.StatusCode == 429 {
			return
		}
	}
	t.Fatal("handshake flood never limited")
}

func TestLobbyRoundTrip(t *testing.T) {
	f := newFixture(t)
	a, res, err := f.dial(t, "?channel=lobby_0123456789abcdef", "bearer", jwtUA)
	if err != nil {
		t.Fatal(err)
	}
	if res.Header.Get("Sec-WebSocket-Protocol") != "bearer" {
		t.Fatalf("subprotocol not echoed: %q", res.Header.Get("Sec-WebSocket-Protocol"))
	}
	hello := read(t, a)
	if hello["type"] != "hello" || hello["userId"] != "ua" || hello["tick"].(float64) != 50 {
		t.Fatalf("hello: %v", hello)
	}
	connID := hello["connectionId"].(string)
	if !strings.HasPrefix(connID, f.server.Instance()+":") {
		t.Fatalf("connection id shape: %s", connID)
	}
	_ = a.WriteJSON(map[string]any{"type": "pos", "zone": "Zone001", "x": 1, "y": 1})
	readUntil(t, a, "snapshot")
	b, _, err := f.dial(t, "?channel=lobby_0123456789abcdef", "bearer", jwtUB)
	if err != nil {
		t.Fatal(err)
	}
	read(t, b)
	_ = b.WriteJSON(map[string]any{"type": "pos", "zone": "Zone001", "x": 2, "y": 2})
	if snap := readUntil(t, b, "snapshot"); len(snap["peers"].([]any)) != 1 {
		t.Fatalf("snapshot: %v", snap)
	}
	if e := readUntil(t, a, "enter"); e["userId"] != "ub" {
		t.Fatalf("enter: %v", e)
	}
	_ = b.WriteJSON(map[string]any{"type": "pos", "zone": "Zone001", "x": 3, "y": 2})
	if p := readUntil(t, a, "pos"); len(p["peers"].([]any)) == 0 {
		t.Fatalf("pos batch: %v", p)
	}
	_ = a.WriteJSON(map[string]any{"type": "say", "scope": "user", "to": "ub", "text": "hi"})
	if s := readUntil(t, b, "say"); s["text"] != "hi" || s["from"] != "ua" {
		t.Fatalf("say: %v", s)
	}
	// A second socket for ua replaces the first with 4000.
	a2, _, err := f.dial(t, "?channel=lobby_0123456789abcdef", "bearer", jwtUA)
	if err != nil {
		t.Fatal(err)
	}
	read(t, a2)
	// `hello` precedes the restore; the `snapshot` says a2 is in the zone.
	readUntil(t, a2, "snapshot")
	_ = a.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, _, err := a.ReadMessage()
		if err != nil {
			ce, ok := err.(*websocket.CloseError)
			if !ok || ce.Code != 4000 {
				t.Fatalf("replace close: %v", err)
			}
			break
		}
	}
	_ = b.Close()
	if l := readUntil(t, a2, "leave"); l["userId"] != "ub" {
		t.Fatalf("leave: %v", l)
	}
	// Channel gone on refresh → 4004.
	f.gone.Store(true)
	f.server.Refresh(context.Background())
	_ = a2.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, _, err := a2.ReadMessage()
		if err != nil {
			ce, ok := err.(*websocket.CloseError)
			if !ok || ce.Code != 4004 {
				t.Fatalf("gone close: %v", err)
			}
			break
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for f.server.reg.Gauges.Connections.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if f.server.reg.Gauges.Connections.Load() != 0 {
		t.Fatal("connection gauge not back to zero")
	}
}

func TestQRoundTripAndShutdown(t *testing.T) {
	f := newFixture(t)
	f.mr.Set("game:test:ch_q:event:g1", `{"gameId":"g1","members":[{"memberId":"ua","name":"A","email":"a@example.com"}]}`)
	a, _, err := f.dial(t, "?channel=q_0123456789abcdef&gameId=g1", "bearer", jwtUA)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if items, _ := f.mr.List("game:test:ch_q:queue:g1"); len(items) == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	items, _ := f.mr.List("game:test:ch_q:queue:g1")
	if len(items) != 1 || !strings.Contains(items[0], `"type":"enter"`) {
		t.Fatalf("enter not pushed: %v", items)
	}
	var env struct {
		Item struct {
			ConnectionID string `json:"connectionId"`
		} `json:"item"`
	}
	_ = json.Unmarshal([]byte(items[0]), &env)
	_ = a.WriteJSON(map[string]any{"type": "move", "dir": "n"})
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if items, _ = f.mr.List("game:test:ch_q:queue:g1"); len(items) == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(items) != 2 || !strings.Contains(items[1], `"connectionId":"`+env.Item.ConnectionID+`"`) {
		t.Fatalf("move not pushed: %v", items)
	}
	ctx := context.Background()
	for f.rdb.PubSubNumSub(ctx, "game:out:test:ch_q:g1").Val()["game:out:test:ch_q:g1"] == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	f.rdb.Publish(ctx, "game:out:test:ch_q:g1", `{"op":"send","connectionId":"`+env.Item.ConnectionID+`","message":{"type":"snapshot","hp":3}}`)
	if m := read(t, a); m["type"] != "snapshot" || m["hp"].(float64) != 3 {
		t.Fatalf("snapshot: %v", m)
	}
	// Shutdown: 1001 to the client, `leave` pushed, subscription gone.
	sctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := f.server.Shutdown(sctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	_ = a.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err = a.ReadMessage()
	if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != 1001 {
		t.Fatalf("shutdown close: %v", err)
	}
	items, _ = f.mr.List("game:test:ch_q:queue:g1")
	if len(items) != 3 || !strings.Contains(items[2], `"type":"leave"`) {
		t.Fatalf("leave not pushed: %v", items)
	}
	if f.rdb.PubSubNumSub(ctx, "game:out:test:ch_q:g1").Val()["game:out:test:ch_q:g1"] != 0 {
		t.Fatal("subscription leaked")
	}
	_, res, _ := f.dial(t, "?channel=q_0123456789abcdef&gameId=g1", "bearer", jwtUA)
	if res == nil || res.StatusCode != 503 {
		t.Fatal("accepting after shutdown")
	}
	hres, _ := http.Get(f.srv.URL + "/healthz")
	if hres.StatusCode != 503 {
		t.Fatalf("healthz during shutdown: %d", hres.StatusCode)
	}
}

func TestHealthAndMetrics(t *testing.T) {
	f := newFixture(t)
	res, err := http.Get(f.srv.URL + "/healthz")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("healthz: %v %v", res, err)
	}
	var h map[string]any
	_ = json.NewDecoder(res.Body).Decode(&h)
	if h["redis"] != "ok" || h["console"] != "ok" || h["service"] != "yyt-gateway" {
		t.Fatalf("health body: %v", h)
	}
	res, _ = http.Get(f.srv.URL + "/metrics")
	var m map[string]any
	_ = json.NewDecoder(res.Body).Decode(&m)
	if _, ok := m["counters"]; !ok || m["channels"] != nil {
		t.Fatalf("public metrics: %v", m)
	}
	req, _ := http.NewRequest(http.MethodGet, f.srv.URL+"/metrics", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, _ = http.DefaultClient.Do(req)
	_ = json.NewDecoder(res.Body).Decode(&m)
	if _, ok := m["channels"]; !ok {
		t.Fatalf("operator metrics lack channels: %v", m)
	}
	res, _ = http.Get(f.srv.URL + "/livez")
	if res.StatusCode != 200 {
		t.Fatal("livez")
	}
	f.mr.Close()
	res, _ = http.Get(f.srv.URL + "/healthz")
	if res.StatusCode != 503 {
		t.Fatal("redis down not reported")
	}
	res, _ = http.Get(f.srv.URL + "/livez")
	if res.StatusCode != 200 {
		t.Fatal("livez must not depend on redis")
	}
}
