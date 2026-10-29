// Package cli embeds the files the yyt binary prints verbatim.
package cli

import _ "embed"

// AgentGuide is agent-guide.md: `yyt help agents` prints it, and the release
// archive ships it beside the binary.
//
//go:embed agent-guide.md
var AgentGuide string
