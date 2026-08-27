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
