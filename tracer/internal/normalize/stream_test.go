package normalize

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func TestArrayItems(t *testing.T) {
	kept, total, err := ArrayItems([]byte(`[1,2,3,4,5]`), "", 3, false)
	if err != nil || total != 5 || string(kept[0]) != "1" || len(kept) != 3 {
		t.Fatalf("first: %s %d %v", kept, total, err)
	}
	kept, total, _ = ArrayItems([]byte(`{"x":{"a":[1]},"values":[1,2,3,4,5]}`), "values", 3, true)
	if total != 5 || len(kept) != 3 || string(kept[0]) != "3" || string(kept[2]) != "5" {
		t.Fatalf("last: %s %d", kept, total)
	}
	if _, _, err := ArrayItems([]byte(`{"a":1}`), "", 3, false); err == nil {
		t.Fatal("object without wrap key accepted")
	}
	if kept, _, err := ArrayItems([]byte(`{"a":1}`), "values", 3, false); err != nil || kept != nil {
		t.Fatal("missing wrap key must be empty")
	}
	pairs, err := ObjectPairs([]byte(`{"a":1,"b":{"c":[2]},"d":3}`), 2)
	if err != nil || len(pairs) != 2 || string(pairs[1][1]) != `{"c":[2]}` {
		t.Fatalf("pairs %s %v", pairs, err)
	}
}

// A megabyte of tiny breadcrumbs/logs must not amplify into a huge slice.
func TestNoAmplification(t *testing.T) {
	tiny := "[" + strings.Repeat("{},", 350_000) + "{}]"
	ev := `{"event_id":"0123456789abcdef0123456789abcdef","breadcrumbs":` + tiny + `,"tags":{` +
		strings.Repeat(`"k":"v",`, 1000) + `"z":"v"},"exception":{"values":[{"type":"E","stacktrace":{"frames":` + tiny + `}}]}}`
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	e, err := Event([]byte(ev), "event", "", 1)
	runtime.ReadMemStats(&after)
	if err != nil || len(e.Breadcrumbs) != MaxBreadcrumbs || len(e.Tags) > MaxTags {
		t.Fatalf("%v %d %d", err, len(e.Breadcrumbs), len(e.Tags))
	}
	logs, dropped, err := Logs([]byte(`{"items":`+tiny+`}`), 1)
	if err != nil || len(logs) != MaxLogsPerItem || dropped != 350_001-MaxLogsPerItem {
		t.Fatalf("logs %v %d %d", err, len(logs), dropped)
	}
	_ = json.Valid
	if live := int64(after.HeapAlloc) - int64(before.HeapAlloc); live > 64<<20 {
		t.Fatalf("heap grew by %d", live)
	}
}
