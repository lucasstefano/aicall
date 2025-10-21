import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import { Buffer } from "buffer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 🔒 Variáveis de ambiente com validação
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;

// Validação das variáveis de ambiente
if (!accountSid || !authToken || !fromNumber || !baseUrl) {
  console.error("❌ Variáveis de ambiente faltando!");
  process.exit(1);
}

const client = twilio(accountSid, authToken);
const clientSTT = new speech.SpeechClient();

// =============================
// 1️⃣ Endpoint: iniciar chamada (Melhorado)
// =============================
app.post("/make-call", async (req, res) => {
  const to = req.body.to;

  if (!to) {
    return res.status(400).json({ 
      error: "Número de telefone é obrigatório" 
    });
  }

  try {
    const call = await client.calls.create({
      to: to.trim(),
      from: fromNumber,
      url: `${baseUrl}/twiml`,
      timeout: 30,
      statusCallback: `${baseUrl}/call-status`,
      statusCallbackEvent: ["completed", "failed", "busy", "no-answer"],
    });

    console.log("✅ Chamada iniciada:", call.sid);
    res.json({ 
      message: "Chamada iniciada", 
      sid: call.sid,
      status: call.status 
    });
  } catch (error) {
    console.error("❌ Erro ao criar chamada:", error);
    res.status(500).json({ 
      error: "Falha ao iniciar chamada",
      details: error.message 
    });
  }
});

// =============================
// 2️⃣ Endpoint: status da chamada
// =============================
app.post("/call-status", (req, res) => {
  console.log(`📞 Status da chamada ${req.body.CallSid}: ${req.body.CallStatus}`);
  res.status(200).send("OK");
});

// =============================
// 3️⃣ Endpoint: retorna TwiML (Melhorado)
// =============================
app.post("/twiml", (req, res) => {
  try {
    const response = new twilio.twiml.VoiceResponse();

    response.say({ 
      voice: "alice", 
      language: "pt-BR" 
    }, "Oi, estamos te ouvindo! Pode começar a falar.");

    const start = response.start();
    start.stream({ 
      url: `wss://${new URL(baseUrl).host}/media-stream`,
      track: "both_tracks" // Captura áudio inbound e outbound
    });

    // Mantém a chamada por 300s (5 minutos)
    response.pause({ length: 300 });

    res.type("text/xml");
    res.send(response.toString());
  } catch (error) {
    console.error("❌ Erro ao gerar TwiML:", error);
    res.status(500).send("Erro interno");
  }
});

// =============================
// 4️⃣ WebSocket do Media Stream + STT (MELHORADO)
// =============================
const wss = new WebSocketServer({ 
  noServer: true,
  clientTracking: true
});

// Configuração reutilizável do STT
const sttConfig = {
  config: {
    encoding: "MULAW", // Twilio usa MULAW, não LINEAR16
    sampleRateHertz: 8000,
    languageCode: "pt-BR",
    enableAutomaticPunctuation: true,
    model: "default"
  },
  interimResults: true,
};

class AudioStreamSession {
  constructor(ws) {
    this.ws = ws;
    this.sttStream = null;
    this.callSid = null;
    this.isActive = false;
    this.setupSTT();
  }

  setupSTT() {
    this.sttStream = clientSTT
      .streamingRecognize(sttConfig)
      .on("data", (data) => {
        this.handleSTTData(data);
      })
      .on("error", (error) => {
        console.error("❌ Erro no STT:", error);
        this.cleanup();
      })
      .on("end", () => {
        console.log("🔚 Stream STT finalizado");
      });
  }

  handleSTTData(data) {
    try {
      if (data.results && data.results[0]) {
        const result = data.results[0];
        const transcript = result.alternatives[0].transcript;
        
        if (result.isFinal) {
          console.log(`📝 [FINAL] ${this.callSid}: ${transcript}`);
          
          // Aqui você pode salvar no banco, enviar para API, etc.
          this.saveTranscript(transcript);
        } else {
          console.log(`🎯 [INTERIM] ${this.callSid}: ${transcript}`);
        }
      }
    } catch (error) {
      console.error("❌ Erro ao processar dados STT:", error);
    }
  }

  saveTranscript(transcript) {
    // Implemente a lógica para salvar a transcrição
    // Ex: banco de dados, arquivo, API externa
    console.log(`💾 Salvando transcrição: ${transcript}`);
  }

  handleMedia(payload) {
    if (this.sttStream && this.isActive) {
      try {
        const audioBuffer = Buffer.from(payload, "base64");
        this.sttStream.write(audioBuffer);
      } catch (error) {
        console.error("❌ Erro ao processar áudio:", error);
      }
    }
  }

  cleanup() {
    this.isActive = false;
    if (this.sttStream) {
      this.sttStream.end();
      this.sttStream = null;
    }
  }
}

wss.on("connection", (ws, req) => {
  console.log("🎧 Novo stream de áudio conectado");
  
  const session = new AudioStreamSession(ws);
  let heartbeatInterval;

  // Heartbeat para manter conexão ativa
  const setupHeartbeat = () => {
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
  };

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      
      switch (data.event) {
        case "start":
          console.log("🚀 Stream iniciado:", data.start.callSid);
          session.callSid = data.start.callSid;
          session.isActive = true;
          setupHeartbeat();
          break;

        case "media":
          if (session.isActive) {
            session.handleMedia(data.media.payload);
          }
          break;

        case "stop":
          console.log("🛑 Stream encerrado para:", session.callSid);
          session.cleanup();
          break;

        case "mark":
          console.log("📍 Evento mark:", data.mark.name);
          break;
      }
    } catch (error) {
      console.error("❌ Erro ao processar mensagem WebSocket:", error);
    }
  });

  ws.on("error", (error) => {
    console.error("❌ Erro WebSocket:", error);
    session.cleanup();
  });

  ws.on("close", () => {
    console.log("🔌 Conexão WebSocket fechada");
    session.cleanup();
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  });

  // Timeout de inatividade (5 minutos)
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log("⏰ Timeout de inatividade atingido");
      ws.close();
    }
  }, 300000);
});

// =============================
// 5️⃣ Health Check e Monitoramento
// =============================
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    connections: wss.clients.size
  });
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>Twilio Voice + STT</h1>
        <form action="/make-call" method="POST">
          <input type="tel" name="to" placeholder="Número destino" required>
          <button type="submit">Fazer Chamada</button>
        </form>
      </body>
    </html>
  `);
});

// =============================
// 6️⃣ Servidor HTTP + WebSocket
// =============================
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
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

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🔻 Recebido SIGTERM, encerrando servidor...");
  server.close(() => {
    wss.close();
    process.exit(0);
  });
});