package lobby

import (
	"fmt"
	"testing"
)

// viewChecker replays a socket's outbound frames against the view
// invariant (`gateway/README.md` "View invariant"): every zone-scoped
// frame naming a peer sits between the `snapshot`/`enter` that introduced
// it and the `leave` that removed it, in the zone of the last `snapshot`.
// It is wired into every recorder, so each hub test checks it for free.
// Violations are reported with t.Errorf, never a panic: the hub holds its
// lock without defer, and a panic inside Send would deadlock h.Stop.
type viewChecker struct {
	self string
	zone string
	seen map[string]struct{}
	// violations counts what was reported, so a test can assert on it.
	violations int
}

func newViewChecker() *viewChecker { return &viewChecker{seen: map[string]struct{}{}} }

func (v *viewChecker) fail(t *testing.T, idx int, frame map[string]any, format string, args ...any) {
	v.violations++
	if t != nil {
		t.Helper()
		t.Errorf("view invariant, frame %d %v: %s", idx, frame, fmt.Sprintf(format, args...))
	}
}

func (v *viewChecker) apply(t *testing.T, idx int, f map[string]any) {
	typ, _ := f["type"].(string)
	zone, _ := f["zone"].(string)
	requireZone := func() bool {
		if zone != v.zone {
			v.fail(t, idx, f, "zone %q but the last snapshot was for %q", zone, v.zone)
			return false
		}
		return true
	}
	switch typ {
	case "hello":
		v.self, _ = f["userId"].(string)
		v.zone = ""
		v.seen = map[string]struct{}{}
	case "snapshot":
		v.zone = zone
		v.seen = map[string]struct{}{}
		for _, p := range f["peers"].([]any) {
			id := p.(map[string]any)["userId"].(string)
			if id == v.self {
				v.fail(t, idx, f, "snapshot lists the receiver")
			}
			v.seen[id] = struct{}{}
		}
	case "enter":
		id, _ := f["userId"].(string)
		if !requireZone() {
			return
		}
		if id == v.self {
			v.fail(t, idx, f, "enter for the receiver itself")
		}
		if _, had := v.seen[id]; had {
			v.fail(t, idx, f, "enter for %s, already in view", id)
		}
		v.seen[id] = struct{}{}
	case "leave":
		id, _ := f["userId"].(string)
		if !requireZone() {
			return
		}
		if _, had := v.seen[id]; !had {
			v.fail(t, idx, f, "leave for %s, not in view", id)
		}
		delete(v.seen, id)
	case "pos":
		if !requireZone() {
			return
		}
		for _, p := range f["peers"].([]any) {
			id := p.(map[string]any)["userId"].(string)
			if id == v.self {
				continue
			}
			if _, had := v.seen[id]; !had {
				v.fail(t, idx, f, "pos for %s, not in view", id)
			}
		}
	case "say", "event":
		if scope, _ := f["scope"].(string); scope != "zone" {
			return
		}
		from, _ := f["from"].(string)
		if from == v.self {
			return
		}
		if _, had := v.seen[from]; !had {
			v.fail(t, idx, f, "zone %s from %s, not in view", typ, from)
		}
	}
}
