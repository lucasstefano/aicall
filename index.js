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

// 🔥 Servir arquivos de áudio estáticos
app.use('/audio', express.static('audio'));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const baseUrl = process.env.BASE_URL;

// Validação de variáveis de ambiente
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

// Criar diretório para áudios
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
    name: "pt-BR-Chirp3-HD-Leda",
    ssmlGender: 'FEMALE'
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
// 🎯 Sistema de Fila para Respostas
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
      
      const audioUrl = await this.generateAndHostTTS(callSid, response.text);
      await this.updateCallWithAudioURL(callSid, audioUrl);
      
      callQueue.responses.shift();
      callQueue.retryCount = 0;
      
      console.log(`✅ Áudio TTS enviado para [${callSid}]. Restantes: ${callQueue.responses.length}`);
      
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

  startAudioCleanupSchedule() {
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
    }, 30 * 60 * 1000);
  }
}

const responseQueue = new ResponseQueue();
responseQueue.startAudioCleanupSchedule();

// =============================
// 🧠 Gemini Service com Prompts Dinâmicos
// =============================
class GeminiService {
  constructor() {
    this.conversationHistory = new Map();
    this.userData = new Map();
    this.maxHistoryLength = 6;
    
    // 🔥 SISTEMA DE PROMPTS DINÂMICOS
    this.problemPrompts = {
      'email': {
        system: `Você é um especialista em configuração de e-mail. 
PROBLEMA: Configurar e-mail no celular
NOME DA PESSOA: {nome}

Instruções específicas:
- Foque em problemas de configuração de e-mail (Gmail, Outlook, etc.)
- Ajude com servidores de entrada/saída (IMAP, SMTP)
- Oriente sobre senhas de aplicativo e autenticação
- Explique de forma simples e passo a passo
- Mantenha 1-2 frases por resposta
- Use o nome da pessoa naturalmente
- Seja prático e direto ao ponto`,
        welcome: `Crie uma mensagem de boas-vindas para {nome} sobre configuração de e-mail no celular.
Seja prático e ofereça ajuda imediata com servidores e senhas.
Apenas UMA frase curta e direta.`
      },
      
      'internet': {
        system: `Você é um técnico especialista em problemas de internet.
PROBLEMA: Problemas de conexão na internet  
NOME DA PESSOA: {nome}

Instruções específicas:
- Ajude com troubleshooting de conexão WiFi e dados móveis
- Sugira verificação de senha, reset de modem, configuração DNS
- Oriente sobre testes de velocidade e verificação de provedor
- Use linguagem técnica mas acessível
- Mantenha 1-2 frases por resposta
- Foque em soluções práticas e imediatas`,
        welcome: `Crie uma mensagem de boas-vindas para {nome} sobre problemas de conexão na internet.
Mostre-se preparado para diagnosticar e resolver o problema rapidamente.
Apenas UMA frase curta.`
      },
      
      'conta': {
        system: `Você é um especialista em atualização de cadastro.
PROBLEMA: Atualizar cadastro da conta
NOME DA PESSOA: {nome}

Instruções específicas:
- Auxilie com atualização de dados pessoais, endereço, telefone
- Oriente sobre verificação de documentos e confirmação de identidade
- Explique prazos e confirmações de atualização
- Foque em segurança e verificação de dados
- Mantenha 1-2 frases por resposta
- Seja claro sobre os procedimentos necessários`,
        welcome: `Crie uma mensagem de boas-vindas para {nome} sobre atualização de cadastro.
Destaque a importância de manter os dados atualizados e a segurança.
Apenas UMA frase curta.`
      },
      
      'fatura': {
        system: `Você é um especialista financeiro.
PROBLEMA: Fatura com valor incorreto
NOME DA PESSOA: {nome}

Instruções específicas:
- Ajude a analisar cobranças e disputar valores incorretos
- Oriente sobre verificação de uso, tarifas e impostos
- Explique prazos para contestação e documentos necessários
- Mantenha tom profissional mas empático com o problema
- Mantenha 1-2 frases por resposta
- Ofereça orientações claras sobre próximos passos`,
        welcome: `Crie uma mensagem de boas-vindas para {nome} sobre problemas na fatura.
Mostre compreensão e disposição para resolver a questão.
Apenas UMA frase curta.`
      },
      
      'suporte': {
        system: `Você é um técnico de suporte urgente.
PROBLEMA: Suporte técnico urgente
NOME DA PESSOA: {nome}

Instruções específicas:
- Priorize resolução rápida e eficiente
- Identifique a criticidade do problema rapidamente
- Ofereça soluções imediatas e escalonamento se necessário
- Mantenha calma e profissionalismo mesmo em situações urgentes
- Mantenha 1-2 frases por resposta
- Foque em acalmar o usuário e resolver o problema`,
        welcome: `Crie uma mensagem de boas-vindas urgente para {nome}.
Transmita confiança e rapidez no atendimento.
Apenas UMA frase curta.`
      },
      
      'default': {
        system: `Você é um assistente de chamada telefônica em português brasileiro.
PROBLEMA: {issue}
NOME DA PESSOA: {nome}

Instruções:
- Responda com 1 a 2 frases curtas, claras e naturais.
- Mantenha o foco no problema mencionado.
- Use o nome da pessoa sempre que fizer sentido.
- Adote um tom amigável, profissional e humano.`,
        welcome: `Crie uma mensagem de boas-vindas em português brasileiro para {nome} sobre: {issue}
Apenas UMA frase curta, cordial e que transmita confiança.`
      }
    };
  }

  // 🔥 IDENTIFICAR TIPO DE PROBLEMA
  identifyProblemType(issue) {
    const issueLower = issue.toLowerCase();
    
    if (issueLower.includes('email') || issueLower.includes('e-mail')) return 'email';
    if (issueLower.includes('internet') || issueLower.includes('conexão') || issueLower.includes('wifi')) return 'internet';
    if (issueLower.includes('conta') || issueLower.includes('cadastro') || issueLower.includes('atualizar')) return 'conta';
    if (issueLower.includes('fatura') || issueLower.includes('cobrança') || issueLower.includes('valor')) return 'fatura';
    if (issueLower.includes('suporte') || issueLower.includes('técnico') || issueLower.includes('urgente')) return 'suporte';
    
    return 'default';
  }

  async generateWelcomeMessage(callSid, issue, nome) {
    try {
      const problemType = this.identifyProblemType(issue);
      const promptConfig = this.problemPrompts[problemType] || this.problemPrompts.default;
      
      this.userData.set(callSid, { 
        issue: issue,
        nome: nome,
        problemType: problemType
      });
      
      const prompt = promptConfig.welcome
        .replace(/{nome}/g, nome)
        .replace(/{issue}/g, issue);

      console.log(`🎯 Gerando mensagem [${problemType}] para: ${nome} - ${issue}`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const welcomeMessage = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      console.log(`🤖 Mensagem de boas-vindas [${problemType}] para ${nome}: ${welcomeMessage}`);
      
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
      
      const { issue, nome, problemType } = userData;
      const recentHistory = history.slice(-3);
      
      const prompt = this.buildProblemSpecificPrompt(userMessage, recentHistory, issue, nome, problemType);
      
      console.log(`🧠 Gemini [${callSid} - ${nome} - ${problemType}]: "${userMessage.substring(0, 50)}..."`);
      
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
      
      console.log(`🤖 Resposta [${callSid} - ${problemType}]: "${text.substring(0, 50)}..."`);
      
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

  // 🔥 CONSTRUIR PROMPT ESPECÍFICO
  buildProblemSpecificPrompt(userMessage, history, issue, nome, problemType) {
    const promptConfig = this.problemPrompts[problemType] || this.problemPrompts.default;
    
    let prompt = promptConfig.system
      .replace(/{nome}/g, nome)
      .replace(/{issue}/g, issue);

    if (history.length > 0) {
      history.forEach(([user, assistant]) => {
        prompt += `\nUsuário: ${user}`;
        prompt += `\nVocê: ${assistant}`;
      });
    }

    prompt += `\n\nUsuário: ${userMessage}`;
    prompt += `\n\nSua resposta (curta, focada no problema, para ${nome}):`;

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
    this.userData.delete(callSid);
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
    speechContexts: [{
      phrases: [
        "configurar", "e-mail", "email", "celular", "problema", "conexão",
        "internet", "conta", "fatura", "suporte", "técnico", "urgente"
      ],
      boost: 5.0
    }]
  },
  interimResults: true,
  interimResultsThreshold: 0.3,
  single_utterance: false,
  noSpeechTimeout: 60,
  enableVoiceActivityEvents: true
};

// =============================
// 🎙️ Audio Stream Session
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
    this.inactivityTimeout = null;
    this.lastActivityTime = Date.now();
    
    console.log(`🎧 Nova sessão: ${callSid}, Nome: ${nome}, Issue: ${issue}`);
    this.setupSTT();
    this.startHealthCheck();
    this.resetInactivityTimer();
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

  resetInactivityTimer() {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    
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
        this.resetInactivityTimer();

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
        this.resetInactivityTimer();
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
    
    if (this.inactivityTimeout) {
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
  }, 15000);

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
            session.ws = ws;
            console.log(`🔗 WebSocket atualizado para [${callSid}]`);
            
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
    
    if (session && (code === 1001 || code === 1006)) {
      console.log(`⏳ WebSocket desconectado, aguardando reconexão [${session.callSid}]`);
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
    isAlive = true;
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
    }, "Olá!");

    const start = response.start();
    start.stream({ 
      url: `wss://${new URL(baseUrl).host}/media-stream`,
      track: "inbound_track"
    });

    response.pause({ length: 300 });

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
  const nome = req.body.nome || "";

  if (!to || !nome) {
    return res.status(400).json({ 
      error: "Número e nome são obrigatórios" 
    });
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
      problemType: geminiService.identifyProblemType(issue),
      features: ["STT", "Gemini AI", "Google TTS", "Voz natural", "Personalização por nome", "Prompts dinâmicos"]
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
    features: ["STT", "Gemini AI", "Google TTS", "Voz natural premium", "Personalização por nome", "Prompts dinâmicos por problema"]
  });
});

// Middleware de segurança
app.use((req, res, next) => {
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

// Endpoint para cancelar chamadas
app.post("/cancel-call", async (req, res) => {
  const { callSid } = req.body;
  
  if (!callSid) {
    return res.status(400).json({ error: "callSid é obrigatório" });
  }

  try {
    await client.calls(callSid).update({ status: 'completed' });
    
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

// =============================
// 🎯 Página HTML com Seleção de Problemas
// =============================
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SafeCall AI - Prompts Dinâmicos</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background: #f0f2f5; }
          .container { max-width: 900px; margin: 0 auto; }
          .card { background: white; padding: 25px; margin: 20px 0; border-radius: 15px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          button { background: #007bff; color: white; padding: 12px 25px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; transition: 0.3s; }
          button:hover { background: #0056b3; transform: translateY(-2px); }
          input, textarea { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; box-sizing: border-box; }
          .feature { background: #e8f4fd; padding: 12px; margin: 8px 0; border-radius: 8px; border-left: 4px solid #007bff; }
          .issues-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
          .issue-card { 
            background: #fff; 
            border: 2px solid #e0e0e0; 
            border-radius: 12px; 
            padding: 20px; 
            text-align: center; 
            cursor: pointer; 
            transition: 0.3s; 
            font-weight: 500;
          }
          .issue-card:hover { 
            background: #007bff; 
            color: white; 
            border-color: #007bff;
            transform: translateY(-3px);
            box-shadow: 0 4px 15px rgba(0,123,255,0.3);
          }
          .issue-card.selected {
            background: #007bff;
            color: white;
            border-color: #007bff;
          }
          .status-badge { 
            display: inline-block; 
            padding: 4px 12px; 
            border-radius: 20px; 
            font-size: 14px; 
            margin: 5px; 
          }
          .status-active { background: #d4edda; color: #155724; }
          .status-pending { background: #fff3cd; color: #856404; }
          h1 { color: #333; text-align: center; margin-bottom: 30px; }
          h3 { color: #444; margin-bottom: 20px; }
          .problem-type { 
            background: #17a2b8; 
            color: white; 
            padding: 4px 8px; 
            border-radius: 4px; 
            font-size: 12px; 
            margin-left: 10px; 
          }
        </style>
        <script>
          let selectedProblemType = 'default';
          
          function selectIssue(text, type) {
            const textarea = document.querySelector('textarea[name="issue"]');
            const cards = document.querySelectorAll('.issue-card');
            
            // Remover seleção anterior
            cards.forEach(card => card.classList.remove('selected'));
            
            // Adicionar seleção atual
            event.target.classList.add('selected');
            
            textarea.value = text;
            selectedProblemType = type;
            
            // Atualizar display do tipo de problema
            updateProblemTypeDisplay(type);
          }
          
          function updateProblemTypeDisplay(type) {
            const typeDisplay = document.getElementById('problemTypeDisplay');
            const typeNames = {
              'email': '📱 E-mail',
              'internet': '🌐 Internet', 
              'conta': '🧾 Conta',
              'fatura': '💰 Fatura',
              'suporte': '🛠️ Suporte',
              'default': '🔧 Geral'
            };
            typeDisplay.innerHTML = \`Tipo: <span class="problem-type">\${typeNames[type]}</span>\`;
          }
          
          function updateStatus() {
            fetch('/health')
              .then(r => r.json())
              .then(data => {
                document.getElementById('activeSessions').textContent = data.active_sessions;
                document.getElementById('pendingIssues').textContent = data.pending_issues;
              });
          }
          
          // Atualizar status a cada 5 segundos
          setInterval(updateStatus, 5000);
          updateStatus();
        </script>
      </head>
      <body>
        <div class="container">
          <h1>SafeCall AI - Prompts Dinâmicos</h1>
          
          <div class="card">
            <h3>🎯 Fazer Chamada de Voz Inteligente</h3>
            <form action="/make-call" method="POST">
              <input type="text" name="nome" placeholder="Nome da pessoa" value="Daniel" required>
              
              <input type="tel" name="to" placeholder="Número de telefone" value="21994442087" required>

              <h4>Selecione o tipo de problema:</h4>
              <div class="issues-grid">
                <div class="issue-card" onclick="selectIssue('Preciso de ajuda para configurar meu e-mail no celular', 'email')">
                  📱 Configurar e-mail
                  <div style="font-size: 12px; opacity: 0.8; margin-top: 5px;">Servidores, senhas, autenticação</div>
                </div>
                <div class="issue-card" onclick="selectIssue('Estou com problemas de conexão na internet', 'internet')">
                  🌐 Problemas de internet
                  <div style="font-size: 12px; opacity: 0.8; margin-top: 5px;">WiFi, modem, velocidade</div>
                </div>
                <div class="issue-card" onclick="selectIssue('Quero atualizar o cadastro da minha conta', 'conta')">
                  🧾 Atualizar cadastro
                  <div style="font-size: 12px; opacity: 0.8; margin-top: 5px;">Dados, documentos, segurança</div>
                </div>
                <div class="issue-card" onclick="selectIssue('Minha fatura veio com valor incorreto', 'fatura')">
                  💰 Fatura incorreta
                  <div style="font-size: 12px; opacity: 0.8; margin-top: 5px;">Cobranças, contestação</div>
                </div>
                <div class="issue-card" onclick="selectIssue('Preciso de suporte técnico urgente', 'suporte')">
                  🛠️ Suporte técnico
                  <div style="font-size: 12px; opacity: 0.8; margin-top: 5px;">Urgente, crítico</div>
                </div>
              </div>

              <div id="problemTypeDisplay" style="margin: 10px 0; font-weight: bold;">Tipo: <span class="problem-type">🔧 Geral</span></div>

              <textarea name="issue" placeholder="Descreva o problema ou use os botões acima..." rows="3" required>
Preciso de ajuda para configurar meu email no celular
              </textarea>
              <button type="submit">🎯 Fazer Ligação Inteligente</button>
            </form>
          </div>
          
          <div class="card">
            <h3>📊 Status do Sistema</h3>
            <div class="feature">
              Sessões ativas: <strong id="activeSessions">0</strong>
              <span class="status-badge status-active">STT + Gemini</span>
            </div>
            <div class="feature">
              Issues pendentes: <strong id="pendingIssues">0</strong>
              <span class="status-badge status-pending">Aguardando</span>
            </div>
            <a href="/health" style="color: #007bff; text-decoration: none;">🔍 Ver Health Check Detalhado</a>
          </div>

          <div class="card">
            <h3>🚫 Cancelar Chamada</h3>
            <form action="/cancel-call" method="POST">
              <input type="text" name="callSid" placeholder="Call SID da chamada" required>
              <button type="submit" style="background: #dc3545;">⛔ Cancelar Chamada</button>
            </form>
          </div>

          <div class="card">
            <h3>🎯 Sistema de Prompts Dinâmicos</h3>
            <div class="feature">
              <strong>📱 E-mail:</strong> Configuração, servidores IMAP/SMTP, senhas de aplicativo
            </div>
            <div class="feature">
              <strong>🌐 Internet:</strong> Troubleshooting, reset de modem, velocidade, DNS
            </div>
            <div class="feature">
              <strong>🧾 Conta:</strong> Atualização de dados, documentos, segurança
            </div>
            <div class="feature">
              <strong>💰 Fatura:</strong> Análise de cobranças, contestação, documentos
            </div>
            <div class="feature">
              <strong>🛠️ Suporte:</strong> Urgência, criticidade, escalonamento
            </div>
            <div class="feature">
              <strong>🔧 Geral:</strong> Prompt padrão para outros problemas
            </div>
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
  console.log(`🎯 Sistema: Prompts dinâmicos ATIVADO`);
  console.log(`📊 Tipos de problemas: email, internet, conta, fatura, suporte`);
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