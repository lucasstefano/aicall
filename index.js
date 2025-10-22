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

// 🔥 NOVO: Servir arquivos de áudio estáticos
app.use('/audio', express.static('audio'));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;

// 🔥 VALIDAÇÃO DE VARIÁVEIS DE AMBIENTE
const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'BASE_URL', 'GCLOUD_PROJECT', 'GCLOUD_LOCATION'
];

requiredEnvVars.forEach(envVar => {
  if (!process.env[envVar]) {
    console.error(`❌ Variável de ambiente faltando: ${envVar}`);
    process.exit(1);
  }
});

const client = twilio(accountSid, authToken);
const clientSTT = new speech.SpeechClient();
const clientTTS = new textToSpeech.TextToSpeechClient();

// 🔥 NOVO: Criar diretório para áudios
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
// 🎙️ Configuração Google TTS (OTIMIZADA)
// =============================
const ttsConfig = {
  voice: {
    languageCode: 'pt-BR',
    name: "pt-BR-Chirp3-HD-Leda",
    ssmlGender: 'FEMALE'
  },
  audioConfig: {
    audioEncoding: 'MP3', // 🔥 MUDADO para MP3 (menor tamanho)
    sampleRateHertz: 8000,
    speakingRate: 1.0,
    pitch: 0.0,
    volumeGainDb: 0.0
  }
};

// =============================
// 🎯 Sistema de Fila para Respostas (CORRIGIDO)
// =============================
class ResponseQueue {
  constructor() {
    this.queue = new Map();
    this.processingDelay = 2000;
    this.maxRetries = 3;
    this.audioFileCleanup = new Map(); // callSid -> [audioFiles]
  }

  addResponse(callSid, responseText) {
    try {
      if (!this.queue.has(callSid)) {
        this.queue.set(callSid, { responses: [], isProcessing: false, retryCount: 0 });
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
      
      // 🔥 CORREÇÃO: Gera arquivo de áudio e hospeda externamente
      const audioUrl = await this.generateAndHostTTS(callSid, response.text);
      
      // Envia via TwiML com URL externa
      await this.updateCallWithAudioURL(callSid, audioUrl);
      
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

  // 🔥 CORREÇÃO: Gera arquivo MP3 e retorna URL pública
  async generateAndHostTTS(callSid, text) {
    try {
      const request = {
        input: { text: text },
        voice: ttsConfig.voice,
        audioConfig: {
          ...ttsConfig.audioConfig,
          audioEncoding: 'MP3' // Sempre MP3 para menor tamanho
        }
      };

      console.log(`🔊 Gerando TTS MP3: "${text.substring(0, 50)}..."`);
      
      const [response] = await clientTTS.synthesizeSpeech(request);
      
      if (!response.audioContent) {
        throw new Error('Resposta de TTS vazia');
      }
      
      // 🔥 SALVA COMO ARQUIVO MP3
      const filename = `tts_${callSid}_${Date.now()}.mp3`;
      const filepath = join(audioDir, filename);
      
      writeFileSync(filepath, response.audioContent, 'binary');
      
      // Registra arquivo para limpeza posterior
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

  // 🔥 CORREÇÃO: Usa URL externa em vez de base64
  async updateCallWithAudioURL(callSid, audioUrl) {
    try {
      const twiml = new twilio.twiml.VoiceResponse();
      
      // 🔥 USA URL EXTERNA - não tem limite de tamanho!
      twiml.play({}, audioUrl);
      
      // Mantém o stream aberto
      const start = twiml.start();
      start.stream({ 
        url: `wss://${new URL(baseUrl).host}/media-stream`,
        track: "inbound_track"
      });
      
      twiml.pause({ length: 300 });

      const twimlString = twiml.toString();
      console.log(`📊 TwiML size: ${twimlString.length} chars (limite: 4000)`);
      
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

  // 🔥 NOVO: Limpa arquivos de áudio
  cleanup(callSid) {
    // Remove arquivos de áudio
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

  // 🔥 NOVO: Limpeza automática de arquivos antigos
  startAudioCleanupSchedule() {
    // Limpa arquivos com mais de 1 hora a cada 30 minutos
    setInterval(() => {
      const now = Date.now();
      const oneHourAgo = now - (60 * 60 * 1000);
      
      this.audioFileCleanup.forEach((files, callSid) => {
        const remainingFiles = files.filter(filepath => {
          try {
            const stats = require('fs').statSync(filepath);
            if (stats.mtimeMs < oneHourAgo) {
              unlinkSync(filepath);
              console.log(`🗑️ Arquivo antigo removido: ${filepath}`);
              return false;
            }
            return true;
          } catch (error) {
            return false;
          }
        });
        
        if (remainingFiles.length === 0) {
          this.audioFileCleanup.delete(callSid);
        } else {
          this.audioFileCleanup.set(callSid, remainingFiles);
        }
      });
    }, 30 * 60 * 1000); // 30 minutos
  }
}

const responseQueue = new ResponseQueue();
responseQueue.startAudioCleanupSchedule(); // 🔥 INICIAR LIMPEZA AUTOMÁTICA

// =============================
// 🧠 Gemini Service (ATUALIZADO COM NOME)
// =============================
class GeminiService {
  constructor() {
    this.conversationHistory = new Map();
    this.userData = new Map(); // 🔥 MUDANÇA: Agora armazena mais dados
    this.maxHistoryLength = 6;
  }

  async generateWelcomeMessage(callSid, issue, nome) { // 🔥 ADICIONAR nome como parâmetro
    try {
      this.userData.set(callSid, { 
        issue: issue,
        nome: nome 
      });
      
      const prompt = `Crie uma MENSAGEM DE BOAS-VINDAS inicial em português brasileiro.

Contexto: ${issue}
Nome da pessoa: ${nome}

Regras:
- Apenas UMA frase curta
- Seja amigável e use o nome da pessoa
- Linguagem natural
- Menção direta ao nome

Sua mensagem:`;

      console.log(`🎯 Gerando mensagem de boas-vindas para: ${nome} - ${issue}`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const welcomeMessage = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      console.log(`🤖 Mensagem de boas-vindas para ${nome}: ${welcomeMessage}`);
      
      return welcomeMessage;
      
    } catch (error) {
      console.error(`❌ Erro gerando mensagem de boas-vindas [${callSid}]:`, error);
      return `Olá ${nome}! Como posso te ajudar hoje?`;
    }
  }

  async generateResponse(callSid, userMessage) {
    try {
      const history = this.getConversationHistory(callSid);
      const userData = this.userData.get(callSid);
      
      if (!userData) {
        throw new Error('Dados do usuário não encontrados');
      }
      
      const { issue, nome } = userData;
      const recentHistory = history.slice(-3);
      
      const prompt = this.buildPrompt(userMessage, recentHistory, issue, nome); // 🔥 ADICIONAR nome
      
      console.log(`🧠 Gemini [${callSid} - ${nome}]: "${userMessage.substring(0, 50)}..."`);
      
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
      
      console.log(`🤖 Resposta [${callSid} - ${nome}]: "${text.substring(0, 50)}..."`);
      
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

  buildPrompt(userMessage, history, issue, nome) { // 🔥 ADICIONAR nome
    let prompt = `Você é um assistente em chamada telefônica. Responda em português brasileiro.

PROBLEMA: ${issue}
NOME DA PESSOA: ${nome}

Regras:
- 1-2 frases no máximo
- Linguagem natural
- Foco no problema acima
- Use o nome da pessoa quando apropriado

Histórico:`;

    if (history.length > 0) {
      history.forEach(([user, assistant]) => {
        prompt += `\nUsuário: ${user}`;
        prompt += `\nVocê: ${assistant}`;
      });
    }

    prompt += `\n\nUsuário: ${userMessage}`;
    prompt += `\n\nSua resposta (curta, sobre "${issue}", para ${nome}):`;

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
    this.userData.delete(callSid); // 🔥 MUDANÇA: Limpar userData
    console.log(`🧹 Histórico limpo para [${callSid}]`);
  }
}

const geminiService = new GeminiService();

// =============================
// 🎯 Configuração STT (ATUALIZADA)
// =============================
const sttConfig = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "pt-BR",
    enableAutomaticPunctuation: true,
    model: "phone_call",
    useEnhanced: true,
    speechContexts: [{
      phrases: [
        "configurar", "e-mail", "email", "celular", "problema", "conexão",
        "internet", "conta", "fatura", "suporte", "técnico", "urgente"
      ],
      boost: 5.0
    }]
  },
  interimResults: true,
  interimResultsThreshold: 0.3, // 🔥 AUMENTAR threshold para menos interims
  single_utterance: false,
  noSpeechTimeout: 60, // 🔥 AUMENTAR timeout sem áudio
  enableVoiceActivityEvents: true // 🔥 ATIVAR eventos de atividade
};

// =============================
// 🎙️ Audio Stream Session (ATUALIZADO COM CORREÇÕES)
// =============================
class AudioStreamSession {
  constructor(ws, callSid, issue = null, nome = null) {
    this.ws = ws;
    this.callSid = callSid;
    this.issue = issue;
    this.nome = nome;
    this.sttStream = null;
    this.isActive = false;
    this.lastFinalTranscript = "";
    this.geminiProcessing = false;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
    this.healthCheckInterval = null;
    this.inactivityTimeout = null; // 🔥 NOVO: Timeout de inatividade
    this.lastActivityTime = Date.now(); // 🔥 NOVO: Última atividade
    
    console.log(`🎧 Nova sessão: ${callSid}, Nome: ${nome}, Issue: ${issue}`);
    this.setupSTT();
    this.startHealthCheck();
    this.resetInactivityTimer(); // 🔥 NOVO: Iniciar timer
  }

  setupSTT() {
    try {
      console.log(`🔧 Configurando STT para [${this.callSid}]`);
      
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
          // 🔥 TENTAR RECRIAR se ainda estiver ativo
          if (this.isActive) {
            console.log(`🔄 STT finalizado inesperadamente, recriando... [${this.callSid}]`);
            setTimeout(() => {
              if (this.isActive) {
                this.setupSTT();
              }
            }, 1000);
          }
        })
        .on("close", () => {
          console.log(`🔒 Stream STT fechado [${this.callSid}]`);
        });

      this.isActive = true;
      this.consecutiveErrors = 0;
      console.log(`✅ STT configurado com sucesso [${this.callSid}]`);
      
    } catch (error) {
      console.error(`❌ Erro criando stream STT [${this.callSid}]:`, error);
      this.consecutiveErrors++;
    }
  }

  // 🔥 NOVO: Resetar timer de inatividade
  resetInactivityTimer() {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    
    // Se não houver atividade em 30 segundos, verificar saúde
    this.inactivityTimeout = setTimeout(() => {
      console.log(`⏰ Timeout de inatividade [${this.callSid}], verificando...`);
      this.checkHealth();
    }, 30000);
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
        this.resetInactivityTimer(); // 🔥 RESETAR no áudio recebido

        if (isFinal) {
          console.log(`📝 [FINAL] ${this.callSid} (${this.nome}): ${transcript}`);
          
          if (transcript !== this.lastFinalTranscript && transcript.length > 2) {
            this.lastFinalTranscript = transcript;
            await this.processWithGemini(transcript);
          }
          
        } else {
          if (transcript.length > 8) {
            console.log(`🎯 [INTERIM] ${this.callSid} (${this.nome}): ${transcript}`);
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
        this.resetInactivityTimer(); // 🔥 RESETAR no media recebido
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
    
    if (this.inactivityTimeout) { // 🔥 LIMPAR timeout
      clearTimeout(this.inactivityTimeout);
    }
    
    if (this.sttStream) {
      this.sttStream.removeAllListeners();
      this.sttStream.destroy();
      this.sttStream = null;
    }

    geminiService.cleanup(this.callSid);
    responseQueue.cleanup(this.callSid);
    
    console.log(`🔚 Sessão finalizada [${this.callSid} - ${this.nome}]`);
  }
}

// =============================
// 🔄 WebSocket Server (ATUALIZADO COM CORREÇÕES)
// =============================
const wss = new WebSocketServer({ 
  noServer: true,
  clientTracking: true
});

const activeSessions = new Map();
const pendingIssues = new Map(); // Agora armazena objetos {issue, nome}

wss.on("connection", (ws, req) => {
  console.log("🎧 Nova conexão WebSocket");
  let session = null;
  let isAlive = true;

  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      if (!isAlive) {
        console.log("💔 WebSocket inativo, terminando...");
        return ws.terminate();
      }
      isAlive = false;
      ws.ping();
    }
  }, 15000); // 🔥 REDUZIR para 15 segundos

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      
      switch (data.event) {
        case "start":
          console.log("🚀 Iniciando stream:", data.start.callSid);
          
          const callSid = data.start.callSid;
          const userData = pendingIssues.get(callSid);
          
          if (activeSessions.has(callSid)) {
            session = activeSessions.get(callSid);
            session.ws = ws; // Atualizar WebSocket
            console.log(`🔗 WebSocket atualizado para [${callSid}]`);
            
            // 🔥 REINICIAR STT se necessário
            if (!session.sttStream || !session.isActive) {
              console.log(`🔄 Reativando STT para [${callSid}]`);
              session.setupSTT();
            }
          } else {
            session = new AudioStreamSession(ws, callSid, userData?.issue, userData?.nome);
            activeSessions.set(callSid, session);
            
            if (userData) {
              geminiService.generateWelcomeMessage(callSid, userData.issue, userData.nome)
                .then(welcomeMessage => {
                  responseQueue.addResponse(callSid, welcomeMessage);
                })
                .catch(error => {
                  console.error(`❌ Erro welcome message [${callSid}]:`, error);
                  responseQueue.addResponse(callSid, `Olá ${userData.nome}! Como posso te ajudar?`);
                });
            }
          }
          
          pendingIssues.delete(callSid);
          break;

        case "media":
          if (session && session.isActive) {
            session.handleMedia(data.media.payload);
          } else if (session) {
            // 🔥 TENTAR REATIVAR se a sessão existe mas não está ativa
            console.log(`🔄 Tentando reativar sessão inativa [${callSid}]`);
            session.setupSTT();
            if (session.isActive) {
              session.handleMedia(data.media.payload);
            }
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

  ws.on("close", (code, reason) => {
    console.log(`🔌 WebSocket fechado: ${code} - ${reason}`);
    clearInterval(heartbeatInterval);
    
    // 🔥 NÃO limpar sessão imediatamente, aguardar reconexão
    if (session && (code === 1001 || code === 1006)) {
      console.log(`⏳ WebSocket desconectado, aguardando reconexão [${session.callSid}]`);
      // Manter a sessão ativa por 30 segundos para reconexão
      setTimeout(() => {
        if (session && session.ws?.readyState !== WebSocket.OPEN) {
          console.log(`🚫 Timeout de reconexão [${session.callSid}], limpando...`);
          session.cleanup();
          activeSessions.delete(session.callSid);
        }
      }, 30000);
    }
  });

  ws.on("error", (error) => {
    console.error("❌ Erro WebSocket:", error);
    clearInterval(heartbeatInterval);
  });

  ws.on("pong", () => {
    isAlive = true; // 🔥 MARCAR como ativo
  });
});

// =============================
// 📞 Endpoints Twilio (ATUALIZADO COM NOME)
// =============================
app.post("/twiml", (req, res) => {
  try {
    const response = new twilio.twiml.VoiceResponse();

    // 🔥 REDUZIR a mensagem inicial
    response.say({ 
      voice: "alice", 
      language: "pt-BR" 
    }, "Olá!");

    const start = response.start();
    start.stream({ 
      url: `wss://${new URL(baseUrl).host}/media-stream`,
      track: "inbound_track"
    });

    // 🔥 AUMENTAR o pause para 5 minutos (máximo do Twilio)
    response.pause({ length: 300 }); // 300 segundos = 5 minutos

    res.type("text/xml");
    res.send(response.toString());
    
    console.log("📞 TwiML gerado com pause de 5 minutos");
    
  } catch (error) {
    console.error("❌ Erro gerando TwiML:", error);
    res.status(500).send("Erro interno");
  }
});

app.post("/make-call", async (req, res) => {
  let to = req.body.to;
  const issue = req.body.issue || "Preciso de ajuda com um problema";
  const nome = req.body.nome || ""; // 🔥 NOVO: Capturar o nome

  if (!to || !nome) {
    return res.status(400).json({ 
      error: "Número e nome são obrigatórios" 
    });
  }

  try {
    // 🔥 CORREÇÃO: Garantir que o número sempre tenha código 55
    to = to.trim().replace(/\s/g, "");
    
    if (!to.startsWith("+55")) {
      if (to.startsWith("+")) {
        to = "+55" + to.substring(1);
      } else if (to.startsWith("55")) {
        to = "+" + to;
      } else {
        to = "+55" + to;
      }
    }

    console.log(`📞 Chamada para: ${nome} (${to})`);

    const call = await client.calls.create({
      to: to,
      from: fromNumber,
      url: `${baseUrl}/twiml`,
      timeout: 15,
      statusCallback: `${baseUrl}/call-status`,
      statusCallbackEvent: ["answered", "completed"],
    });

    console.log(`✅ Chamada com Gemini + Google TTS iniciada: ${call.sid}`);
    console.log(`👤 Nome do destinatário: ${nome}`);
    console.log(`🎯 Issue: ${issue}`);
    
    // 🔥 ATUALIZADO: Salvar nome junto com o issue
    pendingIssues.set(call.sid, { 
      issue: issue, 
      nome: nome 
    });
    
    res.json({ 
      message: "Chamada com IA e voz natural iniciada", 
      sid: call.sid,
      nome: nome,
      issue: issue,
      numero_formatado: to,
      features: ["STT", "Gemini AI", "Google TTS", "Voz natural", "Personalização por nome"]
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
    features: ["STT", "Gemini AI", "Google TTS", "Voz natural premium", "Personalização por nome"]
  });
});

// 🔥 MIDDLEWARE DE SEGURANÇA
app.use((req, res, next) => {
  // Rate limiting básico
  const clientIP = req.ip || req.connection.remoteAddress;
  console.log(`🌐 Requisição: ${req.method} ${req.url} - IP: ${clientIP}`);
  next();
});

// CORS para o frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// 🔥 ENDPOINT PARA CANCELAR CHAMADAS
app.post("/cancel-call", async (req, res) => {
  const { callSid } = req.body;
  
  if (!callSid) {
    return res.status(400).json({ error: "callSid é obrigatório" });
  }

  try {
    await client.calls(callSid).update({ status: 'completed' });
    
    // Limpar recursos
    if (activeSessions.has(callSid)) {
      activeSessions.get(callSid).cleanup();
      activeSessions.delete(callSid);
    }
    
    pendingIssues.delete(callSid);
    
    res.json({ 
      message: "Chamada cancelada com sucesso",
      callSid: callSid
    });
  } catch (error) {
    console.error("❌ Erro cancelando chamada:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SafeCall AI</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 800px; margin: 0 auto; }
          .card { background: #f5f5f5; padding: 20px; margin: 20px 0; border-radius: 10px; }
          button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
          input, textarea { width: 100%; padding: 10px; margin: 5px 0; border: 1px solid #ddd; border-radius: 5px; }
          .feature { background: #e8f4fd; padding: 10px; margin: 5px 0; border-radius: 5px; }
          .issues-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 15px 0; }
          .issue-card { background: #fff; border: 1px solid #ccc; border-radius: 10px; padding: 15px; text-align: center; cursor: pointer; transition: 0.2s; }
          .issue-card:hover { background: #007bff; color: white; border-color: #007bff; }
        </style>
        <script>
          function selectIssue(text) {
            const textarea = document.querySelector('textarea[name="issue"]');
            textarea.value = text;
          }
        </script>
      </head>
      <body>
        <div class="container">
          <h1>SafeCall AI</h1>
          
          <div class="card">
            <h3>Fazer Chamada de Voz</h3>
            <form action="/make-call" method="POST">
              <!-- 🔥 ADICIONAR CAMPO NOME -->
              <input type="text" name="nome" placeholder="Nome da pessoa" value="João Silva" required>
              
              <input type="tel" name="to" placeholder="21994442087" value="21994442087" required>

              <div class="issues-grid">
                <div class="issue-card" onclick="selectIssue('Preciso de ajuda para configurar meu e-mail no celular')">
                  📱 Configurar e-mail no celular
                </div>
                <div class="issue-card" onclick="selectIssue('Estou com problemas de conexão na internet')">
                  🌐 Problemas de internet
                </div>
                <div class="issue-card" onclick="selectIssue('Quero atualizar o cadastro da minha conta')">
                  🧾 Atualizar cadastro
                </div>
                <div class="issue-card" onclick="selectIssue('Minha fatura veio com valor incorreto')">
                  💰 Fatura incorreta
                </div>
                <div class="issue-card" onclick="selectIssue('Preciso de suporte técnico urgente')">
                  🛠️ Suporte técnico urgente
                </div>
              </div>

              <textarea name="issue" placeholder="Descreva o problema que o usuário precisa resolver..." rows="3" required>
Preciso de ajuda para configurar meu email no celular
              </textarea>
              <button type="submit">Fazer Ligação</button>
            </form>
          </div>
          
          <div class="card">
            <h3>Status do Sistema</h3>
            <p>Sessões ativas: <strong>${activeSessions.size}</strong></p>
            <p>Issues pendentes: <strong>${pendingIssues.size}</strong></p>
            <a href="/health">Ver Health Check</a>
          </div>

          <div class="card">
            <h3>Cancelar Chamada</h3>
            <form action="/cancel-call" method="POST">
              <input type="text" name="callSid" placeholder="Call SID da chamada" required>
              <button type="submit" style="background: #dc3545;">Cancelar Chamada</button>
            </form>
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
  console.log(`📁 Áudios servidos em: ${baseUrl}/audio/`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`👤 Recurso: Personalização por nome ATIVADA`);
  console.log(`🔄 Sistema: Reconexão automática ATIVADA`);
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