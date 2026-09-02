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
}

func New(base, token string) *Client {
	return &Client{Base: strings.TrimRight(base, "/"), Token: token, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// Do sends `in` as JSON (nil = no body) and decodes the JSON response into
// `out` (nil = discard). 204 yields no decoding.
func (c *Client) Do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "yyt-cli/"+Version)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 400 {
		e := &Error{Status: res.StatusCode}
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
			e.Message += " (is --api the console base URL?)"
		}
		return e
	}
	if out == nil || res.StatusCode == http.StatusNoContent || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode %s %s: %w (is --api the console base URL?)", method, path, err)
	}
	return nil
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
