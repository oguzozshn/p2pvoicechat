// Package server serves the P2PVoiceChat web UI and hosts the signaling endpoint
// that the two browsers use to negotiate their direct WebRTC connection.
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"time"

	"p2pvoicechat/internal/signal"
	"p2pvoicechat/internal/web"
)

// Config holds the knobs main passes in.
type Config struct {
	Addr string
	Log  *slog.Logger
	// Cert is the TLS certificate to serve with. Required unless Insecure
	// is set: browsers only expose microphone and screen capture in a
	// secure context.
	Cert tls.Certificate
	// Insecure serves plain HTTP. Only useful for testing both tabs on this
	// machine, where localhost counts as a secure context on its own.
	Insecure bool
	// DevDir, when set, serves the UI from this directory rather than from
	// the copy embedded in the binary, so edits show up on reload.
	DevDir string
}

// Run serves until ctx is cancelled, then shuts down gracefully.
func Run(ctx context.Context, cfg Config) error {
	room := signal.NewRoom(cfg.Log)

	assets := web.FS()
	if cfg.DevDir != "" {
		cfg.Log.Info("serving UI from disk", "dir", cfg.DevDir)
		assets = web.DevFS(cfg.DevDir)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", room.Handler)
	mux.Handle("/", noCache(http.FileServerFS(assets)))

	srv := &http.Server{
		Addr:    cfg.Addr,
		Handler: mux,
		// Deliberately no WriteTimeout: /ws is a long-lived WebSocket and
		// would be cut off by one.
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          slog.NewLogLogger(cfg.Log.Handler(), slog.LevelDebug),
	}
	if !cfg.Insecure {
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cfg.Cert}}
	}

	errc := make(chan error, 1)
	go func() {
		var err error
		if cfg.Insecure {
			err = srv.ListenAndServe()
		} else {
			// Certificate and key come from TLSConfig, so both empty here.
			err = srv.ListenAndServeTLS("", "")
		}
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		errc <- err
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		cfg.Log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}

// noCache stops the browser from holding on to a stale UI, which otherwise
// makes every edit look like it did nothing.
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

// tailscaleCGNAT is the 100.64.0.0/10 range Tailscale assigns to nodes.
var tailscaleCGNAT = netip.MustParsePrefix("100.64.0.0/10")

// TailscaleAddrs reports this machine's Tailscale IPv4 addresses. They are
// used both to print a shareable URL and to put the right names in the
// self-signed certificate. An empty result means Tailscale is not up, which
// is worth saying before the user debugs anything else.
func TailscaleAddrs() []netip.Addr {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var found []netip.Addr
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			prefix, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			addr, ok := netip.AddrFromSlice(prefix.IP)
			if !ok {
				continue
			}
			addr = addr.Unmap()
			if addr.Is4() && tailscaleCGNAT.Contains(addr) {
				found = append(found, addr)
			}
		}
	}
	return found
}
