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
	"sort"
	"sync"
	"time"

	"github.com/yingyeothon/service/cli/internal/api"
)

/*
 * Files over the console's single-PUT ceiling (64 MiB) come back from a
 * presign as a multipart grant: no URL, a part size and a part count
 * (docs/decisions.md *Large asset uploads* #1, #6). The uploader hashes each
 * part, asks `POST /assets/uploads/{id}/parts` for the parts it still owes
 * (every URL signs its part's exact length and SHA-256), PUTs them in
 * parallel, and commits the upload like any other. The upload lives a day,
 * so a run that dies is resumed: the upload id is kept under the user's
 * cache directory by bundle and file SHA-256, and `GET …/parts` says which
 * parts S3 already holds.
 */

// multipartGrant is the presign answer for a file uploaded in parts.
type multipartGrant struct {
	UploadID  string `json:"uploadId"`
	Key       string `json:"key"`
	PartSize  int64  `json:"partSize"`
	PartCount int    `json:"partCount"`
	Size      int64  `json:"size"`
	ExpiresAt int64  `json:"expiresAt"`
	// CommitOnly: the upload is `completing` (a commit died mid-way); its
	// parts are in, only the commit is owed.
	CommitOnly bool `json:"-"`
}

// partGrant is one presigned part URL.
type partGrant struct {
	PartNumber int               `json:"partNumber"`
	URL        string            `json:"url"`
	Method     string            `json:"method"`
	Headers    map[string]string `json:"headers"`
}

type partsResult struct {
	ExpiresAt int64       `json:"expiresAt"`
	Parts     []partGrant `json:"parts"`
}

// listedPart is one part S3 holds, as `GET …/parts` reports it.
type listedPart struct {
	PartNumber int     `json:"partNumber"`
	Size       int64   `json:"size"`
	SHA256     *string `json:"sha256"`
}

type partsListing struct {
	Status    string       `json:"status"`
	Open      bool         `json:"open"`
	PartSize  int64        `json:"partSize"`
	PartCount int          `json:"partCount"`
	Parts     []listedPart `json:"parts"`
}

// errUploadGone: S3 no longer holds the upload (aborted, or a day old): the
// caller presigns afresh.
var errUploadGone = errors.New("the multipart upload is no longer open")

// uploadState is what a resume needs: which upload id holds this file's
// parts. It is keyed by bundle and SHA-256, so the same bytes at the same
// path resume even from another directory.
type uploadState struct {
	UploadID  string `json:"uploadId"`
	BundleID  string `json:"bundleId"`
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
	ExpiresAt int64  `json:"expiresAt"`
}

// uploadStatePath is `$YYT_CACHE/uploads/<bundle>/<sha256>.json`, the cache
// directory defaulting to the user's (`~/.cache/yyt` on Linux). Both ids
// are hex/underscore, so they are safe path segments.
func uploadStatePath(bundleID, sha string) (string, error) {
	dir, err := cacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "uploads", bundleID, sha+".json"), nil
}

// cacheDir is `$YYT_CACHE`, else the user's cache directory plus `yyt`.
func cacheDir() (string, error) {
	if dir := os.Getenv("YYT_CACHE"); dir != "" {
		return dir, nil
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "yyt"), nil
}

func loadUploadState(bundleID, sha string) *uploadState {
	p, err := uploadStatePath(bundleID, sha)
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var s uploadState
	if json.Unmarshal(b, &s) != nil || s.UploadID == "" || s.SHA256 != sha {
		return nil
	}
	return &s
}

// saveUploadState writes atomically (temp file + rename), like the config.
func saveUploadState(s uploadState) error {
	p, err := uploadStatePath(s.BundleID, s.SHA256)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(s)
	tmp, err := os.CreateTemp(filepath.Dir(p), ".upload-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), p)
}

func dropUploadState(bundleID, sha string) {
	if p, err := uploadStatePath(bundleID, sha); err == nil {
		os.Remove(p)
	}
}

// resumableUpload returns the pending upload a saved state names for this
// file, if the console still has it open under the same path; otherwise the
// state is dropped and nil comes back.
func resumableUpload(ctx context.Context, call func(ctx context.Context, method, path string, in, out any) error, bundleID string, f localFile) *multipartGrant {
	s := loadUploadState(bundleID, f.SHA256)
	if s == nil || s.Path != f.Path || s.Size != f.Size {
		return nil
	}
	var u struct {
		ID        string `json:"id"`
		Path      string `json:"path"`
		Status    string `json:"status"`
		Multipart bool   `json:"multipart"`
		PartSize  int64  `json:"partSize"`
		PartCount int    `json:"partCount"`
		ExpiresAt int64  `json:"expiresAt"`
		Size      int64  `json:"size"`
	}
	if err := call(ctx, http.MethodGet, "/assets/uploads/"+api.PathID(s.UploadID), nil, &u); err != nil {
		var ae *api.Error
		if errors.As(err, &ae) && ae.Status == 404 {
			dropUploadState(bundleID, f.SHA256)
		}
		return nil
	}
	if (u.Status != "pending" && u.Status != "completing") || !u.Multipart || u.Path != f.Path || u.Size != f.Size || u.ExpiresAt <= time.Now().Unix()+60 {
		dropUploadState(bundleID, f.SHA256)
		return nil
	}
	return &multipartGrant{UploadID: u.ID, PartSize: u.PartSize, PartCount: u.PartCount, Size: u.Size, ExpiresAt: u.ExpiresAt, CommitOnly: u.Status == "completing"}
}

// committingUpload reads the upload id out of a presign refusal that says
// the path's file row is a claim still being committed (`reason:
// "committing"`): the fix is to commit that upload, not to upload again.
func committingUpload(err error) (uploadID, path string, ok bool) {
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Status != 409 || len(ae.Details) == 0 {
		return "", "", false
	}
	var d struct {
		Reason   string `json:"reason"`
		UploadID string `json:"uploadId"`
		Path     string `json:"path"`
	}
	if json.Unmarshal(ae.Details, &d) != nil || d.Reason != "committing" || d.UploadID == "" {
		return "", "", false
	}
	return d.UploadID, d.Path, true
}

// partRange is the byte range of part n (1-based).
func partRange(g multipartGrant, n int) (off, length int64) {
	off = g.PartSize * int64(n-1)
	length = g.PartSize
	if rest := g.Size - off; rest < length {
		length = rest
	}
	return off, length
}

// hashPart hashes one part of the file.
func hashPart(local string, off, length int64) (string, error) {
	f, err := os.Open(local)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(f, off, length)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// uploadMultipart brings the upload's parts to S3: what `GET …/parts` says
// is there (with its size and a checksum) is skipped, the rest is hashed,
// presigned in one call and PUT `parallel` at a time, each attempt reading
// its section of the file afresh. `progress` gets one line per part.
func uploadMultipart(ctx context.Context, call func(ctx context.Context, method, path string, in, out any) error, cl *api.Client, g multipartGrant, local string, parallel int, progress func(string)) error {
	if g.PartSize <= 0 || g.PartCount <= 0 {
		return fmt.Errorf("multipart grant without a part size")
	}
	var have partsListing
	if err := call(ctx, http.MethodGet, "/assets/uploads/"+api.PathID(g.UploadID)+"/parts", nil, &have); err != nil {
		return err
	}
	if !have.Open {
		return errUploadGone
	}
	done := map[int]bool{}
	for _, p := range have.Parts {
		if _, length := partRange(g, p.PartNumber); p.Size == length && p.SHA256 != nil {
			done[p.PartNumber] = true
		}
	}
	var todo []map[string]any
	shaOf := map[int]string{}
	for n := 1; n <= g.PartCount; n++ {
		if done[n] {
			continue
		}
		off, length := partRange(g, n)
		sha, err := hashPart(local, off, length)
		if err != nil {
			return err
		}
		shaOf[n] = sha
		todo = append(todo, map[string]any{"partNumber": n, "sha256": sha})
	}
	if len(todo) == 0 {
		return nil
	}
	if len(done) > 0 && progress != nil {
		progress(fmt.Sprintf("resuming: %d of %d part(s) already uploaded", len(done), g.PartCount))
	}
	presign := func(parts []map[string]any) (partsResult, error) {
		var urls partsResult
		if err := call(ctx, http.MethodPost, "/assets/uploads/"+api.PathID(g.UploadID)+"/parts", map[string]any{"parts": parts}, &urls); err != nil {
			return urls, err
		}
		if len(urls.Parts) != len(parts) {
			return urls, fmt.Errorf("asked %d part URL(s), got %d", len(parts), len(urls.Parts))
		}
		return urls, nil
	}
	urls, err := presign(todo)
	if err != nil {
		return err
	}
	sort.Slice(urls.Parts, func(i, j int) bool { return urls.Parts[i].PartNumber < urls.Parts[j].PartNumber })
	// A part URL lives an hour; a slow link can outlive it. A 403 (the
	// signature lapsed) is answered by one fresh URL for that part.
	putPart := func(p partGrant) error {
		off, length := partRange(g, p.PartNumber)
		put := func(p partGrant) error {
			return defaultRetry.do(ctx, func() error {
				fh, err := os.Open(local)
				if err != nil {
					return err
				}
				defer fh.Close()
				return putPresigned(ctx, cl, uploadGrant{UploadID: g.UploadID, URL: p.URL, Method: p.Method, Headers: p.Headers}, io.NewSectionReader(fh, off, length), length)
			})
		}
		err := put(p)
		var he *httpStatusError
		if errors.As(err, &he) && he.Status == http.StatusForbidden {
			fresh, perr := presign([]map[string]any{{"partNumber": p.PartNumber, "sha256": shaOf[p.PartNumber]}})
			if perr != nil {
				return err
			}
			err = put(fresh.Parts[0])
		}
		return err
	}
	jobs := make(chan partGrant)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	var sent int
	for w := 0; w < max(1, parallel); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				err := putPart(p)
				mu.Lock()
				if err != nil {
					if firstErr == nil {
						firstErr = fmt.Errorf("part %d: %w", p.PartNumber, err)
					}
				} else {
					sent++
					if progress != nil {
						progress(fmt.Sprintf("uploaded part %d/%d", p.PartNumber, g.PartCount))
					}
				}
				mu.Unlock()
			}
		}()
	}
	for _, p := range urls.Parts {
		jobs <- p
	}
	close(jobs)
	wg.Wait()
	return firstErr
}
