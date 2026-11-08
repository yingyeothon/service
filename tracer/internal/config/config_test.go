package config

import "testing"

func TestParseRejectsWildcardListen(t *testing.T) {
	for _, listen := range []string{":8095", "0.0.0.0:8095", "[::]:8095"} {
		_, err := Parse([]byte(`{"listen":"` + listen + `","db":"x.db"}`))
		if err == nil {
			t.Errorf("listen %q: expected error", listen)
		}
	}
}

func TestParseDefaultsAndLookup(t *testing.T) {
	c, err := Parse([]byte(`{"listen":"127.0.0.1:8095","db":"x.db","projects":[{"id":3,"slug":"a","key":"k"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxEnvelopeBytes != DefaultMaxEnvelopeBytes {
		t.Errorf("MaxEnvelopeBytes = %d", c.MaxEnvelopeBytes)
	}
	if p, ok := c.ProjectByID(3); !ok || p.Slug != "a" {
		t.Errorf("ProjectByID(3) = %+v, %v", p, ok)
	}
	if _, ok := c.ProjectByID(4); ok {
		t.Error("ProjectByID(4) should miss")
	}
}

func TestParseRejectsDuplicateKeys(t *testing.T) {
	_, err := Parse([]byte(`{"listen":"127.0.0.1:1","db":"x.db","projects":[{"id":1,"slug":"a","key":"k"},{"id":2,"slug":"b","key":"k"}]}`))
	if err == nil {
		t.Fatal("expected duplicate key error")
	}
}
