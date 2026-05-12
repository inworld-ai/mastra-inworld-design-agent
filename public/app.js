const $log = document.getElementById("log");
const $form = document.getElementById("composer");
const $input = document.getElementById("input");
const $send = document.getElementById("send");
const $reset = document.getElementById("reset");
const $voice = document.getElementById("voice");
const $voiceLabel = $voice.querySelector(".voice-label");
const $frame = document.getElementById("preview-frame");

const history = []; // [{ role, content }]
let loadedFonts = new Set();

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function appendMessage(role, content) {
  const li = document.createElement("li");
  li.dataset.role = role;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = content;
  li.appendChild(bubble);
  $log.appendChild(li);
  $log.scrollTop = $log.scrollHeight;
  return bubble;
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
  const { theme, typography, layout, copy, features } = state;
  ensureFont(typography.fontFamily);

  $frame.style.setProperty("--site-bg", theme.bg);
  $frame.style.setProperty("--site-text", theme.text);
  $frame.style.setProperty("--site-accent", theme.accent);
  $frame.style.setProperty("--site-scale", String(typography.scale));
  $frame.style.fontFamily = `'${typography.fontFamily}', system-ui, sans-serif`;

  const featuresHtml = features
    .map(
      (f) => `
        <article class="site-feature">
          <h3>${escape(f.title)}</h3>
          <p>${escape(f.body)}</p>
        </article>`,
    )
    .join("");

  $frame.innerHTML = `
    <section class="site-hero" data-alignment="${escape(layout.alignment)}" data-variant="${escape(layout.heroVariant)}">
      <div>
        <h1>${escape(copy.headline)}</h1>
        <p class="site-subhead">${escape(copy.subheadline)}</p>
        <p class="site-body">${escape(copy.body)}</p>
        <a class="site-cta" href="#">${escape(copy.cta)}</a>
      </div>
      ${layout.heroVariant === "split" ? '<div aria-hidden="true"></div>' : ""}
    </section>
    <section class="site-features">${featuresHtml}</section>
  `;
}

async function loadInitialState() {
  const res = await fetch("/api/state");
  if (!res.ok) {
    appendMessage("system", `Could not load initial state (${res.status})`);
    return;
  }
  render(await res.json());
}

async function send(message) {
  history.push({ role: "user", content: message });
  appendMessage("user", message);
  $send.disabled = true;
  $input.disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });

    if (!res.ok) {
      const text = await res.text();
      appendMessage("system", `Server error ${res.status}: ${text.slice(0, 200)}`);
      return;
    }

    const data = await res.json();
    if (data.text) {
      history.push({ role: "assistant", content: data.text });
      appendMessage("assistant", data.text);
    }
    if (data.toolCalls && data.toolCalls.length > 0) {
      for (const call of data.toolCalls) {
        appendMessage("system", `🔧 ${call.tool}(${JSON.stringify(call.args)})`);
      }
    }
    if (data.state) render(data.state);
  } catch (err) {
    appendMessage("system", `Request failed: ${err?.message ?? err}`);
  } finally {
    $send.disabled = false;
    $input.disabled = false;
    $input.focus();
  }
}

$form.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $input.value.trim();
  if (!value) return;
  $input.value = "";
  send(value);
});

$reset.addEventListener("click", () => {
  history.length = 0;
  $log.innerHTML = "";
  send("reset");
});

/* ---------- Voice (OpenAI Realtime via SSE + chunked POSTs) ---------- */

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
  sessionId: null,
  evt: null,
  stream: null,
  ctxIn: null,
  ctxOut: null,
  source: null,
  worklet: null,
  pending: [],
  flushTimer: null,
  outCursor: 0,
  activeAudio: new Set(),
  bubbles: { user: null, assistant: null },
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

function decodeAudio(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // PCM16 little-endian
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

function setVoiceUI(on, label) {
  voice.active = on;
  $voice.setAttribute("aria-pressed", on ? "true" : "false");
  $voiceLabel.textContent = label || (on ? "Stop voice" : "Start voice");
}

function appendTranscript(role, text) {
  // Each role gets a single streaming bubble per turn. A `\n` chunk
  // from the server signals end-of-turn — finalize and reset.
  if (text === "\n") {
    voice.bubbles[role] = null;
    return;
  }
  if (!voice.bubbles[role]) {
    voice.bubbles[role] = appendMessage(role, "");
  }
  voice.bubbles[role].textContent += text;
  $log.scrollTop = $log.scrollHeight;
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
  for (const src of voice.activeAudio) {
    try { src.stop(); } catch {}
  }
  voice.activeAudio.clear();
  voice.outCursor = voice.ctxOut ? voice.ctxOut.currentTime : 0;
}

function scheduleFlush() {
  if (voice.flushTimer) return;
  voice.flushTimer = setTimeout(flushMic, MIC_FLUSH_MS);
}

async function flushMic() {
  voice.flushTimer = null;
  if (!voice.active || !voice.sessionId || voice.pending.length === 0) return;
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
    await fetch(`/api/voice/append?sid=${encodeURIComponent(voice.sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: merged.buffer,
    });
  } catch (err) {
    console.warn("voice append failed", err);
  }
}

function onMicChunk(f32) {
  if (!voice.active) return;
  voice.pending.push(floatToPCM16(f32));
  scheduleFlush();
}

async function startVoice() {
  if (voice.active) return;
  setVoiceUI(true, "Connecting…");
  try {
    const startRes = await fetch("/api/voice/start", { method: "POST" });
    if (!startRes.ok) {
      const msg = await startRes.text();
      throw new Error(`start failed (${startRes.status}): ${msg}`);
    }
    const { sessionId } = await startRes.json();
    voice.sessionId = sessionId;

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
    // Intentionally do NOT connect the worklet to ctxIn.destination — that
    // would loop the mic back to the speakers.

    voice.evt = new EventSource(
      `/api/voice/events?sid=${encodeURIComponent(sessionId)}`,
    );
    voice.evt.addEventListener("audio", (e) => {
      const { b64 } = JSON.parse(e.data);
      playPcmChunk(decodeAudio(b64));
    });
    voice.evt.addEventListener("audio.done", () => {
      // Let the queue drain naturally; nothing to do.
    });
    voice.evt.addEventListener("transcript", (e) => {
      const { text, role } = JSON.parse(e.data);
      appendTranscript(role, text);
    });
    voice.evt.addEventListener("state", (e) => {
      try { render(JSON.parse(e.data)); } catch {}
    });
    voice.evt.addEventListener("tool", (e) => {
      try {
        const payload = JSON.parse(e.data);
        appendMessage("system", `🔧 ${payload.toolName || payload.tool || 'tool'}(${JSON.stringify(payload.args || {})})`);
      } catch {}
    });
    voice.evt.addEventListener("turn.done", () => {
      voice.bubbles.user = null;
      voice.bubbles.assistant = null;
    });
    voice.evt.addEventListener("error", (e) => {
      try {
        const { message } = JSON.parse(e.data);
        appendMessage("system", `Voice error: ${message}`);
      } catch {
        appendMessage("system", "Voice error");
      }
    });
    voice.evt.addEventListener("closed", () => {
      stopVoice(false);
    });
    voice.evt.onerror = () => {
      // EventSource will reconnect on its own for transient issues; surface
      // a status only if we lose the stream permanently.
      if (voice.evt && voice.evt.readyState === EventSource.CLOSED) {
        appendMessage("system", "Voice stream disconnected");
        stopVoice(false);
      }
    };

    setVoiceUI(true, "Stop voice");
    appendMessage("system", "Voice on — talk to the designer.");
  } catch (err) {
    appendMessage("system", `Voice start failed: ${err?.message ?? err}`);
    await stopVoice(true);
  }
}

async function stopVoice(notifyServer = true) {
  const sid = voice.sessionId;
  if (voice.flushTimer) {
    clearTimeout(voice.flushTimer);
    voice.flushTimer = null;
  }
  if (voice.evt) {
    voice.evt.close();
    voice.evt = null;
  }
  if (voice.worklet) {
    try { voice.worklet.port.onmessage = null; voice.worklet.disconnect(); } catch {}
    voice.worklet = null;
  }
  if (voice.source) {
    try { voice.source.disconnect(); } catch {}
    voice.source = null;
  }
  if (voice.stream) {
    for (const t of voice.stream.getTracks()) t.stop();
    voice.stream = null;
  }
  stopAllAudio();
  if (voice.ctxIn) { try { await voice.ctxIn.close(); } catch {} voice.ctxIn = null; }
  if (voice.ctxOut) { try { await voice.ctxOut.close(); } catch {} voice.ctxOut = null; }
  voice.pending.length = 0;
  voice.bubbles.user = null;
  voice.bubbles.assistant = null;
  voice.sessionId = null;
  setVoiceUI(false, "Start voice");
  if (notifyServer && sid) {
    try {
      await fetch(`/api/voice/stop?sid=${encodeURIComponent(sid)}`, { method: "POST" });
    } catch {}
  }
}

$voice.addEventListener("click", () => {
  if (voice.active) stopVoice();
  else startVoice();
});

loadInitialState().then(() => {
  appendMessage(
    "system",
    "Connected. Type to the designer, or click Start voice to talk.",
  );
});
