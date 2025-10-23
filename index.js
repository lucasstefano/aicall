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

// Validação básica
if (!accountSid || !authToken || !fromNumber || !baseUrl) {
  console.error("❌ Variáveis Twilio faltando");
  process.exit(1);
}

const client = twilio(accountSid, authToken);
const clientSTT = new speech.SpeechClient();
const clientTTS = new textToSpeech.TextToSpeechClient();

// Criar diretório para áudios
const audioDir = join(process.cwd(), 'audio');
if (!existsSync(audioDir)) {
  mkdirSync(audioDir, { recursive: true });
}

// Configuração Vertex AI
const vertex_ai = new VertexAI({
  project: process.env.GCLOUD_PROJECT,
  location: process.env.GCLOUD_LOCATION,
});

const generativeModel = vertex_ai.getGenerativeModel({
  model: 'gemini-2.0-flash-001',
  generationConfig: {
    maxOutputTokens: 150,
    temperature: 0.7
  },
});

// =============================
// 🎯 Sistema Simplificado de Respostas
// =============================
class SimpleResponseQueue {
  constructor() {
    this.queue = new Map();
  }

  async addResponse(callSid, responseText) {
    try {
      console.log(`📥 Adicionando resposta: "${responseText.substring(0, 50)}..."`);
      
      const audioUrl = await this.generateTTS(callSid, responseText);
      await this.sendTTS(callSid, audioUrl);
      
    } catch (error) {
      console.error(`❌ Erro enviando resposta [${callSid}]:`, error);
    }
  }

  async generateTTS(callSid, text) {
    try {
      const request = {
        input: { text: text },
        voice: {
          languageCode: 'pt-BR',
          name: "pt-BR-Neural2-A",
          ssmlGender: 'FEMALE'
        },
        audioConfig: {
          audioEncoding: 'MP3',
          sampleRateHertz: 8000,
          speakingRate: 1.0,
        }
      };

      const [response] = await clientTTS.synthesizeSpeech(request);
      
      const filename = `tts_${callSid}_${Date.now()}.mp3`;
      const filepath = join(audioDir, filename);
      
      writeFileSync(filepath, response.audioContent, 'binary');
      
      // Limpar arquivo após 5 minutos
      setTimeout(() => {
        try {
          if (existsSync(filepath)) {
            unlinkSync(filepath);
          }
        } catch (e) {}
      }, 300000);
      
      return `${baseUrl}/audio/${filename}`;
      
    } catch (error) {
      console.error('❌ Erro gerando TTS:', error);
      throw error;
    }
  }

  async sendTTS(callSid, audioUrl) {
    try {
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.play({}, audioUrl);
      
      // Manter stream aberto
      const start = twiml.start();
      start.stream({ 
        url: `wss://${new URL(baseUrl).host}/media-stream`
      });

      await client.calls(callSid).update({
        twiml: twiml.toString()
      });

      console.log(`✅ Áudio enviado para [${callSid}]`);
      
    } catch (error) {
      console.error(`❌ Erro enviando TTS [${callSid}]:`, error);
      throw error;
    }
  }
}

const responseQueue = new SimpleResponseQueue();

// =============================
// 🧠 Gemini Service Simplificado
// =============================
class SimpleGeminiService {
  constructor() {
    this.conversationHistory = new Map();
    this.userData = new Map();
  }

  async generateWelcomeMessage(callSid, nome) {
    try {
      const prompt = `
        Você é um assistente de segurança. 
        Inicie uma conversa amigável sobre segurança digital.
        Seja direto e faça uma pergunta de cada vez.
        Fale naturalmente em português.
        
        Exemplo: "Olá ${nome}, sou assistente de segurança. Estou aqui para conversar sobre alguns alertas de segurança. Você tem um minuto para conversar?"
      `;

      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const message = response.candidates[0].content.parts[0].text.trim();
      
      console.log(`🤖 Mensagem inicial: ${message}`);
      return message;
      
    } catch (error) {
      console.error(`❌ Erro mensagem inicial [${callSid}]:`, error);
      return `Olá ${nome}, sou assistente de segurança. Podemos conversar sobre segurança digital?`;
    }
  }

  async generateResponse(callSid, userMessage) {
    try {
      const history = this.getConversationHistory(callSid);
      const nome = this.userData.get(callSid)?.nome || 'Usuário';
      
      // Manter apenas últimas 4 trocas
      const recentHistory = history.slice(-4);
      
      let prompt = `
        Você é um assistente de segurança conversando com ${nome}.
        Mantenha a conversa natural e direta.
        Faça uma pergunta de cada vez.
        Seja claro e objetivo.
        Use português natural.
        
        Histórico recente:
      `;

      recentHistory.forEach(([user, assistant]) => {
        prompt += `\nUsuário: ${user}`;
        prompt += `\nVocê: ${assistant}`;
      });

      prompt += `\n\nUsuário: ${userMessage}`;
      prompt += `\n\nSua resposta (curta e natural):`;

      console.log(`🧠 Processando: "${userMessage.substring(0, 50)}..."`);
      
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const text = response.candidates[0].content.parts[0].text.trim();
      
      this.updateConversationHistory(callSid, userMessage, text);
      
      console.log(`🤖 Resposta: "${text.substring(0, 50)}..."`);
      return text;
      
    } catch (error) {
      console.error(`❌ Erro Gemini [${callSid}]:`, error);
      return "Pode repetir, por favor? Não entendi completamente.";
    }
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
    this.conversationHistory.set(callSid, history);
  }

  setUserData(callSid, data) {
    this.userData.set(callSid, data);
  }

  async generateSummary(callSid) {
    const history = this.getConversationHistory(callSid);
    const userData = this.userData.get(callSid);

    if (!history || history.length === 0) {
      return "Nenhuma conversa registrada.";
    }

    let conversationText = "";
    history.forEach(([userMessage, assistantResponse]) => {
      conversationText += `Usuário: ${userMessage}\n`;
      conversationText += `Assistente: ${assistantResponse}\n\n`;
    });

    const prompt = `
      Resuma esta conversa sobre segurança digital em português.
      Destaque os principais pontos discutidos e qualquer ação ou preocupação mencionada.
      Seja conciso (máximo 150 palavras).

      Conversa:
      ${conversationText}
    `;

    try {
      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      return response.candidates[0].content.parts[0].text.trim();
    } catch (error) {
      console.error(`❌ Erro gerando resumo [${callSid}]:`, error);
      return "Resumo não disponível.";
    }
  }

  cleanup(callSid) {
    this.conversationHistory.delete(callSid);
    this.userData.delete(callSid);
  }
}

const geminiService = new SimpleGeminiService();

// =============================
// 🎙️ Configuração STT Simplificada
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
  interimResults: false, // 🔥 APENAS resultados finais
  single_utterance: true, // 🔥 Uma frase por vez
  noSpeechTimeout: 5, // 🔥 Timeout curto
};

// =============================
// 🎧 Audio Session Simplificada
// =============================
class SimpleAudioSession {
  constructor(ws, callSid, nome) {
    this.ws = ws;
    this.callSid = callSid;
    this.nome = nome;
    this.sttStream = null;
    this.isActive = true;
    this.lastTranscript = "";
    
    console.log(`🎧 Nova sessão: ${callSid}, Nome: ${nome}`);
    this.setupSTT();
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
        })
        .on("end", () => {
          console.log(`🔚 STT finalizado [${this.callSid}]`);
        });

    } catch (error) {
      console.error(`❌ Erro criando STT [${this.callSid}]:`, error);
    }
  }

  async handleSTTData(data) {
    if (data.results && data.results[0] && data.results[0].isFinal) {
      const transcript = data.results[0].alternatives[0]?.transcript?.trim();
      
      if (transcript && transcript.length > 2) {
        console.log(`📝 Transcrição [${this.callSid}]: "${transcript}"`);
        
        // Evitar processar a mesma transcrição repetidamente
        if (transcript !== this.lastTranscript) {
          this.lastTranscript = transcript;
          
          try {
            const response = await geminiService.generateResponse(this.callSid, transcript);
            await responseQueue.addResponse(this.callSid, response);
          } catch (error) {
            console.error(`❌ Erro processando resposta [${this.callSid}]:`, error);
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
    this.isActive = false;
    if (this.sttStream) {
      try {
        this.sttStream.end();
      } catch (error) {}
    }
  }
}

// =============================
// 🔄 WebSocket Server Simplificado
// =============================
const wss = new WebSocketServer({ noServer: true });
const activeSessions = new Map();
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
          const nome = data.start.nome || "Usuário";
          
          console.log(`🚀 Iniciando chamada: ${callSid}, Nome: ${nome}`);
          
          if (!activeSessions.has(callSid)) {
            session = new SimpleAudioSession(ws, callSid, nome);
            activeSessions.set(callSid, session);
            
            geminiService.setUserData(callSid, { nome });
            
            // Enviar mensagem inicial
            geminiService.generateWelcomeMessage(callSid, nome)
              .then(welcomeMessage => {
                responseQueue.addResponse(callSid, welcomeMessage);
              });
          } else {
            session = activeSessions.get(callSid);
            session.ws = ws;
          }
          break;

        case "media":
          if (session) {
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
      session.cleanup();
    }
  });

  ws.on("error", (error) => {
    console.error("❌ Erro WebSocket:", error);
  });
});

// =============================
// 📞 Endpoints Principais
// =============================
app.post("/twiml", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  response.say({ 
    voice: "alice", 
    language: "pt-BR" 
  }, "Conectando com assistente de segurança.");

  const start = response.start();
  start.stream({ 
    url: `wss://${new URL(baseUrl).host}/media-stream`
  });

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/make-call", async (req, res) => {
  let to = req.body.to;
  const nome = req.body.nome || "Usuário";

  if (!to || !nome) {
    return res.status(400).json({ error: "Número e nome são obrigatórios" });
  }

  try {
    to = to.trim().replace(/\s/g, "");
    
    if (!to.startsWith("+55")) {
      to = "+55" + to;
    }

    console.log(`📞 Chamando: ${nome} (${to})`);

    const call = await client.calls.create({
      to: to,
      from: fromNumber,
      url: `${baseUrl}/twiml`,
      timeout: 15,
      statusCallback: `${baseUrl}/call-status`,
      statusCallbackEvent: ["answered", "completed"],
    });

    // Armazenar nome para usar quando a chamada conectar
    geminiService.setUserData(call.sid, { nome });
    
    res.json({ 
      message: "Chamada iniciada", 
      sid: call.sid,
      nome: nome
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
      const userData = geminiService.userData.get(CallSid);
      
      callSummaries.set(CallSid, {
        summary: summary,
        nome: userData?.nome || 'Usuário',
        timestamp: new Date().toISOString(),
        callSid: CallSid
      });
      
      console.log(`✅ Resumo armazenado [${CallSid}]`);
    } catch (error) {
      console.error(`❌ Erro gerando resumo [${CallSid}]:`, error);
    }
    
    geminiService.cleanup(CallSid);
    activeSessions.delete(CallSid);
  }
  
  res.status(200).send("OK");
});

// Endpoint para obter resumo
app.get("/call-summary/:callSid", (req, res) => {
  const { callSid } = req.params;
  const summaryData = callSummaries.get(callSid);
  
  if (!summaryData) {
    return res.status(404).json({ error: "Resumo não encontrado" });
  }

  res.json(summaryData);
});

// Endpoint para listar resumos
app.get("/call-summaries", (req, res) => {
  const summaries = Array.from(callSummaries.values());
  res.json(summaries);
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    active_sessions: activeSessions.size,
    call_summaries: callSummaries.size
  });
});

// =============================
// 🎯 Página HTML Simplificada
// =============================
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SafeCall AI - Simplificado</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          input, button { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; }
          button { background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; }
          button:hover { background: #0056b3; }
          .summary { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0; }
          .status { padding: 10px; background: #e9ecef; border-radius: 5px; text-align: center; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎯 SafeCall AI</h1>
          <p>Conversa por voz com Gemini - Versão Simplificada</p>
          
          <div>
            <input type="text" id="nome" placeholder="Seu nome" value="João Silva">
            <input type="tel" id="telefone" placeholder="21994442087" value="21994442087">
            <button onclick="makeCall()">📞 Fazer Chamada</button>
          </div>
          
          <div id="status"></div>
          <div id="summary"></div>
          
          <div class="status">
            <strong>Status:</strong> 
            <span id="activeSessions">0</span> chamadas ativas | 
            <span id="callSummaries">0</span> resumos
          </div>
        </div>

        <script>
          async function makeCall() {
            const nome = document.getElementById('nome').value;
            const telefone = document.getElementById('telefone').value;
            
            if (!nome || !telefone) {
              alert('Preencha nome e telefone');
              return;
            }

            document.getElementById('status').innerHTML = '<div class="status">🔄 Iniciando chamada...</div>';
            
            try {
              const response = await fetch('/make-call', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'nome=' + encodeURIComponent(nome) + '&to=' + encodeURIComponent(telefone)
              });
              
              const data = await response.json();
              
              if (data.sid) {
                document.getElementById('status').innerHTML = '<div class="status">✅ Chamada iniciada! Aguardando conversa...</div>';
                checkForSummary(data.sid);
              }
            } catch (error) {
              document.getElementById('status').innerHTML = '<div class="status">❌ Erro: ' + error.message + '</div>';
            }
          }
          
          async function checkForSummary(callSid) {
            const checkInterval = setInterval(async () => {
              try {
                const response = await fetch('/call-summary/' + callSid);
                if (response.ok) {
                  const summaryData = await response.json();
                  showSummary(summaryData);
                  clearInterval(checkInterval);
                }
              } catch (error) {
                // Continua verificando
              }
            }, 3000);
            
            // Para após 5 minutos
            setTimeout(() => clearInterval(checkInterval), 300000);
          }
          
          function showSummary(summaryData) {
            document.getElementById('summary').innerHTML = \`
              <div class="summary">
                <h3>📋 Resumo da Conversa com \${summaryData.nome}</h3>
                <p>\${summaryData.summary}</p>
                <small>Call SID: \${summaryData.callSid}</small>
              </div>
            \`;
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
  console.log(`🚀 Servidor simplificado na porta ${PORT}`);
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