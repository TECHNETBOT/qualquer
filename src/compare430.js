const fs = require('fs');
let XLSX = null;

function getXLSX() {
  if (XLSX) return XLSX;
  try {
    XLSX = require('xlsx');
    return XLSX;
  } catch (err) {
    throw new Error('Dependência "xlsx" não encontrada. Rode: npm install xlsx');
  }
}


function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findBestSheetName(workbook) {
  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) return null;

  const exact = sheetNames.find((name) => normalizeText(name) === 'devolucao pendente');
  if (exact) return exact;

  const partial = sheetNames.find((name) => {
    const n = normalizeText(name);
    return n.includes('devolucao') && n.includes('pendente');
  });
  if (partial) return partial;

  return null;
}

function normalizeName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\[[^\]]+\]\s*/g, ' ')
    .replace(/\b(desc|ntl|tecnico|tecnica|ftz|tecnico)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function onlyDigits(value = '') {
  return String(value).replace(/\D+/g, '');
}

function getDatePartsInTimeZone(date, timeZone) {
  const formatted = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const map = {};
  for (const p of formatted) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }

  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function isSameDateInTimeZone(input, refDate, timeZone) {
  if (!input) return false;
  const ref = getDatePartsInTimeZone(refDate, timeZone);

  if (input instanceof Date && !isNaN(input)) {
    const d = getDatePartsInTimeZone(input, timeZone);
    return d.year === ref.year && d.month === ref.month && d.day === ref.day;
  }

  const text = String(input).trim();
  const br = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]);
    const year = Number(br[3].length === 2 ? `20${br[3]}` : br[3]);
    return year === ref.year && month === ref.month && day === ref.day;
  }

  const parsed = new Date(text);
  if (!isNaN(parsed)) {
    const d = getDatePartsInTimeZone(parsed, timeZone);
    return d.year === ref.year && d.month === ref.month && d.day === ref.day;
  }

  return false;
}

function toDateFromExcel(raw) {
  if (typeof raw === 'number') {
    const parsed = getXLSX().SSF.parse_date_code(raw);
    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, parsed.S || 0));
    }
  }
  return raw;
}

function extractWhatsRows(content) {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = [];

  for (const line of lines) {
    if (!/\b430\b/.test(line)) continue;

    // Formato export WhatsApp: [16:51, 24/02/2026] Nome: mensagem
    const exportMatch = line.match(/^\[[^\]]+\]\s*([^:]+):\s*(.*)$/);
    const sender = exportMatch ? exportMatch[1].trim() : 'remetente_nao_identificado';
    const textToAnalyze = exportMatch ? exportMatch[2] : line;

    const contractMatch = textToAnalyze.match(/\b(\d{6,8})\b/) || line.match(/\b(\d{6,8})\b/);
    if (!contractMatch) continue;

    result.push({
      raw: line,
      contrato: contractMatch[1],
      remetente: sender
    });
  }

  return result;
}

function findColumnName(columns, candidates) {
  const normalized = columns.map((col) => ({
    original: col,
    key: normalizeName(col)
  }));

  for (const candidate of candidates) {
    const key = normalizeName(candidate);
    const found = normalized.find((item) => item.key.includes(key) || key.includes(item.key));
    if (found) return found.original;
  }

  return null;
}

function isSameTechnician(whatsName, imperiumName) {
  const w = normalizeName(whatsName);
  const i = normalizeName(imperiumName);
  if (!w || !i) return false;
  if (w === i) return true;
  if (w.includes(i) || i.includes(w)) return true;

  const wt = w.split(' ').filter(Boolean);
  const it = i.split(' ').filter(Boolean);
  if (!wt.length || !it.length) return false;
  if (wt[0] === it[0]) return true;

  const common = wt.filter((t) => it.includes(t));
  return common.length >= 2;
}


function inferColumnByData(rows, columns, scorer, minScore = 3) {
  let best = { col: null, score: 0 };
  for (const col of columns) {
    let score = 0;
    for (const row of rows.slice(0, 200)) {
      if (scorer(row[col])) score += 1;
    }
    if (score > best.score) best = { col, score };
  }
  return best.score >= minScore ? best.col : null;
}

function compare430({ whatsPath, imperiumXlsxPath, timeZone = 'America/Sao_Paulo' }) {
  if (!fs.existsSync(whatsPath)) throw new Error(`Arquivo Whats não encontrado: ${whatsPath}`);
  if (!fs.existsSync(imperiumXlsxPath)) throw new Error(`Arquivo Imperium não encontrado: ${imperiumXlsxPath}`);

  const whatsContent = fs.readFileSync(whatsPath, 'utf8');
  const whatsRows = extractWhatsRows(whatsContent);

  const xlsx = getXLSX();
  const workbook = xlsx.readFile(imperiumXlsxPath, { cellDates: true });
  const sheetName = findBestSheetName(workbook);
  if (!sheetName) {
    throw new Error(`Aba de devolução pendente não encontrada no XLSX. Abas disponíveis: ${workbook.SheetNames.join(', ')}`);
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  const allColumns = rows.length ? Object.keys(rows[0]) : [];

  let contratoCol = findColumnName(allColumns, ['contrato']);
  let tecnicoCol = findColumnName(allColumns, ['instalador', 'tecnico', 'técnico', 'instalad']);
  let serialCol = findColumnName(allColumns, ['serial', 'numero serial', 'número serial', 'num serial']);
  let dataBaixaCol = findColumnName(allColumns, ['data da baixa', 'data baixa', 'data da b', 'baixa']);

  if (!contratoCol) {
    contratoCol = inferColumnByData(rows, allColumns, (v) => /^\d{6,8}$/.test(onlyDigits(v)), 1);
  }
  if (!serialCol) {
    serialCol = inferColumnByData(rows, allColumns, (v) => {
      const text = String(v || '').trim();
      return /[a-z]/i.test(text) && /\d/.test(text) && text.replace(/\W/g, '').length >= 6;
    }, 1);
  }
  if (!dataBaixaCol) {
    dataBaixaCol = inferColumnByData(rows, allColumns, (v) => isSameDateInTimeZone(toDateFromExcel(v), new Date(), timeZone), 1)
      || inferColumnByData(rows, allColumns, (v) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(String(v || '')), 1);
  }
  if (!tecnicoCol) {
    tecnicoCol = inferColumnByData(rows, allColumns, (v) => normalizeText(v).includes('desc'), 1);
  }

  if (!contratoCol || !tecnicoCol || !serialCol || !dataBaixaCol) {
    throw new Error(`Colunas obrigatórias não encontradas na aba ${sheetName} (Contrato, Instalador/Técnico, Serial, Data da Baixa). Colunas lidas: ${allColumns.join(', ')}`);
  }

  const hoje = new Date();
  const imperiumFiltered = rows.filter((row) => {
    const tecnicoRaw = String(row[tecnicoCol] || '');
    const tecnicoValue = normalizeText(tecnicoRaw);
    const isDesc = tecnicoValue.includes('desc');
    const sameDay = isSameDateInTimeZone(toDateFromExcel(row[dataBaixaCol]), hoje, timeZone);
    return isDesc && sameDay;
  });

  const byContract = new Map();
  for (const row of imperiumFiltered) {
    const contrato = onlyDigits(row[contratoCol]);
    if (!/^\d{6,8}$/.test(contrato)) continue;

    if (!byContract.has(contrato)) byContract.set(contrato, []);
    byContract.get(contrato).push({
      tecnicoOriginal: String(row[tecnicoCol] || '').trim(),
      tecnicoNorm: normalizeName(row[tecnicoCol] || ''),
      serial: String(row[serialCol] || '').trim()
    });
  }

  const divergencias = [];
  const naoEncontrados = [];

  for (const item of whatsRows) {
    const tecnicoWhatsNorm = normalizeName(item.remetente);
    const registros = byContract.get(item.contrato) || [];

    if (!registros.length) {
      naoEncontrados.push(item.contrato);
      continue;
    }

    const sameTech = registros.some((r) => r.tecnicoNorm && isSameTechnician(tecnicoWhatsNorm, r.tecnicoNorm));
    if (sameTech) continue;

    const serials = [...new Set(registros.map((r) => r.serial).filter(Boolean))];
    divergencias.push({
      contrato: item.contrato,
      serials,
      tecnicoWhats: item.remetente,
      tecnicosImperium: [...new Set(registros.map((r) => r.tecnicoOriginal).filter(Boolean))]
    });
  }

  return {
    totalWhats430: whatsRows.length,
    divergencias,
    naoEncontrados: [...new Set(naoEncontrados)]
  };
}

function formatForCopy(divergencias) {
  return divergencias
    .map((d) => `${d.contrato} (CONTRATO) / ${d.serials.join(', ') || 'SEM SERIAL'} (SERIAL)`)
    .join('\n');
}

module.exports = {
  compare430,
  formatForCopy
};
