// public/app.js (part 1): tokens, mic, and the two sockets
import { TextToSpeechSession } from "/vendor/assemblyai.mjs";

const STT_URL = "wss://streaming.assemblyai.com/v3/ws";
let stt, tts, audioCtx, micStream, workletNode;
const history = []; // the conversation so far, sent to /api/reply each turn

async function connect() {
  // 1. Fresh temporary tokens from our server, one pair per connection
  const res = await fetch("/api/tokens");
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const tokens = await res.json();

  // 2. Audio graph at the browser's default rate; the worklet resamples to 16 kHz
  audioCtx = new AudioContext();
  await audioCtx.resume(); // must run inside a click handler
  await audioCtx.audioWorklet.addModule("pcm-worklet.js");
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false },
  });
  workletNode = new AudioWorkletNode(audioCtx, "pcm-worklet");
  audioCtx.createMediaStreamSource(micStream).connect(workletNode);

  // 3. Text-to-speech session, opened with its token: no API key in the page
  tts = new TextToSpeechSession({
    token: tokens.tts,
    voiceId: document.querySelector("#voice").value,
    language: "english",
  });
  await tts.connect(); // resolves with the Begin frame

  // 4. Speech-to-text WebSocket, opened with its own token
  const params = new URLSearchParams({
    speech_model: "universal-3-6-pro",
    encoding: "pcm_s16le",
    sample_rate: "16000",
    token: tokens.stt,
  });
  stt = new WebSocket(`${STT_URL}?${params}`);
  stt.onmessage = (e) => handleEvent(JSON.parse(e.data));
  stt.onclose = (e) => setStatus(`Disconnected (${e.code})`);

  speakReply("Hi! What can I help you with today?");
}

// public/app.js (part 2): react to speech-to-text events
const MIN_WORDS = 2; // shorter turns during agent speech are backchannel ("mhm")
let pending = [];
let pendingSamples = 0;

function handleEvent(evt) {
  switch (evt.type) {
    case "Begin":
      setStatus("Listening");
      // Only start streaming mic audio once the session has begun
      workletNode.port.onmessage = (e) => sendMic(new Int16Array(e.data));
      break;
    case "Turn": {
      const words = evt.transcript.split(/\s+/).filter(Boolean).length;
      if (isSpeaking()) {
        if (words < MIN_WORDS) return; // "mhm" while the agent talks: ignore it
        stopPlayback();                // a real interruption: barge in
      }
      if (!evt.end_of_turn) {
        showPartial(evt.transcript);
      } else if (words > 0) {
        addMessage("You", evt.transcript);
        respond(evt.transcript);
      }
      break;
    }
    case "Termination":
      cleanup();
      break;
  }
}

// Worklet blocks are tiny; batch them into ~100 ms messages (1,600 samples at 16 kHz)
function sendMic(samples) {
  pending.push(samples);
  pendingSamples += samples.length;
  if (pendingSamples < 1600) return;

  const chunk = new Int16Array(pendingSamples);
  let offset = 0;
  for (const s of pending) {
    chunk.set(s, offset);
    offset += s.length;
  }
  pending = [];
  pendingSamples = 0;
  if (stt.readyState === WebSocket.OPEN) stt.send(chunk.buffer); // binary PCM
}

// public/app.js (part 3): ask the LLM, then speak the reply
let streaming = false; // audio still arriving from the TTS session
let turnId = 0;

async function respond(userText) {
  const myTurn = ++turnId;
  history.push({ role: "user", content: userText });

  const res = await fetch("/api/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemPrompt: document.querySelector("#prompt").value,
      messages: history,
    }),
  });
  const { text, error } = await res.json();
  if (!res.ok) return setStatus(`LLM error: ${error}`);
  if (myTurn !== turnId) return; // the user spoke again while the LLM was thinking

  await speakReply(text);
}

async function speakReply(text) {
  history.push({ role: "assistant", content: text });
  addMessage("Agent", text);
  streaming = true;
  try {
    // speak() sends the text, flushes it and yields raw PCM chunks.
    // The loop ends at the reply's FlushDone, or at once after cancel().
    for await (const chunk of tts.speak(text)) playChunk(chunk);
  } catch (err) {
    setStatus(`TTS error: ${err.message}`);
  } finally {
    streaming = false;
  }
}

// public/app.js (part 4): gapless playback of raw PCM
let playbackTime = 0;
const scheduled = new Set();

function playChunk(bytes) {
  // 16-bit little-endian PCM at the rate the session reports in Begin (24 kHz by default)
  const rate = tts.begin.configuration.sample_rate;
  const pcm = new Int16Array(bytes.slice().buffer); // copy: Int16Array needs an aligned buffer

  const buffer = audioCtx.createBuffer(1, pcm.length, rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);

  playbackTime = Math.max(playbackTime, audioCtx.currentTime);
  src.start(playbackTime); // schedule right after the previous chunk
  playbackTime += buffer.duration;

  scheduled.add(src);
  src.onended = () => scheduled.delete(src);
}

function isSpeaking() {
  return streaming || (audioCtx && playbackTime > audioCtx.currentTime);
}

// public/app.js (part 5): barge-in
function stopPlayback() {
  tts.cancel(); // stops synthesis and ends the speak() loop
  for (const src of scheduled) {
    try { src.stop(); } catch { /* already finished */ }
  }
  scheduled.clear();
  playbackTime = audioCtx.currentTime;
  turnId++; // drop any LLM reply still on its way
}

// public/app.js (part 6): end the session cleanly
function hangUp() {
  if (stt?.readyState === WebSocket.OPEN) {
    stt.send(JSON.stringify({ type: "Terminate" })); // server replies with Termination
  }
}

function cleanup() {
  stt?.close();
  tts?.close().catch(() => {}); // sends Terminate and waits for the summary
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  setStatus("Session ended");
}

// Tab closed or navigated away
window.addEventListener("pagehide", hangUp);

// public/app.js (part 7): minimal UI wiring
const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");
let partialEl = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function showPartial(text) {
  if (!partialEl) {
    partialEl = document.createElement("p");
    partialEl.className = "partial";
    logEl.append(partialEl);
  }
  partialEl.textContent = text;
}

function addMessage(who, text) {
  if (who === "You" && partialEl) {
    partialEl.remove();
    partialEl = null;
  }
  const p = document.createElement("p");
  p.textContent = `${who}: ${text}`;
  logEl.append(p);
}

document.querySelector("#connect").onclick = () =>
  connect().catch((err) => setStatus(err.message));
document.querySelector("#hangup").onclick = hangUp;
