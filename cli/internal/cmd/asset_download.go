package cmd

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
)

// byteRange is `a-b` or `a-` (inclusive, as in an HTTP Range header).
var byteRange = regexp.MustCompile(`^(\d+)-(\d*)$`)

// assetBody is the seam where a bundle's content is turned into what the
// caller asked for. Today every bundle is plaintext, so the body passes
// through; an encrypted bundle (todo/46 P4) decrypts here, segment by
// segment, and maps a --range onto whole segments before the request.
func assetBody(_ assetBundle, body io.Reader) io.Reader { return body }

func newAssetDownload(a *App, bundleID bundleResolver) *cobra.Command {
	var version, out, rng string
	c := &cobra.Command{
		Use:   "download <bundle> <path>",
		Short: "Download one file of a bundle from the CDN",
		Long: "Download one file of a bundle from the public CDN: the file of --version\n" +
			"in a versioned bundle, or the file at <path> in a live one. -o names the\n" +
			"output (default: the file's base name here; - is stdout), and --range\n" +
			"a-b fetches bytes a..b only (inclusive, `a-` to the end).",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if rng != "" && !byteRange.MatchString(rng) {
				return fmt.Errorf("--range is a-b or a- (byte offsets), not %q", rng)
			}
			if m := byteRange.FindStringSubmatch(rng); m != nil && m[2] != "" {
				from, _ := strconv.ParseInt(m[1], 10, 64)
				to, _ := strconv.ParseInt(m[2], 10, 64)
				if to < from {
					return fmt.Errorf("--range %q ends before it starts", rng)
				}
			}
			cc, id, err := bundleID(cmd, args[0], false)
			if err != nil {
				return err
			}
			var b assetBundle
			if err := cc.cl.Do(ctx, http.MethodGet, "/assets/bundles/"+api.PathID(id), nil, &b); err != nil {
				return err
			}
			q := url.Values{"path": {args[1]}}
			if version != "" {
				q.Set("version", version)
			}
			var res struct {
				Files []assetFile `json:"files"`
			}
			if err := cc.cl.Do(ctx, http.MethodGet, "/assets/bundles/"+api.PathID(id)+"/files?"+q.Encode(), nil, &res); err != nil {
				return liveHint(err, args[0])
			}
			if len(res.Files) == 0 {
				return &api.Error{Status: 404, Code: "not_found", Message: fmt.Sprintf("%q is not in %s", args[1], args[0])}
			}
			f := res.Files[0]
			dst := out
			if dst == "" {
				dst = path.Base(f.Path)
			}
			return defaultRetry.do(ctx, func() error {
				return fetchTo(ctx, cc.cl.HTTP, f.URL, rng, dst, func(body io.Reader) io.Reader { return assetBody(b, body) }, a)
			})
		},
	}
	fl := c.Flags()
	fl.StringVar(&version, "version", "", "the version holding the file (versioned bundles)")
	fl.StringVarP(&out, "output", "o", "", "where to write (default: the file's base name; - is stdout)")
	fl.StringVar(&rng, "range", "", "bytes a-b only (inclusive; a- to the end)")
	return c
}

// fetchTo GETs `src` (a public CDN URL: no credentials go with it) and
// writes the body to `dst` through a temp file and a rename, so an
// interrupted download never leaves a half file under the final name.
func fetchTo(ctx context.Context, hc *http.Client, src, rng, dst string, decode func(io.Reader) io.Reader, a *App) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return err
	}
	if rng != "" {
		req.Header.Set("Range", "bytes="+rng)
	}
	var transport http.RoundTripper
	if hc != nil {
		transport = hc.Transport
	}
	// No client timeout: a large file outlives the API client's 30 s.
	res, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	want := http.StatusOK
	if rng != "" {
		want = http.StatusPartialContent
	}
	if res.StatusCode != want {
		var after time.Duration
		if sec, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil {
			after = time.Duration(sec) * time.Second
		}
		return &httpStatusError{Op: "download", Status: res.StatusCode, RetryAfter: after}
	}
	body := decode(res.Body)
	if dst == "-" {
		// Bytes already on stdout cannot be taken back, so a failure here is
		// final (%v drops the type the retry policy would act on).
		if _, err := io.Copy(a.Out, body); err != nil {
			return fmt.Errorf("download interrupted: %v", err)
		}
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".*.part")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	n, err := io.Copy(tmp, body)
	if err == nil && res.ContentLength >= 0 && n != res.ContentLength {
		err = io.ErrUnexpectedEOF
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return err
	}
	fmt.Fprintf(a.Err, "wrote %s (%d bytes)\n", dst, n)
	return nil
}
