// Command yyt is the CLI for the yingyeothon service console.
package main

import (
	"os"

	"github.com/yingyeothon/service/cli/internal/cmd"
)

func main() { os.Exit(cmd.Execute()) }
