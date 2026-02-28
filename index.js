const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');

// IMPORTAÇÕES LOCAIS
const C = require('./src/config');
const Utils = require('./src/utils');
const Data = require('./src/data');
const Sheets = require('./src/sheets');
const Alerts = require('./src/alerts');
const { gerarComprovanteDevolucao, getFollowupText } = require('./src/gerador');
const { lerTextoDeImagem } = require('./src/ocr'); 
const { processarMensagemPonto, gerarRelatorioDia, gerarRelatorioCSV } = require('./src/ponto');
const { compare430, formatForCopy } = require('./src/compare430');
const { createToaBridge } = require('./src/toaBridge');

// CONFIGURAÇÃO DOS GRUPOS
const ID_GRUPO_TESTE = '120363423496684075@g.us';
const ID_GRUPO_RELATORIO = '120363423496684075@g.us'; 
const ID_GRUPO_ADESAO = '558496022125-1485433351@g.us';
const ID_GRUPO_TECNICOS = '120363422121095440@g.us'; 
const ID_GRUPO_CONTATOS = '120363422121095440@g.us'; 
const ID_GRUPO_CONTROLADORES_PONTO = '558488045008-1401380014@g.us';

const GRUPOS_CONTATOS_TOA = new Set([
  ID_GRUPO_CONTROLADORES_PONTO,
  ID_GRUPO_CONTATOS,
  ID_GRUPO_TESTE,
]);

const BOT_BUILD = process.env.BOT_BUILD || 'v30';
let PLANILHA_ATIVA = false;
const precisaValidarURA = (chatId) => chatId === ID_GRUPO_TECNICOS;

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(__dirname, 'auth_baileys');
const WHATS_TXT_PATH = path.join(DATA_DIR, 'whats.txt');
const WHATS_CSV_PATH = path.join(DATA_DIR, 'whats.csv');
const IMPERIUM_XLSX_PATH = path.join(DATA_DIR, 'imperium.xlsx');

const TOA_BRIDGE_PORT = Number(process.env.TOA_BRIDGE_PORT || 8787);
const TOA_BRIDGE_HOST = process.env.TOA_BRIDGE_HOST || '127.0.0.1';
const TOA_BRIDGE_TOKEN = process.env.TOA_BRIDGE_TOKEN || '';
const toaBridge = createToaBridge({ dataDir: DATA_DIR, port: TOA_BRIDGE_PORT, host: TOA_BRIDGE_HOST, token: TOA_BRIDGE_TOKEN });

toaBridge.start();

// Limpa sessão antiga para forçar novo QR
function limparSessaoWhatsApp() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🗑️  Sessão antiga removida — aguardando novo QR...');
    }
  } catch (e) {
    console.error('❌ Erro ao limpar sessão:', e.message);
  }
}

function startToaChromeAutomation() {
  if (process.env.TOA_AUTO_LOGIN_ENABLED === '0') {
    console.log(`🌐 [${BOT_BUILD}] abertura automática do TOA desativada por env (TOA_AUTO_LOGIN_ENABLED=0)`);
    return;
  }
  const scriptPath = path.join(__dirname, 'src', 'toa_auto_login.py');
  const pythonCmd = process.env.PYTHON_BIN || 'python3';
  const child = spawn(pythonCmd, [scriptPath], { env: { ...process.env, BOT_BUILD }, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`🌐 [${BOT_BUILD}] abrindo Chrome no TOA...`);
  child.stdout.on('data', (data) => { const t = data.toString().trim(); if (t) console.log(`🌐 [${BOT_BUILD}] toa-open: ${t}`); });
  child.stderr.on('data', (data) => { const t = data.toString().trim(); if (t) console.log(`🌐 [${BOT_BUILD}] toa-open-err: ${t}`); });
  child.on('error', (err) => { console.log(`🌐 [${BOT_BUILD}] falha ao abrir TOA: ${err.message}`); });
  child.on('close', (code) => { console.log(`🌐 [${BOT_BUILD}] rotina de abertura TOA finalizada (code=${code})`); });
}

startToaChromeAutomation();

const limparArquivosComparacao430 = () => {
  [WHATS_TXT_PATH, WHATS_CSV_PATH, IMPERIUM_XLSX_PATH].forEach((filePath) => {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
    catch (e) { console.error('Erro ao limpar arquivo 430:', filePath, e.message); }
  });
};

// === CACHE E MEMÓRIA ===
let CACHE_CONTRATOS = []; 
let CACHE_FORAROTA = []; 
let CONTRATOS_USADOS = new Set(Data.listaForaRotaUsados || []); 
const esperaConfirmacaoURA = new Map(); 
const TEMPO_ATUALIZACAO_MINUTOS = 5; 
let ultimoAlertaEnviado = "";
let ultimoAlertaVT = "";
let ultimoAlertaAD = "";
let ultimoAvisoRota = ""; 
let alertaIntervalId = null;
let cacheIntervalId = null; 
let relatorioEnviadoHoje = false;
let sock;
let reconnectTimeout = null;
let reconnectAttempts = 0;

// ==================== LOGS TOA ====================
const TOA_LOG = {
  info:  (msg) => console.log(`🌐 [TOA] ${msg}`),
  warn:  (msg) => console.warn(`⚠️  [TOA] ${msg}`),
  error: (msg) => console.error(`❌ [TOA] ${msg}`),
};

// ==================== FUNÇÕES DE CACHE ====================
async function atualizarCache() {
  console.log('🔄 Atualizando caches...');
  try {
    const dadosGeral = await Sheets.obterBaseContratos();
    if (dadosGeral && dadosGeral.length > 0) { CACHE_CONTRATOS = dadosGeral; console.log(`✅ CACHE GERAL: ${CACHE_CONTRATOS.length} linhas.`); }
    const dadosForaRota = await Sheets.obterBaseForaRota();
    if (dadosForaRota && dadosForaRota.length > 0) { CACHE_FORAROTA = dadosForaRota; console.log(`✅ CACHE FORA ROTA: ${CACHE_FORAROTA.length} linhas.`); }
  } catch (e) { console.error('❌ Erro fatal ao atualizar cache:', e); }
}

// ==================== FUNÇÕES TOA ====================
async function toaBridgeLookupWithTimeout(termo, timeoutMs = 500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(null); }, timeoutMs);
    Promise.resolve(toaBridge.findByContract(termo))
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); TOA_LOG.error(`findByContract falhou: ${err.message}`); resolve(null); });
  });
}

const _pollingAtivos = new Map(); // evita polling duplicado por contrato

function iniciarPollingEResponder({ chatId, termo, message, timeoutMs = 25000, intervalMs = 2000 }) {
  // Se já há polling ativo para esse contrato, não inicia outro
  if (_pollingAtivos.has(termo)) {
    TOA_LOG.warn(`polling já ativo para contrato=${termo} — ignorando duplicata`);
    return;
  }
  const inicio = Date.now();
  TOA_LOG.info(`iniciando polling contrato=${termo} timeout=${timeoutMs}ms`);
  _pollingAtivos.set(termo, true);
  const interval = setInterval(async () => {
    const decorrido = Date.now() - inicio;
    const achado = toaBridge.findByContract(termo);
    if (achado) {
      clearInterval(interval);
      _pollingAtivos.delete(termo);
      TOA_LOG.info(`polling encontrou contrato=${termo} após ${decorrido}ms`);
      try { await sock.sendMessage(chatId, { text: formatToaContactMessage(chatId, termo, achado) }, { quoted: message }); }
      catch (e) { TOA_LOG.error(`erro ao enviar resposta polling: ${e.message}`); }
      return;
    }
    if (decorrido >= timeoutMs) {
      clearInterval(interval);
      _pollingAtivos.delete(termo);
      TOA_LOG.warn(`polling expirado contrato=${termo} após ${decorrido}ms`);
      try {
        await sock.sendMessage(chatId, {
          text: `⚠️ Não consegui buscar o contrato *${termo}* automaticamente.\n\nAbra uma OS no TOA para ativar a extensão e tente novamente.`
        }, { quoted: message });
      } catch (e) { TOA_LOG.error(`erro ao enviar timeout msg: ${e.message}`); }
    }
  }, intervalMs);
}

// ==================== FUNÇÕES AUXILIARES ====================
const enviarMensagemComMarcacaoLista = async (grupoId, textoBase, listaNumeros) => {
  try {
    if (!listaNumeros || listaNumeros.length === 0) { await sock.sendMessage(grupoId, { text: textoBase }); return; }
    const mentions = listaNumeros.map(num => `${num}@s.whatsapp.net`);
    const textoFinal = `${textoBase}\n\n${listaNumeros.map(num => `@${num}`).join(' ')}`;
    await sock.sendMessage(grupoId, { text: textoFinal, mentions });
    console.log(`📢 Aviso enviado para ${grupoId} (Marcados: ${listaNumeros.length})`);
  } catch (e) { console.error(`❌ Erro ao marcar lista no grupo ${grupoId}:`, e); }
};

const enviarMensagemComMarcacaoGeral = async (grupoId, textoBase) => {
  try {
    const metadata = await sock.groupMetadata(grupoId);
    const participantes = metadata.participants.map(p => p.id);
    const textoFinal = `${textoBase}\n\n${participantes.map(p => `@${p.split('@')[0]}`).join(' ')}`;
    await sock.sendMessage(grupoId, { text: textoFinal, mentions: participantes });
  } catch (e) { console.error(e); }
};

const validarNumero = async (chatId, numero, comandoExemplo) => {
  if (numero.length < 10) { await sock.sendMessage(chatId, { text: `❌ Número inválido. Use: ${comandoExemplo}` }); return false; }
  return true;
};

const adicionarNaLista = async (chatId, numero, arrayLista, funcaoSalvar, nomeLista, exemplo) => {
  if (!(await validarNumero(chatId, numero, exemplo))) return;
  if (arrayLista.includes(numero)) { await sock.sendMessage(chatId, { text: `⚠️ ${numero} já está na lista ${nomeLista}.` }); return; }
  arrayLista.push(numero); funcaoSalvar();
  await sock.sendMessage(chatId, { text: `✅ ${numero} adicionado em ${nomeLista}!\n📋 Total: ${arrayLista.length}` });
};

const removerDaLista = async (chatId, numero, arrayLista, funcaoSalvar, nomeLista) => {
  const index = arrayLista.indexOf(numero);
  if (index === -1) { await sock.sendMessage(chatId, { text: `⚠️ ${numero} não está na lista ${nomeLista}.` }); return; }
  arrayLista.splice(index, 1); funcaoSalvar();
  await sock.sendMessage(chatId, { text: `✅ ${numero} removido de ${nomeLista}!\n📋 Total: ${arrayLista.length}` });
};

const listarNumeros = async (chatId, lista, nomeLista) => {
  if (lista.length === 0) { await sock.sendMessage(chatId, { text: `📋 *${nomeLista}* - Vazio.` }); return; }
  let resposta = `📋 *LISTA ${nomeLista}:*\n\n`;
  lista.forEach((num, i) => { resposta += `${i + 1}. ${num}\n`; });
  resposta += `\n✅ Total: ${lista.length}`;
  await sock.sendMessage(chatId, { text: resposta });
};

async function exibirDadosContrato(chatId, encontrado, termoBusca, message) {
  let resposta = '';
  if (chatId === ID_GRUPO_CONTATOS || chatId === ID_GRUPO_TECNICOS) {
    resposta = `✅ *CONTATOS LIBERADOS* \n\n📄 *Contrato:* ${termoBusca}\n────────────────────\n`;
    if (encontrado['Telefone 1']) resposta += `📞 *Tel 1:* ${encontrado['Telefone 1']}\n`;
    if (encontrado['Telefone 2']) resposta += `📞 *Tel 2:* ${encontrado['Telefone 2']}\n`;
    if (encontrado['Telefone 3']) resposta += `📞 *Tel 3:* ${encontrado['Telefone 3']}\n`;
    resposta += `\nCaso não consiga contato, retornar com evidências.`;
  } else {
    resposta = `📄 *Contrato:* ${termoBusca}\n────────────────────\n`;
    if (encontrado['Telefone 1']) resposta += `📞 *Tel 1:* ${encontrado['Telefone 1']}\n`;
    if (encontrado['Telefone 2']) resposta += `📞 *Tel 2:* ${encontrado['Telefone 2']}\n`;
    if (encontrado['Telefone 3']) resposta += `📞 *Tel 3:* ${encontrado['Telefone 3']}`;
  }
  await sock.sendMessage(chatId, { text: resposta }, { quoted: message });
}

function formatToaContactMessage(chatId, termoBusca, data) {
  let resposta = '';
  if (chatId === ID_GRUPO_CONTATOS || chatId === ID_GRUPO_TECNICOS) resposta = `✅ *CONTATOS LIBERADOS (TOA)*\n\n`;
  resposta += `📄 *Contrato:* ${termoBusca}\n────────────────────\n`;
  data.telefones.forEach((tel, index) => { resposta += `📞 *Tel ${index + 1}:* ${tel}\n`; });
  resposta += `────────────────────\n`;
  if (data.janela) resposta += `🕐 *Janela:* ${data.janela}\n`;
  if (data.tecnico) resposta += `👷 *Técnico:* ${data.tecnico}\n`;
  return resposta.trim();
}

function runPythonToaLookup(contract) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'src', 'toa_lookup.py');
    const pythonCmd = process.env.PYTHON_BIN || 'python3';
    const child = spawn(pythonCmd, [scriptPath, String(contract)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (err) => { resolve({ ok: false, error: err.message, stdout, stderr }); });
    child.on('close', (code) => { resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

// ==================== MAIN ====================
async function connectToWhatsApp() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Versão WhatsApp Web usada: ${version.join('.')} (latest: ${isLatest})`);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'fatal' }),
    browser: ['Bot Consulta', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    version,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 QR Code recebido! Escaneie com o WhatsApp.');
      qrcode.generate(qr, { small: true }, (qrCode) => console.log(qrCode));
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      const statusCode = (err instanceof Boom) ? err.output.statusCode : 'desconhecido';
      console.log(`🔌 Conexão fechada. Motivo: ${statusCode}`);

      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isBadSession = statusCode === DisconnectReason.badSession || statusCode === 500;

      if (isLoggedOut || isBadSession) {
        console.log(`🔑 Sessão inválida (${statusCode}) — limpando credenciais para gerar novo QR...`);
        limparSessaoWhatsApp();
        reconnectAttempts = 0;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => connectToWhatsApp(), 2000);
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        console.log('🔄 Restart required — reconectando...');
        reconnectAttempts = 0;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => connectToWhatsApp(), 1000);
        return;
      }

      reconnectAttempts += 1;
      const retryDelayMs = Math.min(3000 * reconnectAttempts, 15000);
      console.log(`🔄 Tentando reconectar em ${Math.round(retryDelayMs / 1000)}s...`);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(() => connectToWhatsApp(), retryDelayMs);

    } else if (connection === 'open') {
      reconnectAttempts = 0;
      if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
      console.log(`--- BOT ATIVO (FINAL HYBRID VERSION) [${BOT_BUILD}] ---`);
      await atualizarCache();
      console.log(`💾 Histórico Fora Rota carregado: ${CONTRATOS_USADOS.size} contratos já enviados.`);

      if (cacheIntervalId) clearInterval(cacheIntervalId);
      cacheIntervalId = setInterval(async () => { await atualizarCache(); }, TEMPO_ATUALIZACAO_MINUTOS * 60 * 1000);

      if (alertaIntervalId) clearInterval(alertaIntervalId);
      alertaIntervalId = setInterval(async () => {
        const agora = new Date();
        const horaAtual = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const horariosAlertaTec1 = { "11:45": "das 08h às 12h", "14:45": "das 12h às 15h", "17:45": "das 15h às 18h" };
        if (horariosAlertaTec1[horaAtual] && ultimoAlertaEnviado !== horaAtual) { Alerts.enviarAlertaJanela(sock, horariosAlertaTec1[horaAtual], C.ID_GRUPO_ALERTAS); ultimoAlertaEnviado = horaAtual; }
        
        const horariosAlertaVT = { "09:45": ["08:00 às 10:00"], "10:45": ["08:00 às 11:00"], "11:45": ["10:00 às 12:00"], "13:45": ["11:00 às 14:00", "12:00 às 14:00"], "15:45": ["14:00 às 16:00"], "16:45": ["14:00 às 17:00"], "17:45": ["16:00 às 18:00"], "19:45": ["17:00 às 20:00", "18:00 às 20:00"] };
        if (horariosAlertaVT[horaAtual] && ultimoAlertaVT !== horaAtual) { Alerts.enviarAlertaGenerico(sock, { titulo: 'VISITA TÉCNICA (VT)', janelas: horariosAlertaVT[horaAtual], idDestino: C.ID_GRUPO_ALERTAS, lista: Data.listaVT, logPrefixo: 'VT' }); ultimoAlertaVT = horaAtual; }

        const horariosAlertaAD = { "11:45": ["08:00 às 12:00"], "14:45": ["12:00 às 15:00"], "17:45": ["15:00 às 18:00"] };
        if (horariosAlertaAD[horaAtual] && ultimoAlertaAD !== horaAtual) { Alerts.enviarAlertaGenerico(sock, { titulo: 'ADESÃO', janelas: horariosAlertaAD[horaAtual], idDestino: C.ID_GRUPO_ALERTAS, lista: Data.listaAD, logPrefixo: 'ADESÃO' }); ultimoAlertaAD = horaAtual; }

        const horariosRota = ["07:40", "07:50", "08:00"];
        if (horariosRota.includes(horaAtual) && ultimoAvisoRota !== horaAtual) {
          const mensagemRota = "Bom dia a todos!\n\nLembrando que é necessário ativar a rota até às 8h.\nÀs 8h05, o sistema desativa automaticamente as rotas não ativas.\n\nContamos com a colaboração de todos.";
          await enviarMensagemComMarcacaoLista(ID_GRUPO_ADESAO, mensagemRota, Data.listaAD);
          ultimoAvisoRota = horaAtual;
        }

        if (horaAtual === "23:00" && !relatorioEnviadoHoje) {
          const csv = gerarRelatorioCSV();
          if (csv) { await sock.sendMessage(ID_GRUPO_RELATORIO, { text: `📋 *FECHAMENTO DO DIA*\n\n\`\`\`${csv}\`\`\`` }); }
          relatorioEnviadoHoje = true;
        }
        if (horaAtual === "00:00") relatorioEnviadoHoje = false;
      }, 30000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      const m = messages[0];
      if (type !== 'notify' || m.key.fromMe) return;
      const msgTextoRaw = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.documentMessage?.caption || '';
      const msgTexto = msgTextoRaw.toLowerCase().trim();
      const msgTextoSemAcento = msgTexto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const chatId = m.key.remoteJid;
      let usuarioId = m.key.participant || chatId;
      const nomeUsuario = m.key.participant ? m.pushName : null; 
      const isGrupo = chatId.endsWith('@g.us');
      const isGrupoAutorizado = Data.isGrupoAutorizado(chatId) || chatId === ID_GRUPO_TESTE;
      const isGrupoControladoresPonto = chatId === ID_GRUPO_CONTROLADORES_PONTO;
      const isImage = !!m.message?.imageMessage;
      const isQuotedImage = !!m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      const isDocument = !!m.message?.documentMessage;
      const documentCaption = (m.message?.documentMessage?.caption || '').toLowerCase().trim();

      const executarComparacao430 = async () => {
        const hasWhats = fs.existsSync(WHATS_TXT_PATH) || fs.existsSync(WHATS_CSV_PATH);
        const whatsPath = fs.existsSync(WHATS_TXT_PATH) ? WHATS_TXT_PATH : WHATS_CSV_PATH;
        const hasImperium = fs.existsSync(IMPERIUM_XLSX_PATH);
        if (!hasWhats || !hasImperium) {
          const faltantes = [];
          if (!hasWhats) faltantes.push('• Arquivo Whats (.txt ou .csv)');
          if (!hasImperium) faltantes.push('• Arquivo Imperium (.xlsx)');
          await sock.sendMessage(chatId, { text: `⚠️ Faltam arquivos para comparar:\n\n${faltantes.join('\n')}\n\nEnvie os dois documentos (.txt/.csv e .xlsx).` }, { quoted: m });
          return;
        }
        try {
          const resultado = compare430({ whatsPath, imperiumXlsxPath: IMPERIUM_XLSX_PATH, timeZone: 'America/Sao_Paulo' });
          if (resultado.totalWhats430 === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Não encontrei mensagens com *430/FR* no arquivo Whats informado.' }, { quoted: m }); return; }
          const blocos = [];
          blocos.push(`📊 Contratos únicos 430/FR no Whats: *${resultado.totalContratosWhats430 || resultado.totalWhats430}*`);
          if (resultado.relatorio) {
            blocos.push(`\n${resultado.relatorio}`);
          } else {
            if (resultado.divergencias.length > 0) blocos.push(`\n❌ *DIVERGÊNCIAS*\n${formatForCopy(resultado.divergencias)}`);
            else blocos.push('\n✅ Nenhuma divergência de técnico encontrada para os 430/FR.');
            if (resultado.naoEncontrados.length > 0) {
              const listaNaoEncontrados = resultado.naoEncontrados.map((n) => typeof n === 'object' ? `${n.contrato} - ${n.tecnicoWhats}` : String(n)).join('\n');
              blocos.push(`\n⚠️ *CONTRATOS 430/FR NÃO ENCONTRADOS NO XLSX (DESC + hoje)*\n${listaNaoEncontrados}`);
            }
          }
          const respostaFinal = blocos.join('\n');
          const TAMANHO_MAX = 3500;
          if (respostaFinal.length <= TAMANHO_MAX) {
            await sock.sendMessage(chatId, { text: respostaFinal }, { quoted: m });
          } else {
            const partes = [];
            let atual = '';
            for (const linha of respostaFinal.split('\n')) {
              const tentativa = atual ? `${atual}\n${linha}` : linha;
              if (tentativa.length > TAMANHO_MAX) { if (atual) partes.push(atual); atual = linha; }
              else { atual = tentativa; }
            }
            if (atual) partes.push(atual);
            for (let i = 0; i < partes.length; i++) {
              await sock.sendMessage(chatId, { text: `${i === 0 ? '' : `(continuação ${i + 1}/${partes.length})\n`}${partes[i]}` }, { quoted: m });
            }
          }
        } catch (err) {
          console.error('Erro comparar430:', err);
          await sock.sendMessage(chatId, { text: `❌ Erro ao comparar 430: ${err.message}` }, { quoted: m });
        } finally { limparArquivosComparacao430(); }
      };

      // ==================== COMANDO !MENU ====================
      if (msgTexto === '!menu' || msgTexto === '!ajuda') {
        const menu = `🤖 *MENU DE COMANDOS* 🤖 (${BOT_BUILD})

🚛 *FORA ROTA*
• !forarota [Tecnico], [Bairro], [Qtd]
• !forarota-raw [Tecnico], [Texto]

📋 *LISTAS & MARCAÇÃO*
• !addvt [Numero] - Add na lista VT
• !unaddvt [Numero] - Remove VT
• !listavt - Ver lista VT
• !addad [Numero] - Add na lista Adesão (Rota)
• !unaddad [Numero] - Remove Adesão
• !listaad - Ver lista Adesão

🛠️ *FERRAMENTAS*
• !ler - Ler texto de imagem (OCR)
• !controlador - Relatório do dia
• !planilha - CSV do ponto
• !marcar - Marca TODOS (Cuidado!)
• !comparar430 / !relatorio430 / relatorio - Compara Whats x Imperium

📎 *ARQUIVOS (documento)*
• Envie .txt/.csv (nome livre)
• Envie .xlsx (nome livre)
• Ao receber 1x .txt/.csv + 1x .xlsx, o bot compara automático

🔍 *CONSULTA*
• "contatos 1234567" — busca no TOA (auto-pesquisa)
• "contato 12345", "cct 12345", "ctt 12345" — busca na planilha
• !toastatus - Status do cache TOA
`;
        await sock.sendMessage(chatId, { text: menu }, { quoted: m });
        return;
      }

      // ==================== LISTAS DE MARCAÇÃO (VT / AD) ====================
      if (msgTexto.startsWith('!addvt ')) { await adicionarNaLista(chatId, Utils.normalizeDigits(msgTextoRaw.slice(7)), Data.listaVT, Data.salvarVT, 'VT', '!addvt 5584...'); return; }
      if (msgTexto.startsWith('!unaddvt ')) { await removerDaLista(chatId, Utils.normalizeDigits(msgTextoRaw.slice(9)), Data.listaVT, Data.salvarVT, 'VT'); return; }
      if (msgTexto === '!listavt') { await listarNumeros(chatId, Data.listaVT, 'VT'); return; }
      if (msgTexto.startsWith('!addad ')) { await adicionarNaLista(chatId, Utils.normalizeDigits(msgTextoRaw.slice(7)), Data.listaAD, Data.salvarAD, 'ADESÃO', '!addad 5584...'); return; }
      if (msgTexto.startsWith('!unaddad ')) { await removerDaLista(chatId, Utils.normalizeDigits(msgTextoRaw.slice(9)), Data.listaAD, Data.salvarAD, 'ADESÃO'); return; }
      if (msgTexto === '!listaad') { await listarNumeros(chatId, Data.listaAD, 'ADESÃO'); return; }

      // ==================== CAPTURA DE DOCUMENTOS ====================
      if (isDocument) {
        const originalName = (m.message?.documentMessage?.fileName || '').toLowerCase().trim();
        const mimetype = (m.message?.documentMessage?.mimetype || '').toLowerCase();
        const isTxtOrCsv = originalName.endsWith('.txt') || originalName.endsWith('.csv') || mimetype.includes('text/') || mimetype.includes('csv');
        const isXlsx = originalName.endsWith('.xlsx') || originalName.endsWith('.xls') || mimetype.includes('spreadsheetml') || mimetype.includes('ms-excel') || mimetype.includes('officedocument');
        const isZip = originalName.endsWith('.zip') || mimetype.includes('zip');
        const legendaMarcaWhats = documentCaption === 'whats';
        const legendaMarcaImperium = documentCaption === 'imperium';

        if (isTxtOrCsv || isXlsx || isZip || legendaMarcaWhats || legendaMarcaImperium) {
          const fileBuffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          if (!fileBuffer) { await sock.sendMessage(chatId, { text: '❌ Não consegui baixar o documento.' }, { quoted: m }); return; }

          let salvouAlgum = false;
          if (isZip) {
            try {
              const zip = new AdmZip(fileBuffer);
              const entries = zip.getEntries().filter((e) => !e.isDirectory);
              const xlsxEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.xlsx'));
              const whatsEntry = entries.find((e) => { const n = e.entryName.toLowerCase(); return n.endsWith('.txt') || n.endsWith('.csv'); });
              if (xlsxEntry) { fs.writeFileSync(IMPERIUM_XLSX_PATH, xlsxEntry.getData()); salvouAlgum = true; }
              if (whatsEntry) { const lower = whatsEntry.entryName.toLowerCase(); fs.writeFileSync(lower.endsWith('.csv') ? WHATS_CSV_PATH : WHATS_TXT_PATH, whatsEntry.getData()); salvouAlgum = true; }
              if (!salvouAlgum) { await sock.sendMessage(chatId, { text: '⚠️ ZIP recebido, mas não encontrei .xlsx e/ou .txt/.csv dentro dele.' }, { quoted: m }); return; }
              await sock.sendMessage(chatId, { text: '✅ ZIP processado. Arquivos internos salvos para comparação 430.' }, { quoted: m });
            } catch (zipErr) { await sock.sendMessage(chatId, { text: `❌ Erro ao ler ZIP: ${zipErr.message}` }, { quoted: m }); return; }
          } else if (isTxtOrCsv || legendaMarcaWhats) {
            fs.writeFileSync(originalName.endsWith('.csv') ? WHATS_CSV_PATH : WHATS_TXT_PATH, fileBuffer); salvouAlgum = true;
            await sock.sendMessage(chatId, { text: `✅ Arquivo Whats salvo em: ${path.basename(originalName.endsWith('.csv') ? WHATS_CSV_PATH : WHATS_TXT_PATH)}` }, { quoted: m });
          } else if (isXlsx || legendaMarcaImperium) {
            fs.writeFileSync(IMPERIUM_XLSX_PATH, fileBuffer); salvouAlgum = true;
            await sock.sendMessage(chatId, { text: '✅ Arquivo Imperium salvo em: imperium.xlsx' }, { quoted: m });
          }

          if (salvouAlgum) {
            const hasWhats = fs.existsSync(WHATS_TXT_PATH) || fs.existsSync(WHATS_CSV_PATH);
            const hasImperium = fs.existsSync(IMPERIUM_XLSX_PATH);
            if (hasWhats && hasImperium) {
              await sock.sendMessage(chatId, { text: '🤖 Arquivos detectados (.txt/.csv + .xlsx). Iniciando comparação 430...' }, { quoted: m });
              await executarComparacao430();
            } else {
              await sock.sendMessage(chatId, { text: '📥 Arquivo recebido. Aguardando o outro arquivo para comparar (Whats + Imperium).' }, { quoted: m });
            }
            return;
          }
        }
      }

      if (msgTexto === '!comparar430' || msgTexto === '!relatorio430' || msgTextoSemAcento === 'relatorio' || msgTextoSemAcento.startsWith('relatorio')) {
        await sock.sendMessage(chatId, { text: '📊 Gerando relatório 430/FR, aguarde...' }, { quoted: m });
        await executarComparacao430();
        return;
      }

      // ==================== [PRIORIDADE 0] VERIFICAÇÃO URA ====================
      if (esperaConfirmacaoURA.has(chatId)) {
        const contexto = esperaConfirmacaoURA.get(chatId);
        if (msgTextoSemAcento === 'sim') {
          await exibirDadosContrato(chatId, contexto.dados, contexto.contrato, m);
          esperaConfirmacaoURA.delete(chatId); return; 
        } else if (msgTextoSemAcento === 'nao' || msgTextoSemAcento === 'não') {
          await sock.sendMessage(chatId, { text: '⚠️ Por favor valide na URA antes de pegar o contato.' }, { quoted: m });
          esperaConfirmacaoURA.delete(chatId); return;
        }
      }

      // ==================== [PRIORIDADE 1] !FORAROTA ====================
      if (msgTexto.startsWith('!forarota ')) {
        const params = msgTextoRaw.slice(10).split(',').map(p => p.trim());
        if (params.length < 2) { await sock.sendMessage(chatId, { text: '❌ Uso: !forarota [Tecnico], [Bairro], [Quantidade (opcional)]' }, { quoted: m }); return; }
        const [tecnico, bairroBusca, qtdStr] = params;
        const qtd = parseInt(qtdStr) || 1;
        const disponiveis = CACHE_FORAROTA.filter(r => r.bairro && r.bairro.toLowerCase().includes(bairroBusca.toLowerCase()) && !CONTRATOS_USADOS.has(r.contrato));
        if (disponiveis.length === 0) { await sock.sendMessage(chatId, { text: `⚠️ Nenhuma OS disponível para *${bairroBusca}* (ou todas já foram enviadas).` }, { quoted: m }); return; }
        const selecionados = disponiveis.slice(0, qtd);
        selecionados.forEach(r => CONTRATOS_USADOS.add(r.contrato));
        Data.salvarForaRotaUsados(Array.from(CONTRATOS_USADOS));
        for (let item of selecionados) {
          await sock.sendMessage(chatId, { text: `⭕ FORA ROTA ⭕\n\nCONTRATO: ${item.contrato}\nNOME: ${item.cliente}\nEND: ${item.endereco}\nTEL: ${item.telefone}\nTECNICO: ${tecnico}` });
          await new Promise(r => setTimeout(r, 800));
        }
        return;
      }

      // ==================== [PRIORIDADE 2] !FORAROTA-RAW ====================
      if (msgTexto.startsWith('!forarota-raw ')) {
        const content = msgTextoRaw.slice(14);
        const primeiroVirgula = content.indexOf(',');
        if (primeiroVirgula === -1) return;
        const tecnico = content.substring(0, primeiroVirgula).trim();
        const textoBruto = content.substring(primeiroVirgula + 1).trim();
        const regexContrato = /(\d{7,})([A-Z\s.]+)/g;
        let matchRaw, resultados = [];
        while ((matchRaw = regexContrato.exec(textoBruto)) !== null) {
          const contrato = matchRaw[1], resto = matchRaw[2];
          const telefoneMatch = resto.match(/(859\d{8})/);
          const telefone = telefoneMatch ? telefoneMatch[0] : 'N/D';
          resultados.push({ contrato, info: resto.replace(telefone, '').trim(), telefone });
        }
        if (resultados.length === 0) { await sock.sendMessage(chatId, { text: '⚠️ Não identifiquei dados no texto.' }, { quoted: m }); return; }
        for (let item of resultados) {
          await sock.sendMessage(chatId, { text: `⭕ FORA ROTA ⭕\n\nCONTRATO: ${item.contrato}\nDADOS: ${item.info}\nTEL: ${item.telefone}\nTECNICO: ${tecnico}` });
          await new Promise(r => setTimeout(r, 800));
        }
        return;
      }

      // ==================== [PRIORIDADE 3] COMPROVANTE ====================
      if (msgTextoSemAcento.includes('tecnico') && (msgTextoSemAcento.includes('serial') || msgTextoSemAcento.includes('equipamento'))) {
        try {
          const inferirModeloPorSerial = (serial) => {
            const base = String(serial || '').toUpperCase().replace(/\W/g, '');
            if (!base) return 'DECODER';
            if (/[A-Z]/.test(base) && /\d/.test(base)) return 'EMTA';
            if (/^\d+$/.test(base)) return 'DECODER';
            return 'DECODER';
          };
          const extrairValor = (chave) => {
            const chaveClean = chave.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const linha = msgTextoRaw.split('\n').find(l => l.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(chaveClean));
            if (linha) { const partes = linha.split(':'); if (partes.length > 1) return partes.slice(1).join(':').trim(); }
            return '';
          };
          const data = extrairValor('Data');
          const contrato = extrairValor('Contrato');
          const nomeCliente = extrairValor('Nome do cliente');
          const tecnico = (extrairValor('Nome do Técnico') || extrairValor('Tecnico')).replace(/^\.\s*/, '');
          let rawEquips = extrairValor('Equipamentos') || extrairValor('Numero serial') || extrairValor('Número serial');
          const modeloEquipamentoInformado = (extrairValor('Modelo equipamento') || extrairValor('Modelo Equipamento') || '').toUpperCase();
          if (!contrato || !rawEquips) { await sock.sendMessage(chatId, { text: '⚠️ Faltou o Contrato ou os Equipamentos.' }, { quoted: m }); return; }
          const palavrasChave = ['EMTA', 'DECODE', 'SMART', 'MASH', 'HGU', 'ONT', 'DECODER'];
          const equipamentosBrutos = rawEquips.split(',').map(item => item.trim()).filter(Boolean);
          const hintSmartGlobal = /\bSMART\b/.test(modeloEquipamentoInformado) || /\bSMART\b/.test(msgTextoSemAcento.toUpperCase());
          const hintDecoderGlobal = /DECO|DECODER/.test(modeloEquipamentoInformado) || /DECO|DECODER/.test(msgTextoSemAcento.toUpperCase());
          const smartHintIndex = (() => {
            if (!hintSmartGlobal) return -1;
            const candidatos = [];
            equipamentosBrutos.forEach((item, idx) => {
              const limpo = item.toUpperCase().replace(/^\*+\s*/, '');
              if (!palavrasChave.some((p) => limpo.startsWith(p)) && !limpo.includes(':') && /^\d+$/.test(limpo)) candidatos.push(idx);
            });
            return candidatos.length ? candidatos[candidatos.length - 1] : -1;
          })();
          const listaEquipamentosProcessada = equipamentosBrutos.map((item, idx) => {
            let itemLimpo = item.trim().toUpperCase();
            const smartForcado = itemLimpo.startsWith('*');
            if (smartForcado) itemLimpo = itemLimpo.replace(/^\*+\s*/, '');
            for (const modelo of palavrasChave) {
              if (itemLimpo.startsWith(modelo)) {
                const serialSobra = itemLimpo.substring(modelo.length).replace(/^[:;\s-]+/, '').trim().replace(/^\*+\s*/, '');
                if (!serialSobra) return null;
                return { modelo: smartForcado ? 'SMART' : (modelo === 'DECODE' ? 'DECODER' : modelo), serial: serialSobra };
              }
            }
            if (itemLimpo.includes(':')) {
              const parts = itemLimpo.split(':');
              const modeloDeclarado = parts[0].trim().toUpperCase();
              const serialDeclarado = parts.slice(1).join(':').trim().replace(/^\*+\s*/, '');
              return { modelo: smartForcado ? 'SMART' : (['EMTA', 'SMART', 'DECODER'].includes(modeloDeclarado) ? modeloDeclarado : inferirModeloPorSerial(serialDeclarado)), serial: serialDeclarado };
            }
            const serialFinal = itemLimpo.replace(/^\*+\s*/, '');
            const smartPorHint = idx === smartHintIndex || (hintSmartGlobal && !hintDecoderGlobal && /^\d+$/.test(serialFinal));
            return { modelo: (smartForcado || itemLimpo.includes('SMART') || smartPorHint) ? 'SMART' : inferirModeloPorSerial(serialFinal), serial: serialFinal };
          }).filter(i => i && i.serial);
          if (listaEquipamentosProcessada.length === 0) { await sock.sendMessage(chatId, { text: '⚠️ Nenhum serial válido.' }, { quoted: m }); return; }
          await sock.sendMessage(chatId, { react: { text: '⏳', key: m.key } });
          const bufferImagem = await gerarComprovanteDevolucao({ data, contrato, nomeCliente, equipamentos: listaEquipamentosProcessada, tecnico });
          await sock.sendMessage(chatId, { image: bufferImagem, caption: `✅ Comprovante Gerado.\nCliente: ${nomeCliente}` }, { quoted: m });
          await sock.sendMessage(chatId, { text: getFollowupText() }, { quoted: m });
        } catch (err) { console.error('Erro comprovante:', err); }
        return;
      }

      // ==================== [PRIORIDADE 4] ADMIN/PONTO/OCR ====================
      if (isGrupo && msgTexto === '!marcar') { await enviarMensagemComMarcacaoGeral(chatId, "⚠️ *TESTE DE MARCAÇÃO GERAL*"); return; }
      if (msgTexto === '!id') { await sock.sendMessage(chatId, { text: `🆔 Chat: ${chatId}\n👤 User: ${usuarioId}` }, { quoted: m }); return; }
      if (msgTexto === '!controlador') { if (!isGrupoControladoresPonto) return; await sock.sendMessage(chatId, { text: gerarRelatorioDia() }, { quoted: m }); return; }
      if (msgTexto === '!planilha') { if (!isGrupoControladoresPonto) return; const csv = gerarRelatorioCSV(); await sock.sendMessage(chatId, { text: `📋 *HORÁRIOS DO DIA*\n\n_Copie o bloco abaixo:_\n\n\`\`\`${csv}\`\`\`` }, { quoted: m }); return; }
      if (msgTexto === '!ligarplanilha') { if (!GRUPOS_CONTATOS_TOA.has(chatId)) return; PLANILHA_ATIVA = true; await sock.sendMessage(chatId, { text: '✅ Fallback da planilha *ativado*.' }, { quoted: m }); return; }
      if (msgTexto === '!desligarplanilha') { if (!GRUPOS_CONTATOS_TOA.has(chatId)) return; PLANILHA_ATIVA = false; await sock.sendMessage(chatId, { text: '⛔ Fallback da planilha *desativado*.' }, { quoted: m }); return; }
      if (msgTexto === '!toastatus') {
        if (!GRUPOS_CONTATOS_TOA.has(chatId)) return;
        const stats = toaBridge.stats();
        await sock.sendMessage(chatId, { text: `🌐 *TOA Bridge* [${BOT_BUILD}]\nContratos: *${stats.contracts}*\nTelefones: *${stats.phones}*\nPorta: *${stats.port}*\nPendentes: *${stats.pendingLookups || 0}*` }, { quoted: m });
        return;
      }

      if (isGrupoControladoresPonto && msgTextoRaw.length > 0 && msgTextoRaw.length < 200) { 
        const resultadoPonto = processarMensagemPonto(nomeUsuario, msgTextoRaw, m.messageTimestamp);
        if (resultadoPonto) { await sock.sendMessage(chatId, { react: { text: '✅', key: m.key } }); console.log(`⏰ Ponto: ${resultadoPonto.nome} (${resultadoPonto.horario})`); }
      }

      if (msgTexto === '!ler') {
        let buffer = null;
        if (isImage) {
          buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        } else if (isQuotedImage) {
          const msgCitada = { message: m.message.extendedTextMessage.contextInfo.quotedMessage, key: { id: m.message.extendedTextMessage.contextInfo.stanzaId, remoteJid: chatId, participant: m.message.extendedTextMessage.contextInfo.participant } };
          buffer = await downloadMediaMessage(msgCitada, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        }
        if (buffer) {
          await sock.sendMessage(chatId, { react: { text: '👀', key: m.key } });
          const resultado = await lerTextoDeImagem(buffer);
          if (resultado && resultado.codigos.length > 0) {
            let resposta = `📠 *CÓDIGOS ENCONTRADOS:*\n`;
            resultado.codigos.forEach(c => { resposta += `\n🏷️ *${c.tipo}:* ${c.valor}`; });
            await sock.sendMessage(chatId, { text: resposta }, { quoted: m });
          } else if (resultado && resultado.raw) {
            await sock.sendMessage(chatId, { text: `⚠️ Li isto:\n\n${resultado.raw.slice(0, 500)}...` }, { quoted: m });
          } else {
            await sock.sendMessage(chatId, { text: '❌ Não consegui ler nada.' }, { quoted: m });
          }
        }
        return;
      }

      // ==================== [PRIORIDADE 5A] CONTATOS TOA (3 GRUPOS) ====================
      const matchControladores = msgTexto.match(/(?:contrato s?|contatos|conttatos|contats|ctt|cct)\D*(\d{6,9})|(\d{6,9})\D*(?:contrato s?|contatos|conttatos|contats|ctt|cct)/i);

      if (GRUPOS_CONTATOS_TOA.has(chatId) && matchControladores) {
        const termo = matchControladores[1] || matchControladores[2];
        TOA_LOG.info(`busca disparada — grupo=${chatId} contrato=${termo} build=${BOT_BUILD}`);

        const achadoCache = await toaBridgeLookupWithTimeout(termo, 500);
        if (achadoCache) {
          TOA_LOG.info(`cache hit — contrato=${termo} telefones=${achadoCache.telefones.length}`);
          await sock.sendMessage(chatId, { text: formatToaContactMessage(chatId, termo, achadoCache) }, { quoted: m });
          return;
        }

        TOA_LOG.warn(`cache miss — contrato=${termo}; enfileirando auto-lookup`);
        const lookupQueued = toaBridge.queueLookup(termo);
        TOA_LOG.info(`queue-lookup contrato=${termo} queued=${lookupQueued}`);

        runPythonToaLookup(termo)
          .then((py) => { TOA_LOG.info(`python lookup ${py.ok ? '✅' : '⚠️'} contrato=${termo} code=${py.code ?? 'n/a'}`); })
          .catch((err) => TOA_LOG.error(`python erro: ${err.message}`));

        iniciarPollingEResponder({ chatId, termo, message: m, timeoutMs: 25000, intervalMs: 2000 });

        if (PLANILHA_ATIVA) {
          if (CACHE_CONTRATOS.length === 0) await atualizarCache();
          const achadoPlanilha = CACHE_CONTRATOS.find(r => r['Contrato'] === termo);
          if (achadoPlanilha) {
            TOA_LOG.info(`fallback planilha encontrou contrato=${termo}`);
            if (precisaValidarURA(chatId)) {
              esperaConfirmacaoURA.set(chatId, { contrato: termo, dados: achadoPlanilha });
              await sock.sendMessage(chatId, { text: `📄 *Contrato:* ${termo}\n\nJá confirmou com a URA?\n\n_Responda apenas *Sim* ou *Não*_` }, { quoted: m });
            } else {
              await exibirDadosContrato(chatId, achadoPlanilha, termo, m);
            }
          }
        }
        return;
      }

      // ==================== [PRIORIDADE 5] BUSCA DE CONTRATO (PLANILHA) ====================
      const match = msgTexto.match(/(?:c[o0]nt\w*|ctt|cct)\D*(\d{6,9})|(\d{6,9})\D*(?:c[o0]nt\w*|ctt|cct)/i);
      
      if (match && GRUPOS_CONTATOS_TOA.has(chatId)) {
        const termo = match[1] || match[2];
        console.log(`🔍 [${BOT_BUILD}] busca contrato autorizada em ${chatId}: ${termo}`);
        if (CACHE_CONTRATOS.length === 0) {
          await sock.sendMessage(chatId, { text: `⚠️ Estou atualizando a base de dados agora, tente novamente em 1 minuto.` }, { quoted: m });
          await atualizarCache(); return;
        }
        const achado = CACHE_CONTRATOS.find(r => r['Contrato'] === termo);
        if (achado) {
          if (precisaValidarURA(chatId)) {
            esperaConfirmacaoURA.set(chatId, { contrato: termo, dados: achado });
            await sock.sendMessage(chatId, { text: `📄 *Contrato:* ${termo}\n\nJá confirmou com a URA?\n\n_Responda apenas *Sim* ou *Não*_` }, { quoted: m });
          } else {
            await exibirDadosContrato(chatId, achado, termo, m);
          }
        } else if (chatId === ID_GRUPO_CONTATOS) {
          await sock.sendMessage(chatId, { text: `⚠️ [${BOT_BUILD}] Contatos não encontrado na Base de Dados, favor retornar ao seu controlador.` }, { quoted: m });
        }
        return; 
      }

    } catch (e) { console.error('Erro msg:', e); }
  });
  return sock;
}

connectToWhatsApp();
