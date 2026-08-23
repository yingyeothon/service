// Package output renders command results either as JSON (`--json`) or as a
// plain-text table. Secrets are printed only by the commands that mint them.
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"
)

type Printer struct {
	W    io.Writer
	JSON bool
}

// JSONValue pretty-prints any value.
func (p Printer) JSONValue(v any) error {
	enc := json.NewEncoder(p.W)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// Table prints a header + rows with aligned columns.
func (p Printer) Table(header []string, rows [][]string) error {
	tw := tabwriter.NewWriter(p.W, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(header, "\t"))
	for _, r := range rows {
		fmt.Fprintln(tw, strings.Join(r, "\t"))
	}
	return tw.Flush()
}

// KV prints `key: value` lines for a single record.
func (p Printer) KV(pairs [][2]string) error {
	tw := tabwriter.NewWriter(p.W, 0, 0, 1, ' ', 0)
	for _, kv := range pairs {
		fmt.Fprintf(tw, "%s:\t%s\n", kv[0], kv[1])
	}
	return tw.Flush()
}

// Time formats unix seconds as UTC RFC3339; 0/nil → "-".
func Time(sec int64) string {
	if sec == 0 {
		return "-"
	}
	return time.Unix(sec, 0).UTC().Format(time.RFC3339)
}

func TimePtr(sec *int64) string {
	if sec == nil {
		return "-"
	}
	return Time(*sec)
}

func Str(s *string) string {
	if s == nil || *s == "" {
		return "-"
	}
	return *s
}
