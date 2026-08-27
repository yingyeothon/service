package lobby

import (
	"crypto/rand"
	"encoding/hex"
)

// randomID returns 16 hex characters from the CSPRNG.
func randomID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// ValidPartyID is the shape `party.create` issues: `pty_` + 16 hex.
func ValidPartyID(id string) bool {
	if len(id) != 4+16 || id[:4] != "pty_" {
		return false
	}
	for _, c := range id[4:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
