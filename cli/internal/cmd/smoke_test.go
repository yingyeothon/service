package cmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
)

// fakeWS accepts `bearer, <jwt>` and hands each socket to `serve` with its index.
func fakeWS(t *testing.T, serve func(i int, tok string, c *websocket.Conn)) string {
	var mu sync.Mutex
	n := 0
	up := websocket.Upgrader{Subprotocols: []string{"bearer"}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		protos := websocket.Subprotocols(r)
		if len(protos) != 2 || protos[0] != "bearer" || !strings.HasPrefix(protos[1], "ok") {
			w.WriteHeader(401)
			return
		}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		mu.Lock()
		i := n
		n++
		mu.Unlock()
		go serve(i, protos[1], c)
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func runSmoke(t *testing.T, args ...string) (string, error) {
	var out, errb bytes.Buffer
	root := NewRoot(&App{Out: &out, Err: &errb})
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

func TestSmokeMatchSuccess(t *testing.T) {
	var mu sync.Mutex
	conns := []*websocket.Conn{}
	url := fakeWS(t, func(_ int, _ string, c *websocket.Conn) {
		mu.Lock()
		conns = append(conns, c)
		ready := len(conns) == 2
		all := append([]*websocket.Conn{}, conns...)
		mu.Unlock()
		if ready {
			for _, o := range all {
				_ = o.WriteJSON(map[string]any{"type": "matched", "matchId": "m1", "partial": false, "result": nil})
			}
		}
	})
	out, err := runSmoke(t, "smoke", "match", "--url", url, "--jwt", "ok1", "--jwt", "ok2", "--timeout", "10s", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	matched := 0
	for _, l := range lines {
		var e smokeEvent
		if json.Unmarshal([]byte(l), &e) != nil {
			t.Fatalf("bad line %q", l)
		}
		if e.Msg.Type() == "matched" {
			matched++
		}
		if strings.Contains(l, "ok1") || strings.Contains(l, "ok2") {
			t.Fatalf("token leaked: %s", l)
		}
	}
	if matched != 2 {
		t.Fatalf("matched=%d\n%s", matched, out)
	}
}

func TestSmokeMatchFailedAndRejected(t *testing.T) {
	url := fakeWS(t, func(_ int, _ string, c *websocket.Conn) {
		_ = c.WriteJSON(map[string]any{"type": "failed", "reason": "timeout"})
		select {}
	})
	out, err := runSmoke(t, "smoke", "match", "--url", url, "--jwt", "ok1", "--timeout", "10s")
	if err == nil || !strings.Contains(err.Error(), "1 of 1") {
		t.Fatalf("err=%v out=%s", err, out)
	}
	if !strings.Contains(out, `"reason":"timeout"`) {
		t.Fatalf("out=%s", out)
	}
	_, err = runSmoke(t, "smoke", "match", "--url", url, "--jwt", "bad", "--timeout", "5s")
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err=%v", err)
	}
	if _, err = runSmoke(t, "smoke", "match", "--url", url); err == nil {
		t.Fatal("--jwt required")
	}
}

func TestSmokeMatchTimeout(t *testing.T) {
	url := fakeWS(t, func(int, string, *websocket.Conn) { select {} })
	_, err := runSmoke(t, "smoke", "match", "--url", url, "--jwt", "ok1", "--timeout", "500ms")
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err=%v", err)
	}
}

func TestSmokeTopic(t *testing.T) {
	var mu sync.Mutex
	conns := []*websocket.Conn{}
	url := fakeWS(t, func(i int, _ string, c *websocket.Conn) {
		mu.Lock()
		conns = append(conns, c)
		mu.Unlock()
		for {
			var m map[string]any
			if c.ReadJSON(&m) != nil {
				return
			}
			mu.Lock()
			for _, o := range conns {
				_ = o.WriteJSON(map[string]any{"type": "msg", "from": "u", "seq": 1, "payload": m["payload"]})
			}
			mu.Unlock()
		}
	})
	out, err := runSmoke(t, "smoke", "topic", "--url", url, "--jwt", "ok1", "--jwt", "ok2", "--wait", "700ms")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if c := strings.Count(out, `"type":"msg"`); c < 2 {
		t.Fatalf("expected echoes, got %d\n%s", c, out)
	}
	// One member gets an expired frame while the other stays healthy: must still fail.
	url2 := fakeWS(t, func(i int, _ string, c *websocket.Conn) {
		var m map[string]any
		_ = c.ReadJSON(&m)
		if i == 0 {
			_ = c.WriteJSON(map[string]any{"type": "expired"})
		}
		select {}
	})
	out, err = runSmoke(t, "smoke", "topic", "--url", url2, "--jwt", "ok1", "--jwt", "ok2", "--wait", "1s")
	if err == nil || !strings.Contains(err.Error(), "1 of 2") {
		t.Fatalf("err=%v out=%s", err, out)
	}
}
