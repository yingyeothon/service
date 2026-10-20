// Package api is a thin JSON client for the console API. Responses are decoded
// into caller-provided values; error envelopes `{error:{code,message,details}}`
// become *Error.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/yingyeothon/service/cli/internal/textsafe"
)

// Version is set by cli/scripts/build-release.sh via -ldflags; `go install`
// builds fall back to the module version from the build info.
var Version = "dev"

func init() {
	if Version != "dev" {
		return
	}
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		Version = bi.Main.Version
	}
}

type Error struct {
	Status  int
	Code    string
	Message string
	Details json.RawMessage
	// RetryAfter is the response's Retry-After header, when it named seconds.
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("HTTP %d", e.Status)
	}
	s := fmt.Sprintf("%s: %s", e.Code, e.Message)
	if len(e.Details) > 0 && string(e.Details) != "null" {
		s += " " + sanitize(e.Details)
	}
	return s
}

type Client struct {
	Base  string
	Token string
	HTTP  *http.Client
	// DataPlane marks a client of a data-plane host (state, match tickets):
	// its errors must not suggest checking the console URL.
	DataPlane bool
}

func New(base, token string) *Client {
	return &Client{Base: strings.TrimRight(base, "/"), Token: token, HTTP: &http.Client{
		Timeout: 30 * time.Second,
		// No API route redirects, and net/http would carry the bearer along a
		// same-host redirect, an https → http downgrade included.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// Do sends `in` as JSON (nil = no body) and decodes the JSON response into
// `out` (nil = discard). 204 yields no decoding.
func (c *Client) Do(ctx context.Context, method, path string, in, out any) error {
	_, err := c.DoStatus(ctx, method, path, in, out)
	return err
}

// DoStatus is Do that also returns the success status, for the routes whose
// 2xx answers differ in meaning (202 "not done yet" vs 204 "done").
func (c *Client) DoStatus(ctx context.Context, method, path string, in, out any) (int, error) {
	status, raw, err := c.send(ctx, method, path, in, "application/json")
	if err != nil {
		return 0, err
	}
	if out == nil || status == http.StatusNoContent || len(raw) == 0 {
		return status, nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return status, fmt.Errorf("decode %s %s: %w (is --api the console base URL?)", method, path, err)
	}
	return status, nil
}

// DoRaw is Do for a route whose success body is a file rather than JSON (a
// `GoogleService-Info.plist`): it returns the body as it came. Errors are
// still the JSON envelope, decoded into *Error as Do does.
func (c *Client) DoRaw(ctx context.Context, method, path string, in any, accept string) ([]byte, error) {
	_, raw, err := c.send(ctx, method, path, in, accept+", application/json")
	return raw, err
}

func (c *Client) send(ctx context.Context, method, path string, in any, accept string) (int, []byte, error) {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "yyt-cli/"+Version)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return 0, nil, err
	}
	if res.StatusCode >= 400 {
		e := &Error{Status: res.StatusCode}
		if sec, err := strconv.Atoi(strings.TrimSpace(res.Header.Get("Retry-After"))); err == nil && sec >= 0 {
			e.RetryAfter = time.Duration(sec) * time.Second
		}
		var env struct {
			Error struct {
				Code    string          `json:"code"`
				Message string          `json:"message"`
				Details json.RawMessage `json:"details"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &env) == nil && env.Error.Code != "" {
			e.Code, e.Message, e.Details = env.Error.Code, env.Error.Message, env.Error.Details
		} else {
			e.Message = sanitize(raw)
			if e.Message == "" {
				e.Message = http.StatusText(res.StatusCode)
			}
			e.Code = "http_" + fmt.Sprint(res.StatusCode)
			if !c.DataPlane {
				e.Message += " (is --api the console base URL?)"
			}
		}
		return 0, nil, e
	}
	return res.StatusCode, raw, nil
}

// sanitize caps an opaque error body and strips control characters so a
// hostile host cannot inject terminal escapes.
func sanitize(raw []byte) string {
	s := strings.TrimSpace(string(raw))
	if len(s) > 512 {
		s = s[:512] + "…"
	}
	return textsafe.Clean(s)
}

// PathID escapes a user-supplied id for use in a URL path segment.
func PathID(id string) string { return url.PathEscape(id) }
