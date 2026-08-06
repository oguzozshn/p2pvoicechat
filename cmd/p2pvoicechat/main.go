// Command p2pvoicechat hosts a two-person voice and screen-sharing room reachable
// over a Tailscale network. It serves the web UI and relays WebRTC signaling;
// the audio and video themselves flow directly between the two browsers.
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"p2pvoicechat/internal/certs"
	"p2pvoicechat/internal/config"
	"p2pvoicechat/internal/server"
	"p2pvoicechat/internal/web"
)

func main() {
	addr := flag.String("addr", ":8443", "address to listen on")
	certFile := flag.String("tls-cert", "", "TLS certificate file (default: a self-signed one is generated)")
	keyFile := flag.String("tls-key", "", "TLS key file, required with -tls-cert")
	extraHosts := flag.String("host", "", "extra comma-separated names to put in the self-signed certificate")
	insecure := flag.Bool("insecure", false, "serve plain HTTP; only usable via localhost, for testing two tabs on one machine")
	dev := flag.Bool("dev", false, "serve the UI from "+web.DefaultDevDir+" instead of the embedded copy")
	devDir := flag.String("dev-dir", web.DefaultDevDir, "directory to serve the UI from with -dev")
	verbose := flag.Bool("v", false, "log debug detail")
	logFile := flag.String("log", "", `also append logs to a file (default ~/.p2pvoicechat/server.log; "-" disables)`)
	flag.Parse()

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	logOut, closeLog := logWriter(*logFile)
	defer closeLog()
	log := slog.New(slog.NewTextHandler(logOut, &slog.HandlerOptions{Level: level}))

	var cert tls.Certificate
	if !*insecure {
		var err error
		cert, err = loadCert(*certFile, *keyFile, *extraHosts)
		fatalIf(err)
	}

	printJoinURLs(log, *addr, *certFile != "", *insecure)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	serveDir := ""
	if *dev {
		serveDir = *devDir
	}
	err := server.Run(ctx, server.Config{
		Addr:     *addr,
		Log:      log,
		Cert:     cert,
		Insecure: *insecure,
		DevDir:   serveDir,
	})
	fatalIf(err)
}

// logWriter sends logs to the terminal and, unless disabled, appends them to
// a file as well. When something goes wrong hours into a call, the terminal
// has usually been closed; the file is the only record left.
func logWriter(path string) (io.Writer, func()) {
	if path == "-" {
		return os.Stderr, func() {}
	}
	if path == "" {
		dir, err := config.Dir()
		if err != nil {
			fmt.Fprintln(os.Stderr, "warning: no log file:", err)
			return os.Stderr, func() {}
		}
		path = filepath.Join(dir, "server.log")
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		// Losing the log file is not worth refusing to start over.
		fmt.Fprintln(os.Stderr, "warning: could not open log file:", err)
		return os.Stderr, func() {}
	}
	return io.MultiWriter(os.Stderr, f), func() { f.Close() }
}

// loadCert prefers an explicitly supplied certificate — the warning-free path
// is `tailscale cert` once HTTPS is enabled for the tailnet — and otherwise
// falls back to a cached self-signed one.
func loadCert(certFile, keyFile, extraHosts string) (tls.Certificate, error) {
	if certFile != "" || keyFile != "" {
		if certFile == "" || keyFile == "" {
			return tls.Certificate{}, fmt.Errorf("-tls-cert and -tls-key must be given together")
		}
		return tls.LoadX509KeyPair(certFile, keyFile)
	}

	dir, err := config.Dir()
	if err != nil {
		return tls.Certificate{}, err
	}
	return certs.LoadOrCreate(dir, certHosts(extraHosts))
}

// certHosts collects every name the other machine might type in the address
// bar. A name missing here produces a second, more alarming browser warning.
func certHosts(extra string) []string {
	hosts := []string{"localhost", "127.0.0.1", "::1"}
	for _, a := range server.TailscaleAddrs() {
		hosts = append(hosts, a.String())
	}
	if name, err := os.Hostname(); err == nil && name != "" {
		hosts = append(hosts, name)
	}
	for _, h := range strings.Split(extra, ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

// printJoinURLs shows the addresses the other person should open. Opening the
// wrong one is the most common first-run failure, so it is worth being loud.
func printJoinURLs(log *slog.Logger, addr string, realCert, insecure bool) {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		port = strings.TrimPrefix(addr, ":")
	}

	scheme := "https"
	if insecure {
		scheme = "http"
		fmt.Fprintf(os.Stderr, "insecure mode: only http://localhost:%s works.\n", port)
		fmt.Fprintln(os.Stderr, "the other machine needs TLS, so drop -insecure for real use.")
		return
	}

	ts := server.TailscaleAddrs()
	if len(ts) == 0 {
		log.Warn("no Tailscale address found; is Tailscale running?")
		fmt.Fprintf(os.Stderr, "  local only: %s://localhost:%s\n", scheme, port)
		return
	}
	fmt.Fprintln(os.Stderr, "share this address with the other person:")
	for _, a := range ts {
		fmt.Fprintf(os.Stderr, "  %s://%s:%s\n", scheme, a, port)
	}
	fmt.Fprintf(os.Stderr, "  (this machine: %s://localhost:%s)\n", scheme, port)
	if !realCert {
		fmt.Fprintln(os.Stderr, "\nusing a self-signed certificate: both browsers will warn once.")
		fmt.Fprintln(os.Stderr, "click \"Advanced\" then \"Proceed\" — the microphone needs a secure context.")
	}
}

func fatalIf(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
