package resource

import (
	"context"
	"errors"
	"testing"

	"github.com/yingyeothon/service/tracer/internal/config"
)

func TestLocalLookupAndKey(t *testing.T) {
	f, err := config.ParseLocal([]byte(`{"resources":[{"id":"trc_a1","writeKey":"aaaaaaaaaaaaaaaa","dailyBytes":1000}]}`))
	if err != nil {
		t.Fatal(err)
	}
	l := NewLocal(f)
	r, err := l.Lookup(context.Background(), "trc_a1")
	if err != nil || !r.Active() || r.DailyBytes != 1000 {
		t.Fatalf("lookup: %+v %v", r, err)
	}
	if !r.KeyMatches("aaaaaaaaaaaaaaaa") || r.KeyMatches("aaaaaaaaaaaaaaab") || r.KeyMatches("") {
		t.Fatal("KeyMatches wrong")
	}
	if _, err := l.Lookup(context.Background(), "trc_zz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}
