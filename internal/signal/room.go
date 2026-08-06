// Package signal relays WebRTC negotiation messages between the two browsers
// in the room.
//
// The server never inspects SDP or ICE payloads — it only tracks who is
// present so each side knows when to start negotiating, and forwards
// everything else verbatim. Audio and video never pass through here; they go
// directly between the two browsers over the tailnet.
package signal

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Capacity is the number of people the room holds. P2PVoiceChat is deliberately
// built for exactly two.
const Capacity = 2

// maxMessageSize bounds a single signaling message. SDP for audio plus a
// screen share stays well under this; anything larger is a bug or abuse.
const maxMessageSize = 256 * 1024

// sendQueue is how many outbound messages may back up for one peer before it
// is considered stuck and disconnected. ICE candidates arrive in bursts, so
// this needs headroom.
const sendQueue = 64

// Envelope is the message shape on the wire, in both directions.
type Envelope struct {
	Type string `json:"type"`
	// Data carries the WebRTC payload for Type=="signal". It is relayed
	// without being parsed.
	Data json.RawMessage `json:"data,omitempty"`
	// Polite tells the client which side of perfect negotiation it is on.
	Polite bool `json:"polite,omitempty"`
	// PeerPresent tells a joining client whether it should start
	// negotiating right away or wait for peer-joined.
	PeerPresent bool `json:"peerPresent,omitempty"`
	// Reason explains a refusal.
	Reason string `json:"reason,omitempty"`
}

// Message types sent by the server.
const (
	TypeWelcome    = "welcome"
	TypePeerJoined = "peer-joined"
	TypePeerLeft   = "peer-left"
	TypeRoomFull   = "room-full"
	TypeSignal     = "signal"
)

type peer struct {
	id     int64
	polite bool
	out    chan []byte
	// closeOnce guards out against a double close when the reader and the
	// room both notice the peer is gone.
	closeOnce sync.Once
}

func (p *peer) close() {
	p.closeOnce.Do(func() { close(p.out) })
}

// Room holds up to Capacity peers and relays between them.
type Room struct {
	log    *slog.Logger
	nextID atomic.Int64

	mu    sync.Mutex
	peers []*peer
}

func NewRoom(log *slog.Logger) *Room {
	return &Room{log: log}
}

// Handler upgrades the request and serves one peer until it disconnects.
func (r *Room) Handler(w http.ResponseWriter, req *http.Request) {
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		// Same-origin only; the page and the socket are served by this
		// process, so there is no reason to accept anything else.
		OriginPatterns: nil,
	})
	if err != nil {
		r.log.Debug("websocket accept failed", "err", err)
		return
	}
	conn.SetReadLimit(maxMessageSize)

	p, other, ok := r.add()
	if !ok {
		// Tell the third arrival why, rather than closing silently.
		writeJSON(req.Context(), conn, Envelope{Type: TypeRoomFull, Reason: "oda dolu"})
		conn.Close(websocket.StatusPolicyViolation, "room full")
		return
	}
	r.log.Info("peer joined", "id", p.id, "polite", p.polite, "peerPresent", other != nil)

	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()

	// One writer goroutine per peer: a slow or wedged socket must not block
	// the other side's read loop.
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.writeLoop(ctx, conn, p)
	}()

	// A peer whose machine slept or lost the network leaves a socket that
	// looks open but never speaks again. Without probing, the room stays
	// full and the returning peer is refused its own slot.
	go keepAlive(ctx, conn, r.log, p.id)

	p.enqueue(mustJSON(Envelope{
		Type:        TypeWelcome,
		Polite:      p.polite,
		PeerPresent: other != nil,
	}))
	if other != nil {
		other.enqueue(mustJSON(Envelope{Type: TypePeerJoined}))
	}

	r.readLoop(ctx, conn, p)

	r.remove(p)
	p.close()
	cancel()
	<-done
	conn.CloseNow()
	r.log.Info("peer left", "id", p.id)
}

// pingInterval is how often a silent socket is probed. Signaling goes quiet
// once a call is established, so without probing a dead peer could hold its
// slot indefinitely.
const pingInterval = 15 * time.Second

// pingTimeout bounds how long a probe may go unanswered before the peer is
// treated as gone.
const pingTimeout = 10 * time.Second

func keepAlive(ctx context.Context, conn *websocket.Conn, log *slog.Logger, id int64) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				log.Info("peer stopped responding", "id", id, "err", err)
				// Closing unblocks the read loop, which performs the actual
				// removal from the room.
				conn.CloseNow()
				return
			}
		}
	}
}

func (r *Room) readLoop(ctx context.Context, conn *websocket.Conn, p *peer) {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) && websocket.CloseStatus(err) == -1 {
				r.log.Debug("read ended", "id", p.id, "err", err)
			}
			return
		}
		var env Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			r.log.Debug("dropping malformed message", "id", p.id, "err", err)
			continue
		}
		if env.Type != TypeSignal {
			r.log.Debug("dropping unexpected message type", "id", p.id, "type", env.Type)
			continue
		}
		if other := r.other(p); other != nil {
			other.enqueue(data)
		}
	}
}

func (r *Room) writeLoop(ctx context.Context, conn *websocket.Conn, p *peer) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-p.out:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(writeCtx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				r.log.Debug("write ended", "id", p.id, "err", err)
				return
			}
		}
	}
}

// enqueue drops the message rather than blocking if the peer is not keeping
// up. Losing an ICE candidate is recoverable; stalling the relay is not.
func (p *peer) enqueue(msg []byte) {
	select {
	case p.out <- msg:
	default:
	}
}

func (r *Room) add() (self, other *peer, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.peers) >= Capacity {
		return nil, nil, false
	}
	p := &peer{
		id: r.nextID.Add(1),
		// The first peer in the room is the polite one, so exactly one side
		// yields when both offer at the same time.
		polite: len(r.peers) == 0,
		out:    make(chan []byte, sendQueue),
	}
	if len(r.peers) == 1 {
		other = r.peers[0]
	}
	r.peers = append(r.peers, p)
	return p, other, true
}

func (r *Room) remove(p *peer) {
	r.mu.Lock()
	var remaining *peer
	for i, existing := range r.peers {
		if existing == p {
			r.peers = append(r.peers[:i], r.peers[i+1:]...)
			break
		}
	}
	if len(r.peers) == 1 {
		remaining = r.peers[0]
	}
	r.mu.Unlock()

	if remaining != nil {
		remaining.enqueue(mustJSON(Envelope{Type: TypePeerLeft}))
	}
}

func (r *Room) other(p *peer) *peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.peers {
		if existing != p {
			return existing
		}
	}
	return nil
}

func writeJSON(ctx context.Context, conn *websocket.Conn, env Envelope) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_ = conn.Write(ctx, websocket.MessageText, mustJSON(env))
}

func mustJSON(env Envelope) []byte {
	data, err := json.Marshal(env)
	if err != nil {
		// Unreachable: Envelope contains only marshalable fields.
		panic(err)
	}
	return data
}
