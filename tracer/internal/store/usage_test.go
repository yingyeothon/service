package store

import (
	"context"
	"reflect"
	"testing"
)

func TestUsageAndQuotaHits(t *testing.T) {
	s, w := openTest(t)
	ctx := context.Background()
	put := func(res, day string, bytes, hitMs int64) {
		t.Helper()
		if _, err := w.Write(ctx, &Batch{ResourceID: res, Day: day, ReceivedMs: 1, Bytes: bytes, QuotaHitMs: hitMs}); err != nil {
			t.Fatal(err)
		}
	}
	put("trc_a", "2026-11-06", 10, 0)
	put("trc_a", "2026-11-08", 30, 0)
	put("trc_a", "2026-11-07", 20, 5) // crossing recorded, no drops
	put("trc_b", "2026-11-08", 99, 0)
	put("trc_c", "2026-11-07", 1, 0)
	w.RecordDrops(ctx, "trc_a", "2026-11-08", Drop{ItemType: "attachment", Reason: ReasonQuotaAttachment, Count: 3})
	w.RecordDrops(ctx, "trc_a", "2026-11-08", Drop{ItemType: "envelope", Reason: ReasonQuotaRefused, Count: 2})
	w.RecordDrops(ctx, "trc_a", "2026-11-08", Drop{ItemType: "event", Reason: "too_large", Count: 7}) // not a quota drop
	w.RecordDrops(ctx, "trc_c", "2026-11-07", Drop{ItemType: "attachment", Reason: ReasonQuotaAttachment, Count: 1})

	got, err := Usage(ctx, s.DB, []string{"trc_a", "trc_z"}, []string{"2026-11-08", "2026-11-07"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]UsageDay{"trc_a": {
		{Day: "2026-11-08", Bytes: 30, QuotaAttachment: 3, QuotaRefused: 2},
		{Day: "2026-11-07", Bytes: 20},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage %+v", got)
	}

	hits, err := QuotaHits(ctx, s.DB, "2026-11-07")
	if err != nil {
		t.Fatal(err)
	}
	// trc_a by its recorded crossing, trc_c by its quota drop; trc_b had neither.
	want = map[string][]UsageDay{
		"trc_a": {{Day: "2026-11-07", Bytes: 20}},
		"trc_c": {{Day: "2026-11-07", Bytes: 1, QuotaAttachment: 1}},
	}
	if !reflect.DeepEqual(hits, want) {
		t.Fatalf("quota hits %+v", hits)
	}
	if hits, _ := QuotaHits(ctx, s.DB, "2026-11-08"); len(hits) != 1 || hits["trc_a"][0].QuotaRefused != 2 {
		t.Fatalf("quota hits 11-08 %+v", hits)
	}
}
