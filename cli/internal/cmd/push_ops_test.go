package cmd

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestPushUploadsStatsSweep(t *testing.T) {
	login := "octo"
	f := newFake(t, ctxRoutes(map[string]func(recorded) (int, any){
		"GET /channels/" + pushID + "/push/uploads": func(recorded) (int, any) {
			return 200, map[string]any{"uploads": []any{
				map[string]any{"id": "pu_1", "size": 120, "createdBy": "mem_1", "createdByLogin": login, "createdAt": 1756000000, "usableUntil": 1756086400, "pending": true, "inUse": false},
				map[string]any{"id": "pu_2", "size": 80, "createdBy": "apikey", "createdByLogin": nil, "createdAt": 1756000000, "usableUntil": 1756086400, "pending": false, "inUse": false},
			}, "next": nil, "max": 20}
		},
		"DELETE /channels/" + pushID + "/push/uploads/pu_2": func(recorded) (int, any) { return 204, nil },
		"GET /channels/" + pushID + "/push/stats": func(recorded) (int, any) {
			return 200, map[string]any{"tokens": map[string]any{"count": 3, "capped": false}, "tokenCap": 10000, "since": "2026-09-27",
				"days": []any{map[string]any{"day": "2026-10-10", "calls": 2, "sent": 1, "noToken": 1, "failed": 0, "unregistered": 0}}}
		},
		"GET /admin/push/sweep": func(recorded) (int, any) {
			return 200, map[string]any{"last": map[string]any{"at": 1756000000, "tokens": map[string]any{"channels": 1, "stale": 4}, "released": 0, "kept": 0, "failed": []any{},
				"reconcile": map[string]any{"truncated": false, "slots": []any{map[string]any{"slot": "p1", "claims": 2, "firebaseApps": 3, "orphans": 1, "restored": 1, "lost": 1, "autoClosed": true}}}}}
		},
	}, nil, nil, nil))
	out, errs, err := run(t, f, "push", "upload", "ls", pushID)
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_upload_ls", out)
	if !strings.Contains(errs, "1 of 20 pending places used") {
		t.Fatalf("stderr %q", errs)
	}
	if _, _, err := run(t, f, "push", "upload", "rm", pushID, "pu_2"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, f, "push", "upload", "rm", pushID, "pj_2"); err == nil {
		t.Fatal("a job id was taken for an upload")
	}
	out, _, err = run(t, f, "push", "channel", "stats", pushID)
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_channel_stats", out)
	out, _, err = run(t, f, "push", "pool", "sweep")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "push_pool_sweep", out)
	// The apiKey family needs a stored key.
	cfg := filepath.Join(t.TempDir(), "config.json")
	if _, _, err := runCfg(t, f, cfg, "", "push", "upload", "ls", pushID, "--as-server"); err == nil || !strings.Contains(err.Error(), "push key set") {
		t.Fatalf("--as-server without a key: %v", err)
	}
}
