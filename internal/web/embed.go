// Package web holds the browser UI, embedded into the binary so that the
// whole application ships as a single executable.
package web

import (
	"embed"
	"io/fs"
	"os"
)

//go:embed static
var content embed.FS

// FS returns the static assets rooted at the "static" directory, so that
// "/index.html" resolves rather than "/static/index.html".
func FS() fs.FS {
	sub, err := fs.Sub(content, "static")
	if err != nil {
		// Unreachable: the embed directive guarantees the directory exists.
		panic(err)
	}
	return sub
}

// DevFS serves the assets from disk instead of from the binary. Without it
// every UI tweak needs a rebuild, because go:embed bakes the files in at
// build time.
func DevFS(dir string) fs.FS {
	return os.DirFS(dir)
}

// DefaultDevDir is where the assets live in a source checkout.
const DefaultDevDir = "internal/web/static"
