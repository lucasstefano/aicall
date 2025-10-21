import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import { Buffer } from "buffer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 🔒 Variáveis de ambiente
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;
const client = twilio(accountSid, authToken);

// Google STT client
const clientSTT = new speech.SpeechClient();

// =============================
// 1️⃣ Endpoint: iniciar chamada
// =============================
app.post("/make-call", async (req, res) => {
  const to = req.body.to || "+5521988392219";

  try {
    const call = await client.calls.create({
      to,
      from: fromNumber,
      url: `${baseUrl}/twiml`,
    });

    console.log("✅ Chamada iniciada:", call.sid);
    res.json({ message: "Chamada iniciada", sid: call.sid });
  } catch (error) {
    console.error("❌ Erro ao criar chamada:", error);
    res.status(500).send(error.message);
  }
});

// =============================
// 2️⃣ Endpoint: retorna TwiML
// =============================
app.post("/twiml", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  // Mensagem inicial
  response.say({ voice: "alice", language: "pt-BR" }, "Oi, estamos te ouvindo!");

  // Inicia streaming de áudio
  const start = response.start();
  start.stream({ url: `wss://${new URL(baseUrl).host}/media-stream` });

  // Mantém a chamada viva por 60s
  response.pause({ length: 60 });

  res.type("text/xml");
  res.send(response.toString());
});

// =============================
// 3️⃣ Função para converter μ-law para Linear16
// =============================
function muLawToLinear16(muLawBuffer: Buffer) {
  const linear16 = Buffer.alloc(muLawBuffer.length * 2);
  for (let i = 0; i < muLawBuffer.length; i++) {
    const mu = muLawBuffer[i];
    const sign = (mu & 0x80) ? -1 : 1;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    const sample = sign * (((mantissa << (exponent + 3)) + (1 << (exponent + 2)) - 132));
    linear16.writeInt16LE(sample, i * 2);
  }
  return linear16;
}

// =============================
// 4️⃣ WebSocket do Media Stream + STT
// =============================
const wss = new WebSocketServer({ noServer: true });

function createSTTStream() {
  return clientSTT
    .streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 8000,
        languageCode: "pt-BR",
      },
      interimResults: true,
    })
    .on("data", (data) => {
      if (data.results[0] && data.results[0].alternatives[0]) {
        console.log("📝 STT:", data.results[0].alternatives[0].transcript);
      }
    })
    .on("error", (err) => {
      console.error("❌ Erro no STT:", err);
    });
}

wss.on("connection", (ws) => {
  console.log("🎧 Novo stream de áudio conectado");
  const sttStream = createSTTStream();

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    switch (data.event) {
      case "start":
        console.log("🚀 Stream iniciado:", data.start.callSid);
        break;

      case "media":
        // Decodifica Base64 e converte μ-law → Linear16
        const audioBuffer = Buffer.from(data.media.payload, "base64");
        const linearBuffer = muLawToLinear16(audioBuffer);
        sttStream.write(linearBuffer);
        break;

      case "stop":
        console.log("🛑 Stream encerrado");
        sttStream.end();
        break;
    }
  });

  ws.on("close", () => {
    sttStream.end();
  });
});

// =============================
// 5️⃣ Servidor HTTP + WebSocket
// =============================
const server = app.listen(process.env.PORT || 8080, () => {
  console.log("🚀 Servidor iniciado na porta", process.env.PORT || 8080);
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
