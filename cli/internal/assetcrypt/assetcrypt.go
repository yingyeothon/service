// Package assetcrypt implements the `yyt-enc v1` asset encryption format
// (docs/asset-encryption.md): Tink's AES-CTR-HMAC streaming AEAD with
// AES-256, HKDF-SHA256, 32-byte HMAC-SHA256 tags and 64 KiB segments, except
// that the salt and nonce prefix are derived from the key, the associated
// data and the plaintext instead of drawn at random. The same plaintext at the
// same path under the same key therefore always encrypts to the same bytes.
//
// The associated data is the file's object key below the bundle: `{path}` in
// a live bundle and `{version}/{path}` in a versioned one.
package assetcrypt

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	// HeaderLen is the fixed header: 0x28 ‖ salt (32) ‖ noncePrefix (7).
	HeaderLen = 40
	// SegmentSize is the ciphertext segment size, tag included.
	SegmentSize = 65536
	// TagSize is the HMAC-SHA256 tag on every segment.
	TagSize = 32
	// FirstPlain is how much plaintext the first segment holds when full.
	FirstPlain = SegmentSize - HeaderLen - TagSize // 65,464
	// LaterPlain is how much plaintext every later segment holds when full.
	LaterPlain = SegmentSize - TagSize // 65,504
	// KeySize is the bundle key: 32 random bytes.
	KeySize = 32
	// KeyPrefix names the key's text form: `yak1.` + 43 base64url characters.
	KeyPrefix = "yak1."
	// MinCiphertext is an empty file: the header and one empty segment's tag.
	MinCiphertext = HeaderLen + TagSize
	// MaxPlaintext is the platform's file ceiling (`asset.fileBytes` hard).
	MaxPlaintext = 256 << 20
	// MaxCiphertext is MaxPlaintext plus the format's overhead (4,099 segments).
	MaxCiphertext = MaxPlaintext + HeaderLen + TagSize*4099

	infoDet    = "yyt-enc v1 det"
	infoHeader = "yyt-enc v1 header"
	headerByte = 0x28
	saltLen    = 32
	prefixLen  = 7
)

var (
	// ErrBadKey is a key text that is not `yak1.` + 43 base64url characters of 32 bytes.
	ErrBadKey = errors.New("bad_key")
	// ErrCorrupt is a ciphertext that fails a length rule or a segment tag.
	ErrCorrupt = errors.New("asset_corrupt")
	// ErrChanged is a plaintext that changed between the two encryption passes.
	ErrChanged = errors.New("the file changed while it was being encrypted")
)

// Key is one bundle's 256-bit key.
type Key struct{ b [KeySize]byte }

// KeyFromBytes wraps 32 raw bytes.
func KeyFromBytes(b []byte) (Key, error) {
	var k Key
	if len(b) != KeySize {
		return k, ErrBadKey
	}
	copy(k.b[:], b)
	return k, nil
}

var b64 = base64.RawURLEncoding

// ParseKey accepts exactly the canonical text form: the prefix, 43 base64url
// characters that decode to 32 bytes and re-encode to the same text. A
// lenient and a strict decoder must never disagree on which texts are keys.
func ParseKey(text string) (Key, error) {
	var k Key
	if len(text) != len(KeyPrefix)+43 || text[:len(KeyPrefix)] != KeyPrefix {
		return k, ErrBadKey
	}
	raw, err := b64.Strict().DecodeString(text[len(KeyPrefix):])
	if err != nil || len(raw) != KeySize || b64.EncodeToString(raw) != text[len(KeyPrefix):] {
		return k, ErrBadKey
	}
	copy(k.b[:], raw)
	return k, nil
}

// String is the canonical text form. It is the secret: never log it.
func (k Key) String() string { return KeyPrefix + b64.EncodeToString(k.b[:]) }

// Bytes is the raw key.
func (k Key) Bytes() []byte { return append([]byte(nil), k.b[:]...) }

// SegmentCount is how many segments a plaintext of `n` bytes takes.
func SegmentCount(n int64) int64 {
	if n <= FirstPlain {
		return 1
	}
	return 1 + (n-FirstPlain+LaterPlain-1)/LaterPlain
}

// CiphertextLen is the ciphertext length of a plaintext of `n` bytes.
func CiphertextLen(n int64) int64 { return n + HeaderLen + TagSize*SegmentCount(n) }

// segmentsOf derives the segment count from a ciphertext length, or ErrCorrupt
// when no plaintext produces that length (docs/asset-encryption.md
// *Decrypting a whole file* step 1-2).
func segmentsOf(total int64) (int64, error) {
	if total < MinCiphertext || total > MaxCiphertext {
		return 0, ErrCorrupt
	}
	if total <= SegmentSize {
		return 1, nil
	}
	n := 1 + (total-SegmentSize+SegmentSize-1)/SegmentSize
	if total-SegmentSize*(n-1) < TagSize+1 {
		return 0, ErrCorrupt
	}
	return n, nil
}

// CStart is the ciphertext offset where segment i starts.
func CStart(i int64) int64 {
	if i == 0 {
		return HeaderLen
	}
	return SegmentSize * i
}

// PStart is the plaintext offset where segment i starts.
func PStart(i int64) int64 {
	if i == 0 {
		return 0
	}
	return FirstPlain + LaterPlain*(i-1)
}

// SegmentOf is the segment holding plaintext offset p.
func SegmentOf(p int64) int64 {
	if p < FirstPlain {
		return 0
	}
	return 1 + (p-FirstPlain)/LaterPlain
}

func u32be(n uint32) []byte {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], n)
	return b[:]
}

func iv(prefix []byte, i int64, last bool) []byte {
	out := make([]byte, 0, 16)
	out = append(out, prefix...)
	out = append(out, u32be(uint32(i))...)
	if last {
		out = append(out, 1)
	} else {
		out = append(out, 0)
	}
	return append(out, 0, 0, 0, 0)
}

// segmentKeys derives k_enc ‖ k_mac from the key, the salt and the AD.
func segmentKeys(k Key, salt []byte, ad string) (enc, mac []byte) {
	km, err := hkdf.Key(sha256.New, k.b[:], salt, ad, 64)
	if err != nil {
		panic(err) // fixed sizes: cannot fail
	}
	return km[:32], km[32:]
}

// detKey is K_det, the key of the plaintext digest D.
func detKey(k Key) []byte {
	out, err := hkdf.Key(sha256.New, k.b[:], nil, infoDet, 32)
	if err != nil {
		panic(err)
	}
	return out
}

// digester computes D = HMAC(K_det, u32be(len(AD)) ‖ AD ‖ plaintext).
func digester(k Key, ad string) hashWriter {
	h := hmac.New(sha256.New, detKey(k))
	h.Write(u32be(uint32(len(ad))))
	h.Write([]byte(ad))
	return hashWriter{h}
}

type hashWriter struct{ h hashSum }

type hashSum interface {
	io.Writer
	Sum([]byte) []byte
}

func (w hashWriter) Write(p []byte) (int, error) { return w.h.Write(p) }
func (w hashWriter) Sum() []byte                 { return w.h.Sum(nil) }

// headerOf derives the salt and nonce prefix from D.
func headerOf(d []byte) (header []byte) {
	hdr, err := hkdf.Key(sha256.New, d, nil, infoHeader, saltLen+prefixLen)
	if err != nil {
		panic(err)
	}
	return append([]byte{headerByte}, hdr...)
}

// encrypter turns plaintext segments into ciphertext segments under one header.
type encrypter struct {
	block  cipher.Block
	mac    []byte
	prefix []byte
}

func newEncrypter(k Key, header []byte, ad string) *encrypter {
	enc, mac := segmentKeys(k, header[1:1+saltLen], ad)
	block, err := aes.NewCipher(enc)
	if err != nil {
		panic(err)
	}
	return &encrypter{block: block, mac: mac, prefix: header[1+saltLen:]}
}

func (e *encrypter) seal(i int64, last bool, plain []byte) []byte {
	v := iv(e.prefix, i, last)
	out := make([]byte, len(plain)+TagSize)
	cipher.NewCTR(e.block, v).XORKeyStream(out[:len(plain)], plain)
	h := hmac.New(sha256.New, e.mac)
	h.Write(v)
	h.Write(out[:len(plain)])
	copy(out[len(plain):], h.Sum(nil))
	return out
}

// Encrypt encrypts a plaintext held in memory; one read, so no second pass.
func Encrypt(k Key, ad string, plaintext []byte) []byte {
	d := digester(k, ad)
	d.Write(plaintext)
	header := headerOf(d.Sum())
	e := newEncrypter(k, header, ad)
	out := bytes.NewBuffer(make([]byte, 0, CiphertextLen(int64(len(plaintext)))))
	out.Write(header)
	n := SegmentCount(int64(len(plaintext)))
	at := 0
	for i := int64(0); i < n; i++ {
		size := LaterPlain
		if i == 0 {
			size = FirstPlain
		}
		end := min(at+size, len(plaintext))
		out.Write(e.seal(i, i == n-1, plaintext[at:end]))
		at = end
	}
	return out.Bytes()
}

// EncryptStream encrypts a file read twice: `open` yields a fresh reader each
// time. The first pass computes D and the header; the second encrypts and
// recomputes D over the bytes it actually read, and the output is only
// trustworthy when the two agree (ErrChanged otherwise). The caller discards
// `dst` on any error: a file that changed between the passes would put content
// B under the salt of content A, which shares a keystream with A's ciphertext.
// Returns the plaintext length and the ciphertext's SHA-256.
func EncryptStream(k Key, ad string, open func() (io.ReadCloser, error), dst io.Writer) (plainLen int64, sha [32]byte, err error) {
	r, err := open()
	if err != nil {
		return 0, sha, err
	}
	d := digester(k, ad)
	plainLen, err = io.Copy(d, r)
	_ = r.Close()
	if err != nil {
		return 0, sha, err
	}
	if plainLen > MaxPlaintext {
		return 0, sha, fmt.Errorf("file is larger than %d bytes", MaxPlaintext)
	}
	header := headerOf(d.Sum())
	e := newEncrypter(k, header, ad)
	h := sha256.New()
	w := io.MultiWriter(dst, h)
	if _, err := w.Write(header); err != nil {
		return 0, sha, err
	}
	r, err = open()
	if err != nil {
		return 0, sha, err
	}
	defer r.Close()
	again := digester(k, ad)
	src := io.TeeReader(r, again)
	n := SegmentCount(plainLen)
	buf := make([]byte, LaterPlain)
	var seen int64
	for i := int64(0); i < n; i++ {
		size := LaterPlain
		if i == 0 {
			size = FirstPlain
		}
		want := min(int64(size), plainLen-seen)
		got, err := io.ReadFull(src, buf[:want])
		seen += int64(got)
		if err != nil {
			if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
				return 0, sha, ErrChanged
			}
			return 0, sha, err
		}
		if _, err := w.Write(e.seal(i, i == n-1, buf[:got])); err != nil {
			return 0, sha, err
		}
	}
	// One more byte would mean the file grew.
	if extra, _ := io.ReadFull(src, buf[:1]); extra > 0 {
		return 0, sha, ErrChanged
	}
	if !hmac.Equal(headerOf(again.Sum()), header) {
		return 0, sha, ErrChanged
	}
	copy(sha[:], h.Sum(nil))
	return plainLen, sha, nil
}

// Decryptor verifies and opens the segments of one ciphertext whose total
// length is known (from Content-Length or Content-Range).
type Decryptor struct {
	block  cipher.Block
	mac    []byte
	prefix []byte
	// Total is the ciphertext length; Segments the segment count it implies.
	Total    int64
	Segments int64
}

// NewDecryptor checks the header and the total length and derives the
// segment keys. It never recomputes D: a decryptor cannot tell a derived salt
// from a random one and does not need to.
func NewDecryptor(k Key, ad string, header []byte, total int64) (*Decryptor, error) {
	if len(header) < HeaderLen || header[0] != headerByte {
		return nil, ErrCorrupt
	}
	n, err := segmentsOf(total)
	if err != nil {
		return nil, err
	}
	enc, mac := segmentKeys(k, header[1:1+saltLen], ad)
	block, err := aes.NewCipher(enc)
	if err != nil {
		panic(err)
	}
	return &Decryptor{block: block, mac: mac, prefix: append([]byte(nil), header[1+saltLen:HeaderLen]...), Total: total, Segments: n}, nil
}

// Extent is the ciphertext byte range [Start, End) of segment i.
func (d *Decryptor) Extent(i int64) (start, end int64) {
	start = CStart(i)
	end = min(start+d.segmentCiphertext(i), d.Total)
	return start, end
}

func (d *Decryptor) segmentCiphertext(i int64) int64 {
	if i == 0 {
		return SegmentSize - HeaderLen
	}
	return SegmentSize
}

// Open verifies segment i (its ciphertext with the tag, exactly the bytes of
// Extent(i)) in constant time and returns its plaintext, or ErrCorrupt.
func (d *Decryptor) Open(i int64, seg []byte) ([]byte, error) {
	if i < 0 || i >= d.Segments {
		return nil, ErrCorrupt
	}
	start, end := d.Extent(i)
	if int64(len(seg)) != end-start || len(seg) < TagSize {
		return nil, ErrCorrupt
	}
	v := iv(d.prefix, i, i == d.Segments-1)
	body, tag := seg[:len(seg)-TagSize], seg[len(seg)-TagSize:]
	h := hmac.New(sha256.New, d.mac)
	h.Write(v)
	h.Write(body)
	if subtle.ConstantTimeCompare(h.Sum(nil), tag) != 1 {
		return nil, ErrCorrupt
	}
	out := make([]byte, len(body))
	cipher.NewCTR(d.block, v).XORKeyStream(out, body)
	return out, nil
}

// PlaintextLen is the plaintext length the total ciphertext length implies.
func (d *Decryptor) PlaintextLen() int64 { return d.Total - HeaderLen - TagSize*d.Segments }

// Decrypt opens a whole ciphertext held in memory.
func Decrypt(k Key, ad string, ciphertext []byte) ([]byte, error) {
	if len(ciphertext) < HeaderLen {
		return nil, ErrCorrupt
	}
	d, err := NewDecryptor(k, ad, ciphertext[:HeaderLen], int64(len(ciphertext)))
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, d.PlaintextLen())
	for i := int64(0); i < d.Segments; i++ {
		start, end := d.Extent(i)
		p, err := d.Open(i, ciphertext[start:end])
		if err != nil {
			return nil, err
		}
		out = append(out, p...)
	}
	return out, nil
}

// DecryptStream opens a ciphertext of known total length from a reader
// positioned at its start and writes the plaintext, segment by segment; no
// byte of a segment is written before its tag verified. A short or long
// stream is ErrCorrupt.
func DecryptStream(k Key, ad string, total int64, r io.Reader, w io.Writer) error {
	header := make([]byte, HeaderLen)
	if _, err := io.ReadFull(r, header); err != nil {
		return ErrCorrupt
	}
	d, err := NewDecryptor(k, ad, header, total)
	if err != nil {
		return err
	}
	buf := make([]byte, SegmentSize)
	for i := int64(0); i < d.Segments; i++ {
		start, end := d.Extent(i)
		seg := buf[:end-start]
		if _, err := io.ReadFull(r, seg); err != nil {
			return ErrCorrupt
		}
		p, err := d.Open(i, seg)
		if err != nil {
			return err
		}
		if _, err := w.Write(p); err != nil {
			return err
		}
	}
	if n, _ := io.ReadFull(r, buf[:1]); n > 0 {
		return ErrCorrupt
	}
	return nil
}
