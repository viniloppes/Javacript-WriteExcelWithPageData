// Funções puras de mapeamento: sem dependência de APIs do Chrome para que
// possam ser testadas com `node --test`.

/** Extrai o ID de uma URL do Google Sheets ou valida um ID informado diretamente. */
export function parseSpreadsheetId(input) {
  const text = String(input ?? '').trim();
  const fromUrl = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const id = fromUrl ? fromUrl[1] : text;
  return /^[a-zA-Z0-9_-]{20,}$/.test(id) ? id : null;
}

/** Converte um índice de coluna (0 = A) na letra usada pela notação A1. */
export function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Coloca o nome da aba entre aspas simples, escapando aspas internas. */
export function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

export function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Normaliza o identificador único para comparação. URLs ignoram protocolo,
 * "www.", query string, fragmento e barra final; demais textos ignoram
 * maiúsculas e espaços extras. Células com =HYPERLINK("url"; "texto") usam a URL.
 */
export function normalizeKey(value) {
  let text = String(value ?? '').trim();
  const hyperlink = text.match(/^=\s*HYPERLINK\(\s*"([^"]*)"/i);
  if (hyperlink) text = hyperlink[1].trim();
  if (!text) return '';

  if (/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/|$)/i.test(text)) {
    try {
      const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const path = decodeURI(url.pathname).replace(/\/+$/, '').toLowerCase();
      return `${host}${path}`;
    } catch {
      // Não é uma URL válida: cai na normalização de texto.
    }
  }
  return text.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Prepara o valor de uma célula. Como os dados são enviados com
 * valueInputOption=USER_ENTERED (para que datas sejam reconhecidas), textos
 * vindos da página que começam com =, +, -, @ são prefixados com apóstrofo
 * para nunca virarem fórmulas. Valores vazios viram null, que a API ignora.
 */
export function sanitizeCell(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Localiza cada coluna mapeada no cabeçalho da planilha. */
export function resolveColumns(header, fields) {
  const index = new Map();
  (header ?? []).forEach((name, i) => {
    const key = normalizeHeader(name);
    if (key && !index.has(key)) index.set(key, i);
  });

  const positions = new Map();
  const missing = [];
  for (const field of fields) {
    const pos = index.get(normalizeHeader(field.column));
    if (pos === undefined) missing.push(field.column);
    else positions.set(field.column, pos);
  }
  return { positions, missing };
}

/**
 * Monta a linha na ordem das colunas da planilha. Colunas sem mapeamento
 * ficam como null para que a API não escreva nada nelas.
 */
export function buildRow(values, positions) {
  const width = Math.max(0, ...[...positions.values()].map((p) => p + 1));
  const row = new Array(width).fill(null);
  for (const [column, pos] of positions) {
    row[pos] = sanitizeCell(values?.[column]);
  }
  return row;
}

/** Retorna o valor do identificador único de um registro, se configurado. */
export function recordKey(record, uniqueKeyColumn) {
  if (!uniqueKeyColumn) return '';
  return normalizeKey(record?.values?.[uniqueKeyColumn]);
}

/**
 * Decide quais registros da fila serão adicionados. Registros cujo
 * identificador já existe na planilha (ou se repete no próprio lote) são
 * marcados como duplicados; registros sem identificador são sempre enviados.
 */
export function planAppend({ records, header, fields, uniqueKeyColumn, existingKeys }) {
  const { positions, missing } = resolveColumns(header, fields);
  const existing = new Set([...(existingKeys ?? [])].map(normalizeKey).filter(Boolean));
  const seen = new Set();

  const toAppend = [];
  const duplicates = [];
  const statuses = {};

  for (const record of records) {
    const key = recordKey(record, uniqueKeyColumn);
    if (key && (existing.has(key) || seen.has(key))) {
      duplicates.push(record);
      statuses[record.id] = existing.has(key) ? 'duplicate' : 'duplicate-batch';
      continue;
    }
    if (key) seen.add(key);
    toAppend.push({ record, row: buildRow(record.values, positions) });
    statuses[record.id] = key ? 'new' : 'no-key';
  }

  return { toAppend, duplicates, statuses, missingColumns: missing };
}

/**
 * Insere um registro recém-extraído na fila. Se já houver um registro com o
 * mesmo identificador, ele é substituído (mantendo o id) em vez de duplicado.
 */
export function mergeIntoQueue(queue, record, uniqueKeyColumn) {
  const key = recordKey(record, uniqueKeyColumn);
  if (key) {
    const idx = queue.findIndex((r) => recordKey(r, uniqueKeyColumn) === key);
    if (idx !== -1) {
      const next = [...queue];
      next[idx] = { ...record, id: queue[idx].id };
      return { queue: next, replaced: true };
    }
  }
  return { queue: [...queue, record], replaced: false };
}
