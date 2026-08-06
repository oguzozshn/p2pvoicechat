// SDP rewriting.
//
// Browsers negotiate Opus at roughly 32 kbps mono by default, which is what
// makes most voice apps sound like a telephone. The knobs that change it live
// only in the fmtp line, so the session description has to be edited by hand
// before it is handed to setLocalDescription.
//
// These parameters describe what *we* are willing to receive, so the peer's
// encoder reads them. Both sides set them, so both directions improve.

/**
 * Rewrites the Opus fmtp line with the given options.
 *
 * @param {string} sdp
 * @param {{bitrate: number, stereo: boolean}} opts
 * @returns {string}
 */
export function tuneOpus(sdp, { bitrate, stereo }) {
  const params = {
    // stereo tells the peer to send us two channels; sprop-stereo tells it
    // we intend to send two. Without both, one direction collapses to mono.
    stereo: stereo ? "1" : "0",
    "sprop-stereo": stereo ? "1" : "0",
    maxaveragebitrate: String(bitrate),
    // Forward error correction: cheap insurance against the occasional lost
    // packet, which is far more audible than the bandwidth it costs.
    useinbandfec: "1",
    // Discontinuous transmission off. It saves bandwidth during silence, but
    // the gaps make the other person sound like they dropped out.
    usedtx: "0",
  };

  const lines = sdp.split(/\r\n|\n/);
  const payloadTypes = [];
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000\/2$/i.exec(line);
    if (m) payloadTypes.push(m[1]);
  }
  if (payloadTypes.length === 0) return sdp;

  const out = [];
  const handled = new Set();

  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp && payloadTypes.includes(fmtp[1])) {
      out.push(`a=fmtp:${fmtp[1]} ${mergeParams(fmtp[2], params)}`);
      handled.add(fmtp[1]);
      continue;
    }
    out.push(line);

    // No fmtp line existed for this codec, so add one right after its rtpmap.
    const rtpmap = /^a=rtpmap:(\d+) opus\/48000\/2$/i.exec(line);
    if (rtpmap && !lines.some((l) => l.startsWith(`a=fmtp:${rtpmap[1]} `))) {
      out.push(`a=fmtp:${rtpmap[1]} ${formatParams(params)}`);
      handled.add(rtpmap[1]);
    }
  }

  return out.join("\r\n");
}

// mergeParams keeps whatever the browser already negotiated and overrides
// only the keys we care about, so codec settings we do not understand survive.
function mergeParams(existing, overrides) {
  const merged = new Map();
  for (const pair of existing.split(";")) {
    const [k, v] = pair.split("=");
    if (k?.trim()) merged.set(k.trim(), v?.trim() ?? "");
  }
  for (const [k, v] of Object.entries(overrides)) {
    merged.set(k, v);
  }
  return [...merged].map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
}

function formatParams(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
}
