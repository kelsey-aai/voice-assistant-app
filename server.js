// server.js: serves the app, mints temporary tokens and calls the LLM.
// Your API key never leaves this process.
import "dotenv/config";
import express from "express";
import { AssemblyAI } from "assemblyai";

const client = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });
const app = express();
app.use(express.json());
app.use(express.static("public"));
// The SDK's browser build is one self-contained ES module; serve it to the page.
app.get("/vendor/assemblyai.mjs", (req, res) =>
  res.sendFile("node_modules/assemblyai/dist/browser.mjs", { root: process.cwd() })
);

// One call mints both tokens: speech-to-text and text-to-speech each need their own.
app.get("/api/tokens", async (req, res) => {
  try {
    const [stt, tts] = await Promise.all([
      client.streaming.createTemporaryToken({ expires_in_seconds: 60 }),
      client.tts.createTemporaryToken({ expires_in_seconds: 60 }),
    ]);
    res.json({ stt, tts });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// The LLM call stays on the server too, through LLM Gateway with the same key.
app.post("/api/reply", async (req, res) => {
  const { systemPrompt, messages } = req.body;
  try {
    const completion = await client.llmGateway.chatCompletions({
      model: "qwen3.5-4b-32k-fast", // any model from the LLM Gateway model list
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 200,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Open http://localhost:3000"));
