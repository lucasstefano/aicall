import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import { Buffer } from "buffer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;

// -------------------------
// 🎙️ Google STT client
// -------------------------
const speechClient = new speech.SpeechClient();
function startSTTStream() {
  const request = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 8000,
      languageCode: "pt-BR",
    },
    interimResults: true,
  };
  const recognizeStream = speechClient
    .streamingRecognize(request)
    .on("error", (err) => console.error("❌ Erro STT:", err))
    .on("data", (data) => {
      const result = data.results?.[0];
      if (result) {
        const transcription = result.alternatives[0].transcript;
        console.log(`🗣️ ${transcription}`);
      }
    });
  return recognizeStream;
}

// -------------------------
// 🧠 Conversão μ-law → PCM16
// -------------------------
function muLawToLinear16(muLawBuffer) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  const linear16Buffer = Buffer.alloc(muLawBuffer.length * 2);
  for (let i = 0; i < muLawBuffer.length; i++) {
    let muLaw = ~muLawBuffer[i];
    let sign = (muLaw & 0x80) ? -1 : 1;
    let exponent = (muLaw >> 4) & 0x07;
    let mantissa = muLaw & 0x0F;
    let magnitude = ((mantissa << 4) + MULAW_BIAS) << (exponent + 3);
    let sample = sign * (magnitude - MULAW_MAX);
    linear16Buffer.writeInt16LE(sample, i * 2);
  }
  return linear16Buffer;
}

// -------------------------
// 📞 Endpoint de ligação
// -------------------------
app.post("/make-call", async (req, res) => {
  const client = twilio(accountSid, authToken);
  const to = req.body.to;
  try {
    const call = await client.calls.create({
      to,
      from: fromNumber,
      url: `${baseUrl}/twiml`,
    });
    console.log(`✅ Chamada iniciada: ${call.sid}`);
    res.send({ success: true, callSid: call.sid });
  } catch (err) {
    console.error("Erro ao iniciar chamada:", err);
    res.status(500).send("Erro ao iniciar chamada");
  }
});

// -------------------------
// 🔊 TwiML Stream
// -------------------------
app.post("/twiml", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `${baseUrl.replace("https", "wss")}/media-stream` });
  res.type("text/xml");
  res.send(twiml.toString());
});

// -------------------------
// 🔌 WebSocket Server
// -------------------------
const wss = new WebSocketServer({ noServer: true });
let packetCount = 0;

wss.on("connection", (ws) => {
  console.log("🎧 Novo stream de áudio conectado");
  const sttStream = startSTTStream();

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === "media") {
      const audioBytes = Buffer.from(data.media.payload, "base64");
      const pcm16 = muLawToLinear16(audioBytes);
      sttStream.write(pcm16);
      packetCount++;
      if (packetCount % 50 === 0) console.log(`📡 Pacotes recebidos: ${packetCount}`);
    }
    if (data.event === "stop") {
      console.log("🛑 Stream encerrado");
      sttStream.end();
    }
  });

  ws.on("close", () => {
    console.log("🔒 Conexão WS fechada.");
    sttStream.end();
  });
});

const server = app.listen(8080, () => {
  console.log("🚀 Servidor HTTP iniciado na porta 8080");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }
});
