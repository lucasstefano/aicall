import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import textToSpeech from "@google-cloud/text-to-speech";
import { VertexAI } from '@google-cloud/vertexai';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/audio', express.static('audio'));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;

const client = twilio(accountSid, authToken);
const clientSTT = new speech.SpeechClient();
const clientTTS = new textToSpeech.TextToSpeechClient();

const audioDir = join(process.cwd(), 'audio');
if (!existsSync(audioDir)) {
  mkdirSync(audioDir, { recursive: true });
}

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
    name: 'pt-BR-Wavenet-B',
    ssmlGender: 'MALE'
  },
  audioConfig: {
    audioEncoding: 'MP3',
    sampleRateHertz: 8000,
    speakingRate: 1.0,
    pitch: 0.0,
    volumeGainDb: 0.0
  }
};

// =============================
// 🎯 Sistema de Fila para Respostas (COM BUFFER DE FALA)
// =============================
class ResponseQueue {
  constructor() {
    this.queue = new Map();
    this.processingDelay = 2000;
    this.maxRetries = 3;
    this.audioFileCleanup = new Map();
  }

  addResponse(callSid, responseText) {
    try {
      if (!this.queue.has(callSid)) {
        this.queue.set(callSid, { 
          responses: [], 
          isProcessing: false, 
          retryCount: 0,
          isTTSPlaying: false // 🔥 NOVO: Controla se TTS está tocando
        });
        this.audioFileCleanup.set(callSid, []);
      }
      
      const callQueue = this.queue.get(callSid);
      callQueue.responses.push({
        text: responseText,
        timestamp: new Date(),
        id: Date.now() + Math.random(),
        retries: 0
      });

      console.log(`📥 Fila [${callSid}]: "${responseText.substring(0, 50)}..."`);
      
      if (!callQueue.isProcessing && !callQueue.isTTSPlaying) {
        this.processQueue(callSid);
      }
    } catch (error) {
      console.error(`❌ Erro adicionando resposta à fila [${callSid}]:`, error);
    }
  }

  // 🔥 NOVO: Marca quando TTS começa/termina
  setTTSPlaying(callSid, isPlaying) {
    if (this.queue.has(callSid)) {
      const callQueue = this.queue.get(callSid);
      callQueue.isTTSPlaying = isPlaying;
      console.log(`🔊 TTS [${callSid}]: ${isPlaying ? 'INICIADO' : 'FINALIZADO'}`);
      
      // Se TTS terminou e há respostas na fila, processa
      if (!isPlaying && callQueue.responses.length > 0 && !callQueue.isProcessing) {
        setTimeout(() => this.processQueue(callSid), 500);
      }
    }
  }

  async processQueue(callSid) {
    const callQueue = this.queue.get(callSid);
    if (!callQueue || callQueue.responses.length === 0 || callQueue.isTTSPlaying) {
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
      
      // 🔥 MARCA QUE TTS VAI COMEÇAR
      this.setTTSPlaying(callSid, true);
      
      const audioUrl = await this.generateAndHostTTS(callSid, response.text);
      await this.updateCallWithAudioURL(callSid, audioUrl);
      
      callQueue.responses.shift();
      callQueue.retryCount = 0;
      
      console.log(`✅ Áudio TTS enviado para [${callSid}]. Restantes: ${callQueue.responses.length}`);
      
      // 🔥 AGUARDA O TTS TERMINAR ANTES DE PROCESSAR PRÓXIMO
      // O TTS dura aproximadamente (texto.length / 10) segundos
      const estimatedTTSTime = Math.max(response.text.length / 8 * 1000, 2000);
      setTimeout(() => {
        this.setTTSPlaying(callSid, false);
        
        if (callQueue.responses.length > 0) {
          setTimeout(() => this.processQueue(callSid), 500);
        } else {
          callQueue.isProcessing = false;
        }
      }, estimatedTTSTime);
      
    } catch (error) {
      console.error(`❌ Erro processando TTS [${callSid}]:`, error);
      
      // 🔥 GARANTE QUE TTS ESTÁ PARADO MESMO EM ERRO
      this.setTTSPlaying(callSid, false);
      
      response.retries += 1;
      if (response.retries >= this.maxRetries) {
        console.error(`🚫 Máximo de retries TTS para [${callSid}], removendo: ${response.text}`);
        callQueue.responses.shift();
      }
      
      callQueue.isProcessing = false;
      
      if (callQueue.responses.length > 0) {
        const retryDelay = Math.min(5000 * response.retries, 30000);
        console.log(`🔄 Retentando TTS em ${retryDelay}ms...`);
        setTimeout(() => this.processQueue(callSid), retryDelay);
      }
    }
  }

  async generateAndHostTTS(callSid, text) {
    try {
      const request = {
        input: { text: text },
        voice: ttsConfig.voice,
        audioConfig: {
          ...ttsConfig.audioConfig,
          audioEncoding: 'MP3'
        }
      };

      console.log(`🔊 Gerando TTS MP3: "${text.substring(0, 50)}..."`);
      
      const [response] = await clientTTS.synthesizeSpeech(request);
      
      if (!response.audioContent) {
        throw new Error('Resposta de TTS vazia');
      }
      
      const filename = `tts_${callSid}_${Date.now()}.mp3`;
      const filepath = join(audioDir, filename);
      
      writeFileSync(filepath, response.audioContent, 'binary');
      
      if (this.audioFileCleanup.has(callSid)) {
        this.audioFileCleanup.get(callSid).push(filepath);
      }
      
      const audioUrl = `${baseUrl}/audio/${filename}`;
      console.log(`✅ TTS salvo: ${filename} (${response.audioContent.length} bytes)`);
      
      return audioUrl;
      
    } catch (error) {
      console.error('❌ Erro gerando/hospedando TTS:', error);
      throw error;
    }
  }

  async updateCallWithAudioURL(callSid, audioUrl) {
    try {
      const twiml = new twilio.twiml.VoiceResponse();
      
      twiml.play({}, audioUrl);
      
      const start = twiml.start();
      start.stream({ 
        url: `wss://${new URL(baseUrl).host}/media-stream`,
        track: "inbound_track"
      });
      
      twiml.pause({ length: 120 });

      const twimlString = twiml.toString();
      console.log(`📊 TwiML size: ${twimlString.length} chars`);
      
      if (twimlString.length > 4000) {
        throw new Error(`TwiML muito grande: ${twimlString.length} caracteres`);
      }

      await client.calls(callSid)
        .update({
          twiml: twimlString
        });

      console.log(`✅ Áudio TTS enviado via URL para [${callSid}]`);
      
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
    if (this.audioFileCleanup.has(callSid)) {
      const audioFiles = this.audioFileCleanup.get(callSid);
      audioFiles.forEach(filepath => {
        try {
          if (existsSync(filepath)) {
            unlinkSync(filepath);
            console.log(`🗑️ Arquivo de áudio removido: ${filepath}`);
          }
        } catch (error) {
          console.error(`❌ Erro removendo arquivo ${filepath}:`, error);
        }
      });
      this.audioFileCleanup.delete(callSid);
    }
    
    this.queue.delete(callSid);
    console.log(`🧹 Fila TTS limpa para [${callSid}]`);
  }
}

const responseQueue = new ResponseQueue();

// =============================
// 🧠 Gemini Service
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
// 🎙️ Audio Stream Session (COM BUFFER DE FALA)
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
    
    // 🔥 NOVO: Sistema de buffer para falas sobrepostas
    this.speechBuffer = [];
    this.bufferTimeout = null;
    this.bufferDelay = 1500; // 2 segundos de espera após TTS
    this.isAISpeaking = false; // Controla se AI está falando
    
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

  // 🔥 NOVO: Processa buffer após timeout
  processSpeechBuffer() {
    if (this.speechBuffer.length > 0 && !this.isAISpeaking) {
      const transcript = this.speechBuffer.join(' ');
      console.log(`🎯 Processando buffer [${this.callSid}]: "${transcript}"`);
      
      this.speechBuffer = []; // Limpa buffer
      this.processWithGemini(transcript);
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
          
          // 🔥 LÓGICA DE BUFFER: Se AI está falando, armazena no buffer
          if (this.isAISpeaking) {
            console.log(`⏸️  Fala sobreposta detectada [${this.callSid}], armazenando no buffer: "${transcript}"`);
            this.speechBuffer.push(transcript);
            
            // Reinicia timeout do buffer
            if (this.bufferTimeout) {
              clearTimeout(this.bufferTimeout);
            }
            this.bufferTimeout = setTimeout(() => {
              this.processSpeechBuffer();
            }, this.bufferDelay);
            
          } else if (transcript !== this.lastFinalTranscript && transcript.length > 2) {
            // Se AI não está falando, processa imediatamente
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
        // 🔥 MARCA QUE AI VAI FALAR
        this.isAISpeaking = true;
        responseQueue.setTTSPlaying(this.callSid, true);
        
        responseQueue.addResponse(this.callSid, geminiResponse);
        
        // 🔥 ESTIMA QUANDO AI TERMINARÁ DE FALAR
        const estimatedSpeechTime = Math.max(geminiResponse.length / 8 * 1000, 2000);
        setTimeout(() => {
          this.isAISpeaking = false;
          responseQueue.setTTSPlaying(this.callSid, false);
          console.log(`🔊 AI parou de falar [${this.callSid}], verificando buffer...`);
          
          // 🔥 APÓS AI PARAR, VERIFICA BUFFER APÓS DELAY
          setTimeout(() => {
            this.processSpeechBuffer();
          }, this.bufferDelay);
          
        }, estimatedSpeechTime);
        
      } else {
        console.log(`⚠️ Resposta Gemini vazia para [${this.callSid}]`);
      }
      
    } catch (error) {
      console.error(`❌ Erro processamento Gemini [${this.callSid}]:`, error);
      this.consecutiveErrors++;
      this.isAISpeaking = false;
      responseQueue.setTTSPlaying(this.callSid, false);
      
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
    this.isAISpeaking = false;
    
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
    }
    
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

// ... (resto do código permanece igual)

// =============================
// 🚀 Servidor
// =============================
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor com buffer de fala iniciado na porta ${PORT}`);
  console.log(`🤖 Gemini Model: ${model}`);
  console.log(`🔊 Google TTS: ${ttsConfig.voice.name}`);
  console.log(`⏰ Buffer delay: 2000ms`);
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