// Cliente mínimo da Google Sheets API v4 (somente values.get e values.append).

import { columnLetter, quoteSheetName } from './mapping.js';

const BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

export class SheetsError extends Error {
  /**
   * @param {string} message mensagem para o usuário
   * @param {{kind: string, status?: number, detail?: string}} info
   *   kind: network | auth | permission | not_found | bad_request | rate_limit | server
   */
  constructor(message, { kind, status, detail } = {}) {
    super(message);
    this.name = 'SheetsError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

async function readErrorDetail(response) {
  try {
    const body = await response.json();
    return body?.error?.message ?? '';
  } catch {
    return '';
  }
}

export function isScopeError(detail) {
  return /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(detail);
}

// O Google responde 403 por motivos bem diferentes; a mensagem de erro
// distingue cada um para que o usuário saiba o que corrigir.
function classifyForbidden(detail) {
  const status = 403;
  const google = detail ? ` (Google: ${detail})` : '';
  if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(detail)) {
    return new SheetsError(
      `A Google Sheets API não está ativada no projeto do Google Cloud do seu Client ID. Ative-a em "APIs e serviços → Biblioteca", aguarde alguns minutos e tente de novo.${google}`,
      { kind: 'config', status, detail },
    );
  }
  if (isScopeError(detail)) {
    return new SheetsError(
      `A permissão de acesso às planilhas não foi concedida no login do Google. Tente de novo e marque a permissão na tela de consentimento.${google}`,
      { kind: 'auth', status, detail },
    );
  }
  return new SheetsError(
    `A conta Google escolhida no login não tem acesso de edição a esta planilha. Use "Sair da conta Google" nas configurações e entre com a conta dona da planilha (ou compartilhe a planilha como Editor com a conta usada).${google}`,
    { kind: 'permission', status, detail },
  );
}

function classify(status, detail) {
  if (status === 401) {
    return new SheetsError('Autenticação expirada ou recusada. Faça login novamente.', { kind: 'auth', status, detail });
  }
  if (status === 403) return classifyForbidden(detail);
  if (status === 404) {
    return new SheetsError('Planilha não encontrada. Confira o ID configurado.', { kind: 'not_found', status, detail });
  }
  if (status === 400 && /unable to parse range/i.test(detail)) {
    return new SheetsError('Aba não encontrada na planilha. Confira o nome da aba configurado.', {
      kind: 'not_found',
      status,
      detail,
    });
  }
  if (status === 400 && /not supported for this document/i.test(detail)) {
    return new SheetsError(
      'O arquivo é um Excel (.xlsx) guardado no Drive, não uma planilha Google. Abra-o e use "Arquivo → Salvar como Planilhas Google", depois configure o ID da nova planilha.',
      { kind: 'config', status, detail },
    );
  }
  if (status === 429) {
    return new SheetsError('Limite de requisições da API atingido. Tente novamente em instantes.', {
      kind: 'rate_limit',
      status,
      detail,
    });
  }
  if (status >= 500) {
    return new SheetsError('O Google Sheets está indisponível no momento. Tente novamente.', { kind: 'server', status, detail });
  }
  return new SheetsError(`Erro da Google Sheets API (${status}): ${detail || 'requisição inválida'}`, {
    kind: 'bad_request',
    status,
    detail,
  });
}

/**
 * @param {object} deps
 * @param {{getToken: (opts: {interactive: boolean}) => Promise<string>, invalidateToken: (token: string) => Promise<void>}} deps.auth
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createSheetsClient({ auth, fetchImpl = (...args) => fetch(...args), sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const MAX_RETRIES = 2;

  async function request(url, { method = 'GET', body } = {}) {
    // Requisições de escrita não são repetidas após falha de rede ou erro 5xx:
    // o servidor pode ter gravado os dados e uma nova tentativa duplicaria linhas.
    const idempotent = method === 'GET';
    let token = await auth.getToken({ interactive: true });
    let reauthenticated = false;

    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (idempotent && attempt < MAX_RETRIES) {
          await wait(500 * 2 ** attempt);
          continue;
        }
        throw new SheetsError('Falha de conexão com o Google Sheets. Verifique sua internet.', {
          kind: 'network',
          detail: String(err?.message ?? err),
        });
      }

      if (response.ok) return response.json();

      const detail = await readErrorDetail(response);
      if (response.status === 401 && !reauthenticated) {
        reauthenticated = true;
        await auth.invalidateToken(token);
        token = await auth.getToken({ interactive: true });
        continue;
      }
      // Token sem o escopo: descarta para que a próxima tentativa peça consentimento de novo.
      if (response.status === 403 && isScopeError(detail)) await auth.invalidateToken(token);
      const retriable = response.status === 429 || (idempotent && response.status >= 500);
      if (retriable && attempt < MAX_RETRIES) {
        await wait(1000 * 2 ** attempt);
        continue;
      }
      throw classify(response.status, detail);
    }
  }

  function valuesUrl(spreadsheetId, range, suffix = '') {
    return `${BASE_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
  }

  return {
    /** Lê a linha de cabeçalho da aba. */
    async getHeader(spreadsheetId, sheetName, headerRow = 1) {
      const range = `${quoteSheetName(sheetName)}!${headerRow}:${headerRow}`;
      const data = await request(valuesUrl(spreadsheetId, range));
      return (data.values?.[0] ?? []).map((v) => String(v ?? ''));
    },

    /**
     * Lê todos os valores de uma coluna abaixo do cabeçalho. Usa
     * valueRenderOption=FORMULA para enxergar a URL dentro de =HYPERLINK().
     */
    async getColumnValues(spreadsheetId, sheetName, columnIndex, headerRow = 1) {
      const letter = columnLetter(columnIndex);
      const range = `${quoteSheetName(sheetName)}!${letter}${headerRow + 1}:${letter}`;
      const data = await request(valuesUrl(spreadsheetId, range, '?valueRenderOption=FORMULA'));
      return (data.values ?? []).map((row) => String(row?.[0] ?? ''));
    },

    /**
     * Adiciona linhas após os dados existentes com spreadsheets.values.append.
     * INSERT_ROWS faz a API inserir linhas novas em vez de sobrescrever
     * células, preservando cabeçalhos, fórmulas e dados já presentes.
     */
    async appendRows(spreadsheetId, sheetName, rows, headerRow = 1) {
      const width = Math.max(1, ...rows.map((r) => r.length));
      const range = `${quoteSheetName(sheetName)}!A${headerRow}:${columnLetter(width - 1)}${headerRow}`;
      const query = '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&includeValuesInResponse=false';
      const data = await request(valuesUrl(spreadsheetId, range, `:append${query}`), {
        method: 'POST',
        body: { majorDimension: 'ROWS', values: rows },
      });
      return {
        updatedRows: data.updates?.updatedRows ?? 0,
        updatedRange: data.updates?.updatedRange ?? '',
        tableRange: data.tableRange ?? '',
      };
    },
  };
}
