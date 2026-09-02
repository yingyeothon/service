package textsafe

import "testing"

func TestCleanStripsControlCharactersButKeepsLayout(t *testing.T) {
	in := "\x1b]0;pwned\x07title\x1b[2J line\n\ttab\x7f end"
	want := "]0;pwnedtitle[2J line\n\ttab end"
	if got := Clean(in); got != want {
		t.Fatalf("Clean(%q) = %q, want %q", in, got, want)
	}
	if got := Clean("plain"); got != "plain" {
		t.Fatalf("Clean changed plain text: %q", got)
	}
}
