package metrics

import (
	"encoding/json"
	"testing"
)

func TestSnapshot(t *testing.T) {
	r := New()
	r.Counters.InboundMessages.Add(3)
	r.Gauges.Connections.Store(2)
	r.Channel("ch_a").Dropped.Add(1)
	r.Gauges.RecordQueueDepth(7)
	r.Gauges.RecordQueueDepth(3)
	r.Counters.CountRejection(401)
	r.Counters.CountRejection(502)
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		Counters map[string]int64
		Gauges   map[string]int64
		Runtime  map[string]int64
		Channels map[string]map[string]int64
	}
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	if s.Counters["inboundMessages"] != 3 || s.Gauges["connections"] != 2 || s.Gauges["outboundQueueMax"] != 7 || s.Runtime["goroutines"] == 0 {
		t.Fatalf("bad snapshot: %s", b)
	}
	if s.Counters["rejected401"] != 1 || s.Counters["rejected5xx"] != 1 || s.Counters["connectionsRejected"] != 2 {
		t.Fatalf("rejections: %s", b)
	}
	if s.Channels != nil {
		t.Fatal("public snapshot must not list channels")
	}
	b, _ = json.Marshal(r.Detailed())
	if err := json.Unmarshal(b, &s); err != nil || s.Channels["ch_a"]["dropped"] != 1 {
		t.Fatalf("detailed snapshot: %s", b)
	}
	r.Forget("ch_a")
	b, _ = json.Marshal(r.Detailed())
	var again struct{ Channels map[string]map[string]int64 }
	_ = json.Unmarshal(b, &again)
	if _, ok := again.Channels["ch_a"]; ok {
		t.Fatal("channel not forgotten")
	}
}
