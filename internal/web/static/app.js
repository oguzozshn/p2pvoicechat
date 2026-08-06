// P2PVoiceChat client: joins the two-person room, negotiates a direct WebRTC
// connection with the other browser, and plays what comes back.
//
// Negotiation follows the "perfect negotiation" pattern. The server tells each
// side whether it is polite; when both offer at the same time the polite side
// rolls back. This matters as soon as either side can start or stop a screen
// share mid-call, which renegotiates an already-running connection.

import { tuneOpus } from "./sdp.js";

const els = {
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  peer: document.getElementById("peer"),
  join: document.getElementById("join"),
  leave: document.getElementById("leave"),
  share: document.getElementById("share"),
  screenQuality: document.getElementById("screen-quality"),
  remoteAudio: document.getElementById("remote-audio"),
  remoteVideo: document.getElementById("remote-video"),
  placeholder: document.getElementById("placeholder"),
  mic: document.getElementById("mic"),
  speaker: document.getElementById("speaker"),
  bitrate: document.getElementById("bitrate"),
  processing: document.getElementById("processing"),
  meterFill: document.getElementById("meter-fill"),
  mute: document.getElementById("mute"),
  volume: document.getElementById("volume"),
  ptt: document.getElementById("ptt"),
  stats: document.getElementById("stats"),
};

// No ICE servers on purpose. Tailscale already gives both machines a routable
// address, so host candidates are enough — and adding STUN would let the
// connection form over a path that bypasses the tunnel.
const RTC_CONFIG = { iceServers: [] };

let ws = null;
let pc = null;
let micStream = null;
let micSender = null;
let screenStream = null;
let screenVideoSender = null;
let screenAudioSender = null;

// The remote side's audio and video are kept in separate streams. Putting
// both in one and assigning it to the <video> element as well would play
// every audio track twice.
let remoteAudioStream = null;
let remoteVideoStream = null;

let polite = false;
let makingOffer = false;
let ignoreOffer = false;

// Only one side ever creates offers.
//
// With both sides offering at once, the polite peer rolls back — and in
// practice Chrome does not re-gather ICE candidates after that rollback, so
// the connection stalls with one side never sending a candidate. Designating
// a single offerer removes the collision instead of recovering from it. The
// polite/ignoreOffer logic below stays as a backstop.
let initiator = false;

// ICE candidates that arrived before the remote description was set.
// addIceCandidate throws in that state, and a dropped candidate can be the
// only one that would have worked.
let pendingCandidates = [];

let meterCtx = null;
let meterRaf = 0;

// Reconnection state. `wanted` is what the user asked for: it stays true
// between joining and leaving, and is what tells a dropped socket to come
// back rather than stay down.
let wanted = false;
let reconnectDelay = 0;
let reconnectTimer = 0;
let iceRecoveryTimer = 0;

let muted = false;
let pttHeld = false;
let statsTimer = 0;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15000;
// How long a connection may sit in "disconnected" before ICE is restarted.
// Brief blips recover on their own, and restarting too eagerly makes a
// momentary hiccup into a real gap in the audio.
const ICE_RECOVERY_MS = 4000;

// --- Settings ---------------------------------------------------------

function settings() {
  return {
    micId: els.mic.value || "",
    speakerId: els.speaker.value || "",
    bitrate: Number(els.bitrate.value),
    // When the echo canceller runs, the browser downmixes to mono and
    // narrows the band before we ever see the audio, so every other quality
    // setting stops mattering. Off is the good path; it needs headphones.
    processing: els.processing.checked,
  };
}

function audioConstraints() {
  const s = settings();
  return {
    deviceId: s.micId ? { exact: s.micId } : undefined,
    channelCount: 2,
    sampleRate: 48000,
    echoCancellation: s.processing,
    noiseSuppression: s.processing,
    autoGainControl: s.processing,
  };
}

function opusOptions() {
  const s = settings();
  return { bitrate: s.bitrate, stereo: !s.processing };
}

// Video bitrates are generous because the tailnet is the only hop. The point
// is readable text during a screen share, which is where stingy bitrates
// show up first as smearing.
const SCREEN_BITRATES = {
  "1280x720@30": 3_000_000,
  "1920x1080@30": 6_000_000,
  "1920x1080@60": 10_000_000,
  "2560x1440@30": 12_000_000,
};

function screenOptions() {
  const value = els.screenQuality.value;
  const [size, fps] = value.split("@");
  const [width, height] = size.split("x").map(Number);
  return {
    width,
    height,
    frameRate: Number(fps),
    bitrate: SCREEN_BITRATES[value] ?? 6_000_000,
  };
}

// --- Saved settings ---------------------------------------------------

const STORAGE_KEY = "p2pvoicechat.settings";

// Picking the right microphone and turning off processing every single time
// is exactly the friction that makes a tool not get used.
function saveSettings() {
  const state = {
    mic: els.mic.value,
    speaker: els.speaker.value,
    bitrate: els.bitrate.value,
    processing: els.processing.checked,
    screenQuality: els.screenQuality.value,
    volume: els.volume.value,
    ptt: els.ptt.checked,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing and full quotas both land here; not worth surfacing.
  }
}

function loadSettings() {
  let state;
  try {
    state = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return;
  }
  if (!state) return;

  // Devices are restored by id, which may no longer exist — a headset that
  // was unplugged, say. setSelectIfPresent leaves the default in that case.
  setSelectIfPresent(els.mic, state.mic);
  setSelectIfPresent(els.speaker, state.speaker);
  setSelectIfPresent(els.bitrate, state.bitrate);
  setSelectIfPresent(els.screenQuality, state.screenQuality);
  if (typeof state.processing === "boolean") els.processing.checked = state.processing;
  if (typeof state.ptt === "boolean") els.ptt.checked = state.ptt;
  if (state.volume != null) {
    els.volume.value = state.volume;
    applyVolume();
  }
}

function setSelectIfPresent(select, value) {
  if (value == null) return;
  if ([...select.options].some((o) => o.value === value)) select.value = value;
}

// --- Mute and push-to-talk --------------------------------------------

// The track is disabled rather than stopped: stopping would need a new
// getUserMedia and a renegotiation to come back, and disabled tracks send
// silence at almost no cost.
function applyMicEnabled() {
  const live = els.ptt.checked ? pttHeld : !muted;
  micStream?.getAudioTracks().forEach((t) => {
    t.enabled = live;
  });
  els.mute.textContent = els.ptt.checked
    ? pttHeld
      ? "Konuşuyorsun"
      : "Bas-konuş"
    : muted
      ? "Sesi aç"
      : "Sustur";
  els.mute.classList.toggle("btn-active", !live);
}

function toggleMute() {
  if (els.ptt.checked) return;
  muted = !muted;
  applyMicEnabled();
}

function applyVolume() {
  els.remoteAudio.volume = Number(els.volume.value) / 100;
}

// Typing in a form control must not trigger shortcuts.
function inFormField(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

document.addEventListener("keydown", (e) => {
  if (inFormField(e.target) || e.repeat) return;
  if (e.key === "m" || e.key === "M") {
    toggleMute();
  } else if (e.code === "Space" && els.ptt.checked) {
    e.preventDefault();
    pttHeld = true;
    applyMicEnabled();
  }
});

document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && els.ptt.checked) {
    e.preventDefault();
    pttHeld = false;
    applyMicEnabled();
  }
});

// Releasing the key while the window is not focused would otherwise leave
// the microphone stuck open.
window.addEventListener("blur", () => {
  if (pttHeld) {
    pttHeld = false;
    applyMicEnabled();
  }
});

// --- Notification chime -----------------------------------------------

// A short tone rather than an audio file, so the binary stays a single
// self-contained executable. Rising means arrived, falling means left.
function chime(rising) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(rising ? 520 : 700, now);
    osc.frequency.exponentialRampToValueAtTime(rising ? 780 : 430, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

    osc.start(now);
    osc.stop(now + 0.3);
    osc.onended = () => ctx.close();
  } catch {
    // An audio context that will not start is not worth failing a join over.
  }
}

// --- UI ---------------------------------------------------------------

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
}

function setPeer(text) {
  els.peer.textContent = text;
}

function showVideo(on) {
  els.remoteVideo.classList.toggle("hidden", !on);
  els.placeholder.classList.toggle("hidden", on);
}

// --- Devices ----------------------------------------------------------

// Device labels stay blank until microphone permission has been granted, so
// this is only worth calling after the first getUserMedia.
async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillDeviceSelect(els.mic, devices, "audioinput", "Varsayılan mikrofon");
  fillDeviceSelect(els.speaker, devices, "audiooutput", "Varsayılan hoparlör");
}

function fillDeviceSelect(select, devices, kind, defaultLabel) {
  const previous = select.value;
  select.replaceChildren();

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = defaultLabel;
  select.append(auto);

  for (const d of devices) {
    if (d.kind !== kind) continue;
    // Without granted permission the browser reports a single unnamed
    // placeholder device; listing it as an option would be noise.
    if (!d.label && !d.deviceId) continue;
    const option = document.createElement("option");
    option.value = d.deviceId;
    option.textContent = d.label || `Adsız cihaz ${d.deviceId.slice(0, 6)}`;
    select.append(option);
  }
  select.value = previous;
}

async function applySpeaker() {
  const { speakerId } = settings();
  // setSinkId is Chromium-only; elsewhere the OS default is the only option.
  if (!els.remoteAudio.setSinkId) return;
  try {
    await els.remoteAudio.setSinkId(speakerId);
  } catch (err) {
    console.warn("hoparlör seçilemedi", err);
  }
}

// --- Level meter ------------------------------------------------------

function startMeter(stream) {
  stopMeter();
  meterCtx = new AudioContext();
  const source = meterCtx.createMediaStreamSource(stream);
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const v of samples) {
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }
    // Scaled past 1:1 so normal speech fills a useful part of the bar
    // instead of hugging the left edge.
    els.meterFill.style.width = `${Math.min(100, peak * 140)}%`;
    els.meterFill.classList.toggle("hot", peak > 0.85);
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  meterRaf = 0;
  meterCtx?.close();
  meterCtx = null;
  els.meterFill.style.width = "0";
  els.meterFill.classList.remove("hot");
}

// --- Entry points -----------------------------------------------------

els.join.addEventListener("click", join);
els.leave.addEventListener("click", () => leave("ayrıldın"));
els.share.addEventListener("click", () => (screenStream ? stopShare() : startShare()));
els.screenQuality.addEventListener("change", applyScreenParams);
// Coming back from a closed lid or a dropped network should feel immediate
// rather than waiting out whatever backoff had built up.
function nudgeReconnect() {
  if (!wanted || ws) return;
  reconnectDelay = 0;
  connectSignaling();
}
window.addEventListener("online", nudgeReconnect);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") nudgeReconnect();
});

// Double-click the remote picture to fill the screen with it.
els.remoteVideo.addEventListener("dblclick", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else els.remoteVideo.requestFullscreen?.();
});
els.speaker.addEventListener("change", applySpeaker);
els.mic.addEventListener("change", replaceMicTrack);
els.processing.addEventListener("change", replaceMicTrack);
els.bitrate.addEventListener("change", applyBitrate);
els.mute.addEventListener("click", toggleMute);
els.volume.addEventListener("input", applyVolume);
els.ptt.addEventListener("change", () => {
  // Switching modes must not leave the microphone in whichever state the
  // other mode had it.
  muted = false;
  pttHeld = false;
  applyMicEnabled();
});

// Every control writes its state back, so the next launch starts where this
// one left off.
for (const el of [
  els.mic,
  els.speaker,
  els.bitrate,
  els.processing,
  els.screenQuality,
  els.volume,
  els.ptt,
]) {
  el.addEventListener("change", saveSettings);
}

loadSettings();
applyVolume();

// fakeMic returns a synthetic tone as a real MediaStreamTrack. With ?fake in
// the URL the whole negotiation path can be exercised from two tabs on one
// machine, with no microphone attached and no second person needed.
const FAKE = new URLSearchParams(location.search).has("fake");

// fakeScreen stands in for getDisplayMedia, which cannot be driven without a
// real click on the picker. An animated canvas produces a genuine video
// track, so the transceiver, replaceTrack and mute/unmute path all run for
// real.
let fakeScreenTimer = 0;
function fakeScreen() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  let frame = 0;
  fakeScreenTimer = setInterval(() => {
    frame++;
    ctx.fillStyle = `hsl(${(frame * 4) % 360} 55% 40%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "44px sans-serif";
    ctx.fillText(`TEST ${frame}`, 40, 200);
  }, 100);
  return canvas.captureStream(10);
}

function fakeMic() {
  const ctx = new AudioContext();
  // Autoplay policy starts the context suspended unless a real click is in
  // progress; without this the tone is silent and the meter never moves.
  ctx.resume();

  const osc = ctx.createOscillator();
  osc.frequency.value = 440;

  // Kept quiet, and pulsed rather than continuous. A steady full-scale sine
  // is genuinely painful to sit next to while testing, and the gaps make a
  // dropout obvious in a way an unbroken tone does not.
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const now = ctx.currentTime;
  for (let i = 0; i < 600; i++) {
    const at = now + i * 2;
    gain.gain.setValueAtTime(0.05, at);
    gain.gain.setValueAtTime(0, at + 0.4);
  }

  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  return dest.stream;
}

async function join() {
  els.join.disabled = true;

  // Only where the microphone comes from differs between test and real use.
  // Everything after it is one shared path, so the two cannot drift apart.
  if (FAKE) {
    micStream = fakeMic();
    setPeer("test sesi");
  } else {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("failed", "güvenli bağlam yok");
      alert(
        "Tarayıcı mikrofona izin vermiyor çünkü sayfa güvenli bağlamda değil.\n\n" +
          "Adresin https:// ile başladığından ve sertifika uyarısını " +
          "geçtiğinden emin ol."
      );
      els.join.disabled = false;
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(),
      });
    } catch (err) {
      setStatus("failed", "mikrofon açılamadı");
      alert(`Mikrofon açılamadı: ${err.name}\n\n${err.message}`);
      els.join.disabled = false;
      return;
    }
  }

  await refreshDevices();
  // Device ids only become selectable once the list is populated, so the
  // saved choice is reapplied here rather than at startup.
  loadSettings();
  await applySpeaker();
  startMeter(micStream);
  applyMicEnabled();

  els.leave.disabled = false;
  els.mute.disabled = false;
  wanted = true;
  reconnectDelay = 0;
  connectSignaling();
  startStatsReadout();
}

function leave(reason) {
  els.leave.disabled = true;
  els.join.disabled = false;
  els.mute.disabled = true;
  muted = false;
  pttHeld = false;
  stopStatsReadout();

  // Set before closing the socket so onclose does not treat a deliberate
  // exit as a drop and start reconnecting.
  wanted = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  reconnectDelay = 0;

  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  teardownPeer();
  stopMeter();

  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;

  setStatus("idle", reason);
  setPeer("oda boş");
}

// --- Microphone changes -----------------------------------------------

// Swapping the input device or the processing setting means acquiring a new
// track. replaceTrack swaps it into the running connection, so the other
// side hears no gap while it happens.
async function replaceMicTrack() {
  if (!micStream) return;

  let next;
  try {
    next = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
  } catch (err) {
    alert(`Mikrofon değiştirilemedi: ${err.name}\n\n${err.message}`);
    return;
  }

  const track = next.getAudioTracks()[0];
  if (micSender) {
    await micSender.replaceTrack(track);
  }

  micStream.getTracks().forEach((t) => t.stop());
  micStream = next;
  startMeter(micStream);
  // A freshly acquired track arrives enabled, which would silently undo a
  // mute or drop out of push-to-talk.
  applyMicEnabled();

  // Turning processing on or off changes whether stereo makes sense, and
  // that lives in the SDP, so the session has to be renegotiated.
  await renegotiate();
}

async function applyBitrate() {
  if (!micSender) return;

  const params = micSender.getParameters();
  if (!params.encodings?.length) {
    params.encodings = [{}];
  }
  params.encodings[0].maxBitrate = settings().bitrate;
  try {
    await micSender.setParameters(params);
  } catch (err) {
    console.warn("gönderim bitrate'i ayarlanamadı", err);
  }

  // setParameters caps what we send. What the peer sends us is governed by
  // the fmtp line, so the change reaches both directions only after a new
  // offer.
  await renegotiate();
}

async function renegotiate() {
  if (!pc || pc.signalingState !== "stable") return;
  if (!initiator) {
    send({ type: "signal", data: { needOffer: true } });
    return;
  }
  try {
    await sendOffer();
  } catch (err) {
    console.error("renegotiation failed", err);
  }
}

// --- Screen sharing ---------------------------------------------------

// Finds the transceivers reserved for the screen and makes both of them
// two-way, so either person can start sharing without a new m-line.
//
// The mapping is positional: the first audio m-line is the microphone, the
// second is screen audio, and the only video m-line is the screen. That
// order comes from startPeer and is preserved through the SDP, so both sides
// agree on it.
// Tells the other side whether a picture is on its way. Sent on every change
// and again once the connection is up, so someone joining mid-share sees it.
function announceSharing() {
  send({ type: "signal", data: { sharing: Boolean(screenStream) } });
}

function bindScreenSenders() {
  if (!pc) return;

  const audio = [];
  const video = [];
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver.track?.kind;
    if (kind === "audio") audio.push(t);
    else if (kind === "video") video.push(t);
  }

  if (video[0]) {
    // An answering peer receives these as recvonly. Without flipping the
    // direction, replaceTrack would attach a track that is never sent.
    if (video[0].direction === "recvonly") video[0].direction = "sendrecv";
    screenVideoSender = video[0].sender;
  }
  if (audio[1]) {
    if (audio[1].direction === "recvonly") audio[1].direction = "sendrecv";
    screenAudioSender = audio[1].sender;
  }
  els.share.disabled = !screenVideoSender;
}

// The video and screen-audio transceivers are created up front and sit empty
// until a share starts, so starting and stopping only calls replaceTrack.
// That needs no renegotiation at all, which keeps a running call from
// wobbling every time someone toggles their screen.
async function startShare() {
  if (!pc || screenStream) return;

  const opts = screenOptions();

  // Only the source differs between test and real use; everything after it
  // is shared, so the two paths cannot drift apart.
  if (FAKE) {
    screenStream = fakeScreen();
  } else {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: opts.width },
          height: { ideal: opts.height },
          frameRate: { ideal: opts.frameRate },
        },
        // Chrome only offers the "share audio" checkbox when audio is asked
        // for. Processing stays off so game and video sound arrives intact.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      // Cancelling the picker is a normal outcome, not a failure worth an
      // alert.
      if (err.name !== "NotAllowedError") {
        alert(`Ekran paylaşılamadı: ${err.name}\n\n${err.message}`);
      }
      return;
    }
  }

  const [videoTrack] = screenStream.getVideoTracks();
  const [audioTrack] = screenStream.getAudioTracks();

  await screenVideoSender?.replaceTrack(videoTrack ?? null);
  await screenAudioSender?.replaceTrack(audioTrack ?? null);
  await applyScreenParams();

  // Chrome's own "Stop sharing" bar ends the track behind our back.
  videoTrack?.addEventListener("ended", stopShare);

  els.share.textContent = "Paylaşımı durdur";
  els.share.classList.add("btn-active");
  announceSharing();
}

async function stopShare() {
  if (!screenStream) return;

  await screenVideoSender?.replaceTrack(null);
  await screenAudioSender?.replaceTrack(null);

  clearInterval(fakeScreenTimer);
  fakeScreenTimer = 0;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;

  els.share.textContent = "Ekranı paylaş";
  els.share.classList.remove("btn-active");
  announceSharing();
}

async function applyScreenParams() {
  if (!screenVideoSender?.track) return;
  const opts = screenOptions();

  const params = screenVideoSender.getParameters();
  if (!params.encodings?.length) {
    params.encodings = [{}];
  }
  params.encodings[0].maxBitrate = opts.bitrate;
  params.encodings[0].maxFramerate = opts.frameRate;
  // Prefer keeping text sharp over keeping motion smooth when the link is
  // tight; a blurry screen share is useless, a stuttery one is not.
  params.degradationPreference = "maintain-resolution";
  try {
    await screenVideoSender.setParameters(params);
  } catch (err) {
    console.warn("ekran parametreleri ayarlanamadı", err);
  }

  await screenStream?.getVideoTracks()[0]?.applyConstraints({
    width: { ideal: opts.width },
    height: { ideal: opts.height },
    frameRate: { ideal: opts.frameRate },
  });
}

// --- Signaling --------------------------------------------------------

function connectSignaling() {
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  setStatus("connecting", "sinyal sunucusuna bağlanılıyor");

  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(url);

  ws.onopen = () => {
    reconnectDelay = 0;
    setStatus("connecting", "odaya girildi, eş bekleniyor");
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    await handleMessage(msg);
  };

  ws.onclose = () => {
    ws = null;
    // The media connection is torn down along with the socket rather than
    // kept alive across the gap. On reconnect the server hands out fresh
    // polite/initiator roles, and a surviving connection built under the old
    // roles would leave both sides thinking they should offer.
    teardownPeer();
    if (wanted) scheduleReconnect();
  };
}

function scheduleReconnect() {
  reconnectDelay = reconnectDelay
    ? Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    : RECONNECT_MIN_MS;
  const seconds = Math.round(reconnectDelay / 1000);
  setStatus(
    "connecting",
    seconds >= 1 ? `bağlantı koptu, ${seconds} sn sonra denenecek` : "yeniden bağlanılıyor"
  );
  setPeer("oda boş");
  reconnectTimer = setTimeout(connectSignaling, reconnectDelay);
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function handleMessage(msg) {
  switch (msg.type) {
    case "welcome":
      polite = Boolean(msg.polite);
      // The second person to arrive offers; the one already waiting answers.
      initiator = !polite;
      if (msg.peerPresent) {
        setPeer("eş odada");
        startPeer();
      } else {
        setPeer("oda boş");
      }
      break;

    case "peer-joined":
      setPeer("eş odada");
      chime(true);
      startPeer();
      break;

    case "peer-left":
      setPeer("eş ayrıldı");
      setStatus("connecting", "eş bekleniyor");
      chime(false);
      teardownPeer();
      break;

    case "room-full":
      setStatus("failed", "oda dolu");
      alert("Oda dolu — aynı anda yalnızca iki kişi bağlanabilir.");
      leave("oda dolu");
      break;

    case "signal":
      await handleSignal(msg.data);
      break;
  }
}

// --- Peer connection --------------------------------------------------

function startPeer() {
  if (pc) return;

  setStatus("connecting", "eşle bağlantı kuruluyor");
  pc = new RTCPeerConnection(RTC_CONFIG);
  remoteAudioStream = new MediaStream();
  remoteVideoStream = new MediaStream();

  for (const track of micStream.getAudioTracks()) {
    micSender = pc.addTrack(track, micStream);
  }

  // Reserved up front so a screen share can start later without
  // renegotiating. Only the offering side creates them: if both did, each
  // would add its own m-lines and the session would carry two unused
  // duplicates. The answering side picks up the ones the offer brings.
  if (initiator) {
    pc.addTransceiver("video", { direction: "sendrecv" });
    pc.addTransceiver("audio", { direction: "sendrecv" });
  }
  bindScreenSenders();

  pc.onnegotiationneeded = async () => {
    if (!initiator) {
      // Ask the other side to drive it rather than offering ourselves.
      send({ type: "signal", data: { needOffer: true } });
      return;
    }
    try {
      makingOffer = true;
      await sendOffer();
    } catch (err) {
      console.error("negotiation failed", err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      send({ type: "signal", data: { candidate } });
    }
  };

  pc.ontrack = ({ track }) => {
    if (track.kind === "audio") {
      remoteAudioStream.addTrack(track);
      els.remoteAudio.srcObject = remoteAudioStream;
      applySpeaker();
      return;
    }

    remoteVideoStream.addTrack(track);
    els.remoteVideo.srcObject = remoteVideoStream;

    // Whether the picture is showing is driven by the explicit "sharing"
    // message, not by track.muted: replaceTrack(null) stops the frames
    // without ever muting the receiver, which would leave the viewer staring
    // at a frozen last frame indefinitely.
    track.addEventListener("ended", () => showVideo(false));
  };

  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case "connected":
        clearTimeout(iceRecoveryTimer);
        iceRecoveryTimer = 0;
        setStatus("connected", "bağlı");
        // The sender only exists once negotiation has produced one, so the
        // bitrate cap is applied here rather than at addTrack time.
        applyBitrate();
        announceSharing();
        break;
      case "connecting":
        setStatus("connecting", "eşle bağlantı kuruluyor");
        break;
      case "disconnected":
        // Usually a passing blip — a moment of packet loss, a Wi-Fi roam.
        // Give it a chance to heal before forcing a restart.
        setStatus("connecting", "bağlantı kesildi, toparlanıyor");
        scheduleIceRecovery();
        break;
      case "failed":
        setStatus("failed", "bağlantı koptu, yeniden kuruluyor");
        restartIce();
        break;
    }
  };
}

function scheduleIceRecovery() {
  if (iceRecoveryTimer) return;
  iceRecoveryTimer = setTimeout(() => {
    iceRecoveryTimer = 0;
    if (pc && pc.connectionState !== "connected") restartIce();
  }, ICE_RECOVERY_MS);
}

// Re-gathers candidates and renegotiates over the existing session. This is
// what recovers a laptop that slept, or a Tailscale link that went away and
// came back with a different path.
async function restartIce() {
  if (!pc || !wanted) return;
  if (!initiator) {
    // Only one side drives negotiation, so ask the other to do the restart.
    send({ type: "signal", data: { needOffer: true, iceRestart: true } });
    return;
  }
  try {
    await sendOffer({ iceRestart: true });
  } catch (err) {
    console.error("ICE restart failed", err);
  }
}

// The offer and answer are built explicitly rather than with the implicit
// setLocalDescription(), because the Opus parameters have to be edited into
// the SDP before it is applied.
async function sendOffer(options = {}) {
  const offer = await pc.createOffer(options);
  offer.sdp = tuneOpus(offer.sdp, opusOptions());
  await pc.setLocalDescription(offer);
  send({ type: "signal", data: { description: pc.localDescription } });
}

async function sendAnswer() {
  const answer = await pc.createAnswer();
  answer.sdp = tuneOpus(answer.sdp, opusOptions());
  await pc.setLocalDescription(answer);
  send({ type: "signal", data: { description: pc.localDescription } });
}

async function handleSignal(data) {
  if (!pc || !data) return;

  try {
    if (data.needOffer) {
      if (!initiator) return;
      if (data.iceRestart) await restartIce();
      else await renegotiate();
      return;
    }

    if (data.sharing !== undefined) {
      showVideo(Boolean(data.sharing));
      return;
    }

    if (data.description) {
      const collision =
        data.description.type === "offer" &&
        (makingOffer || pc.signalingState !== "stable");

      ignoreOffer = !polite && collision;
      if (ignoreOffer) return;

      await pc.setRemoteDescription(data.description);
      await flushPendingCandidates();
      // The offer may have brought the screen transceivers with it, so bind
      // them before answering — the answer has to declare sendrecv for the
      // share to work in this direction too.
      bindScreenSenders();
      if (data.description.type === "offer") {
        await sendAnswer();
      }
    } else if (data.candidate) {
      if (!pc.remoteDescription) {
        pendingCandidates.push(data.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        // A candidate arriving for an offer we deliberately ignored is
        // expected; anything else is worth surfacing.
        if (!ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error("signal handling failed", err);
  }
}

async function flushPendingCandidates() {
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of queued) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("queued candidate rejected", err);
    }
  }
}

// --- Diagnostics ------------------------------------------------------

// stats reports the path the media actually took. "host" on both ends is the
// goal: it means the connection went straight over the tailnet. Anything
// else means traffic is detouring, and latency will show it.
async function stats() {
  if (!pc) return null;
  const report = await pc.getStats();

  let pair = null;
  let videoOut = null;
  let videoIn = null;
  // There are two audio streams — the microphone and the screen's own sound
  // — so the byte counts are summed rather than overwritten. Quality figures
  // come from the microphone alone, which is the one worth watching.
  let audioSent = 0;
  let audioReceived = 0;
  let mic = null;
  for (const s of report.values()) {
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
      pair = s;
    }
    if (s.type === "outbound-rtp" && s.kind === "audio") audioSent += s.bytesSent ?? 0;
    if (s.type === "inbound-rtp" && s.kind === "audio") {
      audioReceived += s.bytesReceived ?? 0;
      if (mic === null || s.mid === "0") mic = s;
    }
    if (s.type === "outbound-rtp" && s.kind === "video") videoOut = s;
    if (s.type === "inbound-rtp" && s.kind === "video") videoIn = s;
  }
  if (!pair) return { connected: false };

  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  return {
    connected: true,
    localType: local?.candidateType,
    remoteType: remote?.candidateType,
    rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
    protocol: pair.protocol ?? local?.protocol,
    audioSent,
    audioReceived,
    packetsLost: mic?.packetsLost ?? 0,
    jitterMs: mic?.jitter != null ? mic.jitter * 1000 : null,
    sharing: Boolean(screenStream),
    videoSent: videoOut?.bytesSent ?? 0,
    videoReceived: videoIn?.bytesReceived ?? 0,
    videoOutSize:
      videoOut?.frameWidth != null ? `${videoOut.frameWidth}x${videoOut.frameHeight}` : null,
    videoInSize:
      videoIn?.frameWidth != null ? `${videoIn.frameWidth}x${videoIn.frameHeight}` : null,
  };
}

// The readout is deliberately terse and always visible. Round-trip time and
// packet loss are the two numbers that explain almost every complaint about
// how a call sounds.
function startStatsReadout() {
  stopStatsReadout();
  statsTimer = setInterval(async () => {
    const s = await stats();
    if (!s?.connected) {
      els.stats.textContent = "";
      return;
    }
    const parts = [];
    if (s.rttMs != null) parts.push(`${Math.round(s.rttMs)} ms`);
    if (s.jitterMs != null) parts.push(`jitter ${s.jitterMs.toFixed(1)} ms`);
    parts.push(`kayıp ${s.packetsLost}`);
    // Anything other than host on either end means the media is detouring
    // rather than going straight over the tailnet.
    if (s.localType !== "host" || s.remoteType !== "host") {
      parts.push(`⚠ ${s.localType}/${s.remoteType}`);
    }
    if (s.videoInSize) parts.push(`gelen ${s.videoInSize}`);
    if (s.videoOutSize) parts.push(`giden ${s.videoOutSize}`);
    els.stats.textContent = parts.join(" · ");
  }, 2000);
}

function stopStatsReadout() {
  clearInterval(statsTimer);
  statsTimer = 0;
  els.stats.textContent = "";
}

// localSdp exposes the negotiated description so the Opus settings can be
// checked without digging through chrome://webrtc-internals.
function localSdp() {
  return pc?.localDescription?.sdp ?? null;
}

// Exposed so the connection can be inspected from the browser console.
window.p2p = {
  stats,
  localSdp,
  get pc() {
    return pc;
  },
};

function teardownPeer() {
  clearTimeout(iceRecoveryTimer);
  iceRecoveryTimer = 0;
  if (!pc) return;
  pc.onnegotiationneeded = null;
  pc.onicecandidate = null;
  pc.ontrack = null;
  pc.onconnectionstatechange = null;
  pc.close();
  pc = null;

  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  els.share.textContent = "Ekranı paylaş";
  els.share.classList.remove("btn-active");
  els.share.disabled = true;

  micSender = null;
  screenVideoSender = null;
  screenAudioSender = null;
  remoteAudioStream = null;
  remoteVideoStream = null;
  els.remoteAudio.srcObject = null;
  els.remoteVideo.srcObject = null;
  showVideo(false);

  makingOffer = false;
  ignoreOffer = false;
  pendingCandidates = [];
}
