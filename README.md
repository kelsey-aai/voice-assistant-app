# Build a voice assistant app with AssemblyAI's Voice Agent API

A production-shaped browser voice assistant in under 400 lines. Click **Connect**, talk into your laptop mic, and the agent talks back — over a single WebSocket, with the API key safely behind a tiny Node server.

This is the "real app" version of the [5-minute quickstart](../5min-quickstart): a polished UI, AudioWorklet mic capture, temporary-token auth, and full barge-in handling. The **AssemblyAI Voice Agent API** does the speech recognition, the LLM, and the TTS server-side — you're just shuttling audio bytes.

## Why one WebSocket beats a multi-service pipeline

A traditional browser voice agent needs you to wire up streaming STT, an LLM, and a TTS provider, then orchestrate audio routing between them in the browser. Every hop adds latency, every provider needs a key, and every glue layer adds a failure mode.

| | Multi-service browser pipeline | Voice Agent API |
|---|---|---|
| Services to wire up | STT + LLM + TTS (3+ vendors) | 1 |
| API keys to manage | 3+ | 1 |
| Round trips per turn | 3 (mic→STT→LLM→TTS→speaker) | 1 (mic→agent→speaker) |
| Browser key exposure | Hard to avoid | Solved by temp tokens |
| Turn detection | Configure separately | Built in |
| Barge-in / interruption | Implement yourself | Built in |
| Tool calling | Wire LLM tools manually | Built in |

The endpoint is one URL: `wss://agents.assemblyai.com/v1/ws`. Send 24 kHz PCM, get 24 kHz PCM back. That's it.

## Architecture

```
Browser (index.html)                          Node server (server.js)
┌────────────────────────────────┐           ┌────────────────────────────┐
│ getUserMedia({ echoCancel })   │           │ GET /api/voice-token       │
│       │                        │  fetch    │   ↓                        │
│       ▼                        │ ────────► │ Authorization: Bearer KEY  │
│ AudioWorklet (pcm-processor)   │           │ → agents.assemblyai.com/   │
│   Float32 → Int16 PCM          │  token    │   v1/token                 │
│       │                        │ ◄──────── │ → { token }                │
│       ▼                        │           └────────────────────────────┘
│ WebSocket  ?token=…            │
└──────┬─────────────────────────┘
       │  { type: "input.audio", audio: "<base64>" }
       │  { type: "session.update", session: {…} }
       ▼
┌─────────────────────────────────────────────────┐
│  wss://agents.assemblyai.com/v1/ws              │
│                                                 │
│  AssemblyAI Voice Agent API                     │
│  ├── Universal-3 Pro Streaming  (speech → text) │
│  ├── LLM                        (text → reply)  │
│  └── TTS                        (reply → audio) │
│                                                 │
│  + neural turn detection                        │
│  + barge-in handling                            │
│  + tool calling                                 │
└──────┬──────────────────────────────────────────┘
       │  { type: "reply.audio", data: "<base64 PCM>" }
       │  { type: "transcript.user" / "transcript.agent" }
       ▼
┌────────────────────────────────┐
│ AudioBufferSourceNode schedule │
│   playbackTime cursor          │
│   on barge-in: stop+reset      │
└────────────────────────────────┘
```

## Prerequisites

- Node.js 18+ (uses native `fetch` and ES modules)
- A modern browser (Chrome 66+, Firefox 76+, Safari 14.1+ — anything with `AudioWorklet`)
- An [AssemblyAI API key](https://www.assemblyai.com/dashboard/signup) — free tier available

The browser needs a secure origin to access the mic. `http://localhost` counts as secure, so you can develop locally without TLS. If you deploy this anywhere else, serve it over HTTPS.

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/kelsey-aai/voice-assistant-app
cd voice-assistant-app

npm install
```

### 2. Configure your API key

```bash
cp .env.example .env
# Edit .env — drop in your AssemblyAI API key
```

### 3. Run the app

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000), pick a voice, hit **Connect**, grant mic permission, and start talking. You'll see your speech transcribed live as a partial bubble, then committed to a final bubble, with the agent's reply streaming back in audio and text.

```
Voice Assistant                              ● Connected (sess_…)

You:   What can you do?
Agent: I can chat, answer questions, or help work through ideas — whatever
       you'd like.
```

That's the whole app. About 70 lines of server, ~400 of client (including UI styles).

## How it works

There are four moving parts: the token mint, the AudioWorklet that captures mic audio, the WebSocket loop that drives the conversation, and the playback scheduler that turns `reply.audio` events back into sound.

### 1. The server mints a temporary token

Your AssemblyAI API key never leaves the server. The browser asks `/api/voice-token` for a single-use token, valid for 5 minutes:

```js
// server.js
app.get("/api/voice-token", async (_req, res) => {
  const url = new URL("https://agents.assemblyai.com/v1/token");
  url.searchParams.set("expires_in_seconds", "300");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const { token } = await response.json();
  res.json({ token });
});
```

Tokens are single-use — you fetch a fresh one for every connection. The browser then opens the WebSocket with the token as a query parameter:

```js
ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${token}`);
```

### 2. The AudioWorklet captures mic audio

`AudioWorklet` runs your PCM conversion off the main thread, which keeps it glitch-free. The worklet receives Float32 samples (`-1.0..1.0`), clips them to range, and posts them back as a transferable `Int16Array` buffer:

```js
// public/pcm-processor.js
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}
```

The Voice Agent API expects 24 kHz PCM by default, so we force the entire `AudioContext` to 24 kHz on creation — no resampling needed:

```js
audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE }); // 24000
```

We also enable browser-level acoustic echo cancellation when grabbing the mic, so the agent doesn't interrupt itself by hearing its own TTS through the speakers:

```js
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
});
```

### 3. The WebSocket drives the conversation

`session.update` is the first message — it configures system prompt, greeting, and voice. After that, you stream `input.audio` events whenever the worklet hands you a frame:

```js
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      system_prompt: prompt.value,
      greeting: "Hi there — what can I help you with?",
      output: { voice: "ivy" },
    },
  }));
};

workletNode.port.onmessage = (e) => {
  ws.send(JSON.stringify({
    type: "input.audio",
    audio: arrayBufferToBase64(e.data),
  }));
};
```

The server replies with a stream of events. The ones we care about for UI:

| Event | What we do with it |
|-------|--------------------|
| `session.ready` | Save the `session_id`, start sending audio |
| `transcript.user.delta` | Render a partial bubble (italic, low-opacity) as the user speaks |
| `transcript.user` | Promote the partial to a final user message |
| `reply.audio` | Decode base64 PCM, schedule playback (see below) |
| `transcript.agent` | Render the agent's final reply (with `interrupted` if applicable) |
| `reply.done` (with `status: "interrupted"`) | Flush queued audio — user barged in |
| `session.error` | Surface error code in the status indicator |

### 4. Reply playback uses a scheduling cursor

`reply.audio` chunks arrive faster than they play — sometimes the whole reply is buffered before the first sample hits the speaker. Naively calling `source.start(0)` would overlap the chunks. Instead, we keep a `playbackTime` cursor and schedule each chunk back-to-back:

```js
function playPCM(b64) {
  const bytes  = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const int16  = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const float  = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 0x8000;

  const buffer = audioCtx.createBuffer(1, float.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(float);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  if (playbackTime < now) playbackTime = now;
  source.start(playbackTime);
  playbackTime += buffer.duration;

  scheduledSources.push(source);
}
```

### 5. Barge-in stops scheduled audio cold

When the user speaks over the agent, the server emits `reply.done` with `status: "interrupted"` and trims `transcript.agent` to what was actually spoken. The client's job is to drop any audio that was scheduled but hasn't played yet — otherwise the user hears the agent finishing a sentence after they've already moved on:

```js
function flushPlayback() {
  for (const src of scheduledSources) {
    try { src.stop(); } catch (_) {}
  }
  scheduledSources = [];
  playbackTime = audioCtx.currentTime;
}
```

That's the entire interruption story: stop every scheduled `AudioBufferSourceNode`, reset the cursor to "now."

## Customization

### Pick a different voice

The voice picker is wired to `session.output.voice`. The dropdown ships 16 popular options — drop any voice ID into the `<select>` to add more. Eighteen English voices and 16 multilingual voices are available in total:

```html
<option value="james">James (US, conversational)</option>
<option value="diego">Diego (Spanish, Latin American)</option>
<option value="arjun">Arjun (Hindi/Hinglish)</option>
```

See the [Voices catalog](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices) for samples of each. Multilingual voices code-switch with English automatically.

### Change the personality with the system prompt

The textarea is bound to `session.system_prompt`. Tighten it for shorter replies, give it a persona, or scope it to a specific use case:

```text
You are a customer-support agent for Acme Cloud Storage. Only answer
questions about Acme's products, plans, and account billing. If the user
asks about anything else, politely redirect.
```

You can also re-send `session.update` mid-conversation to swap personas live. (Note: `greeting` and `output` are immutable after the first apply — only `system_prompt`, `tools`, and `input` can change mid-session.)

### Tune turn detection

Add `input.turn_detection` to the `session.update` payload to control how patient the agent feels:

```js
session: {
  input: {
    turn_detection: {
      vad_threshold: 0.5,        // 0.0–1.0; higher = less sensitive
      min_silence: 600,          // ms; min silence before end-of-turn check
      max_silence: 1500,         // ms; hard cap before forcing end-of-turn
      interrupt_response: true,  // false to disable barge-in entirely
    },
  },
}
```

For noisy environments, raise `vad_threshold`. For deliberate speech (healthcare, eldercare) raise `max_silence`.

## Troubleshooting

**`Mic blocked` or no audio going up.** Browsers only allow `getUserMedia` on secure origins. `http://localhost` counts; `http://your-laptop.local` doesn't. If you're testing across devices, terminate TLS in front of the Node server (Caddy, Cloudflare Tunnel, ngrok).

**Agent keeps interrupting itself.** Acoustic echo — the mic is picking up the speakers. Use headphones, or confirm `echoCancellation: true` is set on `getUserMedia`. The browser's OS-level AEC is much better than anything you'll write yourself.

**Audio sounds chipmunky or slowed-down.** Sample-rate mismatch. The `AudioContext` must be created with `{ sampleRate: 24000 }`. If you skip that, the browser creates the context at 44.1 or 48 kHz and the math falls apart.

**`UNAUTHORIZED` close on connect.** Token wasn't included, expired, or was already used. Tokens are single-use — fetch a fresh one for every connection. Confirm `ASSEMBLYAI_API_KEY` is set on the server.

**WebSocket closes with code 1006 and no error.** Pre-handshake failure. In browsers, that's usually a stale or invalid token. Re-fetch the token before reconnecting.

The full troubleshooting guide is in the [Voice Agent API docs](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/troubleshooting).

## Related tutorials

- **Voice Agent API 5-minute quickstart** — minimal Python quickstart — the simplest version of this stack
- **Voice agent that makes outbound calls** — Twilio outbound + Media Streams bridge with `audio/pcmu`
- **Twilio phone agent** — inbound phone calls — Twilio Media Streams + `audio/pcmu`
- **LiveKit voice agent** — Voice Agent API behind a LiveKit room for multi-user / WebRTC
- **Agora voice agent** — Voice Agent API behind an Agora RTC channel
- **Daily.co voice agent** — Voice Agent API behind a Daily room using `daily-python`
- **Node.js voice agent** — JavaScript version of the 5-minute quickstart
- **Raw WebSocket voice agent** — every protocol event handled explicitly, with tool calling and session resume

## FAQ

### What is AssemblyAI's Voice Agent API?

AssemblyAI's Voice Agent API is a single WebSocket endpoint that handles the entire voice agent pipeline server-side — speech-to-text, LLM reasoning, and text-to-speech — so you can build a conversational voice agent without wiring up separate STT, LLM, and TTS providers. It includes neural turn detection, barge-in, tool calling, and 30+ voices out of the box. The endpoint is `wss://agents.assemblyai.com/v1/ws`.

### How do I use the Voice Agent API from the browser without exposing my API key?

Run a small backend that mints short-lived [temporary tokens](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration) by calling `GET https://agents.assemblyai.com/v1/token` with your API key in an `Authorization: Bearer` header. The browser fetches a fresh token from your server before each WebSocket connection and passes it as `?token=` in the URL. Tokens are single-use and expire in 1–600 seconds. This tutorial's `server.js` shows the full pattern.

### What audio format does the browser need to send to the Voice Agent API?

By default, the Voice Agent API expects `audio/pcm` — 16-bit signed little-endian PCM at 24,000 Hz, mono, base64-encoded. From the browser, the cleanest way to produce that is to create the `AudioContext` with `{ sampleRate: 24000 }` so no resampling is needed, then use an `AudioWorklet` to convert Float32 mic samples to `Int16Array` and base64-encode the buffer before sending it as `{ "type": "input.audio", "audio": "..." }`.

### How do I handle interruption (barge-in) in a browser voice agent?

When the user speaks while the agent is replying, the server emits `reply.done` with `status: "interrupted"` and a `transcript.agent` event with `interrupted: true` and the text trimmed to what was actually spoken. The browser must stop any `AudioBufferSourceNode`s it has already scheduled with `source.start(playbackTime)` and reset its `playbackTime` cursor to `audioCtx.currentTime` so the next reply starts cleanly. Otherwise, queued audio plays after the user has already moved on.

### Why does my voice agent keep interrupting itself in the browser?

Almost always acoustic echo: the mic is picking up the agent's TTS output through the speakers, which the server interprets as the user starting a new turn and triggers barge-in. Pass `echoCancellation: true` to `navigator.mediaDevices.getUserMedia({ audio: { ... } })` to enable the browser's OS-level acoustic echo cancellation, and prefer headphones during development. Browser AEC is dramatically better than anything you'd implement by hand.

### Can the Voice Agent API call tools or functions from the browser?

Yes — tool calling works the same way client-side. Register tool definitions in `session.tools` on a `session.update` event. When the agent decides to call a tool, the server emits a `tool.call` event with `call_id`, `name`, and `arguments` (a dict). Execute the tool in your client code, then send a `tool.result` event when you receive the next `reply.done` (not immediately on `tool.call`). See the [tool calling guide](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tool-calling) for the full pattern.

### How much does the AssemblyAI Voice Agent API cost?

AssemblyAI offers a free tier so you can build and test without a credit card. For current pricing, see the [AssemblyAI pricing page](https://www.assemblyai.com/pricing).

## Resources

- [Voice Agent API overview](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
- [Browser integration guide](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration)
- [Session configuration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration)
- [Audio format](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/audio-format)
- [Events reference](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference)
- [Voices catalog](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices)
- [Tool calling](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tool-calling)
- [Troubleshooting](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/troubleshooting)

---

<div class="blog-cta_component">
  <div class="blog-cta_title">Ship a browser voice agent today</div>
  <div class="blog-cta_rt w-richtext">
    <p>Sign up for a free AssemblyAI account and put a real voice assistant on your website with the Voice Agent API. No credit card required.</p>
  </div>
  <a href="https://www.assemblyai.com/dashboard/signup" class="button w-button">Start building</a>
</div>

<div class="blog-cta_component">
  <div class="blog-cta_title">Read the browser-integration guide</div>
  <div class="blog-cta_rt w-richtext">
    <p>The official walkthrough of temporary tokens, AudioWorklet capture, and reply scheduling for the Voice Agent API. Pair it with this tutorial for a complete picture.</p>
  </div>
  <a href="https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration" class="button w-button">Read the docs</a>
</div>
