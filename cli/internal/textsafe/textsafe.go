// Package textsafe strips terminal control characters from text that came
// from another member or another host: a discussion body, an issue title or
// an opaque error body can carry an escape sequence that retitles the
// terminal or writes the clipboard. It depends on nothing, so both the HTTP
// client and the printer can use it.
package textsafe

import "strings"

// Clean drops every control character except \n and \t (and DEL).
func Clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' && r != '\t' || r == 0x7f {
			return -1
		}
		return r
	}, s)
}
