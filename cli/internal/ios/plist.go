// Package ios holds what `yyt catalog deploy --platform ios` needs around
// `flutter build ipa`: the signing preflight (keychain, identity, codesign
// probe, provisioning profiles), ExportOptions.plist, and reading the built
// IPA back. Every external tool goes through a Runner so the logic is tested
// on any OS; the tools themselves exist on macOS only.
package ios

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// parsePlist reads an XML property list into Go values: dict →
// map[string]any, array → []any, string, bool, int64, float64, time.Time
// (date) and []byte (data). It exists so no plist dependency is needed;
// binary plists are converted to XML by `plutil` first.
func parsePlist(data []byte) (any, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	// Property lists carry a DOCTYPE; no entity beyond the XML five is needed.
	dec.Strict = true
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("not a property list: %w", err)
		}
		if start, ok := tok.(xml.StartElement); ok {
			if start.Name.Local != "plist" {
				return nil, fmt.Errorf("not a property list: root element <%s>", start.Name.Local)
			}
			break
		}
	}
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("empty property list: %w", err)
		}
		if start, ok := tok.(xml.StartElement); ok {
			return plistValue(dec, start, 0)
		}
	}
}

// maxPlistDepth bounds nesting in a file that came out of an archive.
const maxPlistDepth = 64

func plistValue(dec *xml.Decoder, start xml.StartElement, depth int) (any, error) {
	if depth > maxPlistDepth {
		return nil, errors.New("property list nests too deeply")
	}
	switch start.Name.Local {
	case "dict":
		out := map[string]any{}
		key, haveKey := "", false
		for {
			tok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.EndElement:
				return out, nil
			case xml.StartElement:
				if t.Name.Local == "key" {
					if key, err = plistText(dec); err != nil {
						return nil, err
					}
					haveKey = true
					continue
				}
				if !haveKey {
					return nil, errors.New("property list dict has a value without a key")
				}
				v, err := plistValue(dec, t, depth+1)
				if err != nil {
					return nil, err
				}
				out[key], haveKey = v, false
			}
		}
	case "array":
		out := []any{}
		for {
			tok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.EndElement:
				return out, nil
			case xml.StartElement:
				v, err := plistValue(dec, t, depth+1)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			}
		}
	case "true", "false":
		if err := dec.Skip(); err != nil {
			return nil, err
		}
		return start.Name.Local == "true", nil
	}
	text, err := plistText(dec)
	if err != nil {
		return nil, err
	}
	switch start.Name.Local {
	case "string":
		return text, nil
	case "integer":
		n, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("property list integer: %w", err)
		}
		return n, nil
	case "real":
		f, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return nil, fmt.Errorf("property list real: %w", err)
		}
		return f, nil
	case "date":
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(text))
		if err != nil {
			return nil, fmt.Errorf("property list date: %w", err)
		}
		return t, nil
	case "data":
		clean := strings.Map(func(r rune) rune {
			if r == ' ' || r == '\n' || r == '\t' || r == '\r' {
				return -1
			}
			return r
		}, text)
		b, err := base64.StdEncoding.DecodeString(clean)
		if err != nil {
			return nil, fmt.Errorf("property list data: %w", err)
		}
		return b, nil
	}
	return nil, fmt.Errorf("property list has an unknown element <%s>", start.Name.Local)
}

// plistText reads character data up to the end of the current element.
func plistText(dec *xml.Decoder) (string, error) {
	var b strings.Builder
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return "", io.ErrUnexpectedEOF
		}
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.CharData:
			b.Write(t)
		case xml.EndElement:
			return b.String(), nil
		case xml.StartElement:
			return "", fmt.Errorf("property list has <%s> inside a scalar", t.Name.Local)
		}
	}
}

// dictOf, strOf and boolOf read typed fields; a missing or mistyped field is
// the zero value, which every caller treats as "not what was expected".
func dictOf(v any, key string) map[string]any {
	d, _ := v.(map[string]any)
	out, _ := d[key].(map[string]any)
	return out
}

func strOf(v any, key string) string {
	d, _ := v.(map[string]any)
	s, _ := d[key].(string)
	return s
}

func boolOf(v any, key string) (val, present bool) {
	d, _ := v.(map[string]any)
	val, present = d[key].(bool)
	return val, present
}

// escapeXML escapes text for a plist <string> or <key>.
func escapeXML(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
