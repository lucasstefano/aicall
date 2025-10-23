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
    maxOutputTokens: 120, // 🔥 REDUZIDO para respostas mais curtas
    temperature: 0.8
  },
});

// =============================
// 🎙️ Configuração Google TTS Otimizada
// =============================
const ttsConfig = {
  voice: {
    languageCode: 'pt-BR',
    name: "pt-BR-Wavenet-B", // 🔥 VOZ MAIS CLARA
    ssmlGender: 'MALE'
  },
  audioConfig: {
    audioEncoding: 'MP3',
    sampleRateHertz: 8000,
    speakingRate: 1.1, // 🔥 UM POUCO MAIS RÁPIDO
    pitch: 0.0,
    volumeGainDb: 2.0 // 🔥 UM POUCO MAIS ALTO
  }
};

// =============================
// 🎯 Sistema de Fila Otimizado
// =============================
class OptimizedResponseQueue {
  constructor() {
    this.queue = new Map();
    this.processing = new Set(); // 🔥 EVITA PROCESSAMENTO DUPLICADO
  }

  async addResponse(callSid, responseText) {
    try {
      // 🔥 EVITA ADICIONAR SE JÁ ESTÁ PROCESSANDO
      if (this.processing.has(callSid)) {
        console.log(`⏳ [${callSid}] Já processando, aguardando...`);
        return;
      }

      this.processing.add(callSid);
      console.log(`📥 Processando resposta: "${responseText.substring(0, 50)}..."`);
      
      const audioUrl = await this.generateAndHostTTS(callSid, responseText);
      await this.updateCallWithAudioURL(callSid, audioUrl);
      
    } catch (error) {
      console.error(`❌ Erro enviando resposta [${callSid}]:`, error);
    } finally {
      // 🔥 SEMPRE LIBERA O PROCESSAMENTO
      this.processing.delete(callSid);
    }
  }

  async generateAndHostTTS(callSid, text) {
    try {
      // 🔥 LIMITA O TAMANHO DO TEXTO PARA TTS
      const cleanText = text.substring(0, 200); // Máximo 200 caracteres
      
      const request = {
        input: { text: cleanText },
        voice: ttsConfig.voice,
        audioConfig: ttsConfig.audioConfig
      };

      console.log(`🔊 Gerando TTS: "${cleanText.substring(0, 50)}..."`);
      
      const [response] = await clientTTS.synthesizeSpeech(request);
      
      if (!response.audioContent) {
        throw new Error('Resposta de TTS vazia');
      }
      
      const filename = `tts_${callSid}_${Date.now()}.mp3`;
      const filepath = join(audioDir, filename);
      
      writeFileSync(filepath, response.audioContent, 'binary');
      
      // 🔥 LIMPEZA AUTOMÁTICA APÓS 3 MINUTOS
      setTimeout(() => {
        try {
          if (existsSync(filepath)) {
            unlinkSync(filepath);
            console.log(`🗑️ Áudio limpo: ${filename}`);
          }
        } catch (e) {}
      }, 180000);
      
      const audioUrl = `${baseUrl}/audio/${filename}`;
      console.log(`✅ TTS gerado: ${filename}`);
      
      return audioUrl;
      
    } catch (error) {
      console.error('❌ Erro gerando TTS:', error);
      throw error;
    }
  }

  async updateCallWithAudioURL(callSid, audioUrl) {
    try {
      const twiml = new twilio.twiml.VoiceResponse();
      
      // 🔥 PAUSA ANTES DE FALAR (melhora a experiência)
      twiml.pause({ length: 1 });
      twiml.play({}, audioUrl);
      
      // 🔥 STREAM CONTINUO
      const start = twiml.start();
      start.stream({ 
        url: `wss://${new URL(baseUrl).host}/media-stream`,
        track: "inbound_track"
      });

      await client.calls(callSid).update({
        twiml: twiml.toString()
      });

      console.log(`✅ Áudio enviado para [${callSid}]`);
      
    } catch (error) {
      console.error(`❌ Erro enviando áudio [${callSid}]:`, error);
      
      if (error.code === 20404) {
        console.log(`📞 Chamada [${callSid}] não existe mais`);
      }
      
      throw error;
    }
  }

  cleanup(callSid) {
    this.processing.delete(callSid);
    console.log(`🧹 Fila limpa para [${callSid}]`);
  }
}

const responseQueue = new OptimizedResponseQueue();

// =============================
// 🧠 Gemini Service Otimizado
// =============================
class OptimizedGeminiService {
  constructor() {
    this.conversationHistory = new Map();
    this.userData = new Map();
    this.maxHistoryLength = 4; // 🔥 HISTÓRICO MAIS CURTO
    
    // 🔥 MANTÉM OS PROMPTS DE SEGURANÇA ORIGINAIS
    this.securityPrompts = {
      'Phishing': {
        system: `[CONTEXTO] Você é um agente de IA de Segurança para Resposta a Incidentes.
        [INSTRUÇÕES] 
        - Converse naturalmente com o usuário sobre o incidente de phishing
        - Faça UMA pergunta por vez e aguarde a resposta
        - Seja direto e claro
        - Use linguagem natural em português
        - Evite repetir a mesma pergunta
        - Se não entender, peça para repetir de forma simples
        
        [INFORMAÇÕES DO INCIDENTE]
        - Usuário: {nome}
        - Tipo: Phishing
        - E-mail: {user_service}
        - URL suspeita: {urls}
        - Horário: {hora_utc3}
        
        [OBJETIVO] Descobrir se o usuário clicou no link, inseriu credenciais ou executou alguma ação.`,
                
        welcome: `[TAREFA]  
        Você é um agente de IA de Segurança da empresa.
        [INSTRUÇÕES]
        - Apresente-se de forma natural
        - Explique brevemente o motivo do contato
        - Faça uma pergunta inicial simples
        - Use tom profissional mas amigável
        [EXEMPLO]  
        "Olá {nome}, sou o assistente de segurança da empresa. Estou entrando em contato sobre um alerta de segurança no seu e-mail. Você tem um momento para conversar?"`
      },
            
      'ransomware': {
        system: `[CONTEXTO] Você é um agente de IA de Segurança para Resposta a Incidentes.
        [INSTRUÇÕES] 
        - Converse naturalmente com o usuário sobre o possível ransomware
        - Faça UMA pergunta por vez
        - Seja claro e direto
        - Use linguagem natural em português
        
        [INFORMAÇÕES]
        - Usuário: {nome}
        - Tipo: Ransomware
        - Servidor: {host_afetado}
        - Horário: {hora_utc3}
        
        [OBJETIVO] Verificar se o usuário notou algo incomum no servidor.`,
        welcome: `[TAREFA]  
        Você é um agente de IA de Segurança da empresa.
        [INSTRUÇÕES]
        - Apresente-se de forma natural
        - Explique brevemente o motivo
        - Faça uma pergunta inicial
        [EXEMPLO]  
        "Olá {nome}, sou o assistente de segurança. Preciso conversar sobre um alerta no servidor {host_afetado}. Você pode falar agora?"`
      },
      
      'exfiltration': {
        system: `[CONTEXTO] Você é um agente de IA de Segurança para Resposta a Incidentes.
        [INSTRUÇÕES] 
        - Converse naturalmente sobre a possível transferência de dados
        - Faça UMA pergunta por vez
        - Seja claro e objetivo
        
        [INFORMAÇÕES]
        - Usuário: {nome}
        - Tipo: Exfiltração de dados
        - Serviço: {user_service}
        - Volume: {volumes}
        
        [OBJETIVO] Verificar se houve algum processo ou job incomum.`,
        welcome: `[TAREFA]  
        Você é um agente de IA de Segurança da empresa.
        [INSTRUÇÕES]
        - Apresente-se naturalmente
        - Explique o motivo brevemente
        - Faça uma pergunta simples
        [EXEMPLO]  
        "Olá {nome}, sou o assistente de segurança. Estou verificando uma atividade incomum no sistema. Você tem um minuto?"`
      },
      
      'default': {
        system: `Você é um especialista em segurança cibernética.
        Converse naturalmente com {nome} sobre um incidente de {attack_type}.
        Faça uma pergunta por vez. Seja direto e claro.`,
        welcome: `Olá {nome}, sou assistente de segurança da empresa. Preciso conversar sobre um alerta de {attack_type}. Você pode falar agora?`
      }
    };
  }

  async generateWelcomeMessage(callSid, securityData) {
    try {
      const { nome, attack_type } = securityData;
      
      const promptConfig = this.securityPrompts[attack_type] || this.securityPrompts.default;
      
      // Salvar dados para uso nas respostas
      this.userData.set(callSid, securityData);
      
      const prompt = this.replacePromptPlaceholders(promptConfig.welcome, securityData);
      
      console.log(`🎯 Gerando mensagem [${attack_type}] para: ${nome}`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const welcomeMessage = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      console.log(`🤖 Mensagem: ${welcomeMessage}`);
      
      return welcomeMessage;
      
    } catch (error) {
      console.error(`❌ Erro mensagem [${callSid}]:`, error);
      return `Olá ${securityData.nome}, sou assistente de segurança. Podemos conversar sobre um alerta?`;
    }
  }

  async generateResponse(callSid, userMessage) {
    try {
      const history = this.getConversationHistory(callSid);
      const securityData = this.userData.get(callSid);
      
      if (!securityData) {
        return "Vamos recomeçar. Podemos conversar sobre o alerta de segurança?";
      }
    
      const { nome, attack_type } = securityData;
      
      // 🔥 HISTÓRICO MAIS CURTO - APENAS ÚLTIMAS 2 INTERAÇÕES
      const recentHistory = history.slice(-2);
      
      const promptConfig = this.securityPrompts[attack_type] || this.securityPrompts.default;
      let prompt = this.replacePromptPlaceholders(promptConfig.system, securityData);

      // 🔥 ADICIONA HISTÓRICO RECENTE SE HOUVER
      if (recentHistory.length > 0) {
        prompt += "\n\n[CONVERSA RECENTE]";
        recentHistory.forEach(([user, assistant]) => {
          prompt += `\nUsuário: ${user}`;
          prompt += `\nVocê: ${assistant}`;
        });
      }

      prompt += `\n\nUsuário: ${userMessage}`;
      prompt += `\n\nSua resposta (curta e natural, 1-2 frases):`;

      console.log(`🧠 Processando: "${userMessage.substring(0, 50)}..."`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      
      if (!response.candidates || !response.candidates[0]) {
        throw new Error('Resposta vazia do Gemini');
      }
      
      const text = response.candidates[0].content.parts[0].text.replace(/\*/g, '').trim();
      
      this.updateConversationHistory(callSid, userMessage, text);
      
      console.log(`🤖 Resposta: "${text.substring(0, 50)}..."`);
      
      return text;
      
    } catch (error) {
      console.error(`❌ Erro Gemini [${callSid}]:`, error);
      
      const fallbacks = [
        "Pode repetir, por favor? Não entendi bem.",
        "Não captei completamente. Pode falar novamente?",
        "Desculpe, houve um problema. Pode repetir?"
      ];
      
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }

  replacePromptPlaceholders(prompt, securityData) {
    return prompt
      .replace(/{nome}/g, securityData.nome || '')
      .replace(/{attack_type}/g, securityData.attack_type || '')
      .replace(/{user_service}/g, securityData.user_service || '')
      .replace(/{urls}/g, securityData.urls || '')
      .replace(/{hora_utc3}/g, securityData.hora_utc3 || '')
      .replace(/{host_afetado}/g, securityData.host_afetado || '')
      .replace(/{volumes}/g, securityData.volumes || '');
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
    
    // 🔥 MANTÉM APENAS HISTÓRICO RECENTE
    if (history.length > this.maxHistoryLength) {
      history.splice(0, history.length - this.maxHistoryLength);
    }
  }

  async generateSummary(callSid) {
    const history = this.getConversationHistory(callSid);
    const securityData = this.userData.get(callSid);

    if (!history || history.length === 0) {
      return "Nenhuma conversa registrada para resumo.";
    }

    let conversationText = "";
    history.forEach(([userMessage, assistantResponse]) => {
      conversationText += `[${securityData?.nome || 'Usuário'}]: ${userMessage}\n`;
      conversationText += `[Assistente]: ${assistantResponse}\n\n`;
    });

    const prompt = `
      Resuma esta conversa sobre segurança em português de forma concisa (máximo 100 palavras).
      Destaque as informações mais importantes que o usuário forneceu.

      Conversa:
      ${conversationText}
    `;

    try {
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      return response.candidates[0].content.parts[0].text.trim();
    } catch (error) {
      console.error(`❌ Erro resumo [${callSid}]:`, error);
      return "Resumo não disponível.";
    }
  }

  cleanup(callSid) {
    this.conversationHistory.delete(callSid);
    this.userData.delete(callSid);
  }
}

const geminiService = new OptimizedGeminiService();

// =============================
// 🎙️ Configuração STT OTIMIZADA
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
        "sim", "não", "phishing", "ransomware", "exfiltration", "segurança", 
        "incidente", "clicar", "link", "senha", "credenciais", "computador",
        "dispositivo", "sim eu", "não eu", "talvez", "possivelmente"
      ],
      boost: 15.0
    }]
  },
  interimResults: false, // 🔥 APENAS RESULTADOS FINAIS
  single_utterance: true, // 🔥 UMA FRASE POR VEZ
  noSpeechTimeout: 10, // 🔥 TIMEOUT MAIS CURTO
  enableVoiceActivityEvents: true
};

// =============================
// 🎧 Audio Session Otimizada
// =============================
class OptimizedAudioSession {
  constructor(ws, callSid, securityData) {
    this.ws = ws;
    this.callSid = callSid;
    this.securityData = securityData;
    this.sttStream = null;
    this.isActive = true;
    this.lastTranscript = "";
    this.isProcessing = false; // 🔥 EVITA PROCESSAMENTO SIMULTÂNEO
    
    console.log(`🎧 Nova sessão: ${callSid}, Nome: ${securityData?.nome}, Tipo: ${securityData?.attack_type}`);
    this.setupSTT();
  }

  setupSTT() {
    try {
      // 🔥 LIMPA STREAM ANTERIOR
      if (this.sttStream) {
        try {
          this.sttStream.removeAllListeners();
          this.sttStream.destroy();
        } catch (error) {}
      }
      
      this.sttStream = clientSTT
        .streamingRecognize(sttConfig)
        .on("data", (data) => {
          this.handleSTTData(data);
        })
        .on("error", (error) => {
          console.error(`❌ Erro STT [${this.callSid}]:`, error);
          this.reconnectSTT();
        })
        .on("end", () => {
          console.log(`🔚 STT finalizado [${this.callSid}]`);
        });

      console.log(`✅ STT configurado [${this.callSid}]`);
      
    } catch (error) {
      console.error(`❌ Erro criando STT [${this.callSid}]:`, error);
    }
  }

  reconnectSTT() {
    if (this.isActive) {
      console.log(`🔄 Reconectando STT [${this.callSid}]...`);
      setTimeout(() => {
        if (this.isActive) {
          this.setupSTT();
        }
      }, 1000);
    }
  }

  async handleSTTData(data) {
    if (!this.isActive || this.isProcessing) return;
    
    if (data.results && data.results[0] && data.results[0].isFinal) {
      const transcript = data.results[0].alternatives[0]?.transcript?.trim();
      
      if (transcript && transcript.length > 1) {
        console.log(`📝 Transcrição [${this.callSid}]: "${transcript}"`);
        
        // 🔥 EVITA PROCESSAR A MESMA TRANSCRIÇÃO REPETIDAMENTE
        if (transcript !== this.lastTranscript) {
          this.lastTranscript = transcript;
          this.isProcessing = true;
          
          try {
            const response = await geminiService.generateResponse(this.callSid, transcript);
            await responseQueue.addResponse(this.callSid, response);
          } catch (error) {
            console.error(`❌ Erro processando resposta [${this.callSid}]:`, error);
          } finally {
            this.isProcessing = false;
          }
        }
      }
    }
  }

  handleMedia(payload) {
    if (this.sttStream && this.isActive) {
      try {
        const audioBuffer = Buffer.from(payload, "base64");
        this.sttStream.write(audioBuffer);
      } catch (error) {
        console.error(`❌ Erro enviando áudio [${this.callSid}]:`, error);
      }
    }
  }

  cleanup() {
    console.log(`🧹 Limpando sessão [${this.callSid}]`);
    this.isActive = false;
    
    if (this.sttStream) {
      try {
        this.sttStream.removeAllListeners();
        this.sttStream.destroy();
      } catch (error) {}
      this.sttStream = null;
    }
  }
}

// =============================
// 🔄 WebSocket Server Otimizado
// =============================
const wss = new WebSocketServer({ noServer: true });
const activeSessions = new Map();
const pendingSecurityData = new Map();
const callSummaries = new Map();

wss.on("connection", (ws, req) => {
  console.log("🎧 Nova conexão WebSocket");
  let session = null;
  let callSid = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      
      switch (data.event) {
        case "start":
          callSid = data.start.callSid;
          const securityData = pendingSecurityData.get(callSid);
          
          console.log(`🚀 Iniciando: ${callSid}, Tipo: ${securityData?.attack_type}`);
          
          if (activeSessions.has(callSid)) {
            session = activeSessions.get(callSid);
            session.ws = ws;
            console.log(`🔗 WebSocket atualizado [${callSid}]`);
          } else {
            session = new OptimizedAudioSession(ws, callSid, securityData);
            activeSessions.set(callSid, session);
            
            // 🔥 ENVIA MENSAGEM DE BOAS-VINDAS
            if (securityData) {
              geminiService.generateWelcomeMessage(callSid, securityData)
                .then(welcomeMessage => {
                  responseQueue.addResponse(callSid, welcomeMessage);
                })
                .catch(error => {
                  console.error(`❌ Erro welcome [${callSid}]:`, error);
                });
            }
          }
          
          pendingSecurityData.delete(callSid);
          break;

        case "media":
          if (session && session.isActive) {
            session.handleMedia(data.media.payload);
          }
          break;

        case "stop":
          console.log(`🛑 Parando: ${data.stop.callSid}`);
          if (session) {
            session.cleanup();
            activeSessions.delete(data.stop.callSid);
          }
          break;
      }
    } catch (error) {
      console.error("❌ Erro WebSocket:", error);
    }
  });

  ws.on("close", () => {
    console.log(`🔌 WebSocket fechado [${callSid}]`);
    if (session) {
      // 🔥 NÃO LIMPA IMEDIATAMENTE - AGUARDA RECONEXÃO
      setTimeout(() => {
        if (session && (!session.ws || session.ws.readyState !== WebSocket.OPEN)) {
          session.cleanup();
          activeSessions.delete(callSid);
        }
      }, 30000);
    }
  });

  ws.on("error", (error) => {
    console.error("❌ Erro WebSocket:", error);
  });
});

// =============================
// 🚨 DADOS DE SEGURANÇA (MANTIDOS)
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
    signatures_iocs: 'URL detectado por gateway de e-mail',
    hashes_anexos: 'invoice_0922.doc (detected macro)',
    evidence: 'Logs de proxy mostram POST com credenciais',
    critical_note: 'Usuário informou via chat que "clicou no link e inseriu a senha"',
    remote_ip: '185.62.128.44',
    volumes: 'Credenciais potencialmente comprometidas'
  },

  'ransomware': {
    data: '2025-10-22',
    hora_utc3: '02:44',
    attack_type: 'ransomware',
    severity: 'CRÍTICO',
    host_afetado: 'srv-finance-03.corp.local',
    ip_origem_host_interno: '10.20.5.73',
    ips_remotos: '45.77.123.9 (C2), 104.21.12.34',
    port_protocol: '445 (SMB) + 443 outbound (TLS)',
    processos: 'evil-encryptor.exe',
    evidence: 'EDR detectou criação massiva de arquivos .enc',
    hash_binario: 'b4c2...e11',
    critical_note: 'Backups aumentaram I/O',
    user_service: 'srv-finance-03.corp.local',
    host_origin: 'srv-finance-03.corp.local',
    remote_ip: '45.77.123.9, 104.21.12.34',
    volumes: 'Dados financeiros criptografados',
    urls: 'C2: 45.77.123.9'
  },

  'exfiltration': {
    data: '2025-10-21',
    hora_utc3: '23:05',
    attack_type: 'exfiltration',
    severity: 'ALTO',
    user_service: 'svc-integration@empresa.com',
    host_origin: 'app-integration-01',
    remote_ip: '52.216.12.78',
    port_protocol: '443 (HTTPS)',
    volumes: '~18 GB em ~7 minutos',
    urls: 'https://s3-external[.]example/upload/part',
    evidence: 'Logs mostram POSTs autenticados com chave API',
    critical_note: 'Service account com acesso a dados sensíveis'
  }
};

// 🔥 FUNÇÃO PARA OBTER DATA/HORA ATUAL
function getCurrentDateTime() {
  const now = new Date();
  now.setHours(now.getHours() - 3);
  return {
    date: now.toISOString().split('T')[0],
    time: now.toTimeString().split(' ')[0],
    timestamp: now.toISOString()
  };
}

// =============================
// 📞 Endpoints (MANTIDOS)
// =============================
app.post("/twiml", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  response.say({ 
    voice: "alice", 
    language: "pt-BR" 
  }, "Conectando com segurança.");

  const start = response.start();
  start.stream({ 
    url: `wss://${new URL(baseUrl).host}/media-stream`,
    track: "inbound_track"
  });

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/make-call", async (req, res) => {
  let to = req.body.to;
  const nome = req.body.nome || "";
  const incidentType = req.body.incident_type || 'Phishing';

  if (!to || !nome) {
    return res.status(400).json({ error: "Número e nome são obrigatórios" });
  }

  try {
    to = to.trim().replace(/\s/g, "");
    
    if (!to.startsWith("+55")) {
      to = "+55" + to;
    }

    console.log(`📞 Chamada para: ${nome} (${to}) - ${incidentType}`);

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

    console.log(`✅ Chamada iniciada: ${call.sid}`);
    console.log(`👤 Responsável: ${nome}`);
    console.log(`🎯 Incidente: ${incidentType}`);
    
    pendingSecurityData.set(call.sid, securityData);
    
    res.json({ 
      message: "Chamada iniciada", 
      sid: call.sid,
      nome: nome,
      incident_type: incidentType,
      severity: baseIncident.severity
    });
  } catch (error) {
    console.error("❌ Erro criando chamada:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus } = req.body;
  
  console.log(`📞 Status: [${CallSid}] -> ${CallStatus}`);
  
  if (CallStatus === 'completed') {
    console.log(`📝 Gerando resumo para [${CallSid}]`);
    
    try {
      const summary = await geminiService.generateSummary(CallSid);
      const securityData = geminiService.userData.get(CallSid);
      
      if (summary && securityData) {
        callSummaries.set(CallSid, {
          summary: summary,
          securityData: securityData,
          timestamp: new Date().toISOString()
        });
        
        console.log(`✅ Resumo armazenado [${CallSid}]`);
      }
    } catch (error) {
      console.error(`❌ Erro resumo [${CallSid}]:`, error);
    }
    
    geminiService.cleanup(CallSid);
    responseQueue.cleanup(CallSid);
    activeSessions.delete(CallSid);
    pendingSecurityData.delete(CallSid);
  }
  
  res.status(200).send("OK");
});

// Endpoints de resumo (mantidos)
app.get("/call-summary/:callSid", (req, res) => {
  const { callSid } = req.params;
  const summaryData = callSummaries.get(callSid);
  
  if (!summaryData) {
    return res.status(404).json({ error: "Resumo não encontrado" });
  }

  res.json(summaryData);
});

app.get("/call-summaries", (req, res) => {
  const summaries = Array.from(callSummaries.values());
  res.json(summaries);
});

app.get("/health", (req, res) => {
  res.json({
    status: "secure",
    active_sessions: activeSessions.size,
    call_summaries: callSummaries.size
  });
});

// =============================
// 🎯 Página HTML (MANTIDA)
// =============================
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SafeCall AI</title>
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background: #0f1a2b; color: #e0e0e0; }
          .container { max-width: 1200px; margin: 0 auto; }
          .card { background: #1a2a3f; padding: 25px; margin: 20px 0; border-radius: 15px; border: 1px solid #2a3a4f; }
          button { background: #007bff; color: white; padding: 15px 30px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; }
          button:hover { background: #0056b3; }
          input { width: 100%; padding: 15px; margin: 10px 0; border: 1px solid #2a3a4f; border-radius: 8px; font-size: 16px; box-sizing: border-box; background: #2a3a4f; color: white; }
          .incidents-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin: 25px 0; }
          .incident-card { 
            background: linear-gradient(135deg, #1a2a3f, #2a3a4f);
            border: 2px solid; 
            border-radius: 12px; 
            padding: 25px; 
            cursor: pointer; 
            transition: 0.3s; 
            text-align: center;
          }
          .incident-card:hover { transform: translateY(-5px); }
          .incident-card.Phishing { border-color: #ff6b6b; }
          .incident-card.ransomware { border-color: #ffa726; }
          .incident-card.exfiltration { border-color: #4fc3f7; }
          .incident-card.selected { background: linear-gradient(135deg, #2a3a4f, #3a4a5f); }
          
          .severity { 
            display: inline-block; 
            padding: 6px 15px; 
            border-radius: 20px; 
            font-size: 12px; 
            font-weight: bold;
            margin: 10px 0;
          }
          .severity-high { background: #dc3545; color: white; }
          .severity-critical { background: #fd7e14; color: white; }
          
          h1 { color: #ffffff; text-align: center; }
          h2 { color: #4fc3f7; text-align: center; }
          
          .status-badge { 
            display: inline-block; 
            padding: 8px 16px; 
            border-radius: 20px; 
            font-size: 14px; 
            margin: 5px; 
          }
          .status-active { background: #28a745; color: white; }
        </style>
        <script>
          let selectedIncident = 'Phishing';
          
          function selectIncident(type) {
            selectedIncident = type;
            const cards = document.querySelectorAll('.incident-card');
            cards.forEach(card => card.classList.remove('selected'));
            event.target.closest('.incident-card').classList.add('selected');
            
            document.getElementById('selectedIncident').innerHTML = 
              \`Incidente Selecionado: <strong>\${type}</strong> <span class="severity severity-\${type === 'ransomware' ? 'critical' : 'high'}">\${type === 'ransomware' ? 'CRÍTICO' : 'ALTO'}</span>\`;
          }
          
          function makeCall() {
            const nome = document.getElementById('nome').value;
            const telefone = document.getElementById('telefone').value;
            
            if (!nome || !telefone) {
              alert('Nome e telefone são obrigatórios!');
              return;
            }

            document.getElementById('summarySection').style.display = 'none';
            
            fetch('/make-call', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: \`nome=\${encodeURIComponent(nome)}&to=\${encodeURIComponent(telefone)}&incident_type=\${encodeURIComponent(selectedIncident)}\`
            })
            .then(response => response.json())
            .then(data => {
                if (data.sid) {
                    showCallStatus('Chamada conectada! Conversando...');
                    startSummaryPolling(data.sid);
                } else {
                    throw new Error(data.error || 'Erro ao iniciar chamada');
                }
            })
            .catch(error => {
                alert('Erro: ' + error.message);
            });
          }
          
          function showCallStatus(message) {
            document.getElementById('callStatus').innerHTML = \`
              <div class="card">
                <h3>📞 Status da Chamada</h3>
                <div style="text-align: center; padding: 20px;">
                  <div style="font-size: 3em;">🎯</div>
                  <div style="margin: 20px 0; font-size: 1.2em;">\${message}</div>
                  <div class="loading-spinner"></div>
                </div>
              </div>
            \`;
          }
          
          function startSummaryPolling(callSid) {
            const pollInterval = setInterval(() => {
                fetch(\`/call-summary/\${callSid}\`)
                    .then(response => response.json())
                    .then(summaryData => {
                        if (summaryData) {
                            clearInterval(pollInterval);
                            showCallSummary(summaryData);
                        }
                    })
                    .catch(() => {});
            }, 3000);
            
            setTimeout(() => clearInterval(pollInterval), 300000);
          }
          
          function showCallSummary(summaryData) {
            document.getElementById('callStatus').innerHTML = '';
            document.getElementById('summarySection').style.display = 'block';
            
            document.getElementById('summarySection').innerHTML = \`
                <h3>📋 Resumo - \${summaryData.securityData.nome}</h3>
                <div class="card">
                    <h4>🎯 \${summaryData.securityData.attack_type} - \${summaryData.securityData.severity}</h4>
                    <div style="background: #2a3a4f; padding: 20px; border-radius: 8px; margin: 15px 0; line-height: 1.6;">
                        \${summaryData.summary}
                    </div>
                    <button onclick="newCall()" style="background: #007bff;">
                        📞 Nova Chamada
                    </button>
                </div>
            \`;
          }
          
          function newCall() {
            document.getElementById('summarySection').style.display = 'none';
            document.getElementById('callStatus').innerHTML = '';
          }
          
          function updateStatus() {
            fetch('/health')
              .then(r => r.json())
              .then(data => {
                document.getElementById('activeSessions').textContent = data.active_sessions;
                document.getElementById('callSummaries').textContent = data.call_summaries;
              });
          }
          
          setInterval(updateStatus, 5000);
          updateStatus();
          
          document.addEventListener('DOMContentLoaded', function() {
            selectIncident('Phishing');
          });
        </script>
      </head>
      <body>
        <div class="container">
          <h1>🚨 SafeCall AI</h1>
          <h2>Central de Resposta a Incidentes</h2>
          
          <div class="card">
            <h3>🔍 Selecionar Tipo de Incidente</h3>
            <div class="incidents-grid">
              <div class="incident-card Phishing" onclick="selectIncident('Phishing')">
                <div>📧</div>
                <h4>Phishing Detectado</h4>
                <div class="severity severity-high">ALTA SEVERIDADE</div>
              </div>
              
              <div class="incident-card ransomware" onclick="selectIncident('ransomware')">
                <div>🦠</div>
                <h4>Ransomware</h4>
                <div class="severity severity-critical">CRÍTICO</div>
              </div>
              
              <div class="incident-card exfiltration" onclick="selectIncident('exfiltration')">
                <div>💾</div>
                <h4>Exfiltração</h4>
                <div class="severity severity-high">ALTA SEVERIDADE</div>
              </div>
            </div>
            
            <div id="selectedIncident" style="text-align: center; margin: 20px 0; font-size: 1.2em; padding: 15px; background: #2a3a4f; border-radius: 8px;">
            </div>
          </div>
          
          <div class="card">
            <h3>📞 Iniciar Chamada</h3>
            <input type="text" id="nome" placeholder="Nome do responsável" value="João Silva" required>
            <input type="tel" id="telefone" placeholder="21994442087" value="21994442087" required>
            <button onclick="makeCall()">🚨 INICIAR CHAMADA</button>
          </div>
          
          <div id="callStatus"></div>
          <div id="summarySection" style="display: none;"></div>
          
          <div class="card">
            <h3>📊 Status</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
              <div style="text-align: center; padding: 20px; background: #2a3a4f; border-radius: 8px;">
                <div style="font-size: 2em; font-weight: bold; color: #28a745;" id="activeSessions">0</div>
                <div>Chamadas Ativas</div>
              </div>
              <div style="text-align: center; padding: 20px; background: #2a3a4f; border-radius: 8px;">
                <div style="font-size: 2em; font-weight: bold; color: #17a2b8;" id="callSummaries">0</div>
                <div>Resumos</div>
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
  console.log(`🚀 Central de Segurança na porta ${PORT}`);
  console.log(`🎯 STT Otimizado: single_utterance=true`);
  console.log(`🔊 TTS Melhorado: Wavenet-B + volume aumentado`);
  console.log(`🤖 Gemini: Respostas mais curtas e naturais`);
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