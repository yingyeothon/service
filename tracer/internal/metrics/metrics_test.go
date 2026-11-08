package metrics

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

func TestPublicHidesResources(t *testing.T) {
	r := New()
	r.Resource("trc_secret").Accepted.Add(1)
	r.Counters.CountRejection(401)
	r.Counters.CountRejection(418)
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "trc_secret") {
		t.Fatalf("public metrics leak a resource id: %s", b)
	}
	var s snapshot
	json.Unmarshal(b, &s)
	if s.Counters["rejected401"] != 1 || s.Counters["rejectedOther"] != 1 || s.Counters["envelopesRejected"] != 2 {
		t.Fatalf("counters %v", s.Counters)
	}
	d, _ := json.Marshal(r.Detailed())
	if !strings.Contains(string(d), `"trc_secret":{"accepted":1`) {
		t.Fatalf("detailed misses the resource: %s", d)
	}
}

func TestResourceBound(t *testing.T) {
	r := New()
	for i := 0; i < maxResources+10; i++ {
		r.Resource(string(rune('a'+i%26)) + strings.Repeat("x", i%7) + string(rune(i)))
	}
	if n := len(r.resources); n > maxResources+1 {
		t.Fatalf("map grew to %d", n)
	}
	r2 := New()
	for i := 0; i < maxResources; i++ {
		r2.Resource("trc_" + strconv.Itoa(i))
	}
	if r2.Resource("trc_new") != r2.Resource("_overflow") || r2.Resource("trc_new2") != r2.Resource("_overflow") {
		t.Fatal("past the bound new ids must share the overflow bucket")
	}
	if r2.Resource("trc_1") == r2.Resource("_overflow") {
		t.Fatal("known ids keep their own bucket")
	}
}
