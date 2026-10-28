# Build a browser voice assistant app with AssemblyAI

A conversational voice assistant that runs in a browser tab. Click **Connect**, talk into your mic, and the assistant talks back. The whole pipeline runs on one AssemblyAI API key, which stays on a small Node server:

- **Speech-to-text:** [Universal-3.6 Pro Realtime](https://www.assemblyai.com/blog/universal-3-6-pro-realtime) (`universal-3-6-pro`) over a raw WebSocket, with turn detection built in
- **LLM:** any model from [LLM Gateway](https://www.assemblyai.com/docs/llm-gateway/available-models), called from the server
- **Text-to-speech:** the [AssemblyAI Text-to-Speech API](https://www.assemblyai.com/products/text-to-speech) (`assemblyai-tts-1`), opened in the browser with the SDK's `TextToSpeechSession`

Companion code for the blog post **[Build a voice assistant app with AssemblyAI](https://www.assemblyai.com/blog/build-a-voice-assistant-app-with-assemblyai)**.

## What's in the repo

| File | What it does |
|------|--------------|
| `server.js` | Serves the app and the SDK's browser build, mints speech-to-text and text-to-speech temporary tokens on `/api/tokens`, and calls the LLM through LLM Gateway on `/api/reply`. Your API key never leaves this process. |
| `public/pcm-worklet.js` | AudioWorklet that resamples mic audio to 16 kHz, 16-bit PCM off the main thread |
| `public/app.js` | The client: tokens, mic capture, the speech-to-text WebSocket, the `TextToSpeechSession`, gapless Web Audio playback, barge-in and a clean hang-up |
| `public/index.html` | The page: voice picker, system prompt, Connect / Hang up |

## Architecture

```
Browser                                              Node server (server.js)
┌──────────────────────────────────────┐            ┌─────────────────────────────────────┐
│ Connect ──► GET /api/tokens ─────────┼──────────► │ client.streaming.createTemporaryToken│
│                                      │ ◄───────── │ client.tts.createTemporaryToken      │
│                                      │ { stt, tts}└─────────────────────────────────────┘
│ getUserMedia ─► AudioWorklet         │
│   (resample to 16 kHz Int16 PCM)     │
│        │                             │
│        ▼                             │
│ WebSocket ?token=stt ────────────────┼──► wss://streaming.assemblyai.com/v3/ws
│   Begin / Turn / Termination ◄───────┼──   speech_model=universal-3-6-pro
│        │ end_of_turn: true           │
│        ▼                             │            ┌─────────────────────────────────────┐
│ POST /api/reply ─────────────────────┼──────────► │ client.llmGateway.chatCompletions   │
│        ◄──── { text } ───────────────┼─────────── └─────────────────────────────────────┘
│        │                             │
│        ▼                             │
│ TextToSpeechSession({ token: tts })  ├──► wss://tts.us.assemblyai.com/v1/ws
│   for await (chunk of tts.speak())   │      raw 16-bit PCM (24 kHz by default)
│        ▼                             │
│ AudioBufferSourceNode scheduling     │
│ Turn while speaking → tts.cancel()   │
│   + stop scheduled audio (barge-in)  │
└──────────────────────────────────────┘
```

| Event | What the app does |
|-------|-------------------|
| Speech-to-text `Begin` | Start streaming mic audio |
| `Turn` with `end_of_turn: false` | Show a live partial transcript |
| `Turn` with `end_of_turn: true` | Commit the user's message and ask the LLM for a reply |
| `Turn` while the agent is speaking | Barge in: `cancel()` the speech and stop playback (one-word backchannels like "mhm" are ignored) |
| Audio chunks from `speak()` | Convert Int16 to Float32 and schedule playback |
| Speech-to-text `Termination` | Close the speech session, release the mic |

## Prerequisites

- Node.js 18+ (native `fetch` and ES modules)
- A modern browser with AudioWorklet support (current Chrome, Edge, Firefox or Safari)
- An [AssemblyAI API key](https://www.assemblyai.com/dashboard/signup). LLM Gateway may require a paid account; if yours doesn't have access, point `/api/reply` at your own LLM provider.

The browser only allows mic access on a secure origin. `http://localhost` counts, so you can develop locally without TLS. Deploy anywhere else over HTTPS.

## Quick start

```bash
git clone https://github.com/kelsey-aai/voice-assistant-app
cd voice-assistant-app

npm install          # express, dotenv, assemblyai (4.42.0 or later)
cp .env.example .env # then set ASSEMBLYAI_API_KEY
npm start            # same as: node server.js
```

Open [http://localhost:3000](http://localhost:3000), click **Connect**, allow the mic and start talking. The assistant greets you, your words appear as a partial transcript and then a final message, and the agent's reply plays back.

The only environment variable is `ASSEMBLYAI_API_KEY`. It covers speech-to-text, LLM Gateway and text-to-speech.

## How it works

### 1. The server mints temporary tokens and calls the LLM

`/api/tokens` mints two tokens in one call, because speech-to-text and text-to-speech each need their own. `expires_in_seconds` is the window in which each token can open its connection; a session that is already open isn't affected when its token expires.

```js
const [stt, tts] = await Promise.all([
  client.streaming.createTemporaryToken({ expires_in_seconds: 60 }),
  client.tts.createTemporaryToken({ expires_in_seconds: 60 }),
]);
```

`/api/reply` sends the system prompt and the conversation to LLM Gateway with the same key:

```js
const completion = await client.llmGateway.chatCompletions({
  model: "qwen3.5-4b-32k-fast", // any model from the LLM Gateway model list
  messages: [{ role: "system", content: systemPrompt }, ...messages],
  max_tokens: 200,
});
```

The model name is an example; pick any model from the [LLM Gateway model list](https://www.assemblyai.com/docs/llm-gateway/available-models). Before you deploy, put authentication and rate limiting in front of both routes, since anyone who can reach them can spend your credits.

The server also serves the SDK's browser build at `/vendor/assemblyai.mjs`, so the page can `import { TextToSpeechSession } from "/vendor/assemblyai.mjs"` without a bundler.

### 2. An AudioWorklet captures and resamples mic audio

`public/pcm-worklet.js` runs on its own audio thread. It resamples from whatever rate the browser uses to 16 kHz, clips and posts Int16 buffers to the page. Safari ignores a requested `AudioContext` sample rate, and Firefox bypasses its echo canceller at non-default rates, so resampling in the worklet works the same everywhere and leaves the page's `AudioContext` at its native rate for playback.

### 3. Two sockets, two tokens

`connect()` in `public/app.js` opens the text-to-speech session with its token and the speech-to-text WebSocket with the other. Neither needs an API key in the page.

```js
tts = new TextToSpeechSession({
  token: tokens.tts,
  voiceId: document.querySelector("#voice").value,
  language: "english",
});
await tts.connect(); // resolves with the Begin frame

const params = new URLSearchParams({
  speech_model: "universal-3-6-pro",
  encoding: "pcm_s16le",
  sample_rate: "16000",
  token: tokens.stt,
});
stt = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
```

Mic audio starts flowing after `Begin`, batched into ~100 ms messages. When a `Turn` arrives with `end_of_turn: true`, the app sends the conversation to `/api/reply`.

### 4. Speak the reply and play raw PCM without gaps

`speakReply()` calls `tts.speak(text)`, which sends the text, flushes it and yields raw PCM as it's synthesized, so playback starts with the first chunk. The audio has no header, so the app converts each chunk to Float32, copies it into an `AudioBuffer` at the rate the session reported in `Begin` (`tts.begin.configuration.sample_rate`, 24 kHz by default), and schedules each buffer where the previous one ends.

### 5. Barge-in

While the agent is talking, a `Turn` of two or more words is a real interruption. `stopPlayback()` calls `tts.cancel()`, which stops the request in flight and ends the `speak()` loop at once, then stops every scheduled `AudioBufferSourceNode` and resets the playback cursor. Shorter turns ("mhm", "okay") are ignored; raise `MIN_WORDS` in `public/app.js` if short filler still gets through.

### 6. Hang up cleanly

**Hang up** sends `{"type": "Terminate"}` on the speech-to-text socket. The server finalizes the open turn and answers with `Termination`, and the app then calls `tts.close()`, which sends its own Terminate and waits for the session summary, and releases the mic and audio context.

## Customize

**Voice.** The dropdown sets `voiceId` on the text-to-speech session. It accepts a voice's UUID (the default is Audrey, `49c443a4-8a1d-5f7e-b70b-98bdbd9823c3`) or a library slug such as `aai-sara`. See the [voices guide](https://www.assemblyai.com/docs/tts/voices). To speak Spanish, French, German, Italian or Portuguese, set `language` to the language's English name, such as `"spanish"`. Voice and language are fixed for a session, so set them before you connect.

**System prompt.** The prompt travels with every `/api/reply` request, so edit the textarea and the next turn uses it. In production, keep the prompt on the server and let the page send only the conversation. Keep replies short and in full sentences with punctuation; the text-to-speech model takes its pacing and tone from the punctuation.

**Turn detection.** Universal-3.6 Pro Realtime decides when a turn ends on its own, and its defaults suit most conversations. Start there.

**Tools.** Tools live in the LLM request. To give the LLM a function, replace the `/api/reply` route with one that passes OpenAI-style `tools` to `client.llmGateway.chatCompletions`, runs the function the model asks for, appends the result as a `tool` message and calls the model again. The browser code doesn't change. The full route is in the blog post.

## Troubleshooting

**Mic blocked or no audio going up.** `getUserMedia` only works on secure origins. `http://localhost` counts; `http://your-laptop.local` doesn't. Also make sure `audioCtx.resume()` runs inside the click handler.

**Agent keeps interrupting itself.** Acoustic echo: the mic is picking up the speakers. Confirm `echoCancellation: true` and use headphones while developing.

**Transcripts are garbled.** Sample-rate mismatch. Every byte must go through the worklet's resampler, since the speech-to-text URL says `sample_rate=16000`.

**Replies arrive but nothing plays.** The speech session sends raw PCM with no header. Play it through the Web Audio API at the rate in `tts.begin.configuration.sample_rate`.

**`connect()` rejects as unauthorized, or a socket closes with 1008.** The token expired before the connection opened, or it was minted for the wrong product. Speech-to-text and text-to-speech each need their own token. Fetch fresh tokens for every connection and confirm `ASSEMBLYAI_API_KEY` is set on the server.

**The speech session closes after two idle minutes.** Call `tts.keepAlive()` on a timer while the user is quiet, or reconnect with fresh tokens. See the [limits page](https://www.assemblyai.com/docs/tts/limits).

## Resources

- [Blog post: Build a voice assistant app with AssemblyAI](https://www.assemblyai.com/blog/build-a-voice-assistant-app-with-assemblyai)
- [Text-to-Speech quickstart](https://www.assemblyai.com/docs/tts/getting-started/quickstart)
- [Choose a text-to-speech interface](https://www.assemblyai.com/docs/tts/getting-started/choose-an-interface)
- [Text-to-speech voices](https://www.assemblyai.com/docs/tts/voices)
- [Streaming speech-to-text](https://www.assemblyai.com/docs/streaming/getting-started/transcribe-streaming-audio)
- [LLM Gateway quickstart](https://www.assemblyai.com/docs/llm-gateway/quickstart)
- [AssemblyAI JavaScript SDK](https://github.com/AssemblyAI/assemblyai-node-sdk)
