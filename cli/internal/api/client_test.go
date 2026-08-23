package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDoSuccessAndHeaders(t *testing.T) {
	var got *http.Request
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"id":"x","n":2}`))
	}))
	defer srv.Close()
	c := New(srv.URL+"/", "tok")
	var out struct {
		ID string `json:"id"`
		N  int    `json:"n"`
	}
	if err := c.Do(context.Background(), "POST", "/things", map[string]string{"a": "b"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != "x" || out.N != 2 {
		t.Fatalf("%+v", out)
	}
	if got.Header.Get("Authorization") != "Bearer tok" || got.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("headers %v", got.Header)
	}
	if string(body) != `{"a":"b"}` || got.URL.Path != "/things" {
		t.Fatalf("body %s path %s", body, got.URL.Path)
	}
}

func TestDoNoContentAndNilOut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			b, _ := io.ReadAll(r.Body)
			if len(b) != 0 {
				t.Errorf("unexpected body %s", b)
			}
		}
		if r.Header.Get("Content-Type") != "" {
			t.Errorf("no content-type expected")
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c := New(srv.URL, "")
	var out map[string]any
	if err := c.Do(context.Background(), "DELETE", "/x", nil, &out); err != nil {
		t.Fatal(err)
	}
}

func TestDoErrorEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"already","details":[{"path":"x"}]}}`))
	}))
	defer srv.Close()
	err := New(srv.URL, "t").Do(context.Background(), "GET", "/x", nil, nil)
	var ae *Error
	if !errors.As(err, &ae) || ae.Status != 409 || ae.Code != "conflict" || ae.Message != "already" {
		t.Fatalf("%v", err)
	}
	if ae.Error() != `conflict: already [{"path":"x"}]` {
		t.Fatalf("%q", ae.Error())
	}
}

func TestDoErrorPlain(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(502)
		_, _ = w.Write([]byte("bad gateway"))
	}))
	defer srv.Close()
	err := New(srv.URL, "t").Do(context.Background(), "GET", "/x", nil, nil)
	var ae *Error
	if !errors.As(err, &ae) || ae.Status != 502 || ae.Code != "http_502" || !strings.HasPrefix(ae.Message, "bad gateway") {
		t.Fatalf("%v", err)
	}
}

func TestDoBadJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>"))
	}))
	defer srv.Close()
	var out json.RawMessage
	if err := New(srv.URL, "t").Do(context.Background(), "GET", "/x", nil, &out); err == nil {
		t.Fatal("expected decode error")
	}
}

func TestPathID(t *testing.T) {
	if PathID("a/b c") != "a%2Fb%20c" {
		t.Fatal(PathID("a/b c"))
	}
}
