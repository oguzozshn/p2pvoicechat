// Package config locates the directory where P2PVoiceChat keeps its TLS material
// and saved settings.
package config

import (
	"os"
	"path/filepath"
)

// Dir returns ~/.p2pvoicechat, creating it if needed.
func Dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".p2pvoicechat")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}
