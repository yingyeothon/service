package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/assetcrypt"
	"github.com/yingyeothon/service/cli/internal/output"
)

// assetEncFormat is what a presign into an encrypted bundle must carry
// (services/console/src/asset-crypto.ts).
const assetEncFormat = "yyt-enc-v1"

// bundleKey fetches an encrypted bundle's key: a POST (the console's Origin
// check covers it, and every read is audited). The key stays in memory.
func bundleKey(ctx context.Context, cl *api.Client, id string) (assetcrypt.Key, error) {
	var res struct {
		Key string `json:"key"`
	}
	if err := cl.Do(ctx, http.MethodPost, "/assets/bundles/"+api.PathID(id)+"/key", nil, &res); err != nil {
		return assetcrypt.Key{}, err
	}
	k, err := assetcrypt.ParseKey(res.Key)
	if err != nil {
		return assetcrypt.Key{}, fmt.Errorf("the console answered a key that is not yak1.<43 base64url> (is --api the console base URL?)")
	}
	return k, nil
}

// assetAD is the associated data of a file: its object key below the bundle.
func assetAD(version, path string) string {
	if version == "" {
		return path
	}
	return version + "/" + path
}

// encryptHint turns the console's refusal of a plain upload into an encrypted
// bundle into the command that does work there.
func encryptHint(err error, bundle string) error {
	var ae *api.Error
	if errors.As(err, &ae) && ae.Status == http.StatusBadRequest && strings.Contains(ae.Message, "this bundle is encrypted") {
		return fmt.Errorf("%w (%s is an encrypted bundle: use `yyt asset sync %s <dir> [--version <v>]`, which encrypts on this machine)", err, bundle, bundle)
	}
	return err
}

// encDigest is what a sync remembers about one plaintext under one key and
// path: the ciphertext's SHA-256 and size. The ciphertext is deterministic,
// so an unchanged file (same plaintext SHA-256) needs no second encryption
// to be compared with the bundle's listing -- only a file that is actually
// sent is encrypted, at send time (`materialize`).
type encDigest struct {
	PlainSHA256 string `json:"plainSha256"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
}

// encDigestPath is `$YYT_CACHE/enc/<bundle>/<sha256(keyId|ad|plainSha)>.json`.
// The key never enters the name: its digest does, so a rotated bundle (a new
// bundle, a new key) never reuses an old entry.
func encDigestPath(bundleID string, key assetcrypt.Key, ad, plainSha string) (string, error) {
	dir, err := cacheDir()
	if err != nil {
		return "", err
	}
	h := sha256.New()
	h.Write(key.Bytes())
	h.Write([]byte{0})
	h.Write([]byte(ad))
	h.Write([]byte{0})
	h.Write([]byte(plainSha))
	return filepath.Join(dir, "enc", bundleID, hex.EncodeToString(h.Sum(nil))+".json"), nil
}

func loadEncDigest(bundleID string, key assetcrypt.Key, ad, plainSha string) *encDigest {
	p, err := encDigestPath(bundleID, key, ad, plainSha)
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var d encDigest
	if json.Unmarshal(b, &d) != nil || d.PlainSHA256 != plainSha || len(d.SHA256) != 64 || d.Size < assetcrypt.MinCiphertext {
		return nil
	}
	return &d
}

func saveEncDigest(bundleID string, key assetcrypt.Key, ad string, d encDigest) {
	p, err := encDigestPath(bundleID, key, ad, d.PlainSHA256)
	if err != nil || os.MkdirAll(filepath.Dir(p), 0o700) != nil {
		return
	}
	b, _ := json.Marshal(d)
	tmp, err := os.CreateTemp(filepath.Dir(p), ".enc-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(b)
	if cerr := tmp.Close(); werr != nil || cerr != nil {
		os.Remove(tmp.Name()) // closed first: Windows cannot delete an open file
		return
	}
	_ = os.Rename(tmp.Name(), p)
}

// encTempDir is where a sync writes ciphertext before sending it: under the
// cache directory (real disk), not $TMPDIR, which is often RAM-backed.
func encTempDir() (string, error) {
	base, err := cacheDir()
	if err == nil {
		err = os.MkdirAll(base, 0o700)
	}
	if err != nil {
		return os.MkdirTemp("", "yyt-enc-*")
	}
	return os.MkdirTemp(base, "enc-tmp-*")
}

// encryptLocal encrypts one local file into `tmpDir` (two passes over the
// source; the output is discarded when the file changed between them) and
// returns the ciphertext's location, size and SHA-256 -- what the sync sends
// instead of the plaintext.
func encryptLocal(key assetcrypt.Key, ad, local, tmpDir string) (path string, size int64, sha string, err error) {
	tmp, err := os.CreateTemp(tmpDir, "enc-*")
	if err != nil {
		return "", 0, "", err
	}
	open := func() (io.ReadCloser, error) { return os.Open(local) }
	plainLen, sum, err := assetcrypt.EncryptStream(key, ad, open, tmp)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", 0, "", err
	}
	return tmp.Name(), assetcrypt.CiphertextLen(plainLen), hex.EncodeToString(sum[:]), nil
}

func newAssetKey(a *App, bundleID bundleResolver) *cobra.Command {
	c := &cobra.Command{
		Use:   "key",
		Short: "The key of an encrypted bundle",
	}
	show := &cobra.Command{
		Use:   "show <bundle>",
		Short: "Print the bundle key (yak1.…) that decrypts every file of the bundle",
		Long: "Print the bundle key. It is what the consumer app embeds to decrypt the\n" +
			"bundle's files, and what `asset sync` and `asset download` fetch for you.\n" +
			"Every read is audited. Never commit it: the key is never rotated in place,\n" +
			"so a leaked key means a new bundle and an app release.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], true)
			if err != nil {
				return err
			}
			var res struct {
				BundleID string `json:"bundleId"`
				Key      string `json:"key"`
				Format   string `json:"format"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, "/assets/bundles/"+api.PathID(id)+"/key", nil, &res); err != nil {
				return err
			}
			if _, err := assetcrypt.ParseKey(res.Key); err != nil {
				return fmt.Errorf("the console answered a key that is not yak1.<43 base64url>")
			}
			fmt.Fprintln(a.Err, "this key decrypts every file of the bundle: embed it in the app, never commit it (a leak means a new bundle)")
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			fmt.Fprintln(a.Out, output.Clean(res.Key))
			return nil
		},
	}
	c.AddCommand(show)
	return c
}

// cdnRange is one ranged GET of a public CDN URL: the status, the ETag, the
// object's total length from Content-Range, and the body still to be read
// (the caller closes it). A 200 means the host ignored Range or the object
// changed under If-Range.
type cdnRange struct {
	status int
	etag   string
	total  int64
	body   io.ReadCloser
}

func getRange(ctx context.Context, hc *http.Client, src string, from, to int64, ifRange string) (*cdnRange, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from, to))
	if ifRange != "" {
		req.Header.Set("If-Range", ifRange)
	}
	var transport http.RoundTripper
	if hc != nil {
		transport = hc.Transport
	}
	res, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		return nil, err
	}
	out := &cdnRange{status: res.StatusCode, etag: res.Header.Get("ETag"), body: res.Body}
	if res.StatusCode != http.StatusPartialContent {
		res.Body.Close()
		out.body = nil
		if res.StatusCode == http.StatusOK {
			return out, nil
		}
		return out, &httpStatusError{Op: "download", Status: res.StatusCode}
	}
	cr := res.Header.Get("Content-Range")
	slash := strings.LastIndex(cr, "/")
	if slash < 0 {
		res.Body.Close()
		return nil, errors.New("download: 206 without a total length")
	}
	total, err := strconv.ParseInt(cr[slash+1:], 10, 64)
	if err != nil {
		res.Body.Close()
		return nil, errors.New("download: 206 without a numeric total length")
	}
	out.total = total
	return out, nil
}

// readAllRange reads a small ranged body (the header) in full.
func readAllRange(r *cdnRange, n int64) ([]byte, error) {
	defer r.body.Close()
	b, err := io.ReadAll(io.LimitReader(r.body, n+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) != n {
		return nil, io.ErrUnexpectedEOF
	}
	return b, nil
}

// errObjectChanged is a ranged read whose object changed between requests.
var errObjectChanged = errors.New("the object changed while it was being read")

// fetchEncrypted downloads plaintext bytes [from, to] (inclusive; to < 0 is
// the end) of an encrypted file: the header once, then the segments the
// range covers under If-Range, each verified before a byte is written. A
// mismatch is `asset_corrupt`; an object that changed under the read starts
// over.
func fetchEncrypted(ctx context.Context, hc *http.Client, key assetcrypt.Key, ad, src string, from, to int64, dst string, a *App) error {
	for attempt := 0; ; attempt++ {
		err := fetchEncryptedOnce(ctx, hc, key, ad, src, from, to, dst, a)
		if errors.Is(err, errObjectChanged) && attempt < 3 {
			continue
		}
		return err
	}
}

func fetchEncryptedOnce(ctx context.Context, hc *http.Client, key assetcrypt.Key, ad, src string, from, to int64, dst string, a *App) error {
	head, err := getRange(ctx, hc, src, 0, assetcrypt.HeaderLen-1, "")
	if err != nil {
		return err
	}
	if head.status == http.StatusOK {
		return errors.New("download: the host does not honour Range requests, which an encrypted file needs")
	}
	if head.status != http.StatusPartialContent {
		return &httpStatusError{Op: "download", Status: head.status}
	}
	header, err := readAllRange(head, assetcrypt.HeaderLen)
	if err != nil {
		return err
	}
	d, err := assetcrypt.NewDecryptor(key, ad, header, head.total)
	if err != nil {
		return err
	}
	plainLen := d.PlaintextLen()
	if to < 0 || to >= plainLen {
		to = plainLen - 1
	}
	if from > to || from >= plainLen {
		if plainLen == 0 && from == 0 {
			// An empty file: nothing to fetch, the header already verified
			// the length rule; the one empty segment still has a tag.
		} else {
			return fmt.Errorf("--range starts past the end of the file (%d bytes)", plainLen)
		}
	}
	first, last := assetcrypt.SegmentOf(from), assetcrypt.SegmentOf(max(to, 0))
	if last >= d.Segments {
		last = d.Segments - 1
	}
	cFrom, _ := d.Extent(first)
	_, cTo := d.Extent(last)
	seg, err := getRange(ctx, hc, src, cFrom, cTo-1, head.etag)
	if err != nil {
		return err
	}
	if seg.status != http.StatusPartialContent || seg.total != head.total || seg.etag != head.etag {
		return errObjectChanged
	}
	defer seg.body.Close()
	var w io.Writer
	var tmp *os.File
	if dst == "-" {
		w = a.Out
	} else {
		tmp, err = os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".*.part")
		if err != nil {
			return err
		}
		// Close before removing: an error return below leaves the handle
		// open, and Windows refuses to delete an open file (the .part then
		// outlived a corrupt download; caught by CI on windows-latest).
		defer func() {
			_ = tmp.Close() // no-op after the success path's Close
			_ = os.Remove(tmp.Name())
		}()
		w = tmp
	}
	// Segment by segment from the stream: one segment in memory at a time,
	// each verified before a byte of it is written.
	var written int64
	buf := make([]byte, assetcrypt.SegmentSize)
	for i := first; i <= last; i++ {
		s, e := d.Extent(i)
		ct := buf[:e-s]
		if _, err := io.ReadFull(seg.body, ct); err != nil {
			return assetcrypt.ErrCorrupt
		}
		p, err := d.Open(i, ct)
		if err != nil {
			return err
		}
		ps := assetcrypt.PStart(i)
		lo, hi := max(from-ps, 0), min(to-ps+1, int64(len(p)))
		if lo < hi {
			n, err := w.Write(p[lo:hi])
			if err != nil {
				return fmt.Errorf("download interrupted: %v", err)
			}
			written += int64(n)
		}
	}
	if tmp == nil {
		return nil
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return err
	}
	fmt.Fprintf(a.Err, "wrote %s (%d bytes, decrypted)\n", dst, written)
	return nil
}
