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
    temperature: 0.7
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
    this.processingDelay = 1000;
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
        const retryDelay = Math.min(3000 * response.retries, 15000);
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
      'Phishing': {
    system: `
        [TAREFA]
        Você é um agente de IA de Segurança para Resposta a Incidentes.
        Seu objetivo é conduzir uma conversa curta e direta com o usuário afetado, confirmar detalhes do incidente e instruir ações imediatas de contenção.

[INSTRUÇÕES ABSOLUTAS]
- Informe ao Usuário qual o incidente ocorreu de forma resumida.
- As respostas serão convertidas para TTS. Evite caracteres especiais, símbolos, emojis, pontuação excessiva ou palavras complexas.
- Faça uma pergunta por vez e aguarde a resposta do usuário.
- Use linguagem urgente, clara e concisa.
- Responda com uma frase curta por vez (máximo 2 frases).
- Se o usuário fizer perguntas fora do roteiro, responda apenas com base no contexto existente, em seguida tente retornar à próxima etapa do roteiro.
- Se o usuário pedir para repetir ou disser que não entendeu, repita a pergunta.
- Atenção TTS:
    - Nunca use emojis, símbolos especiais ou caracteres como #, ##, *, **, [], {}, <>, /**.
    - Use apenas vírgula, ponto, ponto de interrogação e ponto de exclamação.


        [OBJETIVO PRINCIPAL]
        -Capturar as seguintes informações do usuário:
        -O usuário clicou no link e inseriu usuário ou senha?
        -Quando exatamente?
        -Usou outro dispositivo?
        -O usuário abriu o anexo {hashes_anexos}?
        -Foi solicitado habilitar macros ou executar algo?
        -Percebeu algum comportamento estranho no computador depois disso (pop-ups, lentidão, programas desconhecidos)?
        -Ação com base nas respostas:
          - Se a resposta confirmar inserção de credenciais, instruir imediatamente o usuário a não usar essas credenciais e iniciar a redefinição de senha.

        [DADOS COLETADOS DO INCIDENTE]
            - Data do Incidente: {data}
            - Hora do Incidente: (UTC-3): {hora_utc3}
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
    `,
                
    welcome: `[TAREFA]  
        Você é um agente de IA de Segurança da empresa N E.
      [INSTRUÇÕES]
        Informe de forma curta e clara que é sobre um problema de segurança.
        Seja profissional, amigável e urgente.
        Sempre aguarde a resposta do usuário antes de prosseguir.
        Use uma única frase curta para a abertura.
      [EXEMPLO DE FALA]  
        "Oi, sou assistente de IA de segurança da empresa N E. Estou entrando em contato para falar sobre um problema de segurança urgente. Você pode conversar agora ?"
    `
    },
            
      'ransomware': {
        system: `
        [TAREFA]
        Você é um agente de IA de Segurança para Resposta a Incidentes.
        Seu objetivo é conduzir uma conversa curta e direta com o usuário afetado, confirmar detalhes do incidente e instruir ações imediatas de contenção.

        [INSTRUÇÕES ABSOLUTAS]
- Informe ao Usuário qual o incidente ocorreu de forma resumida.
- As respostas serão convertidas para TTS. Evite caracteres especiais, símbolos, emojis, pontuação excessiva ou palavras complexas.
- Faça uma pergunta por vez e aguarde a resposta do usuário.
- Use linguagem urgente, clara e concisa.
- Responda com uma frase curta por vez (máximo 2 frases).
- Se o usuário fizer perguntas fora do roteiro, responda apenas com base no contexto existente, em seguida tente retornar à próxima etapa do roteiro.
- Se o usuário pedir para repetir ou disser que não entendeu, repita a pergunta.
- Atenção TTS:
    - Nunca use emojis, símbolos especiais ou caracteres como #, ##, *, **, [], {}, <>, /**.
    - Use apenas vírgula, ponto, ponto de interrogação e ponto de exclamação.


        [OBJETIVO PRINCIPAL]
        -Capturar as seguintes informações do usuário:
        -O usuário realizou alguma atualização ou processo noturno?
        -Havia tarefas agendadas? Observou arquivos inacessíveis?
        -Usou outro dispositivo?
        - Avise ao Usuário para não desligar a máquina sem instruções
  
        [DADOS COLETADOS DO INCIDENTE]
            - Data do Incidente: {data}
            - Hora do Incidente: (UTC-3): {hora_utc3}
            - Tipo de ataque: Ransomware 
            - Host afetado: {user_service}
            - IP de Origem (cliente): {ip_origem_cliente}
            - IP de Origem (remoto): {ip_origem_remoto}
            - IP de Destino: {ip_destino}
            - Porta / Protocolo: {port_protocol}
              - Processos observados: {processos}
            - Evidências: {evidence}
            - Severity: {severity}
            - Observação crítica: {critical_note}
        `,
    welcome: `
      [TAREFA]  
        Você é um agente de IA de Segurança da empresa N E.
      [INSTRUÇÕES]
        Informe de forma curta e clara que é sobre um problema de segurança.
        Seja profissional, amigável e urgente.
        Sempre aguarde a resposta do usuário antes de prosseguir.
        Use uma única frase curta para a abertura.
      [EXEMPLO DE FALA]  
        "Oi, sou assistente de IA de segurança da empresa N E. Estou entrando em contato para falar sobre um problema de segurança urgente. Você pode conversar agora ?"
    `
    },
      
      'exfiltration': {
        system: `
        [TAREFA]
        Você é um agente de IA de Segurança para Resposta a Incidentes.
        Seu objetivo é conduzir uma conversa curta e direta com o usuário afetado, confirmar detalhes do incidente e instruir ações imediatas de contenção.

       [INSTRUÇÕES ABSOLUTAS]
- Informe ao Usuário qual o incidente ocorreu de forma resumida.
- As respostas serão convertidas para TTS. Evite caracteres especiais, símbolos, emojis, pontuação excessiva ou palavras complexas.
- Faça uma pergunta por vez e aguarde a resposta do usuário.
- Use linguagem urgente, clara e concisa.
- Responda com uma frase curta por vez (máximo 2 frases).
- Se o usuário fizer perguntas fora do roteiro, responda apenas com base no contexto existente, em seguida tente retornar à próxima etapa do roteiro.
- Se o usuário pedir para repetir ou disser que não entendeu, repita a pergunta.
- Atenção TTS:
    - Nunca use emojis, símbolos especiais ou caracteres como #, ##, *, **, [], {}, <>, /**.
    - Use apenas vírgula, ponto, ponto de interrogação e ponto de exclamação.


        [OBJETIVO PRINCIPAL]
        - Capturar as seguintes informações do usuário:
        - Houve um job de sincronização ou processo programado ontem à noite?
        - Quem executou?
        - As chaves foram rotacionadas recentemente?
  
        [DADOS COLETADOS DO INCIDENTE]
            - Data do Incidente: {data}
            - Hora do Incidente: (UTC-3): {hora_utc3}
            - Tipo de ataque: Possível exfiltração de dados para serviço de armazenamento externo (S3-like) / uso legítimo elevado suspeito
            - Usuário / Serviço envolvido: {user_service}
            - IP de Origem (cliente): {ip_origem_cliente}
            - IP de Origem (remoto): {ip_origem_remoto}
            - IP de Destino: {ip_destino}
            - Porta / Protocolo: {port_protocol}
            - Volumes transferidos: {volumes}
            - Endpoints / URLs: {urls}
            - Processos observados: {processos}
            - Evidências: {evidence}
            - Severity: {severity}
            - Observação crítica: {critical_note}

        `,
    welcome: `
    [TAREFA]  
        Você é um agente de IA de Segurança da empresa N E.
      [INSTRUÇÕES]
        Informe de forma curta e clara que é sobre um problema de segurança.
        Seja profissional, amigável e urgente.
        Sempre aguarde a resposta do usuário antes de prosseguir.
        Use uma única frase curta para a abertura.
      [EXEMPLO DE FALA]  
        "Oi, sou assistente de IA de segurança da empresa N E. Estou entrando em contato para falar sobre um problema de segurança urgente. Você pode conversar agora ?"
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

  // 🔥 GERAR MENSAGEM COM DADOS COMPLETOS DE SEGURANÇA
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
      
      // Salvar dados completos para uso nas respostas
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
      console.log(`🎯 DEBUG - Attack Type: ${securityData?.attack_type}`);
      console.log(`🎯 DEBUG - Prompt Config:`, this.securityPrompts[securityData?.attack_type] ? 'ENCONTRADO' : 'USANDO DEFAULT');
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
// 🎯 Configuração STT OTIMIZADA
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
        "sim", "não", "phishing", "ransomware", "exfiltration", "ataque", "segurança", "incidente",
        "firewall", "antivírus", "quarentena", "isolamento", "mitigação", "acesso", "credenciais",
        "senha", "vazamento", "dados", "criptografia", "backup", "exfiltração", "credenciais",
        "macros", "malicioso", "cliquei", "link", "anexo", "computador", "dispositivo", "rede",
        "suspeito", "estranho", "lentidão", "pop-up", "programa", "executar", "habilitei", "macro"
      ],
      boost: 15.0
    }]
  },
  interimResults: true,
  interimResultsThreshold: 0.5,
  single_utterance: false,
  noSpeechTimeout: 30,
  enableVoiceActivityEvents: true,
  speechEventTimeout: 5000
};

// =============================
// 🎙️ Audio Stream Session CORRIGIDA
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
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.mediaPacketsReceived = 0;
    this.lastMediaPacketTime = Date.now();
    
    console.log(`🎧 Nova sessão de segurança: ${callSid}, Nome: ${securityData?.nome}, Tipo: ${securityData?.attack_type}`);
    this.setupSTT();
    this.startHealthCheck();
    this.resetInactivityTimer();
  }

  setupSTT() {
    try {
      console.log(`🔧 Configurando STT para [${this.callSid}]`);
      
      // Fecha stream anterior se existir
      if (this.sttStream) {
        try {
          this.sttStream.removeAllListeners();
          this.sttStream.destroy();
        } catch (error) {
          // Ignora erros na limpeza
        }
      }
      
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
          console.log(`🔚 Stream STT finalizado normalmente [${this.callSid}]`);
          // Não recria automaticamente - aguarda health check
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
      this.attemptReconnect();
    }
  }

  resetInactivityTimer() {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    
    // 🔥 CRÍTICO: Aumentado significativamente para chamadas telefônicas
    this.inactivityTimeout = setTimeout(() => {
      const timeSinceLastMedia = Date.now() - this.lastMediaPacketTime;
      console.log(`⏰ Verificando inatividade [${this.callSid}]: ${timeSinceLastMedia}ms desde último pacote, ${this.mediaPacketsReceived} pacotes recebidos`);
      
      // Só reinicia se realmente não recebeu nenhum pacote de mídia
      if (this.mediaPacketsReceived === 0) {
        console.log(`🔄 Nenhum pacote de mídia recebido, verificando conexão... [${this.callSid}]`);
        this.checkMediaConnection();
      } else {
        console.log(`📞 Pacotes de mídia recebidos: ${this.mediaPacketsReceived}, mantendo sessão ativa [${this.callSid}]`);
        this.resetInactivityTimer(); // Continua monitorando
      }
    }, 120000); // 🔥 2 MINUTOS - tempo suficiente para respostas humanas
  }

  // 🔥 NOVO: Verifica especificamente a conexão de mídia
  checkMediaConnection() {
    const timeSinceLastMedia = Date.now() - this.lastMediaPacketTime;
    
    if (timeSinceLastMedia > 180000) { // 3 minutos sem mídia
      console.log(`🚫 Sem pacotes de mídia há 3 minutos, limpando sessão [${this.callSid}]`);
      this.cleanup();
    } else if (timeSinceLastMedia > 120000 && this.mediaPacketsReceived === 0) {
      console.log(`🔄 Tentando reinicialização completa do STT [${this.callSid}]`);
      this.restartSTT();
    }
    // Caso contrário, mantém a sessão ativa
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 30000); // A cada 30 segundos
  }

  performHealthCheck() {
    const now = Date.now();
    const timeSinceLastActivity = now - this.lastActivityTime;
    const timeSinceLastMedia = now - this.lastMediaPacketTime;
    
    console.log(`❤️ Health Check [${this.callSid}]: ${this.mediaPacketsReceived} pacotes, ${timeSinceLastMedia}ms desde última mídia, ${this.consecutiveErrors} erros`);
    
    // Só considera problema se não recebeu NENHUM pacote de mídia
    if (this.mediaPacketsReceived === 0 && timeSinceLastMedia > 90000) {
      console.log(`🚨 Health Check: Nenhum pacote de mídia recebido em 90s [${this.callSid}]`);
      this.checkMediaConnection();
    }
    
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      console.log(`🚑 Health Check: Muitos erros consecutivos [${this.callSid}], reiniciando...`);
      this.restartSTT();
    }
  }

  checkHealth() {
    this.performHealthCheck();
  }

  restartSTT() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log(`🚫 Máximo de tentativas de reconexão atingido [${this.callSid}]`);
      this.cleanup();
      return;
    }
    
    this.reconnectAttempts++;
    console.log(`🔄 Reiniciando STT (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts}) para [${this.callSid}]...`);
    
    this.setupSTT();
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
      console.log(`🔄 Reconexão ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts} em ${delay}ms [${this.callSid}]`);
      
      setTimeout(() => {
        if (this.isActive) {
          this.restartSTT();
        }
      }, delay);
    }
  }

  async handleSTTData(data) {
    try {
      if (data.results && data.results[0]) {
        const result = data.results[0];
        const transcript = result.alternatives[0]?.transcript?.trim();
        const isFinal = result.isFinal;
        const stability = result.stability;

        if (!transcript) {
          // Log de resultados vazios para debug
          if (data.results[0]?.alternatives?.length > 0) {
            console.log(`🔇 STT retornou transcript vazio [${this.callSid}], stability: ${stability}`);
          }
          return;
        }

        this.consecutiveErrors = 0;
        this.lastActivityTime = Date.now();
        this.resetInactivityTimer();

        // 🔥 MELHORIA: Log mais informativo
        const logType = isFinal ? 'FINAL' : (stability > 0.7 ? 'STABLE' : 'INTERIM');
        console.log(`📝 [${logType}] ${this.callSid}: "${transcript}" (stability: ${stability})`);
        
        if (isFinal && transcript.length > 2) {
          const isSignificantChange = this.isSignificantTranscriptChange(transcript);
          
          if (isSignificantChange) {
            this.lastFinalTranscript = transcript;
            await this.processWithGemini(transcript);
          }
        }
      }
    } catch (error) {
      console.error(`❌ Erro processando STT [${this.callSid}]:`, error);
      this.consecutiveErrors++;
      this.performHealthCheck();
    }
  }

  // 🔥 NOVO: Verifica se a transcrição é significativamente diferente da anterior
  isSignificantTranscriptChange(newTranscript) {
    if (!this.lastFinalTranscript) return true;
    
    const oldWords = this.lastFinalTranscript.toLowerCase().split(/\s+/);
    const newWords = newTranscript.toLowerCase().split(/\s+/);
    
    // Calcula similaridade simples
    const commonWords = oldWords.filter(word => newWords.includes(word));
    const similarity = commonWords.length / Math.max(oldWords.length, newWords.length);
    
    // Considera significativo se similaridade < 60%
    return similarity < 0.6;
  }

  async processWithGemini(transcript) {
    if (this.geminiProcessing) {
      console.log(`⏳ Gemini ocupado [${this.callSid}], ignorando: "${transcript}"`);
      return;
    }

    this.geminiProcessing = true;

    try {
      console.log(`🧠 Processando com Gemini: "${transcript}"`);
      const geminiResponse = await geminiService.generateResponse(this.callSid, transcript);
      
      if (geminiResponse && geminiResponse.length > 2) {
        console.log(`✅ Resposta Gemini recebida: "${geminiResponse.substring(0, 50)}..."`);
        responseQueue.addResponse(this.callSid, geminiResponse);
      } else {
        console.log(`⚠️ Resposta Gemini vazia ou muito curta para [${this.callSid}]`);
        
        // 🔥 MELHORIA: Fallback para resposta padrão
        const fallbackResponse = "Não entendi completamente. Pode repetir por favor?";
        responseQueue.addResponse(this.callSid, fallbackResponse);
      }
      
    } catch (error) {
      console.error(`❌ Erro processamento Gemini [${this.callSid}]:`, error);
      this.consecutiveErrors++;
      
      // 🔥 MELHORIA: Fallback em caso de erro
      const fallbackResponses = [
        "Houve um problema técnico. Pode repetir sua resposta?",
        "Não consegui processar sua resposta. Pode falar novamente?",
        "Estou com dificuldades técnicas. Pode reformular sua resposta?"
      ];
      const fallback = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
      responseQueue.addResponse(this.callSid, fallback);
      
    } finally {
      this.geminiProcessing = false;
    }
  }

  handleMedia(payload) {
    this.mediaPacketsReceived++;
    this.lastMediaPacketTime = Date.now();
    this.lastActivityTime = Date.now();
    
    // Log a cada 100 pacotes para não poluir
    if (this.mediaPacketsReceived % 100 === 0) {
      console.log(`📦 [${this.callSid}] Pacotes de mídia recebidos: ${this.mediaPacketsReceived}`);
    }
    
    if (this.sttStream && this.isActive) {
      try {
        const audioBuffer = Buffer.from(payload, "base64");
        this.sttStream.write(audioBuffer);
        this.resetInactivityTimer();
      } catch (error) {
        console.error(`❌ Erro escrevendo no STT [${this.callSid}]:`, error);
        this.consecutiveErrors++;
        this.performHealthCheck();
      }
    } else if (this.isActive) {
      console.log(`🔄 STT não disponível para pacote #${this.mediaPacketsReceived}, recriando... [${this.callSid}]`);
      this.setupSTT();
      
      // Tenta processar o pacote após recriação
      setTimeout(() => {
        if (this.sttStream && this.isActive) {
          try {
            const audioBuffer = Buffer.from(payload, "base64");
            this.sttStream.write(audioBuffer);
          } catch (retryError) {
            console.error(`❌ Erro no retry STT [${this.callSid}]:`, retryError);
          }
        }
      }, 500);
    }
  }

  // 🔥 MELHORIA: Manter sessão viva com heartbeats
  sendHeartbeat() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.ping();
      } catch (error) {
        console.error(`❌ Erro enviando heartbeat [${this.callSid}]:`, error);
      }
    }
  }

  cleanup() {
    console.log(`🧹 Iniciando cleanup completo [${this.callSid}]`);
    
    this.isActive = false;
    
    // Limpa todos os intervalos e timeouts
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
    
    // Limpa STT stream
    if (this.sttStream) {
      try {
        this.sttStream.removeAllListeners();
        this.sttStream.destroy();
      } catch (error) {
        // Ignora erros na destruição
      }
      this.sttStream = null;
    }
    
    console.log(`🔚 Sessão finalizada [${this.callSid}] - ${this.mediaPacketsReceived} pacotes recebidos`);
  }
}

// =============================
// 🔄 WebSocket Server CORRIGIDO
// =============================
const wss = new WebSocketServer({ 
  noServer: true,
  clientTracking: true
});

const activeSessions = new Map();
const pendingSecurityData = new Map();

// Armazenar resumos para exibição na tela
const callSummaries = new Map();

wss.on("connection", (ws, req) => {
  console.log("🎧 Nova conexão WebSocket de segurança");
  let session = null;
  let isAlive = true;
  let callSid = null;

  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      if (!isAlive) {
        console.log("💔 WebSocket inativo, terminando...");
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
      
      // 🔥 MELHORIA: Envia heartbeat para a sessão também
      if (session) {
        session.sendHeartbeat();
      }
    }
  }, 10000); // Reduzido para 10 segundos

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      
      switch (data.event) {
        case "start":
          console.log("🚀 Iniciando stream de segurança:", data.start.callSid);
          
          callSid = data.start.callSid;
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
          } else if (callSid) {
            console.log(`🔁 Criando nova sessão para mídia recebida [${callSid}]`);
            const securityData = pendingSecurityData.get(callSid) || geminiService.userData.get(callSid);
            session = new AudioStreamSession(ws, callSid, securityData);
            activeSessions.set(callSid, session);
          }
          break;

        case "stop":
          console.log("🛑 Parando stream:", data.stop.callSid);
          if (session) {
            session.isActive = false;
            console.log(`⏳ Stream parado, aguardando webhook de status... [${data.stop.callSid}]`);
            
            // 🔥 MELHORIA: Cleanup mais inteligente
            setTimeout(() => {
              if (session && activeSessions.has(data.stop.callSid)) {
                console.log(`⏰ Timeout fallback - limpando sessão [${data.stop.callSid}]`);
                session.cleanup();
                activeSessions.delete(data.stop.callSid);
              }
            }, 45000); // Aumentado para 45 segundos
          }
          break;
      }
    } catch (error) {
      console.error("❌ Erro processando mensagem WebSocket:", error);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`🔌 WebSocket fechado: ${code} - ${reason || 'Sem motivo'}`);
    clearInterval(heartbeatInterval);
    
    // 🔥 MELHORIA: Lógica de reconexão melhorada
    if (session && (code === 1001 || code === 1006)) {
      console.log(`⏳ WebSocket desconectado, aguardando reconexão [${session.callSid}]`);
      
      // Mantém a sessão ativa por mais tempo aguardando reconexão
      setTimeout(() => {
        if (session && (!session.ws || session.ws.readyState !== WebSocket.OPEN)) {
          console.log(`🚫 Timeout de reconexão [${session.callSid}], limpando...`);
          session.cleanup();
          activeSessions.delete(session.callSid);
        }
      }, 45000); // Aumentado para 45 segundos
    } else if (session) {
      // Para outros códigos de fechamento, limpa imediatamente
      session.cleanup();
      activeSessions.delete(session.callSid);
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

app.post("/make-call", async (req, res) => {
  let to = req.body.to;
  const nome = req.body.nome || "";
  const incidentType = req.body.incident_type || 'Phishing';

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

    const datetime = getCurrentDateTime();
    const baseIncident = SECURITY_INCIDENTS[incidentType];
    
    if (!baseIncident) {
      return res.status(400).json({ error: "Tipo de incidente inválido" });
    }

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
app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus } = req.body;
  
  console.log(`📞 STATUS WEBHOOK: [${CallSid}] -> ${CallStatus}`);
  
  if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
    console.log(`🎯 Processando finalização para [${CallSid}]`);
    
    const hasHistory = geminiService.conversationHistory.has(CallSid);
    const hasUserData = geminiService.userData.has(CallSid);
    
    console.log(`📋 Dados disponíveis - Histórico: ${hasHistory}, UserData: ${hasUserData}`);
    
    if (hasHistory && hasUserData) {
      console.log(`📝 GERANDO RESUMO PARA A TELA [${CallSid}]`);
      
      try {
        const summary = await geminiService.generateSummary(CallSid);
        const securityData = geminiService.userData.get(CallSid);
        const history = geminiService.getConversationHistory(CallSid);
        
        if (summary && securityData) {
          // Armazenar o resumo para exibição na tela
          callSummaries.set(CallSid, {
            summary: summary,
            securityData: securityData,
            conversationHistory: history.map(([user, assistant]) => ({
              user: user,
              assistant: assistant
            })),
            timestamp: new Date().toISOString()
          });
          
          console.log(`✅ Resumo armazenado para exibição na tela [${CallSid}]`);
        }
      } catch (error) {
        console.error(`❌ Erro gerando resumo para tela [${CallSid}]:`, error);
      }
    }
    
    geminiService.cleanup(CallSid);
    responseQueue.cleanup(CallSid);
    activeSessions.delete(CallSid);
    pendingSecurityData.delete(CallSid);
  }
  
  res.status(200).send("OK");
});

// Endpoint para obter resumo da chamada
app.get("/call-summary/:callSid", (req, res) => {
  const { callSid } = req.params;
  
  if (!callSid) {
    return res.status(400).json({ error: "CallSid é obrigatório" });
  }

  const summaryData = callSummaries.get(callSid);
  
  if (!summaryData) {
    return res.status(404).json({ error: "Resumo não encontrado para esta chamada" });
  }

  res.json(summaryData);
});

// Endpoint para listar todas as chamadas com resumo
app.get("/call-summaries", (req, res) => {
  const summaries = [];
  
  callSummaries.forEach((summaryData, callSid) => {
    summaries.push({
      callSid: callSid,
      nome: summaryData.securityData.nome,
      incident_type: summaryData.securityData.attack_type,
      severity: summaryData.securityData.severity,
      timestamp: summaryData.timestamp,
      summary_preview: summaryData.summary.substring(0, 100) + '...'
    });
  });

  res.json(summaries);
});

app.get("/health", (req, res) => {
  res.json({
    status: "secure",
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    pending_incidents: pendingSecurityData.size,
    call_summaries: callSummaries.size,
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
// 🎯 Página HTML com Resumo na Tela
// =============================
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SafeCall AI</title>
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background: #0f1a2b; color: #e0e0e0; }
          .container { max-width: 1200px; margin: 0 auto; }
          .card { background: #1a2a3f; padding: 25px; margin: 20px 0; border-radius: 15px; border: 1px solid #2a3a4f; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
          button { background: #007bff; color: white; padding: 15px 30px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; transition: 0.3s; }
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
          
          /* Estilos para o resumo */
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
          
          .summary-section {
            display: none;
          }
          
          .summary-actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
          }
          
          .summary-actions button {
            flex: 1;
          }
          
          @media (max-width: 768px) {
            .incidents-grid { grid-template-columns: 1fr; }
            .container { padding: 10px; }
            .summary-actions { flex-direction: column; }
          }
        </style>
        <script>
          let selectedIncident = 'Phishing';
          let currentCallSid = null;
          
          function selectIncident(type, name) {
            const cards = document.querySelectorAll('.incident-card');
            
            cards.forEach(card => card.classList.remove('selected'));
            
            event.target.closest('.incident-card').classList.add('selected');
            
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
          
          function makeCall() {
            const nome = document.getElementById('nome').value;
            const telefone = document.getElementById('telefone').value;
            
            if (!nome || !telefone) {
              alert('Nome e telefone são obrigatórios!');
              return;
            }

            // Esconder resumo anterior
            document.getElementById('summarySection').style.display = 'none';
            
            fetch('/make-call', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: \`nome=\${encodeURIComponent(nome)}&to=\${encodeURIComponent(telefone)}&incident_type=\${encodeURIComponent(selectedIncident)}\`
            })
            .then(response => response.json())
            .then(data => {
                if (data.sid) {
                    currentCallSid = data.sid;
                    showCallStatus('Chamada iniciada! Aguardando resposta...');
                    
                    // Iniciar verificação do resumo
                    startSummaryPolling(data.sid);
                } else {
                    throw new Error(data.error || 'Erro ao iniciar chamada');
                }
            })
            .catch(error => {
                console.error('Erro:', error);
                alert('Erro ao iniciar chamada: ' + error.message);
            });
          }
          
          function showCallStatus(message) {
            const statusDiv = document.getElementById('callStatus');
            statusDiv.innerHTML = \`
              <div class="card">
                <h3>📞 Status da Chamada</h3>
                <div style="text-align: center; padding: 20px;">
                  <div style="font-size: 3em;">📞</div>
                  <div style="margin: 20px 0; font-size: 1.2em;">\${message}</div>
                  <div class="loading-spinner"></div>
                </div>
              </div>
            \`;
          }
          
          function startSummaryPolling(callSid) {
            const pollInterval = setInterval(() => {
                fetch(\`/call-summary/\${callSid}\`)
                    .then(response => {
                        if (!response.ok) {
                            return null;
                        }
                        return response.json();
                    })
                    .then(summaryData => {
                        if (summaryData) {
                            clearInterval(pollInterval);
                            showCallSummary(summaryData);
                        }
                    })
                    .catch(error => {
                        // Continua polling se não encontrar resumo ainda
                    });
            }, 3000); // Verifica a cada 3 segundos
            
            // Para o polling após 5 minutos
            setTimeout(() => {
                clearInterval(pollInterval);
            }, 300000);
          }
          
          function showCallSummary(summaryData) {
            const summarySection = document.getElementById('summarySection');
            const callStatus = document.getElementById('callStatus');
            
            // Esconder status da chamada
            callStatus.innerHTML = '';
            
            // Mostrar resumo
            summarySection.style.display = 'block';
            
            let conversationHTML = '';
            if (summaryData.conversationHistory && summaryData.conversationHistory.length > 0) {
                summaryData.conversationHistory.forEach((entry, index) => {
                    conversationHTML += \`
                        <div class="conversation-entry">
                            <div class="user-message">
                                <strong>\${summaryData.securityData.nome || 'Usuário'}:</strong> \${entry.user}
                            </div>
                            <div class="assistant-message">
                                <strong>Assistente IA:</strong> \${entry.assistant}
                            </div>
                        </div>
                    \`;
                });
            }
            
            summarySection.innerHTML = \`
                <h3>📋 Resumo da Chamada - \${summaryData.securityData.nome}</h3>
                <div class="card">
                    <h4>🎯 Detalhes do Incidente</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 15px 0;">
                        <div><strong>Tipo:</strong> \${summaryData.securityData.attack_type}</div>
                        <div><strong>Severidade:</strong> <span class="severity severity-\${getSeverityClass(summaryData.securityData.attack_type)}">\${summaryData.securityData.severity}</span></div>
                        <div><strong>Usuário:</strong> \${summaryData.securityData.user_service}</div>
                        <div><strong>Host:</strong> \${summaryData.securityData.host_origin}</div>
                    </div>
                </div>
                
                <div class="card">
                    <h4>📊 Resumo Executivo</h4>
                    <div class="summary-content">
                        \${summaryData.summary}
                    </div>
                </div>
                
                \${conversationHTML ? \`
                <div class="card">
                    <h4>💬 Transcrição da Conversa</h4>
                    <div class="conversation-history">
                        \${conversationHTML}
                    </div>
                </div>
                \` : '<div class="card"><p>Nenhuma transcrição disponível.</p></div>'}
                
                <div class="card">
                    <div class="summary-actions">
                        <button onclick="downloadSummary('\${currentCallSid}')" style="background: #28a745;">
                            📥 Exportar Resumo
                        </button>
                        <button onclick="newCall()" style="background: #007bff;">
                            📞 Nova Chamada
                        </button>
                        <button onclick="viewAllSummaries()" style="background: #6c757d;">
                            📋 Ver Todas as Chamadas
                        </button>
                    </div>
                </div>
            \`;
          }
          
          function downloadSummary(callSid) {
            fetch(\`/call-summary/\${callSid}\`)
                .then(response => response.json())
                .then(summaryData => {
                    const content = \`
RESUMO DA CHAMADA - SAFECALL AI
===============================

DATA: \${new Date().toLocaleString()}
ANALISTA: \${summaryData.securityData.nome}
INCIDENTE: \${summaryData.securityData.attack_type}
SEVERIDADE: \${summaryData.securityData.severity}

DETALHES DO INCIDENTE:
- Usuário/Serviço: \${summaryData.securityData.user_service}
- Host Origem: \${summaryData.securityData.host_origin}
- IP Remoto: \${summaryData.securityData.remote_ip}

RESUMO EXECUTIVO:
\${summaryData.summary}

\${summaryData.conversationHistory && summaryData.conversationHistory.length > 0 ? \`
TRANSCRIÇÃO DA CONVERSA:
\${summaryData.conversationHistory.map(entry => \`
[\${summaryData.securityData.nome}]: \${entry.user}
[Assistente IA]: \${entry.assistant}
\`).join('\\n')}
\` : ''}
                    \`.trim();
                    
                    const blob = new Blob([content], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = \`resumo-chamada-\${callSid}.txt\`;
                    a.click();
                    URL.revokeObjectURL(url);
                });
          }
          
          function newCall() {
            currentCallSid = null;
            document.getElementById('summarySection').style.display = 'none';
            document.getElementById('callStatus').innerHTML = '';
            // Restaurar formulário original se necessário
          }
          
          function viewAllSummaries() {
            fetch('/call-summaries')
                .then(response => response.json())
                .then(summaries => {
                    const summarySection = document.getElementById('summarySection');
                    let summariesHTML = '<h3>📋 Todas as Chamadas Realizadas</h3>';
                    
                    if (summaries.length === 0) {
                        summariesHTML += '<div class="card"><p>Nenhuma chamada realizada ainda.</p></div>';
                    } else {
                        summaries.forEach(summary => {
                            summariesHTML += \`
                                <div class="card">
                                    <h4>\${summary.nome} - \${summary.incident_type}</h4>
                                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0;">
                                        <div><strong>CallSID:</strong> \${summary.callSid}</div>
                                        <div><strong>Severidade:</strong> <span class="severity severity-\${getSeverityClass(summary.incident_type)}">\${summary.severity}</span></div>
                                        <div><strong>Data:</strong> \${new Date(summary.timestamp).toLocaleString()}</div>
                                    </div>
                                    <p><strong>Resumo:</strong> \${summary.summary_preview}</p>
                                    <button onclick="loadSummary('\${summary.callSid}')" style="background: #007bff; margin-top: 10px;">
                                        🔍 Ver Detalhes
                                    </button>
                                </div>
                            \`;
                        });
                    }
                    
                    summarySection.innerHTML = summariesHTML;
                });
          }
          
          function loadSummary(callSid) {
            fetch(\`/call-summary/\${callSid}\`)
                .then(response => response.json())
                .then(summaryData => {
                    showCallSummary(summaryData);
                });
          }
          
          function updateStatus() {
            fetch('/health')
              .then(r => r.json())
              .then(data => {
                document.getElementById('activeSessions').textContent = data.active_sessions;
                document.getElementById('pendingIncidents').textContent = data.pending_incidents;
                document.getElementById('callSummaries').textContent = data.call_summaries;
              });
          }
          
          // Estilo para loading spinner
          const style = document.createElement('style');
          style.textContent = \`
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
          \`;
          document.head.appendChild(style);
          
          setInterval(updateStatus, 5000);
          updateStatus();
          
          document.addEventListener('DOMContentLoaded', function() {
            selectIncident('Phishing', 'Ataque de Phishing');
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
          
          <div class="card">
            <h3>📞 Iniciar Chamada de Emergência</h3>
            <div class="form-group">
              <label for="nome">👤 Nome do Responsável:</label>
              <input type="text" id="nome" placeholder="Digite seu nome completo" value="Daniel" required>
            </div>
            
            <div class="form-group">
              <label for="telefone">📱 Número de Telefone:</label>
              <input type="tel" id="telefone" placeholder="21994442087" value="21994442087" required>
            </div>
            
            <button onclick="makeCall()">🚨 INICIAR CHAMADA DE EMERGÊNCIA</button>
          </div>
          
          <div id="callStatus">
            <!-- Status da chamada será mostrado aqui -->
          </div>
          
          <div id="summarySection" class="summary-section">
            <!-- Resumo será injetado aqui -->
          </div>
          
          <div class="card">
            <h3>📊 Status do Sistema</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
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
              <div style="text-align: center; padding: 20px; background: #2a3a4f; border-radius: 8px;">
                <div style="font-size: 2em; font-weight: bold; color: #17a2b8;" id="callSummaries">0</div>
                <div>Resumos Gerados</div>
                <div class="status-badge status-pending">Histórico</div>
              </div>
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
  console.log(`🚀 Central de Segurança iniciada na porta ${PORT}`);
  console.log(`🤖 Gemini Model: ${model}`);
  console.log(`🔊 Google TTS: ${ttsConfig.voice.name}`);
  console.log(`📁 Áudios servidos em: ${baseUrl}/audio/`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`🎯 Sistema: Resposta a incidentes ATIVADA`);
  console.log(`🚨 Tipos de incidentes: Phishing, ransomware, exfiltration`);
  console.log(`📋 RESUMOS: Agora aparecem na tela em vez de serem enviados por email`);
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
  callSummaries.clear();
  server.close(() => process.exit(0));
});