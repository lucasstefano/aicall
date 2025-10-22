import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import textToSpeech from "@google-cloud/text-to-speech";
import { VertexAI } from '@google-cloud/vertexai';
import { PassThrough } from 'stream';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;

const client = twilio(accountSid, authToken);
const clientSTT = new speech.SpeechClient();
const clientTTS = new textToSpeech.TextToSpeechClient(); // 🔥 NOVO: Google TTS

// =============================
// 🧠 Configuração Vertex AI Gemini
// =============================
const vertex_ai = new VertexAI({
  project: process.env.GCLOUD_PROJECT,
  location: process.env.GCLOUD_LOCATION,
});

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
// 🎙️ Configuração Google TTS
// =============================
const ttsConfig = {
  voice: {
    languageCode: 'pt-BR',
    name: 'pt-BR-Wavenet-B', // 🔥 Voz premium em português
    ssmlGender: 'MALE'
  },
  audioConfig: {
    audioEncoding: 'MULAW', // 🔥 Compatível com Twilio
    sampleRateHertz: 8000,
    speakingRate: 1.0,
    pitch: 0.0,
    volumeGainDb: 0.0
  }
};

// 🔥 VOZES DISPONÍVEIS PARA PT-BR
const availableVoices = [
  'pt-BR-Wavenet-A', // Feminina
  'pt-BR-Wavenet-B', // Masculina (padrão)
  'pt-BR-Wavenet-C', // Feminina
  'pt-BR-Wavenet-D', // Masculina
  'pt-BR-Standard-A', // Feminina (standard)
  'pt-BR-Standard-B'  // Masculina (standard)
];

// =============================
// 🎯 Sistema de Fila para Respostas (MODIFICADO PARA TTS)
// =============================
class ResponseQueue {
  constructor() {
    this.queue = new Map();
    this.processingDelay = 2000;
    this.maxRetries = 3;
  }

  addResponse(callSid, responseText) {
    try {
      if (!this.queue.has(callSid)) {
        this.queue.set(callSid, { responses: [], isProcessing: false, retryCount: 0 });
      }
      
      const callQueue = this.queue.get(callSid);
      callQueue.responses.push({
        text: responseText,
        timestamp: new Date(),
        id: Date.now() + Math.random(),
        retries: 0
      });

      console.log(`📥 Fila [${callSid}]: "${responseText.substring(0, 50)}..."`);
      
      if (!callQueue.isProcessing) {
        this.processQueue(callSid);
      }
    } catch (error) {
      console.error(`❌ Erro adicionando resposta à fila [${callSid}]:`, error);
    }
  }

  async processQueue(callSid) {
    const callQueue = this.queue.get(callSid);
    if (!callQueue || callQueue.responses.length === 0) {
      if (callQueue) {
        callQueue.isProcessing = false;
        callQueue.retryCount = 0;
      }
      return;
    }

    callQueue.isProcessing = true;
    const response = callQueue.responses[0];

    try {
      console.log(`🎯 Processando TTS para [${callSid}]: "${response.text}"`);
      
      // 🔥 GERA ÁUDIO COM GOOGLE TTS
      const audioBuffer = await this.generateTTS(response.text);
      
      // 🔥 ENVIA ÁUDIO VIA TWIML PLAY
      await this.updateCallWithAudio(callSid, audioBuffer);
      
      // Remove da fila após sucesso
      callQueue.responses.shift();
      callQueue.retryCount = 0;
      
      console.log(`✅ Áudio TTS enviado para [${callSid}]. Restantes: ${callQueue.responses.length}`);
      
      // Agenda próximo processamento
      if (callQueue.responses.length > 0) {
        setTimeout(() => this.processQueue(callSid), this.processingDelay);
      } else {
        callQueue.isProcessing = false;
      }
      
    } catch (error) {
      console.error(`❌ Erro processando TTS [${callSid}]:`, error);
      
      // Mecanismo de retry
      response.retries += 1;
      if (response.retries >= this.maxRetries) {
        console.error(`🚫 Máximo de retries TTS para [${callSid}], removendo: ${response.text}`);
        callQueue.responses.shift();
      }
      
      callQueue.isProcessing = false;
      
      // Tenta novamente após delay
      if (callQueue.responses.length > 0) {
        const retryDelay = Math.min(5000 * response.retries, 30000);
        console.log(`🔄 Retentando TTS em ${retryDelay}ms...`);
        setTimeout(() => this.processQueue(callSid), retryDelay);
      }
    }
  }

  // 🔥 NOVO: Gera áudio usando Google TTS
  async generateTTS(text) {
    try {
      const request = {
        input: { text: text },
        voice: ttsConfig.voice,
        audioConfig: ttsConfig.audioConfig
      };

      console.log(`🔊 Gerando TTS: "${text.substring(0, 50)}..."`);
      
      const [response] = await clientTTS.synthesizeSpeech(request);
      
      if (!response.audioContent) {
        throw new Error('Resposta de TTS vazia');
      }
      
      console.log(`✅ TTS gerado: ${response.audioContent.length} bytes`);
      return response.audioContent;
      
    } catch (error) {
      console.error('❌ Erro gerando TTS:', error);
      throw error;
    }
  }

  // 🔥 MODIFICADO: Usa <Play> com áudio TTS em vez de <Say>
  async updateCallWithAudio(callSid, audioBuffer) {
    try {
      const twiml = new twilio.twiml.VoiceResponse();
      
      // 🔥 CONVERTE ÁUDIO PARA BASE64 E USA <PLAY>
      const audioBase64 = audioBuffer.toString('base64');
      twiml.play({}, `data:audio/mulaw;base64,${audioBase64}`);
      
      // Mantém o stream aberto
      const start = twiml.start();
      start.stream({ 
        url: `wss://${new URL(baseUrl).host}/media-stream`,
        track: "inbound_track"
      });
      
      twiml.pause({ length: 120 });

      await client.calls(callSid)
        .update({
          twiml: twiml.toString()
        });

      console.log(`✅ Áudio TTS enviado para [${callSid}]`);
      
    } catch (error) {
      console.error(`❌ Erro enviando áudio TTS [${callSid}]:`, error);
      
      if (error.code === 20404) {
        console.log(`📞 Chamada [${callSid}] não existe mais, limpando...`);
        this.cleanup(callSid);
      }
      
      throw error;
    }
  }

  cleanup(callSid) {
    this.queue.delete(callSid);
    console.log(`🧹 Fila TTS limpa para [${callSid}]`);
  }
}

const responseQueue = new ResponseQueue();

// =============================
// 🧠 Gemini Service (MELHORADO)
// =============================
class GeminiService {
  constructor() {
    this.conversationHistory = new Map();
    this.userIssues = new Map();
    this.maxHistoryLength = 6;
  }

  async generateWelcomeMessage(callSid, issue) {
    try {
      this.userIssues.set(callSid, issue);
      
      const prompt = `Crie uma MENSAGEM DE BOAS-VINDAS inicial em português brasileiro.

Contexto: ${issue}

Regras:
- Apenas UMA frase curta
- Seja amigável
- Linguagem natural

Sua mensagem:`;

      console.log(`🎯 Gerando mensagem de boas-vindas para: ${issue}`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const welcomeMessage = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      console.log(`🤖 Mensagem de boas-vindas: ${welcomeMessage}`);
      
      return welcomeMessage;
      
    } catch (error) {
      console.error(`❌ Erro gerando mensagem de boas-vindas [${callSid}]:`, error);
      return "Olá! Como posso te ajudar hoje?";
    }
  }

  async generateResponse(callSid, userMessage) {
    try {
      const history = this.getConversationHistory(callSid);
      const issue = this.userIssues.get(callSid);
      
      const recentHistory = history.slice(-3);
      
      const prompt = this.buildPrompt(userMessage, recentHistory, issue);
      
      console.log(`🧠 Gemini [${callSid}]: "${userMessage.substring(0, 50)}..."`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      
      if (!response.candidates || !response.candidates[0]) {
        throw new Error('Resposta vazia do Gemini');
      }
      
      const text = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      if (!text || text.length < 2) {
        throw new Error('Resposta muito curta do Gemini');
      }
      
      this.updateConversationHistory(callSid, userMessage, text);
      
      console.log(`🤖 Resposta [${callSid}]: "${text.substring(0, 50)}..."`);
      
      return text;
      
    } catch (error) {
      console.error(`❌ Erro Gemini [${callSid}]:`, error);
      
      const fallbacks = [
        "Pode repetir? Não entendi direito.",
        "Desculpe, não captei o que você disse. Pode falar novamente?",
        "Não consegui processar sua mensagem. Pode tentar de outra forma?",
        "Hmm, não entendi. Pode explicar de outra maneira?"
      ];
      
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }

  buildPrompt(userMessage, history, issue) {
    let prompt = `Você é um assistente em chamada telefônica. Responda em português brasileiro.

PROBLEMA: ${issue}

Regras:
- 1-2 frases no máximo
- Linguagem natural
- Foco no problema acima

Histórico:`;

    if (history.length > 0) {
      history.forEach(([user, assistant]) => {
        prompt += `\nUsuário: ${user}`;
        prompt += `\nVocê: ${assistant}`;
      });
    }

    prompt += `\n\nUsuário: ${userMessage}`;
    prompt += `\n\nSua resposta (curta, sobre "${issue}"):`;

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
    
    if (history.length > this.maxHistoryLength) {
      history.splice(0, history.length - this.maxHistoryLength);
    }
    
    this.conversationHistory.set(callSid, history);
  }

  cleanup(callSid) {
    this.conversationHistory.delete(callSid);
    this.userIssues.delete(callSid);
    console.log(`🧹 Histórico limpo para [${callSid}]`);
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
// 🎙️ Audio Stream Session
// =============================
class AudioStreamSession {
  constructor(ws, callSid, issue = null) {
    this.ws = ws;
    this.callSid = callSid;
    this.issue = issue;
    this.sttStream = null;
    this.isActive = false;
    this.lastFinalTranscript = "";
    this.geminiProcessing = false;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
    this.healthCheckInterval = null;
    
    console.log(`🎧 Nova sessão: ${callSid}, Issue: ${issue}`);
    this.setupSTT();
    this.startHealthCheck();
  }

  setupSTT() {
    try {
      this.sttStream = clientSTT
        .streamingRecognize(sttConfig)
        .on("data", (data) => {
          this.handleSTTData(data);
        })
        .on("error", (error) => {
          console.error(`❌ Erro STT [${this.callSid}]:`, error);
          this.consecutiveErrors++;
          this.checkHealth();
        })
        .on("end", () => {
          console.log(`🔚 Stream STT finalizado [${this.callSid}]`);
        });

      this.isActive = true;
      this.consecutiveErrors = 0;
      
    } catch (error) {
      console.error(`❌ Erro criando stream STT [${this.callSid}]:`, error);
      this.consecutiveErrors++;
    }
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        console.log(`🚑 Health check: Muitos erros consecutivos [${this.callSid}], reiniciando STT...`);
        this.restartSTT();
      }
    }, 10000);
  }

  restartSTT() {
    console.log(`🔄 Reiniciando STT para [${this.callSid}]...`);
    
    if (this.sttStream) {
      this.sttStream.removeAllListeners();
      this.sttStream.destroy();
      this.sttStream = null;
    }
    
    this.consecutiveErrors = 0;
    this.setupSTT();
  }

  checkHealth() {
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.restartSTT();
    }
  }

  async handleSTTData(data) {
    try {
      if (data.results && data.results[0]) {
        const result = data.results[0];
        const transcript = result.alternatives[0].transcript.trim();
        const isFinal = result.isFinal;

        if (!transcript) return;

        this.consecutiveErrors = 0;

        if (isFinal) {
          console.log(`📝 [FINAL] ${this.callSid}: ${transcript}`);
          
          if (transcript !== this.lastFinalTranscript && transcript.length > 2) {
            this.lastFinalTranscript = transcript;
            await this.processWithGemini(transcript);
          }
          
        } else {
          if (transcript.length > 8) {
            console.log(`🎯 [INTERIM] ${this.callSid}: ${transcript}`);
          }
        }
      }
    } catch (error) {
      console.error(`❌ Erro processando STT [${this.callSid}]:`, error);
      this.consecutiveErrors++;
      this.checkHealth();
    }
  }

  async processWithGemini(transcript) {
    if (this.geminiProcessing) {
      console.log(`⏳ Gemini ocupado [${this.callSid}], ignorando: ${transcript}`);
      return;
    }

    this.geminiProcessing = true;

    try {
      const geminiResponse = await geminiService.generateResponse(this.callSid, transcript);
      
      if (geminiResponse && geminiResponse.length > 2) {
        responseQueue.addResponse(this.callSid, geminiResponse);
      } else {
        console.log(`⚠️ Resposta Gemini vazia para [${this.callSid}]`);
      }
      
    } catch (error) {
      console.error(`❌ Erro processamento Gemini [${this.callSid}]:`, error);
      this.consecutiveErrors++;
      
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
        this.consecutiveErrors++;
        this.checkHealth();
      }
    }
  }

  cleanup() {
    this.isActive = false;
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    if (this.sttStream) {
      this.sttStream.removeAllListeners();
      this.sttStream.destroy();
      this.sttStream = null;
    }

    geminiService.cleanup(this.callSid);
    responseQueue.cleanup(this.callSid);
    
    console.log(`🔚 Sessão finalizada [${this.callSid}]`);
  }
}

// =============================
// 🔄 WebSocket Server
// =============================
const wss = new WebSocketServer({ 
  noServer: true,
  clientTracking: true
});

const activeSessions = new Map();
const pendingIssues = new Map();

wss.on("connection", (ws, req) => {
  console.log("🎧 Nova conexão WebSocket");
  let session = null;

  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      
      switch (data.event) {
        case "start":
          console.log("🚀 Iniciando stream:", data.start.callSid);
          
          const callSid = data.start.callSid;
          const issue = pendingIssues.get(callSid);
          
          if (activeSessions.has(callSid)) {
            session = activeSessions.get(callSid);
            session.ws = ws;
            console.log(`🔗 WebSocket reconectado para [${callSid}]`);
          } else {
            session = new AudioStreamSession(ws, callSid, issue);
            activeSessions.set(callSid, session);
            
            if (issue) {
              geminiService.generateWelcomeMessage(callSid, issue)
                .then(welcomeMessage => {
                  responseQueue.addResponse(callSid, welcomeMessage);
                })
                .catch(error => {
                  console.error(`❌ Erro welcome message [${callSid}]:`, error);
                  responseQueue.addResponse(callSid, "Olá! Como posso te ajudar?");
                });
            }
          }
          
          pendingIssues.delete(callSid);
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
    clearInterval(heartbeatInterval);
  });

  ws.on("error", (error) => {
    console.error("❌ Erro WebSocket:", error);
    clearInterval(heartbeatInterval);
  });

  ws.on("pong", () => {
    // Conexão está viva
  });
});

// =============================
// 📞 Endpoints Twilio
// =============================
app.post("/twiml", (req, res) => {
  try {
    const response = new twilio.twiml.VoiceResponse();

    // Mensagem inicial genérica (será substituída pelo TTS personalizado)
    response.say({ 
      voice: "alice", 
      language: "pt-BR" 
    }, "Olá! Um momento por favor.");

    const start = response.start();
    start.stream({ 
      url: `wss://${new URL(baseUrl).host}/media-stream`,
      track: "inbound_track"
    });

    response.pause({ length: 300 });

    res.type("text/xml");
    res.send(response.toString());
    
  } catch (error) {
    console.error("❌ Erro gerando TwiML:", error);
    res.status(500).send("Erro interno");
  }
});

app.post("/make-call", async (req, res) => {
  const to = req.body.to;
  const issue = req.body.issue || "Preciso de ajuda com um problema";

  if (!to) {
    return res.status(400).json({ error: "Número é obrigatório" });
  }

  try {
    const call = await client.calls.create({
      to: to.trim(),
      from: fromNumber,
      url: `${baseUrl}/twiml`,
      timeout: 15,
      statusCallback: `${baseUrl}/call-status`,
      statusCallbackEvent: ["answered", "completed"],
    });

    console.log(`✅ Chamada com Gemini + Google TTS iniciada: ${call.sid}, Issue: ${issue}`);
    
    pendingIssues.set(call.sid, issue);
    
    res.json({ 
      message: "Chamada com IA e voz natural iniciada", 
      sid: call.sid,
      issue: issue,
      features: ["STT", "Gemini AI", "Google TTS", "Voz natural"]
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
    pendingIssues.delete(CallSid);
  }
  
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    pending_issues: pendingIssues.size,
    features: ["STT", "Gemini AI", "Google TTS", "Voz natural premium"]
  });
});

// 🔥 ATUALIZADO: Interface mostra uso do Google TTS
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Twilio + Gemini AI + Google TTS</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 800px; margin: 0 auto; }
          .card { background: #f5f5f5; padding: 20px; margin: 20px 0; border-radius: 10px; }
          button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
          input, textarea { width: 100%; padding: 10px; margin: 5px 0; border: 1px solid #ddd; border-radius: 5px; }
          .feature { background: #e8f4fd; padding: 10px; margin: 5px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🤖 Twilio + Gemini AI + Google TTS</h1>
          
          <div class="feature">
            <strong>🎙️ Novo:</strong> Agora com <strong>Google Text-to-Speech</strong> - Voz natural em português!
          </div>
          
          <div class="card">
            <h3>Fazer Chamada com Voz Natural</h3>
            <form action="/make-call" method="POST">
              <input type="tel" name="to" placeholder="+5521988392219" value="+5521988392219" required>
              <textarea name="issue" placeholder="Descreva o problema que o usuário precisa resolver..." rows="3" required>Preciso de ajuda para configurar meu email no celular</textarea>
              <button type="submit">📞 Chamar com Voz Natural</button>
            </form>
            <p><small>O Gemini gera respostas e o Google TTS transforma em voz natural</small></p>
          </div>
          
          <div class="card">
            <h3>Status do Sistema</h3>
            <p>Sessões ativas: <strong>${activeSessions.size}</strong></p>
            <p>Issues pendentes: <strong>${pendingIssues.size}</strong></p>
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
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor com Gemini + Google TTS iniciado na porta ${PORT}`);
  console.log(`🤖 Gemini Model: ${model}`);
  console.log(`🔊 Google TTS: ${ttsConfig.voice.name}`);
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
  pendingIssues.clear();
  server.close(() => process.exit(0));
});