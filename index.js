import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import { VertexAI } from '@google-cloud/vertexai';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const clientSTT = new speech.SpeechClient();

// =============================
// 🧠 Configuração Vertex AI Gemini
// =============================
const vertex_ai = new VertexAI();

const model = 'gemini-2.0-flash-001';
const generativeModel = vertex_ai.getGenerativeModel({
  model,
  generationConfig: {
    maxOutputTokens: 256,
    temperature: 0.2,
    topP: 0.8,
  },
});

// =============================
// 🎯 Sistema de Fila para Respostas
// =============================
class ResponseQueue {
  constructor() {
    this.queue = new Map(); // callSid -> { responses: [], isProcessing: false }
    this.processingDelay = 2000; // 2 segundos entre respostas
  }

  addResponse(callSid, responseText) {
    if (!this.queue.has(callSid)) {
      this.queue.set(callSid, { responses: [], isProcessing: false });
    }
    
    const callQueue = this.queue.get(callSid);
    callQueue.responses.push({
      text: responseText,
      timestamp: new Date(),
      id: Date.now() + Math.random()
    });

    console.log(`📥 Fila [${callSid}]: ${responseText.substring(0, 50)}...`);
    
    // Inicia processamento se não estiver processando
    if (!callQueue.isProcessing) {
      this.processQueue(callSid);
    }
  }

  async processQueue(callSid) {
    const callQueue = this.queue.get(callSid);
    if (!callQueue || callQueue.responses.length === 0) {
      if (callQueue) callQueue.isProcessing = false;
      return;
    }

    callQueue.isProcessing = true;
    const response = callQueue.responses.shift();

    try {
      console.log(`🎯 Processando resposta para [${callSid}]: ${response.text}`);
      
      // Atualiza o TwiML com a nova resposta
      await this.updateCallWithResponse(callSid, response.text);
      
      // Agenda próximo processamento
      setTimeout(() => this.processQueue(callSid), this.processingDelay);
      
    } catch (error) {
      console.error(`❌ Erro processando fila [${callSid}]:`, error);
      callQueue.isProcessing = false;
    }
  }

  async updateCallWithResponse(callSid, responseText) {
    try {
      // 🔥 Atualiza a chamada Twilio com novo TwiML
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say({ 
        voice: "alice", 
        language: "pt-BR" 
      }, responseText);
      
      // 🔥 Mantém o stream aberto para continuar ouvindo
      const start = twiml.start();
      start.stream({ 
        url: `wss://${new URL(process.env.BASE_URL).host}/media-stream`,
        track: "inbound_track"
      });
      
      twiml.pause({ length: 60 });

      await client.calls(callSid)
        .update({
          twiml: twiml.toString()
        });

      console.log(`✅ Resposta enviada para chamada [${callSid}]: ${responseText.substring(0, 30)}...`);
      
    } catch (error) {
      console.error(`❌ Erro atualizando chamada [${callSid}]:`, error);
      throw error;
    }
  }

  cleanup(callSid) {
    this.queue.delete(callSid);
    console.log(`🧹 Fila limpa para [${callSid}]`);
  }
}

// Instância global da fila
const responseQueue = new ResponseQueue();

// =============================
// 🧠 Gemini Service
// =============================
class GeminiService {
  constructor() {
    this.conversationHistory = new Map(); // callSid -> history
    this.maxHistoryLength = 10;
  }

  async generateResponse(callSid, userMessage) {
    try {
      const history = this.getConversationHistory(callSid);
      
      const prompt = this.buildPrompt(userMessage, history);
      
      console.log(`🧠 Gemini prompt para [${callSid}]: ${userMessage.substring(0, 100)}...`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const text = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      // Atualiza histórico
      this.updateConversationHistory(callSid, userMessage, text);
      
      console.log(`🤖 Gemini resposta para [${callSid}]: ${text.substring(0, 100)}...`);
      
      return text;
      
    } catch (error) {
      console.error(`❌ Erro Gemini [${callSid}]:`, error);
      return "Desculpe, não consegui processar sua mensagem. Pode repetir?";
    }
  }

  buildPrompt(userMessage, history) {
    let prompt = `Você é um assistente útil e amigável em uma chamada telefônica. 
Responda de forma clara, concisa e natural em português brasileiro.

Regras importantes:
- Respostas curtas (máximo 2 frases)
- Linguagem natural e conversacional
- Sem marcadores ou formatação
- Foco no que o usuário disse

Histórico recente:`;

    if (history.length > 0) {
      history.forEach(([user, assistant]) => {
        prompt += `\nUsuário: ${user}`;
        prompt += `\nAssistente: ${assistant}`;
      });
    } else {
      prompt += "\n(Nova conversa)";
    }

    prompt += `\n\nÚltima mensagem do usuário: ${userMessage}`;
    prompt += `\n\nSua resposta:`;

    return prompt;
  }

  getConversationHistory(callSid) {
    if (!this.conversationHistory.has(callSid)) {
      this.conversationHistory.set(callSid, []);
    }
    return this.conversationHistory.get(callSid);
  }

  updateConversationHistory(callSid, userMessage, assistantResponse) {
    const history = this.getConversationHistory(callSid);
    history.push([userMessage, assistantResponse]);
    
    // Mantém apenas o histórico recente
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
    
    this.conversationHistory.set(callSid, history);
  }

  cleanup(callSid) {
    this.conversationHistory.delete(callSid);
    console.log(`🧹 Histórico Gemini limpo para [${callSid}]`);
  }
}

const geminiService = new GeminiService();

// =============================
// 🎯 Configuração STT
// =============================
const sttConfig = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "pt-BR",
    enableAutomaticPunctuation: true,
    model: "phone_call",
    useEnhanced: true,
  },
  interimResults: true,
  interimResultsThreshold: 0.0,
  single_utterance: false
};

// =============================
// 🎙️ Audio Stream Session com Gemini
// =============================
class AudioStreamSession {
  constructor(ws, callSid) {
    this.ws = ws;
    this.callSid = callSid;
    this.sttStream = null;
    this.isActive = false;
    this.transcriptBuffer = [];
    this.lastFinalTranscript = "";
    this.geminiProcessing = false;
    
    console.log(`🎧 Nova sessão com Gemini: ${callSid}`);
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
      });

    this.isActive = true;
  }

  async handleSTTData(data) {
    try {
      if (data.results && data.results[0]) {
        const result = data.results[0];
        const transcript = result.alternatives[0].transcript.trim();
        const isFinal = result.isFinal;

        if (!transcript) return;

        if (isFinal) {
          console.log(`📝 [FINAL] ${this.callSid}: ${transcript}`);
          
          // 🔥 Evita processar a mesma transcrição múltiplas vezes
          if (transcript !== this.lastFinalTranscript) {
            this.lastFinalTranscript = transcript;
            await this.processWithGemini(transcript);
          }
          
          this.sendToWebhook('final', { transcript });
          
        } else {
          // Interim results para debug
          if (transcript.length > 10) {
            console.log(`🎯 [INTERIM] ${this.callSid}: ${transcript}`);
          }
        }
      }
    } catch (error) {
      console.error(`❌ Erro processando STT [${this.callSid}]:`, error);
    }
  }

  async processWithGemini(transcript) {
    // 🔥 Evita processamento concorrente para mesma chamada
    if (this.geminiProcessing) {
      console.log(`⏳ Gemini já processando [${this.callSid}], ignorando: ${transcript}`);
      return;
    }

    this.geminiProcessing = true;

    try {
      // 🔥 Gera resposta com Gemini
      const geminiResponse = await geminiService.generateResponse(this.callSid, transcript);
      
      // 🔥 Adiciona à fila para ser falada
      responseQueue.addResponse(this.callSid, geminiResponse);
      
    } catch (error) {
      console.error(`❌ Erro processamento Gemini [${this.callSid}]:`, error);
      
      // Resposta de fallback
      responseQueue.addResponse(this.callSid, "Desculpe, não entendi. Pode repetir?");
      
    } finally {
      this.geminiProcessing = false;
    }
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

  sendToWebhook(type, data) {
    const webhookUrl = `${process.env.BASE_URL}/transcription-webhook`;
    const payload = {
      callSid: this.callSid,
      type: type,
      timestamp: new Date().toISOString(),
      ...data
    };

    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(error => {
      console.error(`❌ Erro webhook [${this.callSid}]:`, error);
    });
  }

  cleanup() {
    this.isActive = false;
    
    if (this.sttStream) {
      this.sttStream.end();
      this.sttStream = null;
    }

    // Limpeza de recursos
    geminiService.cleanup(this.callSid);
    responseQueue.cleanup(this.callSid);
    
    console.log(`🔚 Sessão finalizada [${this.callSid}]`);
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
          console.log("🚀 Iniciando stream com Gemini:", data.start.callSid);
          
          if (activeSessions.has(data.start.callSid)) {
            session = activeSessions.get(data.start.callSid);
            session.ws = ws;
          } else {
            session = new AudioStreamSession(ws, data.start.callSid);
            activeSessions.set(data.start.callSid, session);
          }
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
      }
    } catch (error) {
      console.error("❌ Erro processando mensagem WebSocket:", error);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket fechado");
  });

  ws.on("error", (error) => {
    console.error("❌ Erro WebSocket:", error);
  });
});

// =============================
// 📞 Endpoints Twilio
// =============================
app.post("/twiml", (req, res) => {
  try {
    const response = new twilio.twiml.VoiceResponse();

    // Mensagem de boas-vindas inicial
    response.say({ 
      voice: "alice", 
      language: "pt-BR" 
    }, "Olá! Sou sua assistente inteligente. Pode falar que eu respondo!");

    const start = response.start();
    start.stream({ 
      url: `wss://${new URL(process.env.BASE_URL).host}/media-stream`,
      track: "inbound_track"
    });

    response.pause({ length: 300 }); // 5 minutos

    res.type("text/xml");
    res.send(response.toString());
    
  } catch (error) {
    console.error("❌ Erro gerando TwiML:", error);
    res.status(500).send("Erro interno");
  }
});

app.post("/make-call", async (req, res) => {
  const to = req.body.to;

  if (!to) {
    return res.status(400).json({ error: "Número é obrigatório" });
  }

  try {
    const call = await client.calls.create({
      to: to.trim(),
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.BASE_URL}/twiml`,
      timeout: 15,
      statusCallback: `${process.env.BASE_URL}/call-status`,
      statusCallbackEvent: ["answered", "completed"],
    });

    console.log("✅ Chamada com Gemini iniciada:", call.sid);
    res.json({ 
      message: "Chamada com IA iniciada", 
      sid: call.sid,
      features: ["STT", "Gemini AI", "Respostas em tempo real"]
    });
  } catch (error) {
    console.error("❌ Erro criando chamada:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================
// 🌐 Webhooks e Monitoramento
// =============================
app.post("/transcription-webhook", (req, res) => {
  const { callSid, type, transcript } = req.body;
  console.log(`📨 Webhook [${type}]: ${callSid} - "${transcript}"`);
  res.status(200).json({ received: true });
});

app.post("/call-status", (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`📞 Status [${CallStatus}]: ${CallSid}`);
  
  if (['completed', 'failed', 'busy'].includes(CallStatus)) {
    if (activeSessions.has(CallSid)) {
      const session = activeSessions.get(CallSid);
      session.cleanup();
      activeSessions.delete(CallSid);
    }
  }
  
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    features: ["STT", "Gemini AI", "Real-time Responses"]
  });
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Twilio + Gemini AI</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 800px; margin: 0 auto; }
          .card { background: #f5f5f5; padding: 20px; margin: 20px 0; border-radius: 10px; }
          button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🤖 Twilio + Gemini AI Assistant</h1>
          
          <div class="card">
            <h3>Fazer Chamada Inteligente</h3>
            <form action="/make-call" method="POST">
              <input type="tel" name="to" placeholder="+5521988392219" value="+5521988392219" required>
              <button type="submit">📞 Chamar com IA</button>
            </form>
            <p><small>O Gemini irá responder em tempo real suas mensagens</small></p>
          </div>
          
          <div class="card">
            <h3>Status do Sistema</h3>
            <p>Sessões ativas: <strong>${activeSessions.size}</strong></p>
            <a href="/health">Ver Health Check</a>
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
  console.log(`🚀 Servidor com Gemini iniciado na porta ${PORT}`);
  console.log(`🤖 Gemini Model: ${model}`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
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

process.on("SIGTERM", () => {
  console.log("🔻 Encerrando servidor...");
  activeSessions.forEach(session => session.cleanup());
  activeSessions.clear();
  server.close(() => process.exit(0));
});