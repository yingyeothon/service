package assetcrypt

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"

	"github.com/tink-crypto/tink-go/v2/streamingaead/subtle"
)

// tink is Tink's AES-CTR-HMAC streaming primitive with this format's
// parameters: the independent check that a `yyt-enc v1` file is a Tink
// ciphertext (docs/asset-encryption.md *Test vectors*). Test-only dependency.
func tink(t *testing.T, k Key) *subtle.AESCTRHMAC {
	t.Helper()
	p, err := subtle.NewAESCTRHMAC(k.Bytes(), "SHA256", KeySize, "SHA256", TagSize, SegmentSize, 0)
	if err != nil {
		t.Fatal(err)
	}
	if p.HeaderLength() != HeaderLen {
		t.Fatalf("tink header length %d", p.HeaderLength())
	}
	return p
}

func tinkDecrypt(t *testing.T, k Key, ad string, ct []byte) ([]byte, error) {
	t.Helper()
	r, err := tink(t, k).NewDecryptingReader(bytes.NewReader(ct), []byte(ad))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(r)
}

func TestTinkAcceptsTheVectors(t *testing.T) {
	have, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Skip("no vectors file yet")
	}
	var f vectorFile
	if err := json.Unmarshal(have, &f); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Cases {
		k, _ := ParseKey(c.Key)
		ct, _ := hex.DecodeString(c.CiphertextHex)
		pt := c.plaintext()
		got, err := tinkDecrypt(t, k, c.Path, ct)
		if err != nil || !bytes.Equal(got, pt) {
			t.Errorf("%s: tink: %v", c.Name, err)
		}
	}
	for _, n := range f.Negative {
		k, _ := ParseKey(n.Key)
		ct, _ := hex.DecodeString(n.CiphertextHex)
		if _, err := tinkDecrypt(t, k, n.Path, ct); err == nil {
			t.Errorf("%s: tink accepted it", n.Name)
		}
	}
}

func TestTinkCiphertextOpensHere(t *testing.T) {
	// The other direction: a Tink ciphertext (random salt and nonce prefix)
	// is a valid `yyt-enc v1` file, because the decryptor never recomputes D.
	k := vectorKey(t)
	for _, n := range []int{0, 1, FirstPlain, FirstPlain + 1, 200_000} {
		pt := pattern(n, 7)
		var buf bytes.Buffer
		w, err := tink(t, k).NewEncryptingWriter(&buf, []byte("v1/a.bin"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(pt); err != nil {
			t.Fatal(err)
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		got, err := Decrypt(k, "v1/a.bin", buf.Bytes())
		if err != nil {
			// Tink may end a plaintext that fills its buffer exactly with an
			// empty last segment, which this format's length rule refuses;
			// that shape never comes from `Encrypt`, so it is not conformance.
			if n == FirstPlain && errors.Is(err, ErrCorrupt) && int64(buf.Len()) == CiphertextLen(int64(n))+TagSize {
				continue
			}
			t.Fatalf("%d bytes: %v", n, err)
		}
		if !bytes.Equal(got, pt) {
			t.Fatalf("%d bytes: plaintext differs", n)
		}
	}
}
