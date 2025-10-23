import express from "express";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import textToSpeech from "@google-cloud/text-to-speech";
import { VertexAI } from '@google-cloud/vertexai';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const app = express();

// 🔥 CORREÇÃO: Configurar CORS primeiro e depois os parsers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 🔥 CORREÇÃO: Ordem correta dos middlewares
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
    temperature: 1,
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
    
    this.securityPrompts = {
      'Phishing': {
        system: `
        [TAREFA] Você é um agente de IA de Resposta a Incidentes (IR) em modo emergencial.
        Seu objetivo é confirmar detalhes do incidente e instruir ações imediatas de contenção.

        INSTRUÇÕES ABSOLUTAS
        - Faça UMA pergunta por vez e aguarde resposta
        - Linguagem urgente, clara e concisa
        - Responda com uma frase curta por vez (máximo 2 frases).
        - Se o usuário fizer perguntas fora do roteiro, responda apenas com base no contexto existente, mas tente retornar à próxima etapa do roteiro.
        - Se o usuário pedir para repetir, ou que não entendeu, repita a pergunta.
        - ATENÇÃO: as respostas serão convertidas para TTS, então:  
            - NUNCA use emojis, símbolos especiais ou caracteres como # ou ##, *, **, [], {}, <> ou /**.
            - Use apenas vírgula, ponto, ponto de interrogação e ponto de exclamação.  

        [CONTEXTO DO INCIDENTE]
            - Data: {data}
            - Hora (UTC-3): {hora_utc3}
            - Tipo de ataque: Phishing com possível validação de credenciais (link malicioso / formulário falso)
            - Usuário afetado: {user_service}
            - IP de Origem (cliente): {ip_origem_cliente}
            - IP de Origem (remoto): {ip_origem_remoto}
            - IP de Destino: {ip_destino}
            - Porta / Protocolo: {port_protocol}
            - Domínio / URL malicioso: {urls}
            - Assinaturas / IoCs: {signatures_iocs}
            - Hashes / anexos: {hashes_anexos}
            - Evidências: {evidence}
            - Severity: {severity}
            - Observação crítica: {critical_note}

        Passo 1. Passe ao Usuário um Resumo não técnico do problema, explicando o que aconteceu, como, quando, usando  o CONTEXTO DO INCIDENTE e, ao final, Pergunte ao Usuário:
        "Você clicou no link e inseriu usuário ou senha?" (AGUARDE RESPOSTA)

        Passo 2. Pergunte ao Usuário:
        "Quando exatamente? Usou outro dispositivo?" (AGUARDE RESPOSTA)

        Passo 3. Pergunte ao Usuário:
        "Você abriu o anexo {hashes_anexos}? Foi solicitado habilitar macros ou executar algo?" (AGUARDE RESPOSTA)

        Passo 4. Pergunte ao Usuário:
        "Percebeu algum comportamento estranho no computador depois disso? Pop-ups, lentidão ou programas desconhecidos?" (AGUARDE RESPOSTA)

        Passo 5. Com Base nas Respostas Anteriores:
        - Se resposta confirmar inserção: instruir para não usar credenciais e iniciar redefinição de senha.
        `,
                
        welcome: `[TAREFA]  
        Você é um assistente virtual da empresa ENE É.  
        Seu objetivo é iniciar a conversa com o usuário sobre um problema de segurança.  

        [INSTRUÇÕES]  
        - Comece sempre dizendo: "Oi, sou assistente da empresa ENE É."  
        - Informe de forma curta e clara que é sobre um problema de segurança.  
        - Seja profissional, amigável e urgente.  
        - Sempre aguarde resposta do usuário antes de prosseguir.  
        - Use uma única frase curta para a abertura.  

        [EXEMPLO DE FALA]  
        "Oi, sou assistente da empresa ENE É. Estou entrando em contato para falar sobre um problema de segurança urgente. Você pode me conversar agora ?"
        `
      },
            
      'ransomware': {
        system: `
            [TAREFA] Você é um agente de IA de Resposta a Incidentes (IR) em modo emergencial.
            Seu objetivo é confirmar detalhes do incidente e instruir ações imediatas de contenção.

            INSTRUÇÕES ABSOLUTAS
            - Faça UMA pergunta por vez e aguarde resposta
            - Linguagem urgente, clara e concisa
            - Responda com uma frase curta por vez (máximo 2 frases).
            - Se o usuário fizer perguntas fora do roteiro, responda apenas com base no contexto existente, mas tente retornar à próxima etapa do roteiro.
            - Se o usuário pedir para repetir, ou que não entendeu, repita a pergunta.
            - ATENÇÃO: as respostas serão convertidas para TTS, então:  
                - NUNCA use emojis, símbolos especiais ou caracteres como # ou ##, *, **, [], {}, <> ou /**.
                - Use apenas vírgula, ponto, ponto de interrogação e ponto de exclamação.  

            [CONTEXTO DO INCIDENTE]
            - Data: {data}
            - Hora (UTC-3): {hora_utc3}
            - Tipo de ataque: Phishing com possível validação de credenciais (link malicioso / formulário falso)
            - Usuário afetado: {user_service}
            - IP de Origem (cliente): {ip_origem_cliente}
            - IP de Origem (remoto): {ip_origem_remoto}
            - IP de Destino: {ip_destino}
            - Porta / Protocolo: {port_protocol}
            - Domínio / URL malicioso: {urls}
            - Assinaturas / IoCs: {signatures_iocs}
            - Hashes / anexos: {hashes_anexos}
            - Evidências: {evidence}
            - Severity: {severity}
            - Observação crítica: {critical_note}

            Passo 1. Passe ao Usuário um Resumo não técnico do problema, sem usar nomes complexos com ., explicando o que aconteceu, como, quando, usando  o CONTEXTO DO INCIDENTE e, ao final, Pergunte ao Usuário:
            "Estava realizando alguma atualização ou processo noturno?" (AGUARDE RESPOSTA)

            Passo 2. Pergunte ao Usuário:
            "Havia tarefas agendadas? Observou arquivos inacessíveis?" (AGUARDE RESPOSTA)

            Passo 3. Avise ao Usuário para não desligar a máquina sem instruções
        `,
        welcome: `[TAREFA]  
        Você é um assistente virtual da empresa ENE É.  
        Seu objetivo é iniciar a conversa com o usuário sobre um problema de segurança.  

        [INSTRUÇÕES]  
        - Comece sempre dizendo: "Oi, sou assistente da empresa ENE É."  
        - Informe de forma curta e clara que é sobre um problema de segurança.  
        - Seja profissional, amigável e urgente.  
        - Sempre aguarde resposta do usuário antes de prosseguir.  
        - Use uma única frase curta para a abertura.  

        [EXEMPLO DE FALA]  
        "Oi, sou assistente da empresa ENE É. Estou entrando em contato para falar sobre um problema de segurança urgente. Você pode me conversar agora ?"
        `
      },
      
      'exfiltration': {
        system: `
            [TAREFA] Você é um agente de IA de Resposta a Incidentes (IR) em modo emergencial.
            Seu objetivo é confirmar detalhes do incidente e instruir ações imediatas de contenção.

            INSTRUÇÕES ABSOLUTAS
            - Faça UMA pergunta por vez e aguarde resposta
            - Linguagem urgente, clara e concisa
            - Responda com uma frase curta por vez (máximo 2 frases).
            - Se o usuário fizer perguntas fora do roteiro, responda apenas com base no contexto existente, mas tente retornar à próxima etapa do roteiro.
            - Se o usuário pedir para repetir, ou que não entendeu, repita a pergunta.
            - ATENÇÃO: as respostas serão convertidas para TTS, então:  
                - NUNCA use emojis, símbolos especiais ou caracteres como # ou ##, *, **, [], {}, <> ou /**.
                - Use apenas vírgula, ponto, ponto de interrogação e ponto de exclamação.  

            [CONTEXTO DO INCIDENTE]
                - Data: {data}
                - Hora (UTC-3): {hora_utc3}
                - Tipo de ataque: Phishing com possível validação de credenciais (link malicioso / formulário falso)
                - Usuário afetado: {user_service}
                - IP de Origem (cliente): {ip_origem_cliente}
                - IP de Origem (remoto): {ip_origem_remoto}
                - IP de Destino: {ip_destino}
                - Porta / Protocolo: {port_protocol}
                - Domínio / URL malicioso: {urls}
                - Assinaturas / IoCs: {signatures_iocs}
                - Hashes / anexos: {hashes_anexos}
                - Evidências: {evidence}
                - Severity: {severity}
                - Observação crítica: {critical_note}

            Passo 1. Passe ao Usuário um Resumo não técnico do problema, sem usar nomes complexos com "." ou "-", explicando o que aconteceu, como, quando, usando  o CONTEXTO DO INCIDENTE e, ao final, Pergunte ao Usuário:
            "Houve um job de sincronização ou processo programado ontem à noite?" (AGUARDE RESPOSTA)

            Passo 2. Pergunte ao Usuário: 
                - SE Sim: "Quem executou? As chaves foram rotacionadas.
                - SE NÃO: "As chaves foram rotacionadas recentemente?" (AGUARDE RESPOSTA)

            Passo 3. Confirme com o Usuário se o tráfego foi intencional (deploy, backup, migração)(Não precisa especificar o endereço, exceto se foi pedido)
        `,
        welcome: `[TAREFA]  
        Você é um assistente virtual da empresa ENE É.  
        Seu objetivo é iniciar a conversa com o usuário sobre um problema de segurança.  

        [INSTRUÇÕES]  
        - Comece sempre dizendo: "Oi, sou assistente da empresa ENE É."  
        - Informe de forma curta e clara que é sobre um problema de segurança.  
        - Seja profissional, amigável e urgente.  
        - Sempre aguarde resposta do usuário antes de prosseguir.  
        - Use uma única frase curta para a abertura.  

        [EXEMPLO DE FALA]  
        "Oi, sou assistente da empresa ENE É. Estou entrando em contato para falar sobre um problema de segurança urgente. Você pode me conversar agora ?"
        `
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

  async generateWelcomeMessage(callSid, securityData) {
    try {
      const { 
        nome, attack_type, severity, user_service, host_origin, remote_ip,
        data, hora_utc3, ip_origem_cliente, ip_origem_remoto, ip_destino, 
        port_protocol, urls, signatures_iocs, hashes_anexos, evidence, 
        critical_note, host_afetado, ip_origem_host_interno, ips_remotos,
        processos, hash_binario, volumes
      } = securityData;
      
      const promptConfig = this.securityPrompts[attack_type] || this.securityPrompts.default;
      
      this.userData.set(callSid, securityData);
      
      const prompt = promptConfig.welcome
        .replace(/{nome}/g, nome)
        .replace(/{attack_type}/g, attack_type)
        .replace(/{severity}/g, severity)
        .replace(/{user_service}/g, user_service)
        .replace(/{host_origin}/g, host_origin)
        .replace(/{remote_ip}/g, remote_ip)
        .replace(/{data}/g, data)
        .replace(/{hora_utc3}/g, hora_utc3)
        .replace(/{ip_origem_cliente}/g, ip_origem_cliente || '')
        .replace(/{ip_origem_remoto}/g, ip_origem_remoto || '')
        .replace(/{ip_destino}/g, ip_destino || '')
        .replace(/{port_protocol}/g, port_protocol)
        .replace(/{urls}/g, urls)
        .replace(/{signatures_iocs}/g, signatures_iocs || '')
        .replace(/{hashes_anexos}/g, hashes_anexos || '')
        .replace(/{evidence}/g, evidence)
        .replace(/{critical_note}/g, critical_note)
        .replace(/{host_afetado}/g, host_afetado || '')
        .replace(/{ip_origem_host_interno}/g, ip_origem_host_interno || '')
        .replace(/{ips_remotos}/g, ips_remotos || '')
        .replace(/{processos}/g, processos || '')
        .replace(/{hash_binario}/g, hash_binario || '')
        .replace(/{volumes}/g, volumes || '');

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
    
      const { nome, attack_type, severity, user_service, host_origin, remote_ip,
        data, hora_utc3, ip_origem_cliente, ip_origem_remoto, ip_destino, 
        port_protocol, urls, signatures_iocs, hashes_anexos, evidence, 
        critical_note, host_afetado, ip_origem_host_interno, ips_remotos,
        processos, hash_binario, volumes } = securityData;
      
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

  buildSecurityPrompt(userMessage, history, securityData) {
    const { 
      nome, attack_type, severity, user_service, host_origin, remote_ip,
      data, hora_utc3, ip_origem_cliente, ip_origem_remoto, ip_destino, 
      port_protocol, urls, signatures_iocs, hashes_anexos, evidence, 
      critical_note, host_afetado, ip_origem_host_interno, ips_remotos,
      processos, hash_binario, volumes
    } = securityData;
    
    const promptConfig = this.securityPrompts[attack_type] || this.securityPrompts.default;
    
    let prompt = promptConfig.system
      .replace(/{nome}/g, nome)
      .replace(/{attack_type}/g, attack_type)
      .replace(/{severity}/g, severity)
      .replace(/{user_service}/g, user_service)
      .replace(/{host_origin}/g, host_origin)
      .replace(/{remote_ip}/g, remote_ip)
      .replace(/{data}/g, data)
      .replace(/{hora_utc3}/g, hora_utc3)
      .replace(/{ip_origem_cliente}/g, ip_origem_cliente || '')
      .replace(/{ip_origem_remoto}/g, ip_origem_remoto || '')
      .replace(/{ip_destino}/g, ip_destino || '')
      .replace(/{port_protocol}/g, port_protocol)
      .replace(/{urls}/g, urls)
      .replace(/{signatures_iocs}/g, signatures_iocs || '')
      .replace(/{hashes_anexos}/g, hashes_anexos || '')
      .replace(/{evidence}/g, evidence)
      .replace(/{critical_note}/g, critical_note)
      .replace(/{host_afetado}/g, host_afetado || '')
      .replace(/{ip_origem_host_interno}/g, ip_origem_host_interno || '')
      .replace(/{ips_remotos}/g, ips_remotos || '')
      .replace(/{processos}/g, processos || '')
      .replace(/{hash_binario}/g, hash_binario || '')
      .replace(/{volumes}/g, volumes || '');

    if (history.length > 0) {
      history.forEach(([user, assistant]) => {
        prompt += `\nUsuário: ${user}`;
        prompt += `\nVocê: ${assistant}`;
      });
    }

    prompt += `\n\nUsuário: ${userMessage}`;
    prompt += `\n\nSua resposta (curta, seguindo o roteiro, para ${nome}):`;

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
  
  async generateSummary(callSid) {
    const history = this.getConversationHistory(callSid);
    const securityData = this.userData.get(callSid);

    if (!history || history.length === 0 || !securityData) {
      console.log(`⚠️ Sem histórico ou dados para resumir [${callSid}]`);
      return null;
    }

    let conversationText = "";
    history.forEach(([userMessage, assistantResponse]) => {
      conversationText += `[${securityData.nome || 'Usuário'}]: ${userMessage}\n`;
      conversationText += `[Agente IA]: ${assistantResponse}\n`;
    });

    const prompt = `
      Tarefa: Você é um analista de segurança sênior. Resuma a seguinte transcrição de uma chamada de resposta a incidente.

      Contexto do Incidente:
      - Tipo: ${securityData.attack_type}
      - Severidade: ${securityData.severity}
      - Analista: ${securityData.nome}

      Objetivo do Resumo:
      1.  Identificar o reconhecimento do incidente pelo analista.
      2.  Listar as ações de contenção ou investigação confirmadas pelo analista durante a chamada.
      3.  Indicar quaisquer pontos pendentes ou preocupações levantadas.

      Formato: Use bullet points (tópicos) para clareza. Seja conciso e direto ao ponto.

      Transcrição da Chamada:
      ---
      ${conversationText}
      ---

      Resumo Executivo da Chamada:
    `;

    try {
      console.log(`🧠 Gemini [${callSid}] - Solicitando resumo da chamada...`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      
      if (!response.candidates || !response.candidates[0]) {
        throw new Error('Resposta de resumo vazia do Gemini');
      }
      
      const summary = response.candidates[0].content.parts[0].text.trim();
      
      console.log(`✅ Resumo gerado [${callSid}]: ${summary.substring(0, 100)}...`);
      return summary;
      
    } catch (error) {
      console.error(`❌ Erro ao gerar resumo com Gemini [${callSid}]:`, error);
      return "Erro ao gerar o resumo da chamada.";
    }
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
        "Phishing", "ransomware", "exfiltration", "ataque", "segurança", "incidente",
        "firewall", "antivírus", "quarentena", "isolamento", "mitigação",
        "acesso", "credenciais", "senha", "vazamento", "dados", "criptografia",
        "backup", "exfiltração", "credenciais", "macros", "malicioso"
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
            session.isActive = false;
            console.log(`⏳ Stream parado, aguardando webhook de status... [${data.stop.callSid}]`);
            
            setTimeout(() => {
            if (session && activeSessions.has(data.stop.callSid)) {
                console.log(`⏰ Timeout fallback - limpando sessão [${data.stop.callSid}]`);
                session.cleanup();
                activeSessions.delete(data.stop.callSid);
                geminiService.cleanup(data.stop.callSid);
                responseQueue.cleanup(data.stop.callSid);
            }
            }, 30000);
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
// 🚨 DADOS PRÉ-DEFINIDOS PARA CADA TIPO DE ATAQUE
// =============================
const SECURITY_INCIDENTS = {
  'Phishing': {
    data: '2025-10-22',
    hora_utc3: '09:18',
    attack_type: 'Phishing',
    severity: 'ALTO',
    user_service: 'joao.souza@empresa.com',
    host_origin: 'WORKSTATION-045',
    ip_origem_cliente: '10.10.45.21',
    ip_origem_remoto: '185.62.128.44',
    ip_destino: '172.16.2.12',
    port_protocol: '443 / HTTPS',
    urls: 'hxxps://secure-empresa-login[.]com/login',
    signatures_iocs: 'URL detectado por gateway de e-mail; HTTP POST para /auth com payload contendo username e password; user-agent: Mozilla/5.0 (Windows NT 10.0)',
    hashes_anexos: 'invoice_0922.doc (detected macro) — SHA256: fa3b...9c2',
    evidence: 'Logs de proxy mostram POST com credenciais; gateway e-mail marcou como suspicious but delivered; endpoint AV flagged macro attempt',
    critical_note: 'Usuário informou via chat que "clicou no link e inseriu a senha" — ação imediata necessária.',
    remote_ip: '185.62.128.44',
    volumes: 'Credenciais potencialmente comprometidas'
  },

  'ransomware': {
    data: '2025-10-22',
    hora_utc3: '02:44 (início de atividade) / Alerta SOC 02:51',
    attack_type: 'ransomware',
    severity: 'CRÍTICO',
    host_afetado: 'srv-finance-03.corp.local (10.20.5.73)',
    ip_origem_host_interno: '10.20.5.73',
    ips_remotos: '45.77.123.9 (C2 beacon), 104.21.12.34 (exfil endpoint possível)',
    port_protocol: '445 (SMB) + 443 outbound (TLS)',
    processos: 'evil-encryptor.exe iniciado como filho de schtasks.exe — C:\\Users\\Public\\temp\\evil-encryptor.exe',
    evidence: 'EDR detectou criação massiva de arquivos .enc; volume shadow copies deletadas; logs mostram acessos a shares \\\\fileserver\\finance',
    hash_binario: 'b4c2...e11',
    critical_note: 'Backups aumentaram I/O mas última cópia incremental foi ontem às 00:30 — verificar integridade.',
    user_service: 'srv-finance-03.corp.local',
    host_origin: 'srv-finance-03.corp.local',
    remote_ip: '45.77.123.9, 104.21.12.34',
    volumes: 'Dados financeiros criptografados',
    urls: 'C2: 45.77.123.9, Exfil: 104.21.12.34'
  },

  'exfiltration': {
    data: '2025-10-21',
    hora_utc3: '23:05 → 23:12',
    attack_type: 'exfiltration',
    severity: 'ALTO',
    user_service: 'svc-integration@empresa.com',
    host_origin: 'app-integration-01 (10.30.8.14)',
    remote_ip: '52.216.12.78 (provedor de object storage)',
    port_protocol: '443 (HTTPS)',
    volumes: '~18 GB em ~7 minutos (multipart uploads)',
    urls: 'https://s3-external[.]example/upload/part',
    evidence: 'Logs de firewall e proxy mostram POSTs autenticados com chave API AKIA...; comportamento anômalo vs baseline (200–500 MB/dia)',
    critical_note: 'Service account com acesso a sensitive-bucket (PIIs) — verificar abuso de credenciais ou vazamento.'
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

// =============================
// 📞 Endpoints Twilio
// =============================
app.post("/twiml", (req, res) => {
  try {
    const response = new twilio.twiml.VoiceResponse();

    response.say({ 
      voice: "alice", 
      language: "pt-BR" 
    }, "Alerta de Segurança! Um Minuto Por favor.");

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

// 🔥 CORREÇÃO: Endpoint /make-call com tratamento melhor de JSON
app.post("/make-call", async (req, res) => {
  console.log('📥 Recebendo requisição para fazer chamada:', req.body);
  
  // 🔥 CORREÇÃO: Verificar se o corpo existe
  if (!req.body) {
    return res.status(400).json({ 
      error: "Corpo da requisição ausente",
      details: "JSON inválido ou vazio"
    });
  }

  let to = req.body.to;
  const nome = req.body.nome || "";
  const incidentType = req.body.incident_type || 'Phishing';

  console.log(`📞 Dados recebidos: nome=${nome}, to=${to}, incidentType=${incidentType}`);

  if (!to || !nome) {
    return res.status(400).json({ 
      error: "Número e nome são obrigatórios",
      received: { to, nome, incidentType }
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

    const datetime = getCurrentDateTime();
    const baseIncident = SECURITY_INCIDENTS[incidentType];
    
    if (!baseIncident) {
      return res.status(400).json({ 
        error: "Tipo de incidente inválido",
        valid_types: Object.keys(SECURITY_INCIDENTS)
      });
    }

    const securityData = {
      nome: nome,
      ...datetime,
      ...baseIncident
    };

    console.log(`✅ Chamada de segurança iniciada: ${call.sid}`);
    console.log(`👤 Responsável: ${nome}`);
    console.log(`🎯 Incidente: ${incidentType} - ${baseIncident.severity}`);
    
    pendingSecurityData.set(call.sid, securityData);
    
    res.json({ 
      success: true,
      message: "Chamada de segurança iniciada", 
      sid: call.sid,
      nome: nome,
      incident_type: incidentType,
      severity: baseIncident.severity,
      numero_formatado: to,
      datetime: datetime
    });
  } catch (error) {
    console.error("❌ Erro criando chamada de segurança:", error);
    res.status(500).json({ 
      error: "Erro ao criar chamada",
      details: error.message 
    });
  }
});

// =============================
// 🌐 Webhooks e Monitoramento
// =============================
app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus } = req.body;
  
  console.log(`📞 STATUS WEBHOOK: [${CallSid}] -> ${CallStatus}`);
  
  if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
    console.log(`🎯 Processando finalização para [${CallSid}]`);
    
    const hasHistory = geminiService.conversationHistory.has(CallSid);
    const hasUserData = geminiService.userData.has(CallSid);
    
    console.log(`📋 Dados disponíveis - Histórico: ${hasHistory}, UserData: ${hasUserData}`);
    
    geminiService.cleanup(CallSid);
    responseQueue.cleanup(CallSid);
    activeSessions.delete(CallSid);
    pendingSecurityData.delete(CallSid);
  }
  
  res.status(200).send("OK");
});

// Novo endpoint para polling de status
app.get("/call-status-check", async (req, res) => {
  const { callSid } = req.query;
  
  if (!callSid) {
    return res.status(400).json({ error: "CallSid é obrigatório" });
  }

  try {
    const call = await client.calls(callSid).fetch();
    
    const response = {
      status: call.status,
      sid: call.sid,
      duration: call.duration
    };

    if (['completed', 'failed', 'busy', 'no-answer'].includes(call.status)) {
      const history = geminiService.getConversationHistory(callSid);
      const userData = geminiService.userData.get(callSid);
      
      if (history && history.length > 0) {
        let summary = await geminiService.generateSummary(callSid);
        
        response.summary = summary;
        response.conversationData = {
          conversationHistory: history.map(([user, assistant]) => ({
            user: user,
            assistant: assistant
          })),
          incidentDetails: userData
        };
      }
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('Erro verificando status:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "secure",
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    pending_incidents: pendingSecurityData.size,
    features: ["STT", "Gemini AI", "Google TTS", "Resposta a incidentes", "Dados completos de segurança"],
    incident_types: ["Phishing", "ransomware", "exfiltration"]
  });
});

app.get("/conversation-data/:callSid", (req, res) => {
 const { callSid } = req.params;

 if (!callSid) {
  return res.status(400).json({ error: "CallSid é obrigatório" });
 }

 const history = geminiService.getConversationHistory(callSid);
 const userData = geminiService.userData.get(callSid);

 if (!history && !userData) {
  return res.status(404).json({ 
   error: "Nenhum dado de conversa encontrado para este CallSid.",
   callSid: callSid
  });
 }

 const formattedHistory = history.map(([userMessage, assistantResponse]) => ({
  user: userMessage,
  assistant: assistantResponse
 }));

 res.json({
  callSid: callSid,
  incidentDetails: userData || "Dados do incidente não encontrados (possivelmente já limpos)",
  conversationHistory: formattedHistory || "Histórico vazio"
 });
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
// 🎯 Página HTML com Interface Atualizada
// =============================
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>SafeCall AI</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background: #0f1a2b; color: #e0e0e0; }
          .container { max-width: 1200px; margin: 0 auto; }
          .card { background: #1a2a3f; padding: 25px; margin: 20px 0; border-radius: 15px; border: 1px solid #2a3a4f; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
          button { background: #007bff; color: white; padding: 15px 30px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; transition: 0.3s; width: 100%; }
          button:hover { background: #0056b3; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,123,255,0.4); }
          button:disabled { background: #6c757d; cursor: not-allowed; transform: none; box-shadow: none; }
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
          .incident-card.Phishing { border-color: #ff6b6b; }
          .incident-card.ransomware { border-color: #ffa726; }
          .incident-card.exfiltration { border-color: #4fc3f7; }
          
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
          
          /* Novos estilos para a interface de chamada */
          .loading-spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #007bff;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 2s linear infinite;
            margin: 0 auto;
          }
          
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          
          .pulse-animation {
            width: 20px;
            height: 20px;
            background: #28a745;
            border-radius: 50%;
            margin: 0 auto;
            animation: pulse 1.5s infinite;
          }
          
          @keyframes pulse {
            0% { transform: scale(0.8); opacity: 0.7; }
            50% { transform: scale(1.2); opacity: 1; }
            100% { transform: scale(0.8); opacity: 0.7; }
          }
          
          .summary-content {
            background: #2a3a4f;
            padding: 20px;
            border-radius: 8px;
            margin: 15px 0;
            line-height: 1.6;
            white-space: pre-wrap;
          }
          
          .conversation-entry {
            margin: 15px 0;
            padding: 15px;
            background: #2a3a4f;
            border-radius: 8px;
            border-left: 4px solid #007bff;
          }
          
          .user-message {
            margin-bottom: 10px;
            color: #4fc3f7;
          }
          
          .assistant-message {
            color: #a0a0a0;
          }
          
          .conversation-history {
            max-height: 400px;
            overflow-y: auto;
          }
          
          .error-message {
            background: #dc3545;
            color: white;
            padding: 15px;
            border-radius: 8px;
            margin: 10px 0;
            text-align: center;
          }
          
          .success-message {
            background: #28a745;
            color: white;
            padding: 15px;
            border-radius: 8px;
            margin: 10px 0;
            text-align: center;
          }
          
          @media (max-width: 768px) {
            .incidents-grid { grid-template-columns: 1fr; }
            .container { padding: 10px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚨 SafeCall AI</h1>
          <h2>Central de Resposta a Incidentes de Segurança</h2>
          
          <div class="card">
            <h3>🔍 Selecionar Tipo de Incidente</h3>
            <div class="incidents-grid">
              <div class="incident-card Phishing" onclick="selectIncident('Phishing', 'Ataque de Phishing')">
                <div class="incident-icon">📧</div>
                <h4>Phishing Detectado</h4>
                <div class="severity severity-high">ALTA SEVERIDADE</div>
                <div class="incident-details">
                  <div>📅 Data: 2025-10-22</div>
                  <div>⏰ Hora: 09:18 UTC-3</div>
                  <div>👤 Usuário: joao.souza@empresa.com</div>
                  <div>🌐 Host: WORKSTATION-045</div>
                  <div>📍 IP Remoto: 185.62.128.44</div>
                  <div>🚨 Risco: Credenciais comprometidas + Macro</div>
                  <div>⚠️ URL: secure-empresa-login[.]com</div>
                </div>
              </div>
              
              <div class="incident-card ransomware" onclick="selectIncident('ransomware', 'Infecção por Ransomware')">
                <div class="incident-icon">🦠</div>
                <h4>Infecção por Ransomware</h4>
                <div class="severity severity-critical">CRÍTICO</div>
                <div class="incident-details">
                  <div>📅 Data: 2025-10-22</div>
                  <div>⏰ Hora: 02:44 UTC-3</div>
                  <div>🖥️ Servidor: srv-finance-03.corp.local</div>
                  <div>📍 IPs: 45.77.123.9 (C2), 104.21.12.34</div>
                  <div>⚙️ Processo: evil-encryptor.exe</div>
                  <div>🚨 Alerta: Criptografia ativa + Shadow copies</div>
                </div>
              </div>
              
              <div class="incident-card exfiltration" onclick="selectIncident('exfiltration', 'Exfiltração de Dados')">
                <div class="incident-icon">💾</div>
                <h4>Exfiltração de Dados</h4>
                <div class="severity severity-high">ALTA SEVERIDADE</div>
                <div class="incident-details">
                  <div>📅 Data: 2025-10-21</div>
                  <div>⏰ Hora: 23:05-23:12 UTC-3</div>
                  <div>👤 Serviço: svc-integration@empresa.com</div>
                  <div>🖥️ Host: app-integration-01</div>
                  <div>📊 Volume: 18 GB em 7 minutos</div>
                  <div>🚨 Risco: PIIs em bucket sensível</div>
                </div>
              </div>
            </div>
            
            <div id="selectedIncident" style="text-align: center; margin: 20px 0; font-size: 1.2em; padding: 15px; background: #2a3a4f; border-radius: 8px;">
              Selecione um incidente acima
            </div>
          </div>
          
          <div id="callSection" class="card">
            <h3>📞 Iniciar Chamada de Emergência</h3>
            <div class="form-group">
              <label for="nome">👤 Nome do Responsável:</label>
              <input type="text" id="nome" placeholder="Digite seu nome completo" value="Daniel Silva" required>
            </div>
            
            <div class="form-group">
              <label for="telefone">📱 Número de Telefone:</label>
              <input type="tel" id="telefone" placeholder="21994442087" value="21994442087" required>
            </div>
            
            <button onclick="makeCall()" id="callButton">🚨 INICIAR CHAMADA DE EMERGÊNCIA</button>
          </div>
          
          <div id="summarySection" style="display: none;">
            <!-- Resumo será injetado aqui -->
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
          let selectedIncident = 'Phishing';
          let currentCallSid = null;
          let callStatus = 'idle';
          let callSummary = null;
          
          function selectIncident(type, name) {
            const cards = document.querySelectorAll('.incident-card');
            
            cards.forEach(card => card.classList.remove('selected'));
            
            event.currentTarget.classList.add('selected');
            
            selectedIncident = type;
            
            updateIncidentDisplay(type, name);
          }
          
          function updateIncidentDisplay(type, name) {
            const display = document.getElementById('selectedIncident');
            display.innerHTML = \`Incidente Selecionado: <strong>\${name}</strong> <span class="severity severity-\${getSeverityClass(type)}">\${getSeverityText(type)}</span>\`;
          }
          
          function getSeverityClass(type) {
            const severityMap = {
              'Phishing': 'high',
              'ransomware': 'critical', 
              'exfiltration': 'high'
            };
            return severityMap[type];
          }
          
          function getSeverityText(type) {
            const textMap = {
              'Phishing': 'ALTO',
              'ransomware': 'CRÍTICO',
              'exfiltration': 'ALTO'
            };
            return textMap[type];
          }
          
          async function makeCall() {
            const nome = document.getElementById('nome').value;
            const telefone = document.getElementById('telefone').value;
            
            if (!nome || !telefone) {
              showError('Nome e telefone são obrigatórios!');
              return;
            }

            updateCallUI('calling');
            
            try {
              const response = await fetch('/make-call', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  nome: nome,
                  to: telefone,
                  incident_type: selectedIncident
                })
              });

              const data = await response.json();

              if (!response.ok) {
                throw new Error(data.error || data.details || 'Erro desconhecido');
              }

              if (data.sid) {
                currentCallSid = data.sid;
                updateCallUI('active');
                startCallStatusPolling(data.sid);
                showSuccess('Chamada iniciada com sucesso!');
              } else {
                throw new Error(data.error || 'Erro ao iniciar chamada');
              }
            } catch (error) {
              console.error('Erro:', error);
              showError('Erro ao iniciar chamada: ' + error.message);
              updateCallUI('idle');
            }
          }
          
          function updateCallUI(status) {
            callStatus = status;
            const callSection = document.getElementById('callSection');
            const callButton = document.getElementById('callButton');
            
            switch(status) {
              case 'idle':
                callSection.innerHTML = \`
                  <h3>📞 Iniciar Chamada de Emergência</h3>
                  <div class="form-group">
                    <label for="nome">👤 Nome do Responsável:</label>
                    <input type="text" id="nome" placeholder="Digite seu nome completo" value="Daniel Silva" required>
                  </div>
                  <div class="form-group">
                    <label for="telefone">📱 Número de Telefone:</label>
                    <input type="tel" id="telefone" placeholder="21994442087" value="21994442087" required>
                  </div>
                  <button onclick="makeCall()" id="callButton">🚨 INICIAR CHAMADA DE EMERGÊNCIA</button>
                \`;
                break;
                
              case 'calling':
                callSection.innerHTML = \`
                  <h3>📞 Conectando...</h3>
                  <div style="text-align: center; padding: 40px;">
                    <div style="font-size: 3em;">📞</div>
                    <div style="margin: 20px 0;">Iniciando chamada de emergência...</div>
                    <div class="loading-spinner"></div>
                  </div>
                \`;
                break;
                
              case 'active':
                callSection.innerHTML = \`
                  <h3>📞 Chamada em Andamento</h3>
                  <div style="text-align: center; padding: 30px;">
                    <div style="font-size: 4em; color: #28a745;">📞</div>
                    <div style="margin: 20px 0; font-size: 1.2em;">
                      <strong>Chamada Ativa</strong>
                    </div>
                    <div style="margin: 10px 0;">Conversando com o assistente de segurança...</div>
                    <div class="pulse-animation"></div>
                    <button onclick="cancelCall()" style="background: #dc3545; margin-top: 20px;">
                      🛑 Cancelar Chamada
                    </button>
                  </div>
                \`;
                break;
                
              case 'completed':
                callSection.innerHTML = \`
                  <h3>📞 Chamada Finalizada</h3>
                  <div style="text-align: center; padding: 20px;">
                    <div style="font-size: 3em;">✅</div>
                    <div style="margin: 20px 0;">Chamada concluída com sucesso!</div>
                    <button onclick="resetCall()" style="background: #007bff;">
                      📞 Nova Chamada
                    </button>
                  </div>
                \`;
                break;
            }
          }
          
          function cancelCall() {
            if (currentCallSid) {
              fetch('/cancel-call', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ callSid: currentCallSid })
              })
              .then(() => {
                updateCallUI('idle');
                currentCallSid = null;
                showSuccess('Chamada cancelada com sucesso');
              })
              .catch(error => {
                showError('Erro ao cancelar chamada: ' + error.message);
              });
            }
          }
          
          function resetCall() {
            currentCallSid = null;
            callSummary = null;
            updateCallUI('idle');
            document.getElementById('summarySection').style.display = 'none';
          }
          
          function startCallStatusPolling(callSid) {
            const pollInterval = setInterval(() => {
              fetch(\`/call-status-check?callSid=\${encodeURIComponent(callSid)}\`)
                .then(response => response.json())
                .then(data => {
                  if (data.status === 'completed' || data.status === 'failed' || data.status === 'busy' || data.status === 'no-answer') {
                    clearInterval(pollInterval);
                    
                    if (data.status === 'completed' && data.summary) {
                      showCallSummary(data.summary, data.conversationData);
                      showSuccess('Chamada finalizada - Resumo disponível');
                    } else {
                      updateCallUI('idle');
                      if (data.status !== 'completed') {
                        showError('Chamada não completada: ' + data.status);
                      }
                    }
                    
                    currentCallSid = null;
                  }
                })
                .catch(error => {
                  console.error('Erro no polling:', error);
                  clearInterval(pollInterval);
                  updateCallUI('idle');
                  currentCallSid = null;
                });
            }, 2000);
          }
          
          function showCallSummary(summary, conversationData) {
            updateCallUI('completed');
            
            const summarySection = document.getElementById('summarySection');
            summarySection.style.display = 'block';
            
            let conversationHTML = '';
            if (conversationData && conversationData.conversationHistory) {
              conversationData.conversationHistory.forEach((entry, index) => {
                conversationHTML += \`
                  <div class="conversation-entry">
                    <div class="user-message">
                      <strong>\${conversationData.incidentDetails?.nome || 'Usuário'}:</strong> \${entry.user}
                    </div>
                    <div class="assistant-message">
                      <strong>Assistente IA:</strong> \${entry.assistant}
                    </div>
                  </div>
                \`;
              });
            }
            
            summarySection.innerHTML = \`
              <h3>📋 Resumo da Chamada</h3>
              <div class="card">
                <h4>📊 Resumo Executivo</h4>
                <div class="summary-content">
                  \${summary}
                </div>
              </div>
              
              \${conversationHTML ? \`
              <div class="card">
                <h4>💬 Transcrição da Conversa</h4>
                <div class="conversation-history">
                  \${conversationHTML}
                </div>
              </div>
              \` : ''}
              
              <div class="card">
                <button onclick="downloadSummary()" style="background: #28a745; margin-right: 10px;">
                  📥 Exportar Resumo
                </button>
                <button onclick="resetCall()" style="background: #6c757d;">
                  🔄 Nova Chamada
                </button>
              </div>
            \`;
          }
          
          function downloadSummary() {
            const summaryContent = document.querySelector('.summary-content')?.innerText || 'Resumo não disponível';
            const blob = new Blob([summaryContent], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = \`resumo-chamada-\${currentCallSid || 'unknown'}.txt\`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
          
          function showError(message) {
            // Remove existing error messages
            const existingError = document.querySelector('.error-message');
            if (existingError) {
              existingError.remove();
            }
            
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.textContent = message;
            
            const callSection = document.getElementById('callSection');
            callSection.prepend(errorDiv);
            
            setTimeout(() => {
              if (errorDiv.parentNode) {
                errorDiv.remove();
              }
            }, 5000);
          }
          
          function showSuccess(message) {
            // Remove existing success messages
            const existingSuccess = document.querySelector('.success-message');
            if (existingSuccess) {
              existingSuccess.remove();
            }
            
            const successDiv = document.createElement('div');
            successDiv.className = 'success-message';
            successDiv.textContent = message;
            
            const callSection = document.getElementById('callSection');
            callSection.prepend(successDiv);
            
            setTimeout(() => {
              if (successDiv.parentNode) {
                successDiv.remove();
              }
            }, 5000);
          }
          
          function updateStatus() {
            fetch('/health')
              .then(r => r.json())
              .then(data => {
                document.getElementById('activeSessions').textContent = data.active_sessions;
                document.getElementById('pendingIncidents').textContent = data.pending_incidents;
              })
              .catch(error => console.error('Erro ao atualizar status:', error));
          }
          
          // Inicialização
          document.addEventListener('DOMContentLoaded', function() {
            selectIncident('Phishing', 'Ataque de Phishing');
            setInterval(updateStatus, 5000);
            updateStatus();
          });
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
  console.log(`🚨 Tipos de incidentes: Phishing, ransomware, exfiltration`);
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