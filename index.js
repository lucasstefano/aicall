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
// 🎯 Sistema de Fila para Respostas (ATUALIZADO)
// =============================
class ResponseQueue {
  constructor() {
    this.queue = new Map();
    this.processingDelay = 2000;
    this.maxRetries = 3;
    this.audioFileCleanup = new Map(); // callSid -> [audioFiles]
    this.currentlySpeaking = new Map(); // callSid -> boolean (se está falando)
  }

  addResponse(callSid, responseText) {
    try {
      if (!this.queue.has(callSid)) {
        this.queue.set(callSid, { responses: [], isProcessing: false, retryCount: 0 });
        this.audioFileCleanup.set(callSid, []);
        this.currentlySpeaking.set(callSid, false);
      }
      
      const callQueue = this.queue.get(callSid);
      callQueue.responses.push({
        text: responseText,
        timestamp: new Date(),
        id: Date.now() + Math.random(),
        retries: 0
      });

      console.log(`📥 Fila [${callSid}]: Adicionada resposta "${responseText.substring(0, 50)}..." | Total na fila: ${callQueue.responses.length}`);
      
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
        this.currentlySpeaking.set(callSid, false);
      }
      return;
    }

    callQueue.isProcessing = true;
    this.currentlySpeaking.set(callSid, true);
    const response = callQueue.responses[0];

    try {
      console.log(`🎯 Iniciando TTS para [${callSid}]: "${response.text}" | Fila: ${callQueue.responses.length}`);
      
      // 🔥 CORREÇÃO: Gera arquivo de áudio e hospeda externamente
      const audioUrl = await this.generateAndHostTTS(callSid, response.text);
      
      // Envia via TwiML com URL externa
      await this.updateCallWithAudioURL(callSid, audioUrl);
      
      // Remove da fila após sucesso
      callQueue.responses.shift();
      callQueue.retryCount = 0;
      
      console.log(`✅ TTS concluído para [${callSid}]. Restantes na fila: ${callQueue.responses.length}`);
      
      // Agenda próximo processamento
      if (callQueue.responses.length > 0) {
        setTimeout(() => this.processQueue(callSid), this.processingDelay);
      } else {
        callQueue.isProcessing = false;
        this.currentlySpeaking.set(callSid, false);
      }
      
    } catch (error) {
      console.error(`❌ Erro processando TTS [${callSid}]:`, error);
      
      response.retries += 1;
      if (response.retries >= this.maxRetries) {
        console.error(`🚫 Máximo de retries TTS para [${callSid}], removendo: ${response.text}`);
        callQueue.responses.shift();
      }
      
      callQueue.isProcessing = false;
      this.currentlySpeaking.set(callSid, false);
      
      if (callQueue.responses.length > 0) {
        const retryDelay = Math.min(5000 * response.retries, 30000);
        console.log(`🔄 Retentando TTS em ${retryDelay}ms para [${callSid}]...`);
        setTimeout(() => this.processQueue(callSid), retryDelay);
      }
    }
  }

  // 🔥 NOVO: Verifica se está falando no momento
  isSpeaking(callSid) {
    return this.currentlySpeaking.get(callSid) || false;
  }

  // 🔥 NOVO: Interrompe fala atual e limpa fila
  interruptAndClear(callSid) {
    const callQueue = this.queue.get(callSid);
    if (callQueue) {
      console.log(`🔄 Interrompendo fala e limpando fila para [${callSid}] | Fila anterior: ${callQueue.responses.length}`);
      callQueue.responses = []; // Limpa todas as respostas pendentes
      callQueue.isProcessing = false;
      this.currentlySpeaking.set(callSid, false);
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

      console.log(`🔊 Gerando TTS MP3 para [${callSid}]: "${text.substring(0, 50)}..."`);
      
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
      console.log(`✅ TTS salvo: ${filename} (${response.audioContent.length} bytes) para [${callSid}]`);
      
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
      
      twiml.pause({ length: 120 });

      const twimlString = twiml.toString();
      console.log(`📊 TwiML para [${callSid}]: ${twimlString.length} chars (limite: 4000)`);
      
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
      console.log(`🗑️ Limpando ${audioFiles.length} arquivos de áudio para [${callSid}]`);
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
    this.currentlySpeaking.delete(callSid);
    console.log(`🧹 Fila TTS completamente limpa para [${callSid}]`);
  }
}

const responseQueue = new ResponseQueue();

// =============================
// 🧠 Gemini Service (ATUALIZADO PARA CONVERSA FLUIDA)
// =============================
class GeminiService {
  constructor() {
    this.conversationHistory = new Map();
    this.userIssues = new Map();
    this.userNames = new Map();
    this.maxHistoryLength = 8; // 🔥 AUMENTADO para manter mais contexto
  }

  // 🔥 ATUALIZADO: Agora recebe o nome do usuário
  async generateWelcomeMessage(callSid, issue, userName = null) {
    try {
      this.userIssues.set(callSid, issue);
      if (userName) {
        this.userNames.set(callSid, userName);
      }
      
      const prompt = userName 
        ? `Crie uma MENSAGEM DE BOAS-VINDAS personalizada em português brasileiro.

Contexto: ${issue}
Nome do usuário: ${userName}

Regras:
- Use o nome da pessoa naturalmente
- Apenas UMA frase curta
- Seja amigável
- Linguagem natural
- Nunca Use Emojis
Sua mensagem:`
        : `Crie uma MENSAGEM DE BOAS-VINDAS inicial em português brasileiro.

Contexto: ${issue}

Regras:
- Apenas UMA frase curta
- Seja amigável
- Linguagem natural
- Nunca Use Emojis
Sua mensagem:`;

      console.log(`🎯 Gerando mensagem de boas-vindas para: ${issue} | Nome: ${userName || 'Não informado'}`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const welcomeMessage = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      console.log(`🤖 Mensagem de boas-vindas [${callSid}]: ${welcomeMessage}`);
      
      return welcomeMessage;
      
    } catch (error) {
      console.error(`❌ Erro gerando mensagem de boas-vindas [${callSid}]:`, error);
      return userName ? `Olá ${userName}! Como posso te ajudar?` : "Olá! Como posso te ajudar hoje?";
    }
  }

  // 🔥 NOVO: Mensagem de verificação de presença
  async generatePresenceCheck(callSid) {
    try {
      const userName = this.userNames.get(callSid);
      const prompt = userName
        ? `Crie uma mensagem para verificar se a pessoa ainda está na ligação, de forma natural e educada.

Nome da pessoa: ${userName}

Regras:
- Use o nome da pessoa
- 1 frase curta apenas
- Seja educado e natural
- Não use emojis
- Exemplo: "Maria, você ainda está na linha?"

Sua mensagem:`
        : `Crie uma mensagem para verificar se a pessoa ainda está na ligação, de forma natural e educada.

Regras:
- 1 frase curta apenas
- Seja educado e natural
- Não use emojis
- Exemplo: "Você ainda está na linha?"

Sua mensagem:`;

      console.log(`🔍 Gerando verificação de presença para [${callSid}] | Nome: ${userName || 'Não informado'}`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const presenceMessage = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      console.log(`🤖 Verificação de presença [${callSid}]: ${presenceMessage}`);
      
      return presenceMessage;
      
    } catch (error) {
      console.error(`❌ Erro gerando verificação de presença [${callSid}]:`, error);
      return "Você ainda está na linha?";
    }
  }

  // 🔥 ATUALIZADO: Agora aceita múltiplas mensagens para conversa fluida
  async generateResponse(callSid, userMessages) {
    try {
      // Se for array, junta as mensagens
      const userMessage = Array.isArray(userMessages) 
        ? userMessages.join(" ") 
        : userMessages;
      
      const history = this.getConversationHistory(callSid);
      const issue = this.userIssues.get(callSid);
      const userName = this.userNames.get(callSid);
      
      const recentHistory = history.slice(-4); // 🔥 Mantém mais histórico
      
      const prompt = this.buildPrompt(userMessage, recentHistory, issue, userName);
      
      console.log(`🧠 Gemini [${callSid}]: Processando "${userMessage.substring(0, 80)}..." | Histórico: ${recentHistory.length} mensagens`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      
      if (!response.candidates || !response.candidates[0]) {
        throw new Error('Resposta vazia do Gemini');
      }
      
      const text = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      if (!text || text.length < 2) {
        throw new Error('Resposta muito curta do Gemini');
      }
      
      // 🔥 ATUALIZADO: Adiciona todas as mensagens ao histórico
      if (Array.isArray(userMessages)) {
        userMessages.forEach(msg => {
          this.updateConversationHistory(callSid, msg, text);
        });
      } else {
        this.updateConversationHistory(callSid, userMessage, text);
      }
      
      console.log(`🤖 Resposta Gemini [${callSid}]: "${text.substring(0, 80)}..."`);
      
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

  buildPrompt(userMessage, history, issue, userName) {
    let prompt = `Você é um assistente em chamada telefônica. Responda em português brasileiro.

PROBLEMA INICIAL: ${issue}
${userName ? `NOME DO USUÁRIO: ${userName}` : ''}

Regras:
- 1-2 frases no máximo
- Linguagem natural de conversa
- Foco no contexto da conversa
- ${userName ? `Use o nome "${userName}" quando apropriado` : ''}
- Nunca Use Emojis
- Mantenha a conversa fluida

Histórico recente:`;

    if (history.length > 0) {
      history.forEach(([user, assistant]) => {
        prompt += `\nUsuário: ${user}`;
        prompt += `\nVocê: ${assistant}`;
      });
    }

    prompt += `\n\nUsuário: ${userMessage}`;
    prompt += `\n\nSua resposta (curta e natural, mantendo o fluxo):`;

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
    console.log(`📝 Histórico atualizado [${callSid}]: ${history.length} mensagens`);
  }

  getUserName(callSid) {
    return this.userNames.get(callSid);
  }

  cleanup(callSid) {
    this.conversationHistory.delete(callSid);
    this.userIssues.delete(callSid);
    this.userNames.delete(callSid);
    console.log(`🧹 Histórico completamente limpo para [${callSid}]`);
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
// 🎙️ Audio Stream Session (ATUALIZADO PARA CONVERSA FLUIDA)
// =============================
class AudioStreamSession {
  constructor(ws, callSid, issue = null, userName = null) {
    this.ws = ws;
    this.callSid = callSid;
    this.issue = issue;
    this.userName = userName;
    this.sttStream = null;
    this.isActive = false;
    this.lastFinalTranscript = "";
    this.geminiProcessing = false;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
    this.healthCheckInterval = null;
    
    // 🔥 ATUALIZADO: Buffer para mensagens sequenciais
    this.messageBuffer = [];
    this.bufferTimeout = null;
    this.bufferDelay = 1200; // 1.2 segundos para agrupar mensagens
    
    // Controle de inatividade
    this.lastActivity = Date.now();
    this.inactivityTimeout = 5 * 60 * 1000;
    this.presenceCheckSent = false;
    
    // 🔥 REMOVIDO: Sistema de interrupção complexo
    this.isInterrupting = false;
    
    console.log(`🎧 Nova sessão: ${callSid} | Issue: ${issue} | Nome: ${userName || 'Não informado'}`);
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
      console.log(`✅ STT configurado para [${this.callSid}]`);
      
    } catch (error) {
      console.error(`❌ Erro criando stream STT [${this.callSid}]:`, error);
      this.consecutiveErrors++;
    }
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastActivity = now - this.lastActivity;
      
      // Verifica inatividade
      if (timeSinceLastActivity > this.inactivityTimeout && !this.presenceCheckSent) {
        console.log(`⏰ Usuário inativo por ${Math.round(timeSinceLastActivity/1000)}s [${this.callSid}], enviando verificação...`);
        this.sendPresenceCheck();
        this.presenceCheckSent = true;
      }
      
      // Verifica erros consecutivos
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        console.log(`🚑 Health check: Muitos erros consecutivos [${this.callSid}], reiniciando STT...`);
        this.restartSTT();
      }
    }, 10000);
  }

  async sendPresenceCheck() {
    try {
      const presenceMessage = await geminiService.generatePresenceCheck(this.callSid);
      if (presenceMessage) {
        console.log(`🔍 Enviando verificação de presença para [${this.callSid}]: "${presenceMessage}"`);
        responseQueue.addResponse(this.callSid, presenceMessage);
      }
    } catch (error) {
      console.error(`❌ Erro enviando verificação de presença [${this.callSid}]:`, error);
    }
  }

  updateActivity() {
    this.lastActivity = Date.now();
    this.presenceCheckSent = false;
    console.log(`🔄 Atividade atualizada [${this.callSid}] - ${new Date().toISOString()}`);
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

  // 🔥 ATUALIZADO COMPLETAMENTE: Sistema de buffer para mensagens sequenciais
  async handleSTTData(data) {
    try {
      if (data.results && data.results[0]) {
        const result = data.results[0];
        const transcript = result.alternatives[0].transcript.trim();
        const isFinal = result.isFinal;

        if (!transcript) return;

        this.consecutiveErrors = 0;
        this.updateActivity();

        if (isFinal) {
          console.log(`📝 [FINAL] ${this.callSid}: "${transcript}"`);
          
          if (transcript !== this.lastFinalTranscript && transcript.length > 2) {
            this.lastFinalTranscript = transcript;
            
            // 🔥 NOVO: Adiciona ao buffer e agenda processamento
            this.addToBuffer(transcript);
          }
          
        } else {
          if (transcript.length > 8) {
            console.log(`🎯 [INTERIM] ${this.callSid}: "${transcript}"`);
          }
        }
      }
    } catch (error) {
      console.error(`❌ Erro processando STT [${this.callSid}]:`, error);
      this.consecutiveErrors++;
      this.checkHealth();
    }
  }

  // 🔥 NOVO: Sistema de buffer para agrupar mensagens sequenciais
  addToBuffer(transcript) {
    // Limpa timeout anterior
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
    }
    
    // Adiciona mensagem ao buffer
    this.messageBuffer.push(transcript);
    console.log(`📦 Buffer [${this.callSid}]: Adicionada "${transcript}" | Total: ${this.messageBuffer.length}`);
    
    // Agenda processamento do buffer
    this.bufferTimeout = setTimeout(() => {
      this.processBuffer();
    }, this.bufferDelay);
  }

  // 🔥 NOVO: Processa todas as mensagens do buffer de uma vez
  async processBuffer() {
    if (this.messageBuffer.length === 0) return;
    
    const messagesToProcess = [...this.messageBuffer];
    this.messageBuffer = []; // Limpa o buffer
    this.bufferTimeout = null;
    
    console.log(`🎯 Processando buffer [${this.callSid}]: ${messagesToProcess.length} mensagens`);
    messagesToProcess.forEach((msg, i) => {
      console.log(`   ${i + 1}. "${msg}"`);
    });
    
    // Se a IA estiver falando, interrompe para processar as novas mensagens
    if (responseQueue.isSpeaking(this.callSid)) {
      console.log(`🔄 Interrompendo fala atual para processar ${messagesToProcess.length} mensagens [${this.callSid}]`);
      responseQueue.interruptAndClear(this.callSid);
      
      // Pequeno delay para garantir interrupção
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Processa todas as mensagens juntas
    await this.processWithGemini(messagesToProcess);
  }

  // 🔥 ATUALIZADO: Aceita array de mensagens
  async processWithGemini(messages) {
    if (this.geminiProcessing) {
      console.log(`⏳ Gemini ocupado [${this.callSid}], aguardando...`);
      
      // Aguarda até 5 segundos
      let attempts = 0;
      const maxAttempts = 5;
      
      while (this.geminiProcessing && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
        console.log(`⏳ Tentativa ${attempts}/${maxAttempts} para [${this.callSid}]...`);
      }
      
      if (this.geminiProcessing) {
        console.log(`🚫 Gemini ainda ocupado após ${maxAttempts} tentativas [${this.callSid}], ignorando mensagens`);
        return;
      }
    }

    this.geminiProcessing = true;

    try {
      const messageText = Array.isArray(messages) ? messages : [messages];
      console.log(`🧠 Processando ${messageText.length} mensagens com Gemini [${this.callSid}]`);
      
      const geminiResponse = await geminiService.generateResponse(this.callSid, messageText);
      
      if (geminiResponse && geminiResponse.length > 2) {
        responseQueue.addResponse(this.callSid, geminiResponse);
        console.log(`✅ Resposta Gemini adicionada à fila [${this.callSid}]: "${geminiResponse.substring(0, 80)}..."`);
      } else {
        console.log(`⚠️ Resposta Gemini vazia para [${this.callSid}]`);
      }
      
    } catch (error) {
      console.error(`❌ Erro processamento Gemini [${this.callSid}]:`, error);
      this.consecutiveErrors++;
      
    } finally {
      this.geminiProcessing = false;
      console.log(`✅ Gemini liberado para [${this.callSid}]`);
    }
  }

  checkHealth() {
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.restartSTT();
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
    
    // Limpa buffer timeout
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
      this.bufferTimeout = null;
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      console.log(`⏹️ Health check parado para [${this.callSid}]`);
    }
    
    if (this.sttStream) {
      this.sttStream.removeAllListeners();
      this.sttStream.destroy();
      this.sttStream = null;
      console.log(`🔚 STT finalizado para [${this.callSid}]`);
    }

    geminiService.cleanup(this.callSid);
    responseQueue.cleanup(this.callSid);
    
    console.log(`🔚 Sessão completamente finalizada [${this.callSid}]`);
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
const pendingUserNames = new Map();

// 🔥 NOVO: Controle de sessões sendo limpas
const cleaningSessions = new Set();

wss.on("connection", (ws, req) => {
  console.log("🎧 Nova conexão WebSocket estabelecida");
  let session = null;
  let callSid = null;

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
          
          callSid = data.start.callSid;
          const issue = pendingIssues.get(callSid);
          const userName = pendingUserNames.get(callSid);
          
          if (activeSessions.has(callSid)) {
            session = activeSessions.get(callSid);
            session.ws = ws;
            console.log(`🔗 WebSocket reconectado para [${callSid}]`);
          } else {
            session = new AudioStreamSession(ws, callSid, issue, userName);
            activeSessions.set(callSid, session);
            
            if (issue) {
              geminiService.generateWelcomeMessage(callSid, issue, userName)
                .then(welcomeMessage => {
                  console.log(`👋 Enviando mensagem de boas-vindas para [${callSid}]: "${welcomeMessage}"`);
                  responseQueue.addResponse(callSid, welcomeMessage);
                })
                .catch(error => {
                  console.error(`❌ Erro welcome message [${callSid}]:`, error);
                  responseQueue.addResponse(callSid, userName ? `Olá ${userName}! Como posso te ajudar?` : "Olá! Como posso te ajudar?");
                });
            }
          }
          
          pendingIssues.delete(callSid);
          pendingUserNames.delete(callSid);
          break;

        case "media":
          if (session && session.isActive) {
            session.handleMedia(data.media.payload);
          }
          break;

        case "stop":
          console.log("🛑 Parando stream:", data.stop.callSid);
          const stopCallSid = data.stop.callSid;
          
          // Previne limpeza duplicada
          if (!cleaningSessions.has(stopCallSid)) {
            cleaningSessions.add(stopCallSid);
            
            if (activeSessions.has(stopCallSid)) {
              const stopSession = activeSessions.get(stopCallSid);
              stopSession.cleanup();
              activeSessions.delete(stopCallSid);
            }
            
            // Remove da lista de limpeza após um tempo
            setTimeout(() => {
              cleaningSessions.delete(stopCallSid);
            }, 5000);
          } else {
            console.log(`⚠️ Sessão [${stopCallSid}] já está sendo limpa, ignorando...`);
          }
          break;
      }
    } catch (error) {
      console.error("❌ Erro processando mensagem WebSocket:", error);
    }
  });

  ws.on("close", () => {
    console.log(`🔌 WebSocket fechado para [${callSid || 'sessão desconhecida'}]`);
    clearInterval(heartbeatInterval);
  });

  ws.on("error", (error) => {
    console.error(`❌ Erro WebSocket [${callSid || 'sessão desconhecida'}]:`, error);
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
  let to = req.body.to;
  const issue = req.body.issue || "Preciso de ajuda com um problema";
  const userName = req.body.userName;

  if (!to) {
    return res.status(400).json({ error: "Número é obrigatório" });
  }

  try {
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

    console.log(`📞 Número formatado: ${to} | Nome: ${userName || 'Não informado'} | Issue: ${issue}`);

    const call = await client.calls.create({
      to: to,
      from: fromNumber,
      url: `${baseUrl}/twiml`,
      timeout: 15,
      statusCallback: `${baseUrl}/call-status`,
      statusCallbackEvent: ["answered", "completed"],
    });

    console.log(`✅ Chamada com Gemini + Google TTS iniciada: ${call.sid}`);
    
    pendingIssues.set(call.sid, issue);
    if (userName) {
      pendingUserNames.set(call.sid, userName);
    }
    
    res.json({ 
      message: "Chamada com IA e voz natural iniciada", 
      sid: call.sid,
      issue: issue,
      userName: userName,
      numero_formatado: to,
      features: ["STT", "Gemini AI", "Google TTS", "Voz natural", "Conversa fluida", "Buffer de mensagens"]
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
  
  if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
    if (!cleaningSessions.has(CallSid)) {
      cleaningSessions.add(CallSid);
      
      console.log(`🧹 Iniciando limpeza final para [${CallSid}]...`);
      
      if (activeSessions.has(CallSid)) {
        const session = activeSessions.get(CallSid);
        session.cleanup();
        activeSessions.delete(CallSid);
        console.log(`✅ Sessão ativa removida [${CallSid}]`);
      }
      
      pendingIssues.delete(CallSid);
      pendingUserNames.delete(CallSid);
      
      setTimeout(() => {
        cleaningSessions.delete(CallSid);
        console.log(`🗑️ Limpeza finalizada para [${CallSid}]`);
      }, 3000);
    } else {
      console.log(`⚠️ Sessão [${CallSid}] já está sendo limpa, ignorando call-status...`);
    }
  }
  
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    pending_issues: pendingIssues.size,
    pending_names: pendingUserNames.size,
    features: ["STT", "Gemini AI", "Google TTS", "Voz natural premium", "Conversa fluida", "Buffer de mensagens"]
  });
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
              <input type="tel" name="to" placeholder="21994442087" value="21994442087" required>
              
              <input type="text" name="userName" placeholder="Nome da pessoa (opcional)" value="Maria">

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
            <p>Nomes pendentes: <strong>${pendingUserNames.size}</strong></p>
            <a href="/health">Ver Health Check</a>
          </div>

          <div class="card">
            <h3>Novas Funcionalidades</h3>
            <div class="feature">✅ Nome personalizado nas saudações</div>
            <div class="feature">✅ Verificação de presença após 5 minutos</div>
            <div class="feature">✅ Conversa fluida com buffer de mensagens</div>
            <div class="feature">✅ Agrupamento de mensagens sequenciais</div>
            <div class="feature">✅ Logs detalhados para debug</div>
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
  console.log(`🔄 Buffer de mensagens: ${1200}ms`);
  console.log(`🎯 Conversa fluida: ATIVADA`);
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
  pendingUserNames.clear();
  server.close(() => process.exit(0));
});