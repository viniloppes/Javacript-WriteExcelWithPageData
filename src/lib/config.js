// Configuração do usuário (chrome.storage.sync) e modelos de mapeamento.
// Nenhuma credencial é guardada aqui: apenas o Client ID OAuth, que é um
// identificador público do app, informado pelo próprio usuário.

export const SOURCES = {
  selector: 'Seletor CSS',
  url: 'URL da página',
  title: 'Título da página',
  constant: 'Valor fixo / manual',
  date: 'Data de hoje',
  datetime: 'Data e hora',
};

/**
 * Modelo para perfis do LinkedIn, alinhado à planilha "CRM - Linkedin outreach".
 * Os seletores são pontos de partida: o LinkedIn muda o HTML com frequência,
 * então todos podem ser ajustados nas opções (um seletor alternativo por linha).
 */
export const LINKEDIN_PRESET = {
  uniqueKeyColumn: 'Linkedin profile',
  fields: [
    {
      column: 'Company',
      source: 'selector',
      selector: [
        'button[aria-label^="Current company"] div',
        'button[aria-label^="Empresa atual"] div',
        'section:has(#experience) li:first-of-type .t-14.t-normal span[aria-hidden="true"]',
      ].join('\n'),
    },
    { column: 'Sector', source: 'constant', value: '' },
    {
      column: 'Country',
      source: 'selector',
      selector: ['main .text-body-small.inline.t-black--light.break-words', 'main .pv-text-details__left-panel .text-body-small'].join(
        '\n',
      ),
    },
    { column: 'Website', source: 'constant', value: '' },
    { column: 'Contact', source: 'selector', selector: 'main h1' },
    { column: 'Level', source: 'selector', selector: 'main .text-body-medium.break-words' },
    { column: 'Linkedin profile', source: 'url' },
    { column: 'Status', source: 'constant', value: '' },
    { column: 'Date', source: 'datetime' },
  ],
};

export const DEFAULT_CONFIG = {
  oauthClientId: '',
  spreadsheetId: '',
  sheetName: 'Sheet1',
  headerRow: 1,
  uniqueKeyColumn: LINKEDIN_PRESET.uniqueKeyColumn,
  fields: LINKEDIN_PRESET.fields,
};

export async function loadConfig() {
  const { config } = await chrome.storage.sync.get('config');
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}

export async function saveConfig(config) {
  await chrome.storage.sync.set({ config });
}

/** Retorna a lista de problemas que impedem o envio (vazia = configuração ok). */
export function validateConfig(config) {
  const problems = [];
  if (!config.oauthClientId?.trim()) problems.push('OAuth Client ID não configurado.');
  if (!config.spreadsheetId) problems.push('ID da planilha não configurado.');
  if (!config.sheetName?.trim()) problems.push('Nome da aba não configurado.');
  if (!Number.isInteger(config.headerRow) || config.headerRow < 1) problems.push('Linha de cabeçalho inválida.');
  if (!config.fields?.length) problems.push('Nenhum campo mapeado.');
  const columns = (config.fields ?? []).map((f) => f.column?.trim().toLowerCase());
  if (columns.some((c) => !c)) problems.push('Há campos sem nome de coluna.');
  if (new Set(columns).size !== columns.length) problems.push('Há colunas mapeadas mais de uma vez.');
  if (config.uniqueKeyColumn && !columns.includes(config.uniqueKeyColumn.trim().toLowerCase())) {
    problems.push('A coluna de identificador único não está entre os campos mapeados.');
  }
  return problems;
}

export const EXPORT_FORMAT = 'pagina-para-google-sheets/config';

/** Gera o conteúdo do arquivo de exportação (sem tokens: eles nunca ficam na configuração). */
export function exportConfig(config) {
  const { oauthClientId, spreadsheetId, sheetName, headerRow, uniqueKeyColumn, fields } = config;
  return JSON.stringify(
    { format: EXPORT_FORMAT, version: 1, config: { oauthClientId, spreadsheetId, sheetName, headerRow, uniqueKeyColumn, fields } },
    null,
    2,
  );
}

/**
 * Lê um arquivo exportado (ou o JSON da configuração colado diretamente) e
 * devolve uma configuração completa. Lança erro com mensagem amigável se o
 * conteúdo não for válido.
 */
export function parseImportedConfig(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('O conteúdo não é um JSON válido.');
  }
  const raw = data?.format === EXPORT_FORMAT ? data.config : data;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) {
    throw new Error('O arquivo não contém uma configuração desta extensão (lista "fields" ausente).');
  }

  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const fields = raw.fields
    .filter((f) => f && typeof f === 'object' && str(f.column))
    .map((f) => {
      const field = { column: str(f.column), source: Object.hasOwn(SOURCES, f.source) ? f.source : 'constant' };
      if (field.source === 'selector') {
        field.selector = typeof f.selector === 'string' ? f.selector : '';
        if (str(f.attribute)) field.attribute = str(f.attribute);
      }
      if (field.source === 'constant') field.value = typeof f.value === 'string' ? f.value : '';
      return field;
    });
  if (!fields.length) throw new Error('A configuração importada não tem nenhum campo.');

  const headerRow = Number.parseInt(raw.headerRow, 10);
  const uniqueKeyColumn = str(raw.uniqueKeyColumn);
  return {
    oauthClientId: str(raw.oauthClientId),
    spreadsheetId: /^[a-zA-Z0-9_-]{20,}$/.test(str(raw.spreadsheetId)) ? str(raw.spreadsheetId) : '',
    sheetName: str(raw.sheetName) || DEFAULT_CONFIG.sheetName,
    headerRow: headerRow >= 1 ? headerRow : DEFAULT_CONFIG.headerRow,
    uniqueKeyColumn: fields.some((f) => f.column === uniqueKeyColumn) ? uniqueKeyColumn : '',
    fields,
  };
}
