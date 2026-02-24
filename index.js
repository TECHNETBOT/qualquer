const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// IMPORTAÇÕES LOCAIS
const C = require('./src/config');
const Utils = require('./src/utils');
const Data = require('./src/data'); // Usa o data.js atualizado
const Sheets = require('./src/sheets'); // Usa o sheets.js atualizado
const Alerts = require('./src/alerts');
const { gerarComprovanteDevolucao } = require('./src/gerador');
const { lerTextoDeImagem } = require('./src/ocr'); 
const { processarMensagemPonto, gerarRelatorioDia, gerarRelatorioCSV } = require('./src/ponto');
const { compare430, formatForCopy } = require('./src/compare430');

// CONFIGURAÇÃO DOS GRUPOS
const ID_GRUPO_TESTE = '120363423496684075@g.us';
const ID_GRUPO_RELATORIO = '120363423496684075@g.us'; 
const ID_GRUPO_ADESAO = '558496022125-1485433351@g.us';
const ID_GRUPO_TECNICOS = '120363023249969562@g.us'; 
const ID_GRUPO_CONTATOS = '120363422121095440@g.us'; 

const DATA_DIR = path.join(__dirname, 'data');
const WHATS_TXT_PATH = path.join(DATA_DIR, 'whats.txt');
const WHATS_CSV_PATH = path.join(DATA_DIR, 'whats.csv');
const IMPERIUM_XLSX_PATH = path.join(DATA_DIR, 'imperium.xlsx');

// === CACHE E MEMÓRIA ===
let CACHE_CONTRATOS = []; 
let CACHE_FORAROTA = []; 

// Carrega o histórico salvo no arquivo para não perder se reiniciar
let CONTRATOS_USADOS = new Set(Data.listaForaRotaUsados || []); 

// === CONTROLE DE URA ===
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

// ==================== FUNÇÕES DE CACHE ====================
async function atualizarCache() {
    console.log('🔄 Atualizando caches...');
    try {
        const dadosGeral = await Sheets.obterBaseContratos();
        if (dadosGeral && dadosGeral.length > 0) {
            CACHE_CONTRATOS = dadosGeral;
            console.log(`✅ CACHE GERAL: ${CACHE_CONTRATOS.length} linhas.`);
        }
        const dadosForaRota = await Sheets.obterBaseForaRota();
        if (dadosForaRota && dadosForaRota.length > 0) {
            CACHE_FORAROTA = dadosForaRota;
            console.log(`✅ CACHE FORA ROTA: ${CACHE_FORAROTA.length} linhas.`);
        }
    } catch (e) {
        console.error('❌ Erro fatal ao atualizar cache:', e);
    }
}

// ==================== FUNÇÕES AUXILIARES ====================

// --- NOVA FUNÇÃO DE MARCAÇÃO (SÓ QUEM ESTÁ NA LISTA) ---
const enviarMensagemComMarcacaoLista = async (grupoId, textoBase, listaNumeros) => {
    try {
        if (!listaNumeros || listaNumeros.length === 0) {
            await sock.sendMessage(grupoId, { text: textoBase });
            return;
        }
        const mentions = listaNumeros.map(num => `${num}@s.whatsapp.net`);
        const textoMentions = listaNumeros.map(num => `@${num}`).join(' ');
        const textoFinal = `${textoBase}\n\n${textoMentions}`;
        
        await sock.sendMessage(grupoId, { text: textoFinal, mentions: mentions });
        console.log(`📢 Aviso enviado para ${grupoId} (Marcados: ${listaNumeros.length})`);
    } catch (e) {
        console.error(`❌ Erro ao marcar lista no grupo ${grupoId}:`, e);
    }
};

// Função antiga (Marca TODOS do grupo) - Mantida apenas para o comando !marcar
const enviarMensagemComMarcacaoGeral = async (grupoId, textoBase) => {
    try {
        const metadata = await sock.groupMetadata(grupoId);
        const participantes = metadata.participants.map(p => p.id);
        const mencoesTexto = participantes.map(p => `@${p.split('@')[0]}`).join(' ');
        const textoFinal = `${textoBase}\n\n${mencoesTexto}`;
        await sock.sendMessage(grupoId, { text: textoFinal, mentions: participantes });
    } catch (e) { console.error(e); }
};

const validarNumero = async (chatId, numero, comandoExemplo) => {
  if (numero.length < 10) { await sock.sendMessage(chatId, { text: `❌ Número inválido. Use: ${comandoExemplo}` }); return false; }
  return true;
};

// Funções para gerenciar listas (VT, AD, DESC)
const adicionarNaLista = async (chatId, numero, arrayLista, funcaoSalvar, nomeLista, exemplo) => {
    if (!(await validarNumero(chatId, numero, exemplo))) return;
    if (arrayLista.includes(numero)) { await sock.sendMessage(chatId, { text: `⚠️ ${numero} já está na lista ${nomeLista}.` }); return; }
    arrayLista.push(numero);
    funcaoSalvar(); 
    await sock.sendMessage(chatId, { text: `✅ ${numero} adicionado em ${nomeLista}!\n📋 Total: ${arrayLista.length}` });
};

const removerDaLista = async (chatId, numero, arrayLista, funcaoSalvar, nomeLista) => {
    const index = arrayLista.indexOf(numero);
    if (index === -1) { await sock.sendMessage(chatId, { text: `⚠️ ${numero} não está na lista ${nomeLista}.` }); return; }
    arrayLista.splice(index, 1);
    funcaoSalvar(); 
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
  // Se for grupo de CONTATOS ou TÉCNICOS mostra completo
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

async function connectToWhatsApp() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Versão WhatsApp Web usada: ${version.join('.')} (latest: ${isLatest})`);

  sock = makeWASocket({
    auth: state, printQRInTerminal: false, logger: pino({ level: 'fatal' }),
    browser: ['Bot Consulta', 'Chrome', '1.0.0'], markOnlineOnConnect: false,
    version
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('📱 QR Code recebido! Escaneie com o WhatsApp.');
      qrcode.generate(qr, { small: true }, (qrCode) => console.log(qrCode));
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 'desconhecido';
      console.log(`🔌 Conexão fechada. Motivo: ${statusCode}`);
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;

      if (shouldReconnect) {
        reconnectAttempts += 1;
        const retryDelayMs = Math.min(3000 * reconnectAttempts, 15000);
        console.log(`🔄 Tentando reconectar em ${Math.round(retryDelayMs / 1000)}s...`);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => connectToWhatsApp(), retryDelayMs);
      }
    } else if (connection === 'open') {
      reconnectAttempts = 0;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      console.log('--- BOT ATIVO (FINAL HYBRID VERSION) ---');
      await atualizarCache();
      console.log(`💾 Histórico Fora Rota carregado: ${CONTRATOS_USADOS.size} contratos já enviados.`);

      if (cacheIntervalId) clearInterval(cacheIntervalId);
      cacheIntervalId = setInterval(async () => { await atualizarCache(); }, TEMPO_ATUALIZACAO_MINUTOS * 60 * 1000);

      if (alertaIntervalId) clearInterval(alertaIntervalId);
      alertaIntervalId = setInterval(async () => {
        const agora = new Date();
        const horaAtual = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        // --- ALERTAS DE JANELA (Mantidos) ---
        const horariosAlertaTec1 = { "11:45": "das 08h às 12h", "14:45": "das 12h às 15h", "17:45": "das 15h às 18h" };
        if (horariosAlertaTec1[horaAtual] && ultimoAlertaEnviado !== horaAtual) { Alerts.enviarAlertaJanela(sock, horariosAlertaTec1[horaAtual], C.ID_GRUPO_ALERTAS); ultimoAlertaEnviado = horaAtual; }
        
        const horariosAlertaVT = { "09:45": ["08:00 às 10:00"], "10:45": ["08:00 às 11:00"], "11:45": ["10:00 às 12:00"], "13:45": ["11:00 às 14:00", "12:00 às 14:00"], "15:45": ["14:00 às 16:00"], "16:45": ["14:00 às 17:00"], "17:45": ["16:00 às 18:00"], "19:45": ["17:00 às 20:00", "18:00 às 20:00"] };
        if (horariosAlertaVT[horaAtual] && ultimoAlertaVT !== horaAtual) { Alerts.enviarAlertaGenerico(sock, { titulo: 'VISITA TÉCNICA (VT)', janelas: horariosAlertaVT[horaAtual], idDestino: C.ID_GRUPO_ALERTAS, lista: Data.listaVT, logPrefixo: 'VT' }); ultimoAlertaVT = horaAtual; }

        const horariosAlertaAD = { "11:45": ["08:00 às 12:00"], "14:45": ["12:00 às 15:00"], "17:45": ["15:00 às 18:00"] };
        if (horariosAlertaAD[horaAtual] && ultimoAlertaAD !== horaAtual) { Alerts.enviarAlertaGenerico(sock, { titulo: 'ADESÃO', janelas: horariosAlertaAD[horaAtual], idDestino: C.ID_GRUPO_ALERTAS, lista: Data.listaAD, logPrefixo: 'ADESÃO' }); ultimoAlertaAD = horaAtual; }

        // --- AVISO DE ROTA (AGORA USA A LISTA ESPECÍFICA - SEM MARCAR DONO) ---
        const horariosRota = ["07:40", "07:50", "08:00"];
        if (horariosRota.includes(horaAtual) && ultimoAvisoRota !== horaAtual) {
            const mensagemRota = "Bom dia a todos!\n\nLembrando que é necessário ativar a rota até às 8h.\nÀs 8h05, o sistema desativa automaticamente as rotas não ativas.\n\nContamos com a colaboração de todos.";
            // Usa Data.listaAD para marcar só quem está cadastrado
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

              await sock.sendMessage(chatId, {
                  text: `⚠️ Faltam arquivos para comparar:

${faltantes.join('\n')}

Envie os dois documentos (.txt/.csv e .xlsx).`
              }, { quoted: m });
              return;
          }

          try {
              const resultado = compare430({
                  whatsPath,
                  imperiumXlsxPath: IMPERIUM_XLSX_PATH,
                  timeZone: 'America/Sao_Paulo'
              });

              if (resultado.totalWhats430 === 0) {
                  await sock.sendMessage(chatId, { text: 'ℹ️ Não encontrei mensagens com *430* no arquivo Whats informado.' }, { quoted: m });
                  return;
              }

              const blocos = [];
              blocos.push(`📊 Total de contratos 430 no Whats: *${resultado.totalWhats430}*`);

              if (resultado.divergencias.length > 0) {
                  blocos.push(`
🚨 *DIVERGÊNCIAS*
${formatForCopy(resultado.divergencias)}`);
              } else {
                  blocos.push('\n✅ Nenhuma divergência de técnico encontrada para os 430.');
              }

              if (resultado.naoEncontrados.length > 0) {
                  blocos.push(`
📌 *CONTRATOS 430 NÃO ENCONTRADOS NO XLSX (DESC + hoje)*
${resultado.naoEncontrados.join('\n')}`);
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
                      if (tentativa.length > TAMANHO_MAX) {
                          if (atual) partes.push(atual);
                          atual = linha;
                      } else {
                          atual = tentativa;
                      }
                  }
                  if (atual) partes.push(atual);

                  for (let i = 0; i < partes.length; i++) {
                      const prefixo = i === 0 ? '' : `(continuação ${i + 1}/${partes.length})\n`;
                      await sock.sendMessage(chatId, { text: `${prefixo}${partes[i]}` }, { quoted: m });
                  }
              }
          } catch (err) {
              console.error('Erro comparar430:', err);
              await sock.sendMessage(chatId, { text: `❌ Erro ao comparar 430: ${err.message}` }, { quoted: m });
          }
      };

      // ==================== COMANDO !MENU ====================
      if (msgTexto === '!menu' || msgTexto === '!ajuda') {
          const menu = `🤖 *MENU DE COMANDOS* 🤖

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
• !comparar430 - Compara Whats x Imperium

📎 *ARQUIVOS (documento)*
• Envie .txt/.csv (nome livre, ex: relatorio_todas_mensagens_24_02_2026_a_24_02_2026.txt)
• Envie .xlsx (nome livre)
• Ao receber 1x .txt/.csv + 1x .xlsx, o bot compara automático

🔍 *CONSULTA*
• Digite "contato 12345", "cct 12345", "ctt 12345" ou "12345 ctt"
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

      // ==================== CAPTURA DE DOCUMENTOS (whats / imperium) ====================
      if (isDocument) {
          const originalName = (m.message?.documentMessage?.fileName || '').toLowerCase().trim();
          const mimetype = (m.message?.documentMessage?.mimetype || '').toLowerCase();
          const isTxtOrCsv = originalName.endsWith('.txt') || originalName.endsWith('.csv') || mimetype.includes('text/') || mimetype.includes('csv');
          const isXlsx = originalName.endsWith('.xlsx') || mimetype.includes('spreadsheetml');

          const legendaMarcaWhats = documentCaption === 'whats';
          const legendaMarcaImperium = documentCaption === 'imperium';

          if (isTxtOrCsv || isXlsx || legendaMarcaWhats || legendaMarcaImperium) {
              const fileBuffer = await downloadMediaMessage(m, 'buffer', {}, {
                  logger: pino({ level: 'silent' }),
                  reuploadRequest: sock.updateMediaMessage
              });

              if (!fileBuffer) {
                  await sock.sendMessage(chatId, { text: '❌ Não consegui baixar o documento.' }, { quoted: m });
                  return;
              }

              let salvouAlgum = false;
              if (isTxtOrCsv || legendaMarcaWhats) {
                  const destino = originalName.endsWith('.csv') ? WHATS_CSV_PATH : WHATS_TXT_PATH;
                  fs.writeFileSync(destino, fileBuffer);
                  salvouAlgum = true;
                  await sock.sendMessage(chatId, { text: `✅ Arquivo Whats salvo em: ${path.basename(destino)}` }, { quoted: m });
              } else if (isXlsx || legendaMarcaImperium) {
                  fs.writeFileSync(IMPERIUM_XLSX_PATH, fileBuffer);
                  salvouAlgum = true;
                  await sock.sendMessage(chatId, { text: '✅ Arquivo Imperium salvo em: imperium.xlsx' }, { quoted: m });
              }

              if (salvouAlgum) {
                  const hasWhats = fs.existsSync(WHATS_TXT_PATH) || fs.existsSync(WHATS_CSV_PATH);
                  const hasImperium = fs.existsSync(IMPERIUM_XLSX_PATH);
                  if (hasWhats && hasImperium) {
                      await sock.sendMessage(chatId, { text: '🤖 Arquivos detectados (.txt/.csv + .xlsx). Iniciando comparação 430...' }, { quoted: m });
                      await executarComparacao430();
                  }
                  return;
              }
          }
      }

      if (msgTexto === '!comparar430') {
          await executarComparacao430();
          return;
      }

      // ==================== [PRIORIDADE 0] VERIFICAÇÃO URA ====================
      if (esperaConfirmacaoURA.has(chatId)) {
          const contexto = esperaConfirmacaoURA.get(chatId);
          if (msgTextoSemAcento === 'sim') {
              await exibirDadosContrato(chatId, contexto.dados, contexto.contrato, m);
              esperaConfirmacaoURA.delete(chatId);
              return; 
          } else if (msgTextoSemAcento === 'nao' || msgTextoSemAcento === 'não') {
              await sock.sendMessage(chatId, { text: '⚠️ Por favor valide na URA antes de pegar o contato.' }, { quoted: m });
              esperaConfirmacaoURA.delete(chatId);
              return;
          }
      }

      // ==================== [PRIORIDADE 1] !FORAROTA (COM SAVE JSON) ====================
      if (msgTexto.startsWith('!forarota ')) {
          const params = msgTextoRaw.slice(10).split(',').map(p => p.trim());
          if (params.length < 2) { 
              await sock.sendMessage(chatId, { text: '❌ Uso: !forarota [Tecnico], [Bairro], [Quantidade (opcional)]' }, { quoted: m });
              return;
          }
          const [tecnico, bairroBusca, qtdStr] = params;
          const qtd = parseInt(qtdStr) || 1;

          const disponiveis = CACHE_FORAROTA.filter(r => 
              r.bairro && r.bairro.toLowerCase().includes(bairroBusca.toLowerCase()) && !CONTRATOS_USADOS.has(r.contrato)
          );

          if (disponiveis.length === 0) {
              await sock.sendMessage(chatId, { text: `⚠️ Nenhuma OS disponível para *${bairroBusca}* (ou todas já foram enviadas).` }, { quoted: m });
              return;
          }

          const selecionados = disponiveis.slice(0, qtd);
          
          // Marca na memória e SALVA NO ARQUIVO JSON
          selecionados.forEach(r => CONTRATOS_USADOS.add(r.contrato));
          Data.salvarForaRotaUsados(Array.from(CONTRATOS_USADOS));

          for (let item of selecionados) {
              let msgIndividual = `⭕ FORA ROTA ⭕\n\nCONTRATO: ${item.contrato}\nNOME: ${item.cliente}\nEND: ${item.endereco}\nTEL: ${item.telefone}\nTECNICO: ${tecnico}`;
              await sock.sendMessage(chatId, { text: msgIndividual });
              await new Promise(r => setTimeout(r, 800)); // Delay 0.8s
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

          const regexContrato = /(\d{7,})([A-Z\s\.]+)/g;
          let matchRaw;
          let resultados = [];

          while ((matchRaw = regexContrato.exec(textoBruto)) !== null) {
              let contrato = matchRaw[1];
              let resto = matchRaw[2];
              let telefoneMatch = resto.match(/(859\d{8})/);
              let telefone = telefoneMatch ? telefoneMatch[0] : 'N/D';
              let nomeEnd = resto.replace(telefone, '').trim();
              resultados.push({ contrato, info: nomeEnd, telefone });
          }

          if (resultados.length === 0) {
               await sock.sendMessage(chatId, { text: '⚠️ Não identifiquei dados no texto.' }, { quoted: m });
               return;
          }

          for (let item of resultados) {
              let msgIndividual = `⭕ FORA ROTA ⭕\n\nCONTRATO: ${item.contrato}\nDADOS: ${item.info}\nTEL: ${item.telefone}\nTECNICO: ${tecnico}`;
              await sock.sendMessage(chatId, { text: msgIndividual });
              await new Promise(r => setTimeout(r, 800));
          }
          return;
      }

      // ==================== [PRIORIDADE 3] COMPROVANTE ====================
      if (msgTextoSemAcento.includes('tecnico') && (msgTextoSemAcento.includes('serial') || msgTextoSemAcento.includes('equipamento'))) {
           try {
              const extrairValor = (chave) => {
                  const chaveClean = chave.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                  const linhas = msgTextoRaw.split('\n');
                  const linha = linhas.find(l => l.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(chaveClean));
                  if (linha) {
                      const partes = linha.split(':');
                      if (partes.length > 1) return partes.slice(1).join(':').trim();
                  }
                  return '';
              };

              const data = extrairValor('Data');
              const contrato = extrairValor('Contrato');
              const nomeCliente = extrairValor('Nome do cliente');
              const tecnico = extrairValor('Nome do Técnico');
              let rawEquips = extrairValor('Equipamentos') || extrairValor('Numero serial');

              if (!contrato || !rawEquips) { await sock.sendMessage(chatId, { text: '⚠️ Faltou o Contrato ou os Equipamentos.' }, { quoted: m }); return; }

              const palavrasChave = ['EMTA', 'DECODE', 'SMART', 'MASH', 'HGU', 'ONT', 'APARELHO'];
              const listaEquipamentosProcessada = rawEquips.split(',').map(item => {
                  let itemLimpo = item.trim().toUpperCase();
                  for (const modelo of palavrasChave) {
                      if (itemLimpo.startsWith(modelo)) {
                          let serialSobra = itemLimpo.substring(modelo.length).replace(/^[:;\s-]+/, '').trim();
                          if (serialSobra) return { modelo: modelo, serial: serialSobra };
                      }
                  }
                  if (itemLimpo.includes(':')) {
                      const parts = itemLimpo.split(':');
                      return { modelo: parts[0].trim(), serial: parts.slice(1).join(':').trim() };
                  } else {
                      return { modelo: 'APARELHO', serial: itemLimpo };
                  }
              }).filter(i => i.serial);

              if (listaEquipamentosProcessada.length === 0) { await sock.sendMessage(chatId, { text: '⚠️ Nenhum serial válido.' }, { quoted: m }); return; }

              await sock.sendMessage(chatId, { react: { text: '⏳', key: m.key } });
              const bufferImagem = await gerarComprovanteDevolucao({ data, contrato, nomeCliente, equipamentos: listaEquipamentosProcessada, tecnico });
              await sock.sendMessage(chatId, { image: bufferImagem, caption: `✅ Comprovante Gerado.\nCliente: ${nomeCliente}` }, { quoted: m });
          } catch (err) { console.error('Erro comprovante:', err); }
          return;
      }

      // ==================== [PRIORIDADE 4] ADMIN/PONTO/OCR ====================
      if (isGrupo && msgTexto === '!marcar') {
          await enviarMensagemComMarcacaoGeral(chatId, "⚠️ *TESTE DE MARCAÇÃO GERAL*");
          return;
      }
      if (msgTexto === '!id') { await sock.sendMessage(chatId, { text: `🆔 Chat: ${chatId}\n👤 User: ${usuarioId}` }, { quoted: m }); return; }

      if (msgTexto === '!controlador') { if (!isGrupoAutorizado) return; const relatorio = gerarRelatorioDia(); await sock.sendMessage(chatId, { text: relatorio }, { quoted: m }); return; }
      if (msgTexto === '!planilha') { if (!isGrupoAutorizado) return; const csv = gerarRelatorioCSV(); await sock.sendMessage(chatId, { text: `📋 *HORÁRIOS DO DIA*\n\n_Copie o bloco abaixo:_\n\n\`\`\`${csv}\`\`\`` }, { quoted: m }); return; }
      if (isGrupoAutorizado && msgTextoRaw.length > 0 && msgTextoRaw.length < 200) { 
          const resultadoPonto = processarMensagemPonto(nomeUsuario, msgTextoRaw, m.messageTimestamp);
          if (resultadoPonto) { await sock.sendMessage(chatId, { react: { text: '✅', key: m.key } }); console.log(`⏰ Ponto: ${resultadoPonto.nome} (${resultadoPonto.horario})`); }
      }
      if (msgTexto === '!ler') {
          let buffer = null;
          if (isImage) {
              buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          } else if (isQuotedImage) {
              const msgCitada = {
                  message: m.message.extendedTextMessage.contextInfo.quotedMessage,
                  key: { id: m.message.extendedTextMessage.contextInfo.stanzaId, remoteJid: chatId, participant: m.message.extendedTextMessage.contextInfo.participant }
              };
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

      // ==================== [PRIORIDADE 5] BUSCA DE CONTRATO (CACHE + URA) ====================
      const match = msgTexto.match(/(?:c[o0]nt\w*|ctt|cct)\D*(\d+)|(\d+)\D*(?:c[o0]nt\w*|ctt|cct)/i);
      
      if (match) {
          const termo = match[1] || match[2];
          console.log(`🔍 Buscando contrato: ${termo}`);

          if (CACHE_CONTRATOS.length === 0) {
              await sock.sendMessage(chatId, { text: `⚠️ Estou atualizando a base de dados agora, tente novamente em 1 minuto.` }, { quoted: m });
              await atualizarCache(); 
              return;
          }

          const achado = CACHE_CONTRATOS.find(r => r['Contrato'] === termo);
          
          if (achado) {
              esperaConfirmacaoURA.set(chatId, { contrato: termo, dados: achado });
              await sock.sendMessage(chatId, { 
                  text: `📄 *Contrato:* ${termo}\n\nJá confirmou com a URA?\n\n_Responda apenas *Sim* ou *Não*_` 
              }, { quoted: m });

          } else {
              // MENSAGEM ESPECÍFICA PARA GRUPO DE CONTATOS
              if (chatId === ID_GRUPO_CONTATOS) {
                  await sock.sendMessage(chatId, { 
                      text: `Contatos não encontrado na Base de Dados, favor retornar ao seu controlador.` 
                  }, { quoted: m });
              }
          }
          return; 
      }

    } catch (e) { console.error('Erro msg:', e); }
  });
  return sock;
}
connectToWhatsApp();
