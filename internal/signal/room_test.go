package signal

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func newTestRoom(t *testing.T) *httptest.Server {
	t.Helper()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(http.HandlerFunc(NewRoom(quiet).Handler))
	t.Cleanup(srv.Close)
	return srv
}

func dial(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func read(t *testing.T, conn *websocket.Conn) Envelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("unmarshal %q: %v", data, err)
	}
	return env
}

func write(t *testing.T, conn *websocket.Conn, env Envelope) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	data, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestFirstPeerIsPoliteAndAlone(t *testing.T) {
	srv := newTestRoom(t)
	a := dial(t, srv)

	env := read(t, a)
	if env.Type != TypeWelcome {
		t.Fatalf("got %q, want %q", env.Type, TypeWelcome)
	}
	if !env.Polite {
		t.Error("first peer should be polite, so exactly one side yields on glare")
	}
	if env.PeerPresent {
		t.Error("first peer should not see a peer present")
	}
}

func TestSecondPeerIsImpoliteAndNotifiesFirst(t *testing.T) {
	srv := newTestRoom(t)
	a := dial(t, srv)
	read(t, a) // welcome

	b := dial(t, srv)
	env := read(t, b)
	if env.Type != TypeWelcome {
		t.Fatalf("got %q, want %q", env.Type, TypeWelcome)
	}
	if env.Polite {
		t.Error("second peer should be impolite")
	}
	if !env.PeerPresent {
		t.Error("second peer should see the first one present")
	}

	if got := read(t, a); got.Type != TypePeerJoined {
		t.Errorf("first peer got %q, want %q", got.Type, TypePeerJoined)
	}
}

func TestSignalIsRelayedVerbatim(t *testing.T) {
	srv := newTestRoom(t)
	a := dial(t, srv)
	read(t, a)
	b := dial(t, srv)
	read(t, b)
	read(t, a) // peer-joined

	payload := json.RawMessage(`{"description":{"type":"offer","sdp":"v=0\r\n"}}`)
	write(t, a, Envelope{Type: TypeSignal, Data: payload})

	got := read(t, b)
	if got.Type != TypeSignal {
		t.Fatalf("got %q, want %q", got.Type, TypeSignal)
	}
	// The server must not reinterpret SDP; the bytes should survive intact.
	if string(got.Data) != string(payload) {
		t.Errorf("payload altered:\n got %s\nwant %s", got.Data, payload)
	}
}

func TestThirdPeerIsRefused(t *testing.T) {
	srv := newTestRoom(t)
	a := dial(t, srv)
	read(t, a)
	b := dial(t, srv)
	read(t, b)
	read(t, a)

	c := dial(t, srv)
	if got := read(t, c); got.Type != TypeRoomFull {
		t.Fatalf("third peer got %q, want %q", got.Type, TypeRoomFull)
	}
}

func TestRemainingPeerLearnsAboutDeparture(t *testing.T) {
	srv := newTestRoom(t)
	a := dial(t, srv)
	read(t, a)
	b := dial(t, srv)
	read(t, b)
	read(t, a)

	b.Close(websocket.StatusNormalClosure, "bye")

	if got := read(t, a); got.Type != TypePeerLeft {
		t.Fatalf("got %q, want %q", got.Type, TypePeerLeft)
	}
}

func TestSlotIsFreedAfterDeparture(t *testing.T) {
	srv := newTestRoom(t)
	a := dial(t, srv)
	read(t, a)
	b := dial(t, srv)
	read(t, b)
	read(t, a)

	b.Close(websocket.StatusNormalClosure, "bye")
	read(t, a) // peer-left

	// A reconnecting peer must be able to take the freed slot, which is what
	// makes the phase 4 reconnect loop possible.
	c := dial(t, srv)
	if got := read(t, c); got.Type != TypeWelcome {
		t.Fatalf("replacement peer got %q, want %q", got.Type, TypeWelcome)
	}
}

func TestNonSignalMessagesAreIgnored(t *testing.T) {
	srv := newTestRoom(t)
	a := dial(t, srv)
	read(t, a)
	b := dial(t, srv)
	read(t, b)
	read(t, a)

	// A client must not be able to forge control messages at its peer.
	write(t, a, Envelope{Type: TypePeerLeft})
	write(t, a, Envelope{Type: TypeSignal, Data: json.RawMessage(`{"candidate":null}`)})

	got := read(t, b)
	if got.Type != TypeSignal {
		t.Fatalf("got %q, want the forged message to have been dropped", got.Type)
	}
}
