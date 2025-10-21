import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 🔒 Variáveis de ambiente (configuradas no Cloud Run)
const accountSid = process.env.ACCOUNT_SID;
const authToken = process.env.AUTH_TOKEN;
const fromNumber = process.env.PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;
const client = twilio(accountSid, authToken);

// =============================
// 1️⃣ Endpoint: iniciar chamada
// =============================
app.post("/make-call", async (req, res) => {
  const to = "+5521988392219"; // 👈 Muda pro número de destino

  try {
    const call = await client.calls.create({
      to,
      from: fromNumber,
      url: `${baseUrl}/twiml`, // Twilio busca TwiML aqui
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

  // Inicia o streaming de áudio
  const start = response.start();
  start.stream({ url: `wss://${new URL(baseUrl).host}/media-stream` });

  // Mantém a chamada viva por 60s
  response.pause({ length: 60 });

  res.type("text/xml");
  res.send(response.toString());
});

// =============================
// 3️⃣ WebSocket do Media Stream
// =============================
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🎧 Novo stream de áudio conectado");

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    switch (data.event) {
      case "start":
        console.log("🚀 Stream iniciado:", data.start.callSid);
        break;
      case "media":
        console.log("🎤 Pacote de áudio:", data.media.payload?.slice(0, 20), "...");
        break;
      case "stop":
        console.log("🛑 Stream encerrado");
        break;
    }
  });
});

// Vincula o WebSocket ao servidor HTTP
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
