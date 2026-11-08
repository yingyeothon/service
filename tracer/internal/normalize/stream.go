package normalize

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// ArrayItems streams a JSON array — or the array under wrapKey of an object
// ({"values":[…]}, {"items":[…]}) — keeping at most max elements (the first
// max, or the last max when keepLast). It never holds more than max decoded
// elements, so a megabyte of tiny elements cannot amplify into a large
// slice. total counts every element seen.
func ArrayItems(raw []byte, wrapKey string, max int, keepLast bool) (kept []json.RawMessage, total int, err error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, 0, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, 0, err
	}
	switch tok {
	case json.Delim('['):
	case json.Delim('{'):
		if wrapKey == "" {
			return nil, 0, errors.New("normalize: object where an array was expected")
		}
		found := false
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, 0, err
			}
			if k, _ := kt.(string); k == wrapKey && !found {
				t, err := dec.Token()
				if err != nil {
					return nil, 0, err
				}
				if t != json.Delim('[') {
					return nil, 0, errors.New("normalize: wrapped value is not an array")
				}
				found = true
				break
			}
			if err := skipValue(dec); err != nil {
				return nil, 0, err
			}
		}
		if !found {
			return nil, 0, nil
		}
	default:
		return nil, 0, errors.New("normalize: not an array")
	}
	ring := make([]json.RawMessage, 0, min(max, 64))
	start := 0
	for dec.More() {
		var m json.RawMessage
		if err := dec.Decode(&m); err != nil {
			return nil, total, err
		}
		total++
		switch {
		case len(ring) < max:
			ring = append(ring, m)
		case keepLast && max > 0:
			ring[start] = m
			start = (start + 1) % max
		}
	}
	if start == 0 {
		return ring, total, nil
	}
	return append(append([]json.RawMessage{}, ring[start:]...), ring[:start]...), total, nil
}

// ObjectPairs streams a JSON object keeping its first max members.
func ObjectPairs(raw []byte, max int) ([][2]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimSpace(raw)))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, errors.New("normalize: not an object")
	}
	var out [][2]json.RawMessage
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return out, err
		}
		k, _ := kt.(string)
		if len(out) >= max {
			if err := skipValue(dec); err != nil {
				return out, err
			}
			continue
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return out, err
		}
		kb, _ := json.Marshal(k)
		out = append(out, [2]json.RawMessage{kb, v})
	}
	return out, nil
}

// skipValue consumes one value token by token (no allocation of the value).
func skipValue(dec *json.Decoder) error {
	depth := 0
	for {
		t, err := dec.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return io.ErrUnexpectedEOF
			}
			return err
		}
		switch t {
		case json.Delim('['), json.Delim('{'):
			depth++
		case json.Delim(']'), json.Delim('}'):
			depth--
		}
		if depth == 0 {
			return nil
		}
	}
}
