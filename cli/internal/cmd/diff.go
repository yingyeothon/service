package cmd

import (
	"fmt"
	"strings"
)

// diffOp is one line of a line diff: " " (same), "-" (only in a), "+" (only in b).
type diffOp struct {
	Op   string `json:"op"`
	Line string `json:"line"`
}

// diffLines is a plain LCS line diff — small inputs (an event page), no
// dependency. Trailing newlines do not create a phantom empty line.
func diffLines(a, b string) []diffOp {
	al := splitLines(a)
	bl := splitLines(b)
	n, m := len(al), len(bl)
	// lcs[i][j] = length of the LCS of al[i:] and bl[j:].
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if al[i] == bl[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	var out []diffOp
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case al[i] == bl[j]:
			out = append(out, diffOp{" ", al[i]})
			i++
			j++
		case lcs[i+1][j] >= lcs[i][j+1]:
			out = append(out, diffOp{"-", al[i]})
			i++
		default:
			out = append(out, diffOp{"+", bl[j]})
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, diffOp{"-", al[i]})
	}
	for ; j < m; j++ {
		out = append(out, diffOp{"+", bl[j]})
	}
	return out
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// unifiedDiff renders the whole diff as one hunk (pages are short; context
// trimming would hide the fields that did not change, which is the point).
func unifiedDiff(nameA, nameB, a, b string) string {
	ops := diffLines(a, b)
	var sb strings.Builder
	fmt.Fprintf(&sb, "--- %s\n+++ %s\n", nameA, nameB)
	changed := false
	for _, o := range ops {
		if o.Op != " " {
			changed = true
			break
		}
	}
	if !changed {
		sb.WriteString("(no changes)\n")
		return sb.String()
	}
	na, nb := 0, 0
	for _, o := range ops {
		if o.Op != "+" {
			na++
		}
		if o.Op != "-" {
			nb++
		}
	}
	fmt.Fprintf(&sb, "@@ -1,%d +1,%d @@\n", na, nb)
	for _, o := range ops {
		sb.WriteString(o.Op)
		sb.WriteString(o.Line)
		sb.WriteString("\n")
	}
	return sb.String()
}
