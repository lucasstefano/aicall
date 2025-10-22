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

// Servir arquivos de áudio estáticos
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
// 🧠 Gemini Service com Prompts de Segurança
// =============================
class GeminiService {
  constructor() {
    this.conversationHistory = new Map();
    this.userData = new Map();
    this.maxHistoryLength = 6;
    
    // 🔥 SISTEMA DE PROMPTS PARA INCIDENTES DE SEGURANÇA
    this.securityPrompts = {
      'phishing': {
        system: `Você é um especialista em segurança cibernética respondendo a um incidente de PHISHING.
DADOS DO INCIDENTE:
- Tipo: Ataque de Phishing
- Severidade: ALTA
- Usuário/Serviço: {user_service}
- Host Origem: {host_origin}
- IP Remoto: {remote_ip}
- URLs: {urls}

Instruções específicas:
- Foque em contenção imediata do phishing
- Oriente sobre reset de senhas e verificação de contas
- Alerte sobre links maliciosos e anexos suspeitos
- Explique procedimentos de reporte ao time de segurança
- Mantenha 1-2 frases por resposta
- Use tom urgente mas profissional
- Ofereça passos claros de ação`,
        welcome: `Crie uma mensagem urgente sobre incidente de PHISHING para {nome}.
Destaque a gravidade e a necessidade de ação imediata.
Inclua referência aos dados: {user_service}, {remote_ip}`
      },
      
      'malware': {
        system: `Você é um especialista em resposta a incidentes de MALWARE.
DADOS DO INCIDENTE:
- Tipo: Infecção por Malware
- Severidade: CRÍTICA  
- Host Origem: {host_origin}
- IP Remoto: {remote_ip}
- Porta/Protocolo: {port_protocol}
- Volumes: {volumes}

Instruções específicas:
- Priorize isolamento do sistema infectado
- Oriente sobre scan de antivírus e remoção
- Alerte sobre possível exfiltração de dados
- Explique procedimentos de quarentena
- Mantenha tom de extrema urgência
- Foque em contenção e mitigação`,
        welcome: `Crie uma mensagem crítica sobre infecção por MALWARE para {nome}.
Enfatize a necessidade de isolamento imediato do sistema.
Mencione: {host_origin}, {remote_ip}`
      },
      
      'ddos': {
        system: `Você é um especialista em mitigação de ataques DDoS.
DADOS DO INCIDENTE:
- Tipo: Ataque DDoS
- Severidade: ALTA
- IP Remoto: {remote_ip} 
- Porta/Protocolo: {port_protocol}
- Volumes: {volumes}
- Serviço: {user_service}

Instruções específicas:
- Foque em mitigação do tráfego malicioso
- Oriente sobre ativação de proteções DDoS
- Explique mudanças temporárias de roteamento
- Mantenha calma mas aja rapidamente
- Priorize disponibilidade do serviço`,
        welcome: `Crie uma mensagem sobre ataque DDoS em andamento para {nome}.
Destaque a mitigação em progresso e impacto no serviço.
Refira-se a: {remote_ip}, {volumes}`
      },
      
      'access': {
        system: `Você é um especialista em controle de acesso e identidade.
DADOS DO INCIDENTE:
- Tipo: Acesso Não Autorizado
- Severidade: MÉDIA-ALTA
- Usuário/Serviço: {user_service}
- Host Origem: {host_origin}
- IP Remoto: {remote_ip}
- Evidências: {evidence}

Instruções específicas:
- Foque em revogação de acessos comprometidos
- Oriente sobre reset de credenciais
- Explique verificação de logs de acesso
- Alerte sobre possíveis privilégios elevados
- Mantenha foco em contenção de acesso`,
        welcome: `Crie uma mensagem sobre acesso não autorizado detectado para {nome}.
Aborde a revogação de acessos e investigação em curso.
Dados: {user_service}, {host_origin}`
      },
      
      'data': {
        system: `Você é um especialista em proteção de dados e privacidade.
DADOS DO INCIDENTE:
- Tipo: Vazamento de Dados
- Severidade: CRÍTICA
- Volumes: {volumes}
- Endpoints: {urls}
- Evidências: {evidence}
- Observação: {critical_note}

Instruções específicas:
- Priorize contenção do vazamento
- Oriente sobre notificação legal se aplicável
- Explique procedimentos de preservação de evidências
- Mantenha tom de extrema seriedade
- Foque em minimizar impacto e conformidade`,
        welcome: `Crie uma mensagem crítica sobre vazamento de dados para {nome}.
Enfatize a gravidade e ações imediatas de contenção.
Refira-se a: {volumes}, {critical_note}`
      },
      
      'default': {
        system: `Você é um especialista em segurança cibernética.
DADOS DO INCIDENTE:
- Tipo: {attack_type}
- Severidade: {severity}
- Usuário/Serviço: {user_service}
- Host Origem: {host_origin}
- IP Remoto: {remote_ip}

Instruções:
- Responda com 1-2 frases focadas em ação imediata
- Mantenha tom profissional e urgente
- Ofereça orientações claras de contenção
- Adapte-se à severidade do incidente`,
        welcome: `Crie uma mensagem de alerta de segurança para {nome} sobre: {attack_type}
Baseie-se na severidade {severity} e dados fornecidos.`
      }
    };
  }

  // 🔥 GERAR MENSAGEM COM DADOS COMPLETOS DE SEGURANÇA
  async generateWelcomeMessage(callSid, securityData) {
    try {
      const { nome, attack_type, severity, user_service, host_origin, remote_ip, port_protocol, volumes, urls, evidence, critical_note } = securityData;
      
      const promptConfig = this.securityPrompts[attack_type] || this.securityPrompts.default;
      
      // Salvar dados completos para uso nas respostas
      this.userData.set(callSid, securityData);
      
      const prompt = promptConfig.welcome
        .replace(/{nome}/g, nome)
        .replace(/{attack_type}/g, attack_type)
        .replace(/{severity}/g, severity)
        .replace(/{user_service}/g, user_service)
        .replace(/{host_origin}/g, host_origin)
        .replace(/{remote_ip}/g, remote_ip)
        .replace(/{port_protocol}/g, port_protocol)
        .replace(/{volumes}/g, volumes)
        .replace(/{urls}/g, urls)
        .replace(/{evidence}/g, evidence)
        .replace(/{critical_note}/g, critical_note);

      console.log(`🎯 Gerando mensagem [${attack_type}-${severity}] para: ${nome}`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const welcomeMessage = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      console.log(`🤖 Mensagem de segurança [${attack_type}]: ${welcomeMessage}`);
      
      return welcomeMessage;
      
    } catch (error) {
      console.error(`❌ Erro gerando mensagem de segurança [${callSid}]:`, error);
      return `Alerta de segurança para ${securityData.nome}! Incidente ${securityData.attack_type} detectado. Ação imediata necessária.`;
    }
  }

  async generateResponse(callSid, userMessage) {
    try {
      const history = this.getConversationHistory(callSid);
      const securityData = this.userData.get(callSid);
      
      if (!securityData) {
        throw new Error('Dados de segurança não encontrados');
      }
      
      const { nome, attack_type, severity, user_service, host_origin, remote_ip, port_protocol, volumes, urls, evidence, critical_note } = securityData;
      const recentHistory = history.slice(-3);
      
      const prompt = this.buildSecurityPrompt(userMessage, recentHistory, securityData);
      
      console.log(`🧠 Gemini [${callSid} - ${attack_type} - ${severity}]: "${userMessage.substring(0, 50)}..."`);
      
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
      
      console.log(`🤖 Resposta [${callSid} - ${attack_type}]: "${text.substring(0, 50)}..."`);
      
      return text;
      
    } catch (error) {
      console.error(`❌ Erro Gemini [${callSid}]:`, error);
      
      const fallbacks = [
        "Repita por favor, não entendi a instrução.",
        "Confirmando os procedimentos de segurança. Pode detalhar?",
        "Não capturei completamente. Pode reformular o comando?",
        "Verificando protocolo de resposta. Pode repetir a orientação?"
      ];
      
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }

  // 🔥 CONSTRUIR PROMPT COM DADOS COMPLETOS DE SEGURANÇA
  buildSecurityPrompt(userMessage, history, securityData) {
    const { nome, attack_type, severity, user_service, host_origin, remote_ip, port_protocol, volumes, urls, evidence, critical_note } = securityData;
    
    const promptConfig = this.securityPrompts[attack_type] || this.securityPrompts.default;
    
    let prompt = promptConfig.system
      .replace(/{nome}/g, nome)
      .replace(/{attack_type}/g, attack_type)
      .replace(/{severity}/g, severity)
      .replace(/{user_service}/g, user_service)
      .replace(/{host_origin}/g, host_origin)
      .replace(/{remote_ip}/g, remote_ip)
      .replace(/{port_protocol}/g, port_protocol)
      .replace(/{volumes}/g, volumes)
      .replace(/{urls}/g, urls)
      .replace(/{evidence}/g, evidence)
      .replace(/{critical_note}/g, critical_note);

    if (history.length > 0) {
      history.forEach(([user, assistant]) => {
        prompt += `\nUsuário: ${user}`;
        prompt += `\nVocê: ${assistant}`;
      });
    }

    prompt += `\n\nUsuário: ${userMessage}`;
    prompt += `\n\nSua resposta (curta, focada em segurança, para ${nome}):`;

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
    console.log(`🧹 Histórico de segurança limpo para [${callSid}]`);
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
        "phishing", "malware", "ddos", "ataque", "segurança", "incidente",
        "firewall", "antivírus", "quarentena", "isolamento", "mitigação",
        "acesso", "credenciais", "senha", "vazamento", "dados", "criptografia"
      ],
      boost: 10.0
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
  constructor(ws, callSid, securityData = null) {
    this.ws = ws;
    this.callSid = callSid;
    this.securityData = securityData;
    this.sttStream = null;
    this.isActive = false;
    this.lastFinalTranscript = "";
    this.geminiProcessing = false;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
    this.healthCheckInterval = null;
    this.inactivityTimeout = null;
    this.lastActivityTime = Date.now();
    
    console.log(`🎧 Nova sessão de segurança: ${callSid}, Nome: ${securityData?.nome}, Tipo: ${securityData?.attack_type}`);
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
          console.log(`📝 [FINAL] ${this.callSid} (${this.securityData?.nome}): ${transcript}`);
          
          if (transcript !== this.lastFinalTranscript && transcript.length > 2) {
            this.lastFinalTranscript = transcript;
            await this.processWithGemini(transcript);
          }
          
        } else {
          if (transcript.length > 8) {
            console.log(`🎯 [INTERIM] ${this.callSid} (${this.securityData?.nome}): ${transcript}`);
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
    
    console.log(`🔚 Sessão de segurança finalizada [${this.callSid} - ${this.securityData?.nome}]`);
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
const pendingSecurityData = new Map();

wss.on("connection", (ws, req) => {
  console.log("🎧 Nova conexão WebSocket de segurança");
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
          console.log("🚀 Iniciando stream de segurança:", data.start.callSid);
          
          const callSid = data.start.callSid;
          const securityData = pendingSecurityData.get(callSid);
          
          if (activeSessions.has(callSid)) {
            session = activeSessions.get(callSid);
            session.ws = ws;
            console.log(`🔗 WebSocket atualizado para [${callSid}]`);
            
            if (!session.sttStream || !session.isActive) {
              console.log(`🔄 Reativando STT para [${callSid}]`);
              session.setupSTT();
            }
          } else {
            session = new AudioStreamSession(ws, callSid, securityData);
            activeSessions.set(callSid, session);
            
            if (securityData) {
              geminiService.generateWelcomeMessage(callSid, securityData)
                .then(welcomeMessage => {
                  responseQueue.addResponse(callSid, welcomeMessage);
                })
                .catch(error => {
                  console.error(`❌ Erro welcome message [${callSid}]:`, error);
                  responseQueue.addResponse(callSid, `Alerta de segurança para ${securityData.nome}! Incidente ${securityData.attack_type} detectado.`);
                });
            }
          }
          
          pendingSecurityData.delete(callSid);
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
    }, "Alerta de Segurança!");

    const start = response.start();
    start.stream({ 
      url: `wss://${new URL(baseUrl).host}/media-stream`,
      track: "inbound_track"
    });

    response.pause({ length: 300 });

    res.type("text/xml");
    res.send(response.toString());
    
    console.log("📞 TwiML de segurança gerado");
    
  } catch (error) {
    console.error("❌ Erro gerando TwiML:", error);
    res.status(500).send("Erro interno");
  }
});

// 🔥 DADOS PRÉ-DEFINIDOS PARA CADA TIPO DE ATAQUE
const SECURITY_INCIDENTS = {
  'phishing': {
    attack_type: 'phishing',
    severity: 'ALTA',
    user_service: 'usuário@empresa.com',
    host_origin: 'WORKSTATION-045',
    remote_ip: '192.168.1.45',
    port_protocol: '443/HTTPS',
    volumes: '2.3 MB transferidos',
    urls: 'phishing-scam.com/login, malicious-page.net/verify',
    evidence: 'E-mail de phishing detectado, credenciais capturadas',
    critical_note: 'Credenciais corporativas potencialmente comprometidas'
  },
  'malware': {
    attack_type: 'malware',
    severity: 'CRÍTICA',
    user_service: 'SERVIDOR-FILE01',
    host_origin: 'SRV-FILE-01',
    remote_ip: '10.20.30.45',
    port_protocol: '8080/TCP',
    volumes: '150 MB exfiltrados',
    urls: 'C&C: malware-command.com/beacon',
    evidence: 'Processo suspeito svchost-mal.exe, conexões anômalas',
    critical_note: 'Possível ransomware em fase inicial'
  },
  'ddos': {
    attack_type: 'ddos',
    severity: 'ALTA',
    user_service: 'WEBSERVER-PROD',
    host_origin: 'LB-PROD-01',
    remote_ip: '203.0.113.1-203.0.113.254',
    port_protocol: '80/HTTP, 443/HTTPS',
    volumes: '15 Gbps, 2M pps',
    urls: 'api.empresa.com/v1, www.empresa.com',
    evidence: 'Padrão de tráfego SYN flood identificado',
    critical_note: 'Serviços web com latência elevada'
  },
  'access': {
    attack_type: 'access',
    severity: 'MÉDIA-ALTA',
    user_service: 'admin@empresa.com',
    host_origin: 'AD-SERVER-01',
    remote_ip: '198.51.100.23',
    port_protocol: '3389/RDP',
    volumes: 'Vários logs de acesso falho',
    urls: 'vpn.empresa.com, remote.empresa.com',
    evidence: 'Tentativas de brute force no serviço RDP',
    critical_note: 'Possível tentativa de acesso privilegiado'
  },
  'data': {
    attack_type: 'data',
    severity: 'CRÍTICA',
    user_service: 'DB-PROD-01',
    host_origin: 'DATABASE-SRV',
    remote_ip: '172.16.1.100',
    port_protocol: '1433/TCP',
    volumes: '650 MB de dados sensíveis',
    urls: 'N/A (transferência direta)',
    evidence: 'Consulta massiva a tabelas de clientes e PII',
    critical_note: 'Dados pessoais identificáveis potencialmente expostos'
  }
};

// 🔥 FUNÇÃO PARA OBTER DATA/HORA ATUAL
function getCurrentDateTime() {
  const now = new Date();
  now.setHours(now.getHours() - 3); // UTC-3
  return {
    date: now.toISOString().split('T')[0],
    time: now.toTimeString().split(' ')[0],
    timestamp: now.toISOString()
  };
}

app.post("/make-call", async (req, res) => {
  let to = req.body.to;
  const nome = req.body.nome || "";
  const incidentType = req.body.incident_type || 'phishing';

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

    console.log(`📞 Chamada de segurança para: ${nome} (${to}) - ${incidentType}`);

    const call = await client.calls.create({
      to: to,
      from: fromNumber,
      url: `${baseUrl}/twiml`,
      timeout: 15,
      statusCallback: `${baseUrl}/call-status`,
      statusCallbackEvent: ["answered", "completed"],
    });

    // 🔥 MONTAR DADOS COMPLETOS DE SEGURANÇA
    const datetime = getCurrentDateTime();
    const baseIncident = SECURITY_INCIDENTS[incidentType];
    
    const securityData = {
      nome: nome,
      ...datetime,
      ...baseIncident
    };

    console.log(`✅ Chamada de segurança iniciada: ${call.sid}`);
    console.log(`👤 Responsável: ${nome}`);
    console.log(`🎯 Incidente: ${incidentType} - ${baseIncident.severity}`);
    console.log(`📊 Dados: ${baseIncident.user_service} → ${baseIncident.remote_ip}`);
    
    pendingSecurityData.set(call.sid, securityData);
    
    res.json({ 
      message: "Chamada de segurança iniciada", 
      sid: call.sid,
      nome: nome,
      incident_type: incidentType,
      severity: baseIncident.severity,
      numero_formatado: to,
      datetime: datetime,
      features: ["STT", "Gemini AI", "Google TTS", "Resposta a incidentes", "Dados de segurança completos"]
    });
  } catch (error) {
    console.error("❌ Erro criando chamada de segurança:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================
// 🌐 Webhooks e Monitoramento
// =============================
app.post("/call-status", (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`📞 Status [${CallStatus}]: ${CallSid}`);
  
  if (['completed', 'failed', 'busy'].includes(CallStatus)) {
    if (activeSessions.has(CallSid)) {
      const session = activeSessions.get(CallSid);
      session.cleanup();
      activeSessions.delete(CallSid);
    }
    pendingSecurityData.delete(CallSid);
  }
  
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.json({
    status: "secure",
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    pending_incidents: pendingSecurityData.size,
    features: ["STT", "Gemini AI", "Google TTS", "Resposta a incidentes", "Dados completos de segurança"]
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
    
    pendingSecurityData.delete(callSid);
    
    res.json({ 
      message: "Chamada de segurança cancelada",
      callSid: callSid
    });
  } catch (error) {
    console.error("❌ Erro cancelando chamada:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================
// 🎯 Página HTML com Incidentes de Segurança
// =============================
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SafeCall AI - Central de Segurança</title>
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background: #0f1a2b; color: #e0e0e0; }
          .container { max-width: 1200px; margin: 0 auto; }
          .card { background: #1a2a3f; padding: 25px; margin: 20px 0; border-radius: 15px; border: 1px solid #2a3a4f; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
          button { background: #007bff; color: white; padding: 15px 30px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; transition: 0.3s; width: 100%; }
          button:hover { background: #0056b3; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,123,255,0.4); }
          input { width: 100%; padding: 15px; margin: 10px 0; border: 1px solid #2a3a4f; border-radius: 8px; font-size: 16px; box-sizing: border-box; background: #2a3a4f; color: white; }
          .incidents-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin: 25px 0; }
          .incident-card { 
            background: linear-gradient(135deg, #1a2a3f, #2a3a4f);
            border: 2px solid; 
            border-radius: 12px; 
            padding: 25px; 
            cursor: pointer; 
            transition: 0.3s; 
            font-weight: 500;
            text-align: center;
          }
          .incident-card:hover { 
            transform: translateY(-5px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.4);
          }
          .incident-card.phishing { border-color: #ff6b6b; }
          .incident-card.malware { border-color: #ffa726; }
          .incident-card.ddos { border-color: #4fc3f7; }
          .incident-card.access { border-color: #ba68c8; }
          .incident-card.data { border-color: #4db6ac; }
          
          .incident-card.selected { 
            background: linear-gradient(135deg, #2a3a4f, #3a4a5f);
            box-shadow: 0 0 30px rgba(255,255,255,0.1);
          }
          
          .severity { 
            display: inline-block; 
            padding: 6px 15px; 
            border-radius: 20px; 
            font-size: 12px; 
            font-weight: bold;
            margin: 10px 0;
            text-transform: uppercase;
          }
          .severity-high { background: #dc3545; color: white; }
          .severity-critical { background: #fd7e14; color: white; }
          .severity-medium { background: #ffc107; color: black; }
          
          .incident-icon { font-size: 2.5em; margin-bottom: 15px; }
          .incident-details { font-size: 12px; text-align: left; margin-top: 15px; opacity: 0.8; }
          .incident-details div { margin: 5px 0; }
          
          h1 { color: #ffffff; text-align: center; margin-bottom: 10px; font-size: 2.5em; }
          h2 { color: #4fc3f7; text-align: center; margin-bottom: 30px; font-weight: 300; }
          h3 { color: #ffffff; margin-bottom: 20px; border-bottom: 2px solid #2a3a4f; padding-bottom: 10px; }
          
          .status-badge { 
            display: inline-block; 
            padding: 8px 16px; 
            border-radius: 20px; 
            font-size: 14px; 
            margin: 5px; 
            font-weight: 600;
          }
          .status-active { background: #155724; color: #d4edda; border: 1px solid #28a745; }
          .status-pending { background: #856404; color: #fff3cd; border: 1px solid #ffc107; }
          
          .form-group { margin: 20px 0; }
          label { display: block; margin-bottom: 8px; color: #a0a0a0; font-weight: 600; }
          
          @media (max-width: 768px) {
            .incidents-grid { grid-template-columns: 1fr; }
            .container { padding: 10px; }
          }
        </style>
        <script>
          let selectedIncident = 'phishing';
          
          function selectIncident(type, name) {
            const cards = document.querySelectorAll('.incident-card');
            
            // Remover seleção anterior
            cards.forEach(card => card.classList.remove('selected'));
            
            // Adicionar seleção atual
            event.target.closest('.incident-card').classList.add('selected');
            
            selectedIncident = type;
            
            // Atualizar display
            updateIncidentDisplay(type, name);
          }
          
          function updateIncidentDisplay(type, name) {
            const display = document.getElementById('selectedIncident');
            display.innerHTML = \`Incidente Selecionado: <strong>\${name}</strong> <span class="severity severity-\${getSeverityClass(type)}">\${getSeverityText(type)}</span>\`;
          }
          
          function getSeverityClass(type) {
            const severityMap = {
              'phishing': 'high',
              'malware': 'critical', 
              'ddos': 'high',
              'access': 'medium',
              'data': 'critical'
            };
            return severityMap[type];
          }
          
          function getSeverityText(type) {
            const textMap = {
              'phishing': 'ALTA',
              'malware': 'CRÍTICA',
              'ddos': 'ALTA',
              'access': 'MÉDIA-ALTA',
              'data': 'CRÍTICA'
            };
            return textMap[type];
          }
          
          function makeCall() {
            const nome = document.getElementById('nome').value;
            const telefone = document.getElementById('telefone').value;
            
            if (!nome || !telefone) {
              alert('Nome e telefone são obrigatórios!');
              return;
            }
            
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = '/make-call';
            
            const nomeInput = document.createElement('input');
            nomeInput.type = 'hidden';
            nomeInput.name = 'nome';
            nomeInput.value = nome;
            
            const telInput = document.createElement('input');
            telInput.type = 'hidden';
            telInput.name = 'to';
            telInput.value = telefone;
            
            const incidentInput = document.createElement('input');
            incidentInput.type = 'hidden';
            incidentInput.name = 'incident_type';
            incidentInput.value = selectedIncident;
            
            form.appendChild(nomeInput);
            form.appendChild(telInput);
            form.appendChild(incidentInput);
            
            document.body.appendChild(form);
            form.submit();
          }
          
          function updateStatus() {
            fetch('/health')
              .then(r => r.json())
              .then(data => {
                document.getElementById('activeSessions').textContent = data.active_sessions;
                document.getElementById('pendingIncidents').textContent = data.pending_incidents;
              });
          }
          
          // Atualizar status a cada 5 segundos
          setInterval(updateStatus, 5000);
          updateStatus();
          
          // Selecionar phishing por padrão
          document.addEventListener('DOMContentLoaded', function() {
            selectIncident('phishing', 'Ataque de Phishing');
          });
        </script>
      </head>
      <body>
        <div class="container">
          <h1>🚨 SafeCall AI</h1>
          <h2>Central de Resposta a Incidentes de Segurança</h2>
          
          <div class="card">
            <h3>🔍 Selecionar Tipo de Incidente</h3>
            <div class="incidents-grid">
              <div class="incident-card phishing" onclick="selectIncident('phishing', 'Ataque de Phishing')">
                <div class="incident-icon">📧</div>
                <h4>Phishing Detectado</h4>
                <div class="severity severity-high">ALTA SEVERIDADE</div>
                <div class="incident-details">
                  <div>📅 Data: ${getCurrentDateTime().date}</div>
                  <div>⏰ Hora: ${getCurrentDateTime().time} UTC-3</div>
                  <div>👤 Usuário: usuario@empresa.com</div>
                  <div>🌐 Host: WORKSTATION-045</div>
                  <div>📍 IP: 192.168.1.45</div>
                  <div>⚠️ Risco: Credenciais comprometidas</div>
                </div>
              </div>
              
              <div class="incident-card malware" onclick="selectIncident('malware', 'Infecção por Malware')">
                <div class="incident-icon">🦠</div>
                <h4>Infecção por Malware</h4>
                <div class="severity severity-critical">CRÍTICA</div>
                <div class="incident-details">
                  <div>📅 Data: ${getCurrentDateTime().date}</div>
                  <div>⏰ Hora: ${getCurrentDateTime().time} UTC-3</div>
                  <div>🖥️ Servidor: SRV-FILE-01</div>
                  <div>📍 IP: 10.20.30.45</div>
                  <div>📊 Dados: 150 MB exfiltrados</div>
                  <div>🚨 Alerta: Possível ransomware</div>
                </div>
              </div>
              
              <div class="incident-card ddos" onclick="selectIncident('ddos', 'Ataque DDoS')">
                <div class="incident-icon">🌊</div>
                <h4>Ataque DDoS</h4>
                <div class="severity severity-high">ALTA SEVERIDADE</div>
                <div class="incident-details">
                  <div>📅 Data: ${getCurrentDateTime().date}</div>
                  <div>⏰ Hora: ${getCurrentDateTime().time} UTC-3</div>
                  <div>🌐 Serviço: WEBSERVER-PROD</div>
                  <div>📡 IPs: 203.0.113.1-254</div>
                  <div>💥 Tráfego: 15 Gbps</div>
                  <div>⚠️ Impacto: Serviços com latência</div>
                </div>
              </div>
              
              <div class="incident-card access" onclick="selectIncident('access', 'Acesso Não Autorizado')">
                <div class="incident-icon">🔐</div>
                <h4>Acesso Não Autorizado</h4>
                <div class="severity severity-medium">MÉDIA-ALTA</div>
                <div class="incident-details">
                  <div>📅 Data: ${getCurrentDateTime().date}</div>
                  <div>⏰ Hora: ${getCurrentDateTime().time} UTC-3</div>
                  <div>👤 Conta: admin@empresa.com</div>
                  <div>🖥️ Servidor: AD-SERVER-01</div>
                  <div>📍 IP: 198.51.100.23</div>
                  <div>🚨 Tentativa: Brute force RDP</div>
                </div>
              </div>
              
              <div class="incident-card data" onclick="selectIncident('data', 'Vazamento de Dados')">
                <div class="incident-icon">💾</div>
                <h4>Vazamento de Dados</h4>
                <div class="severity severity-critical">CRÍTICA</div>
                <div class="incident-details">
                  <div>📅 Data: ${getCurrentDateTime().date}</div>
                  <div>⏰ Hora: ${getCurrentDateTime().time} UTC-3</div>
                  <div>🗄️ Banco: DB-PROD-01</div>
                  <div>📍 IP: 172.16.1.100</div>
                  <div>📊 Volume: 650 MB sensíveis</div>
                  <div>🚨 Dados: PII expostos</div>
                </div>
              </div>
            </div>
            
            <div id="selectedIncident" style="text-align: center; margin: 20px 0; font-size: 1.2em; padding: 15px; background: #2a3a4f; border-radius: 8px;">
              Selecione um incidente acima
            </div>
          </div>
          
          <div class="card">
            <h3>📞 Iniciar Chamada de Emergência</h3>
            <div class="form-group">
              <label for="nome">👤 Nome do Responsável:</label>
              <input type="text" id="nome" placeholder="Digite seu nome completo" value="Daniel Silva" required>
            </div>
            
            <div class="form-group">
              <label for="telefone">📱 Número de Telefone:</label>
              <input type="tel" id="telefone" placeholder="21994442087" value="21994442087" required>
            </div>
            
            <button onclick="makeCall()">🚨 INICIAR CHAMADA DE EMERGÊNCIA</button>
          </div>
          
          <div class="card">
            <h3>📊 Status do Sistema</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
              <div style="text-align: center; padding: 20px; background: #2a3a4f; border-radius: 8px;">
                <div style="font-size: 2em; font-weight: bold; color: #28a745;" id="activeSessions">0</div>
                <div>Chamadas Ativas</div>
                <div class="status-badge status-active">STT + Gemini</div>
              </div>
              <div style="text-align: center; padding: 20px; background: #2a3a4f; border-radius: 8px;">
                <div style="font-size: 2em; font-weight: bold; color: #ffc107;" id="pendingIncidents">0</div>
                <div>Incidentes Pendentes</div>
                <div class="status-badge status-pending">Monitorando</div>
              </div>
            </div>
          </div>
        </div>
        
        <script>
          function getCurrentDateTime() {
            const now = new Date();
            now.setHours(now.getHours() - 3);
            return {
              date: now.toISOString().split('T')[0],
              time: now.toTimeString().split(' ')[0]
            };
          }
        </script>
      </body>
    </html>
  `);
});

// =============================
// 🚀 Servidor
// =============================
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Central de Segurança iniciada na porta ${PORT}`);
  console.log(`🤖 Gemini Model: ${model}`);
  console.log(`🔊 Google TTS: ${ttsConfig.voice.name}`);
  console.log(`📁 Áudios servidos em: ${baseUrl}/audio/`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`🎯 Sistema: Resposta a incidentes ATIVADA`);
  console.log(`🚨 Tipos de incidentes: phishing, malware, ddos, access, data`);
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
  console.log("🔻 Encerrando central de segurança...");
  activeSessions.forEach(session => session.cleanup());
  activeSessions.clear();
  pendingSecurityData.clear();
  server.close(() => process.exit(0));
});