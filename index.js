import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import { Buffer } from "buffer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 🔒 Variáveis de ambiente (configuradas no Cloud Run)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;
const client = twilio(accountSid, authToken);

// 🎤 Cliente STT
const clientSTT = new speech.SpeechClient();

// =============================
// 1️⃣ Endpoint: iniciar chamada
// =============================
app.post("/make-call", async (req, res) => {
  const to = req.body.to || "+55SEUNUMEROAQUI";

  try {
    const call = await client.calls.create({
      to,
      from: fromNumber,
      url: `${baseUrl}/twiml`,
    });

    console.log("✅ Chamada iniciada:", call.sid);
    res.json({ message: "Chamada iniciada", sid: call.sid });
  } catch (error) {
    console.error("❌ Erro ao criar chamada:", error.message);
    res.status(500).send(error.message);
  }
});

// =============================
// 2️⃣ Endpoint: TwiML (voz + stream)
// =============================
app.post("/twiml", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  response.say({ voice: "alice", language: "pt-BR" }, "Oi, estamos te ouvindo!");

  // inicia streaming
  const start = response.start();
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/media-stream`;
  start.stream({ url: wsUrl });

  response.pause({ length: 60 });

  res.type("text/xml");
  res.send(response.toString());
});

// =============================
// 3️⃣ Função: decodificar μ-law → PCM
// =============================
function muLawDecodeSample(sample) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  sample = ~sample;
  let sign = (sample & 0x80) ? -1 : 1;
  let exponent = (sample & 0x70) >> 4;
  let mantissa = sample & 0x0F;
  let magnitude = ((mantissa << 4) + MULAW_BIAS) << (exponent + 2);
  return sign * (magnitude > MULAW_MAX ? MULAW_MAX : magnitude);
}

function decodeMuLaw(buffer) {
  const decoded = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    decoded[i] = muLawDecodeSample(buffer[i]);
  }
  return Buffer.from(decoded.buffer);
}

// =============================
// 4️⃣ Função: criar stream STT
// =============================
function createSTTStream() {
  const sttStream = clientSTT
    .streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 8000,
        languageCode: "pt-BR",
      },
      interimResults: true,
    })
    .on("data", (data) => {
      if (data.results[0]?.alternatives[0]) {
        console.log("🗣️ Transcrição:", data.results[0].alternatives[0].transcript);
      }
    })
    .on("error", (err) => console.error("❌ Erro STT:", err));

  return sttStream;
}

// =============================
// 5️⃣ WebSocket do Twilio Media Stream
// =============================
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🎧 Novo stream de áudio conectado");
  const sttStream = createSTTStream();

  let packetCount = 0;
  const interval = setInterval(() => {
    console.log(`📡 Pacotes recebidos: ${packetCount}`);
  }, 1000);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start":
          console.log("🚀 Stream iniciado:", data.start.callSid);
          break;
        case "media":
          packetCount++;
          const audio = Buffer.from(data.media.payload, "base64");
          const decoded = decodeMuLaw(audio);
          sttStream.write(decoded);
          break;
        case "stop":
          console.log("🛑 Stream encerrado");
          sttStream.end();
          break;
      }
    } catch (err) {
      console.error("❌ Erro ao processar mensagem:", err);
    }
  });

  ws.on("close", () => {
    clearInterval(interval);
    console.log("🔒 Conexão WS fechada.");
    sttStream.end();
  });
});

// =============================
// 6️⃣ Servidor HTTP + WS Upgrade
// =============================
const port = process.env.PORT || 8080;
const server = app.listen(port, () => {
  console.log(`🚀 Servidor iniciado na porta ${port}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
