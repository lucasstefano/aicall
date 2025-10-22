import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import { Buffer } from "buffer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const clientSTT = new speech.SpeechClient();

// =============================
// 🎯 Configuração STT Ultra-Responsiva
// =============================
const sttConfig = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "pt-BR",
    enableAutomaticPunctuation: true,
    model: "phone_call", // 🔥 Modelo específico para telefonía
    useEnhanced: true,
    audioChannelCount: 1,
    enableSeparateRecognitionPerChannel: false,
    // 🔥 Otimizações para resposta imediata
    maxAlternatives: 1,
    profanityFilter: false,
    enableWordTimeOffsets: false
  },
  interimResults: true,
  interimResultsThreshold: 0.0, // 🔥 ZERO - máximo de resultados intermediários
  single_utterance: false // 🔥 Não espera por pausas
};

// =============================
// 🎯 Classe de Sessão Melhorada
// =============================
class AudioStreamSession {
  constructor(ws, callSid) {
    this.ws = ws;
    this.callSid = callSid;
    this.sttStream = null;
    this.isActive = false;
    this.transcriptBuffer = [];
    this.lastInterimText = "";
    this.interimCount = 0;
    this.finalCount = 0;
    
    console.log(`🎧 Nova sessão para: ${callSid}`);
    this.setupSTT();
  }

  setupSTT() {
    this.sttStream = clientSTT
      .streamingRecognize(sttConfig)
      .on("data", (data) => {
        this.handleSTTData(data);
      })
      .on("error", (error) => {
        console.error(`❌ Erro STT [${this.callSid}]:`, error);
        this.sendToWebhook('error', { error: error.message });
      })
      .on("end", () => {
        console.log(`🔚 Stream STT finalizado [${this.callSid}]`);
      });

    this.isActive = true;
    
    // 🔥 Envia confirmação de conexão
    this.sendToClient({
      event: 'session_created',
      callSid: this.callSid,
      timestamp: new Date().toISOString(),
      message: 'Sessão de transcrição iniciada'
    });
  }

  handleSTTData(data) {
    try {
      if (data.results && data.results[0]) {
        const result = data.results[0];
        const transcript = result.alternatives[0].transcript.trim();
        const isFinal = result.isFinal;
        const stability = result.stability || 0;

        if (!transcript) return;

        const timestamp = new Date().toISOString();

        if (isFinal) {
          this.finalCount++;
          console.log(`📝 [FINAL#${this.finalCount}] ${this.callSid}: ${transcript}`);
          
          this.transcriptBuffer.push(transcript);
          
          // 🔥 Envia para webhook em tempo real
          this.sendToWebhook('final', {
            transcript: transcript,
            stability: stability,
            sequence: this.finalCount
          });

          // 🔥 Envia para cliente WebSocket
          this.sendToClient({
            event: 'transcription',
            type: 'final',
            transcript: transcript,
            timestamp: timestamp,
            sequence: this.finalCount,
            callSid: this.callSid
          });

        } else {
          this.interimCount++;
          
          // 🔥 Filtra interims muito similares aos anteriores
          if (this.shouldLogInterim(transcript)) {
            this.lastInterimText = transcript;
            console.log(`🎯 [INTERIM#${this.interimCount}] ${this.callSid}: ${transcript} (stability: ${stability.toFixed(2)})`);
            
            // 🔥 Envia interim significativo para webhook
            if (transcript.length > 3) { // Só envia se tiver conteúdo
              this.sendToClient({
                event: 'transcription',
                type: 'interim',
                transcript: transcript,
                timestamp: timestamp,
                stability: stability,
                sequence: this.interimCount,
                callSid: this.callSid
              });
            }
          }
        }
      }
    } catch (error) {
      console.error(`❌ Erro processando STT [${this.callSid}]:`, error);
    }
  }

  shouldLogInterim(newTranscript) {
    // 🔥 Evita spam de interims muito similares
    if (this.lastInterimText === newTranscript) return false;
    if (newTranscript.includes(this.lastInterimText) && newTranscript.length - this.lastInterimText.length < 3) return false;
    return true;
  }

  handleMedia(payload) {
    if (this.sttStream && this.isActive) {
      try {
        const audioBuffer = Buffer.from(payload, "base64");
        this.sttStream.write(audioBuffer);
      } catch (error) {
        console.error(`❌ Erro processando áudio [${this.callSid}]:`, error);
      }
    }
  }

  sendToClient(data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (error) {
        console.error(`❌ Erro enviando para cliente [${this.callSid}]:`, error);
      }
    }
  }

  sendToWebhook(type, data) {
    const webhookUrl = `${process.env.BASE_URL}/transcription-webhook`;
    const payload = {
      callSid: this.callSid,
      type: type,
      timestamp: new Date().toISOString(),
      ...data
    };

    // 🔥 Envia para webhook assincronamente
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(error => {
      console.error(`❌ Erro webhook [${this.callSid}]:`, error);
    });
  }

  getFullTranscript() {
    return this.transcriptBuffer.join(' ').trim();
  }

  cleanup() {
    this.isActive = false;
    
    // 🔥 Processa transcrição final completa
    const fullTranscript = this.getFullTranscript();
    if (fullTranscript) {
      console.log(`🧩 [TRANSCRIÇÃO COMPLETA] ${this.callSid}: ${fullTranscript}`);
      
      this.sendToWebhook('complete', {
        transcript: fullTranscript,
        finalCount: this.finalCount,
        interimCount: this.interimCount
      });

      this.sendToClient({
        event: 'transcription_complete',
        transcript: fullTranscript,
        finalCount: this.finalCount,
        interimCount: this.interimCount,
        callSid: this.callSid
      });
    }

    if (this.sttStream) {
      this.sttStream.end();
      this.sttStream = null;
    }

    console.log(`🔚 Sessão finalizada [${this.callSid}]: ${this.finalCount} finais, ${this.interimCount} interims`);
  }
}

// =============================
// 🔄 WebSocket Server
// =============================
const wss = new WebSocketServer({ noServer: true });
const activeSessions = new Map();

wss.on("connection", (ws, req) => {
  console.log("🎧 Nova conexão WebSocket");
  let session = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      
      switch (data.event) {
        case "start":
          console.log("🚀 Iniciando stream:", data.start.callSid);
          
          // 🔥 Cria nova sessão ou recupera existente
          if (activeSessions.has(data.start.callSid)) {
            session = activeSessions.get(data.start.callSid);
            session.ws = ws; // Atualiza WebSocket
          } else {
            session = new AudioStreamSession(ws, data.start.callSid);
            activeSessions.set(data.start.callSid, session);
          }
          
          ws.send(JSON.stringify({
            event: 'stream_started',
            callSid: data.start.callSid,
            timestamp: new Date().toISOString()
          }));
          break;

        case "media":
          if (session && session.isActive) {
            session.handleMedia(data.media.payload);
          }
          break;

        case "stop":
          console.log("🛑 Parando stream:", data.stop.callSid);
          if (session) {
            session.cleanup();
            activeSessions.delete(data.stop.callSid);
          }
          break;

        case "mark":
          console.log("📍 Mark:", data.mark.name);
          break;
      }
    } catch (error) {
      console.error("❌ Erro processando mensagem WebSocket:", error);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket fechado");
    if (session) {
      // Não remove a sessão imediatamente - pode reconectar
      console.log(`⏸️  WebSocket desconectado para: ${session.callSid}`);
    }
  });

  ws.on("error", (error) => {
    console.error("❌ Erro WebSocket:", error);
  });
});

// =============================
// 📞 Endpoints Twilio
// =============================

// 🔥 TwiML Ultra-Rápido
app.post("/twiml", (req, res) => {
  try {
    const response = new twilio.twiml.VoiceResponse();

    // Mensagem mínima para começar rápido
    response.say({ 
      voice: "alice", 
      language: "pt-BR" 
    }, "Oi, fale agora.");

    const start = response.start();
    start.stream({ 
      url: `wss://${new URL(process.env.BASE_URL).host}/media-stream`,
      track: "inbound_track"
    });

    response.pause({ length: 180 }); // 3 minutos

    res.type("text/xml");
    res.send(response.toString());
    
    console.log("📞 TwiML gerado para chamada nova");
  } catch (error) {
    console.error("❌ Erro gerando TwiML:", error);
    res.status(500).send("Erro interno");
  }
});

// 🔥 Endpoint para iniciar chamadas
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
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.BASE_URL}/twiml`,
      timeout: 15,
      record: false,
      statusCallback: `${process.env.BASE_URL}/call-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    console.log("✅ Chamada iniciada:", call.sid);
    res.json({ 
      message: "Chamada iniciada", 
      sid: call.sid,
      status: call.status,
      note: "Transcrição em tempo real ativa"
    });
  } catch (error) {
    console.error("❌ Erro criando chamada:", error);
    res.status(500).json({ 
      error: "Falha ao iniciar chamada",
      details: error.message 
    });
  }
});

// =============================
// 🌐 Webhooks para Transcrições
// =============================

// 🔥 Webhook principal para transcrições
app.post("/transcription-webhook", (req, res) => {
  const { callSid, type, transcript, timestamp, stability, sequence } = req.body;
  
  console.log(`📨 Webhook [${type}]: ${callSid} - "${transcript}"`);
  
  // Aqui você pode:
  // ✅ Salvar no banco de dados
  // ✅ Enviar para outro serviço
  // ✅ Integrar com frontend em tempo real
  // ✅ Processar com NLP
  
  res.status(200).json({ 
    received: true,
    callSid: callSid,
    type: type,
    timestamp: new Date().toISOString()
  });
});

// 🔥 Status da chamada
app.post("/call-status", (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`📞 Status [${CallStatus}]: ${CallSid}`);
  
  // 🔥 Limpa sessão quando chamada termina
  if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'busy') {
    if (activeSessions.has(CallSid)) {
      const session = activeSessions.get(CallSid);
      session.cleanup();
      activeSessions.delete(CallSid);
      console.log(`🧹 Sessão removida: ${CallSid}`);
    }
  }
  
  res.status(200).send("OK");
});

// =============================
// 📊 Dashboard e Monitoramento
// =============================

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    active_calls: Array.from(activeSessions.keys())
  });
});

app.get("/sessions", (req, res) => {
  const sessionsInfo = Array.from(activeSessions.entries()).map(([callSid, session]) => ({
    callSid: callSid,
    isActive: session.isActive,
    finalCount: session.finalCount,
    interimCount: session.interimCount,
    fullTranscript: session.getFullTranscript()
  }));
  
  res.json({
    total_sessions: activeSessions.size,
    sessions: sessionsInfo
  });
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Twilio Voice + STT</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 800px; margin: 0 auto; }
          form { margin: 20px 0; padding: 20px; border: 1px solid #ddd; }
          input, button { padding: 10px; margin: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎯 Twilio Voice + STT em Tempo Real</h1>
          <p>Sessões ativas: <strong>${activeSessions.size}</strong></p>
          
          <form action="/make-call" method="POST">
            <h3>Fazer Chamada de Teste</h3>
            <input type="tel" name="to" placeholder="+5521988392219" value="+5521988392219" required>
            <button type="submit">📞 Fazer Chamada</button>
          </form>
          
          <div>
            <h3>Links Úteis</h3>
            <ul>
              <li><a href="/health">Health Check</a></li>
              <li><a href="/sessions">Sessões Ativas</a></li>
            </ul>
          </div>
        </div>
      </body>
    </html>
  `);
});

// =============================
// 🚀 Servidor
// =============================
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`🎯 Webhook: ${process.env.BASE_URL}/transcription-webhook`);
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
  console.log("🔻 Encerrando servidor...");
  activeSessions.forEach(session => session.cleanup());
  activeSessions.clear();
  
  server.close(() => {
    wss.close();
    process.exit(0);
  });
});