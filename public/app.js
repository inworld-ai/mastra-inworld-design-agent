const $frame = document.getElementById("preview-frame");
const $marqueeHost = document.getElementById("marquee-host");

let loadedFonts = new Set();
let voiceStatus = "off"; // "off" | "connecting" | "on"
let lastCtaLabel = "";
let lastMarqueeText = null;

// Tool affordance. `used` = every tool the agent has called this session
// (persistent highlight, so the user can see what's been touched); `pulse` =
// the one that just fired (transient flash). Tracked in JS, not the DOM,
// because render() rebuilds the tools list on every state update — it
// re-applies these classes so the highlight survives. `reset` clears it.
const toolUsage = { used: new Set(), pulse: null, pulseTimer: null };

const TOOLS = [
  { id: "set_theme", label: "set_theme", desc: "change bg, text, or accent colors" },
  { id: "set_typography", label: "set_typography", desc: "swap Google Fonts or scale text" },
  { id: "set_copy", label: "set_copy", desc: "rewrite headline, subhead, body, or CTA" },
  { id: "set_layout", label: "set_layout", desc: "alignment and hero variant" },
  { id: "add_feature", label: "add_feature", desc: "append a new feature card" },
  { id: "remove_feature", label: "remove_feature", desc: "delete a feature card by index" },
  { id: "update_feature", label: "update_feature", desc: "edit an existing feature card" },
  {
    id: "apply_preset",
    label: "apply_preset",
    desc: "dark, cream, ocean, sunset, mono, forest, neon, default",
  },
  { id: "set_marquee", label: "set_marquee", desc: "change the top scrolling marquee text" },
  { id: "set_decor", label: "set_decor", desc: "garish 90s or tasteful modern styling" },
  { id: "reset", label: "reset", desc: "restore everything to defaults" },
];

function escape(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function ensureFont(family) {
  if (!family || loadedFonts.has(family)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;600;700&display=swap`;
  document.head.appendChild(link);
  loadedFonts.add(family);
}

function render(state) {
  const { theme, typography, layout, copy, features, marquee, decor } = state;
  ensureFont(typography.fontFamily);

  // Styling treatment ("garish" | "tasteful") — CSS keys off this on :root.
  document.documentElement.dataset.decor = decor || "garish";

  const root = document.documentElement.style;
  root.setProperty("--site-bg", theme.bg);
  root.setProperty("--site-text", theme.text);
  root.setProperty("--site-accent", theme.accent);
  root.setProperty("--site-scale", String(typography.scale));
  $frame.style.fontFamily = `'${typography.fontFamily}', system-ui, sans-serif`;

  lastCtaLabel = copy.cta;

  const featuresHtml = (features || [])
    .map(
      (f) => `
        <article class="site-feature">
          <h3>${escape(f.title)}</h3>
          <p>${escape(f.body)}</p>
        </article>`,
    )
    .join("");

  renderMarquee(marquee);

  $frame.innerHTML = `
    <section class="site-hero" data-alignment="${escape(layout.alignment)}" data-variant="${escape(layout.heroVariant)}">
      <div>
        <h1>${escape(copy.headline)}</h1>
        <p class="site-subhead">${escape(copy.subheadline)}</p>
        <p class="site-body">${escape(copy.body)}</p>
      </div>
      ${layout.heroVariant === "split" ? '<div aria-hidden="true"></div>' : ""}
    </section>
    ${featuresHtml ? `<section class="site-features">${featuresHtml}</section>` : ""}
    <section class="site-tools" aria-label="Tools the agent can call">
      <h3>Tools the agent can call</h3>
      <ul class="site-tools__list">
        ${TOOLS.map((t) => {
          const cls = "site-tool" + (toolUsage.used.has(t.id) ? " is-used" : "");
          return `<li class="${cls}" data-tool="${escape(t.id)}"><code class="site-tool__name">${escape(t.label)}</code> <span class="site-tool__desc">${escape(t.desc)}</span></li>`;
        }).join("")}
      </ul>
    </section>
    <div class="site-cta-wrap">
      <button id="site-cta" type="button" class="site-cta">
        <span class="site-cta__dot" aria-hidden="true"></span>
        <span class="site-cta__label">${renderCtaLabel(copy.cta)}</span>
      </button>
    </div>
  `;

  // render() just rebuilt the tools list, dropping the transient flash class.
  // Re-apply it if a tool is mid-pulse so the flash survives state updates.
  if (toolUsage.pulse) flashTool(toolUsage.pulse);

  applyVoiceStatusToCta();
}

function renderMarquee(text) {
  const next = text || "";
  if (next === lastMarqueeText) return;
  lastMarqueeText = next;
  $marqueeHost.innerHTML = next
    ? `<marquee class="site-marquee" behavior="scroll" direction="left" scrollamount="6">${escape(next)}</marquee>`
    : "";
}

// A tool fired: mark it used (persistent highlight) and trigger a one-shot
// flash. `reset` wipes the slate rather than marking itself.
function markToolUsed(name) {
  if (!name) return;
  if (name === "reset") toolUsage.used.clear();
  else toolUsage.used.add(name);
  toolUsage.pulse = name;
  clearTimeout(toolUsage.pulseTimer);
  toolUsage.pulseTimer = setTimeout(() => {
    toolUsage.pulse = null;
    document
      .querySelector(`.site-tool[data-tool="${CSS.escape(name)}"]`)
      ?.classList.remove("is-active");
  }, 900);
  flashTool(name);
}

// Apply the transient flash class, restarting its animation via a reflow.
function flashTool(name) {
  const li = document.querySelector(`.site-tool[data-tool="${CSS.escape(name)}"]`);
  if (!li) return;
  li.classList.remove("is-active");
  void li.offsetWidth;
  li.classList.add("is-active");
}

function renderCtaLabel(text) {
  const lines = String(text).split(/\r?\n/);
  const [first, ...rest] = lines;
  const main = `<span class="site-cta__main">${escape(first)}</span>`;
  const sub = rest.length ? `<span class="site-cta__sub">${escape(rest.join(" "))}</span>` : "";
  return main + sub;
}

function applyVoiceStatusToCta() {
  const btn = document.getElementById("site-cta");
  if (!btn) return;
  btn.dataset.voice = voiceStatus;
  const label = btn.querySelector(".site-cta__label");
  if (!label) return;
  if (voiceStatus === "connecting")
    label.innerHTML = `<span class="site-cta__main">Connecting…</span>`;
  else if (voiceStatus === "on")
    label.innerHTML = `<span class="site-cta__main">Listening — tap to stop</span>`;
  else label.innerHTML = renderCtaLabel(lastCtaLabel);
}

async function loadInitialState() {
  const res = await fetch("/api/state");
  if (!res.ok) {
    console.error(`Could not load initial state (${res.status})`);
    return;
  }
  render(await res.json());
}

/* ---------- Voice (Inworld Realtime via WebSocket) ---------- */

const SAMPLE_RATE = 24_000;
const MIC_FLUSH_MS = 80;

const RECORDER_WORKLET = `
class RecorderWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) {
      this.port.postMessage(ch.slice(0));
    }
    return true;
  }
}
registerProcessor('recorder', RecorderWorklet);
`;

const voice = {
  active: false,
  ws: null,
  stream: null,
  ctxIn: null,
  ctxOut: null,
  source: null,
  worklet: null,
  pending: [],
  flushTimer: null,
  outCursor: 0,
  activeAudio: new Set(),
  /** Barge-in epoch. Bumped by every stopAllAudio(); an `audio.header`
   *  snapshots the current value into `pendingGen`, and a binary frame whose
   *  header predates the latest interrupt (pendingGen !== audioGen) is dropped.
   *  This binds each frame to the playback generation it was queued in, so a
   *  cancelled response's in-flight tail can never re-arm playback — even when
   *  the next response's frames interleave with the old one's on the wire. */
  audioGen: 0,
  pendingGen: 0,
};

function floatToPCM16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}

function pcm16ToFloat(i16) {
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
  return f32;
}

function setVoiceUI(state) {
  // state: "off" | "connecting" | "on"
  voice.active = state === "on";
  voiceStatus = state;
  applyVoiceStatusToCta();
}

function playPcmChunk(i16) {
  if (!voice.ctxOut) return;
  const f32 = pcm16ToFloat(i16);
  const buf = voice.ctxOut.createBuffer(1, f32.length, SAMPLE_RATE);
  buf.copyToChannel(f32, 0);
  const src = voice.ctxOut.createBufferSource();
  src.buffer = buf;
  src.connect(voice.ctxOut.destination);
  const startAt = Math.max(voice.outCursor, voice.ctxOut.currentTime);
  src.start(startAt);
  voice.outCursor = startAt + f32.length / SAMPLE_RATE;
  voice.activeAudio.add(src);
  src.onended = () => voice.activeAudio.delete(src);
}

function stopAllAudio() {
  voice.audioGen++; // invalidate every frame queued before this barge-in
  for (const src of voice.activeAudio) {
    try {
      src.stop();
    } catch {}
  }
  voice.activeAudio.clear();
  voice.outCursor = voice.ctxOut ? voice.ctxOut.currentTime : 0;
}

function scheduleFlush() {
  if (voice.flushTimer) return;
  voice.flushTimer = setTimeout(flushMic, MIC_FLUSH_MS);
}

function flushMic() {
  voice.flushTimer = null;
  if (!voice.active || !voice.ws || voice.ws.readyState !== WebSocket.OPEN) return;
  if (voice.pending.length === 0) return;
  let total = 0;
  for (const c of voice.pending) total += c.length;
  const merged = new Int16Array(total);
  let off = 0;
  for (const c of voice.pending) {
    merged.set(c, off);
    off += c.length;
  }
  voice.pending.length = 0;
  try {
    voice.ws.send(merged.buffer);
  } catch (err) {
    console.warn("ws send failed", err);
  }
}

function onMicChunk(f32) {
  if (!voice.active) return;
  voice.pending.push(floatToPCM16(f32));
  scheduleFlush();
}

function playBinaryAudio(buf) {
  // Drop audio whose header predates the most recent barge-in (its generation
  // was invalidated by stopAllAudio). Prevents a cancelled response's tail
  // from resuming playback on top of the user / the next response.
  if (voice.pendingGen !== voice.audioGen) return;
  playPcmChunk(new Int16Array(buf));
}

function handleVoiceMessage(data) {
  // Binary frames are TTS audio chunks; the preceding `audio.header` JSON
  // stamped the current playback epoch used to gate barge-in tail frames.
  if (data instanceof ArrayBuffer) {
    playBinaryAudio(data);
    return;
  }
  if (data instanceof Blob) {
    data.arrayBuffer().then(playBinaryAudio);
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  switch (msg.type) {
    case "ready":
      setVoiceUI("on");
      break;
    case "state":
      try {
        render(msg.state);
      } catch {}
      break;
    case "tool":
      markToolUsed(msg.toolName || "tool");
      break;
    case "interrupted":
      // Barge-in: stop playback and bump the epoch so any tail frames already
      // in flight (their headers predate this) are dropped instead of resuming.
      stopAllAudio();
      break;
    case "speaking.done":
      break;
    case "audio.header":
      // Bind the binary frame that follows to the current playback epoch.
      voice.pendingGen = voice.audioGen;
      break;
    case "error":
      console.warn(`voice error: ${msg.message ?? "unknown"}`);
      break;
    default:
      // Unknown control message — ignore for forward compatibility.
      break;
  }
}

async function startVoice() {
  if (voice.active) return;
  setVoiceUI("connecting");
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    voice.ctxIn = new AudioContext({ sampleRate: SAMPLE_RATE });
    voice.ctxOut = new AudioContext({ sampleRate: SAMPLE_RATE });
    voice.outCursor = voice.ctxOut.currentTime;

    const blobUrl = URL.createObjectURL(
      new Blob([RECORDER_WORKLET], { type: "application/javascript" }),
    );
    await voice.ctxIn.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    voice.source = voice.ctxIn.createMediaStreamSource(voice.stream);
    voice.worklet = new AudioWorkletNode(voice.ctxIn, "recorder");
    voice.worklet.port.onmessage = (e) => onMicChunk(e.data);
    voice.source.connect(voice.worklet);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/voice`);
    ws.binaryType = "arraybuffer";
    voice.ws = ws;
    voice.active = true; // mic chunks queue immediately; flushMic gates on ws state

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "hello" }));
    });
    ws.addEventListener("message", (e) => handleVoiceMessage(e.data));
    ws.addEventListener("close", () => {
      if (voice.active) console.warn("voice stream disconnected");
      stopVoice(false);
    });
    ws.addEventListener("error", () => {
      console.warn("voice connection error");
    });
  } catch (err) {
    console.error(`voice start failed: ${err?.message ?? err}`);
    await stopVoice(false);
  }
}

async function stopVoice(closeSocket = true) {
  if (voice.flushTimer) {
    clearTimeout(voice.flushTimer);
    voice.flushTimer = null;
  }
  if (closeSocket && voice.ws) {
    try {
      voice.ws.close(1000, "client stop");
    } catch {}
  }
  voice.ws = null;
  if (voice.worklet) {
    try {
      voice.worklet.port.onmessage = null;
      voice.worklet.disconnect();
    } catch {}
    voice.worklet = null;
  }
  if (voice.source) {
    try {
      voice.source.disconnect();
    } catch {}
    voice.source = null;
  }
  if (voice.stream) {
    for (const t of voice.stream.getTracks()) t.stop();
    voice.stream = null;
  }
  stopAllAudio();
  if (voice.ctxIn) {
    try {
      await voice.ctxIn.close();
    } catch {}
    voice.ctxIn = null;
  }
  if (voice.ctxOut) {
    try {
      await voice.ctxOut.close();
    } catch {}
    voice.ctxOut = null;
  }
  voice.pending.length = 0;
  voice.active = false;
  setVoiceUI("off");
}

// CTA button is inside the preview frame and re-rendered on each state
// update, so delegate from the frame.
$frame.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("#site-cta") : null;
  if (!btn) return;
  if (voice.active) stopVoice();
  else startVoice();
});

loadInitialState();
