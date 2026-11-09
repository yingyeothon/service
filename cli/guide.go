// Package cli embeds the files the yyt binary prints verbatim.
package cli

import "embed"

// AgentGuide is agent-guide.md: `yyt help agents` prints it, and the release
// archive ships it beside the binary.
//
//go:embed agent-guide.md
var AgentGuide string

// Skills holds the agent skills `yyt skill` lists, prints and installs, one
// directory per skill with its SKILL.md (frontmatter `name`, `description`).
//
//go:embed skills
var Skills embed.FS
