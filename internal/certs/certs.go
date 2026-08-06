// Package certs supplies the TLS material P2PVoiceChat serves with.
//
// TLS is not optional here. Browsers expose getUserMedia and getDisplayMedia
// only in a secure context, so a plain http:// page served over the tailnet
// leaves the other machine unable to open its microphone at all. A
// self-signed certificate is enough: the browser shows a warning once, and
// after the user proceeds the origin counts as secure.
//
// For a warning-free setup, enable HTTPS in the Tailscale admin console and
// pass the resulting certificate with -tls-cert/-tls-key instead.
package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// validity stays under the 398-day ceiling browsers apply to long-lived
// certificates, so the warning the user clicks through stays the ordinary
// "unknown authority" one.
const validity = 397 * 24 * time.Hour

// renewBefore regenerates a certificate that is close enough to expiry that
// it would lapse mid-use.
const renewBefore = 30 * 24 * time.Hour

// LoadOrCreate returns a self-signed certificate covering hosts, reusing the
// one cached in dir when it is still valid and still covers every host.
func LoadOrCreate(dir string, hosts []string) (tls.Certificate, error) {
	certPath := filepath.Join(dir, "self_signed.crt")
	keyPath := filepath.Join(dir, "self_signed.key")

	if cert, ok := loadUsable(certPath, keyPath, hosts); ok {
		return cert, nil
	}

	certPEM, keyPEM, err := generate(hosts)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certPEM, keyPEM)
}

// loadUsable reports whether the cached pair exists, parses, is not near
// expiry, and covers every requested host.
func loadUsable(certPath, keyPath string, hosts []string) (tls.Certificate, bool) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return tls.Certificate{}, false
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return tls.Certificate{}, false
	}
	if time.Now().Add(renewBefore).After(leaf.NotAfter) {
		return tls.Certificate{}, false
	}
	for _, h := range hosts {
		if !covers(leaf, h) {
			return tls.Certificate{}, false
		}
	}
	cert.Leaf = leaf
	return cert, true
}

func covers(leaf *x509.Certificate, host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return slices.ContainsFunc(leaf.IPAddresses, ip.Equal)
	}
	return slices.Contains(leaf.DNSNames, host)
}

func generate(hosts []string) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}

	serialMax := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialMax)
	if err != nil {
		return nil, nil, err
	}

	now := time.Now()
	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "P2PVoiceChat"},
		// Backdated an hour so a small clock skew between the two machines
		// does not make the certificate look not-yet-valid.
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(validity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal key: %w", err)
	}

	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}
