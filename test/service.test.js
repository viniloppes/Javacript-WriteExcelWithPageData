import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LINKEDIN_PRESET } from '../src/lib/config.js';
import { createService } from '../src/lib/service.js';
import { SheetsError } from '../src/lib/sheets.js';

const HEADER = ['Company', 'Sector', 'Country', 'Website', 'Contact', 'Level', 'Linkedin profile', 'Status', 'Date'];

const CONFIG = {
  oauthClientId: 'client.apps.googleusercontent.com',
  spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  sheetName: 'CRM',
  headerRow: 1,
  uniqueKeyColumn: LINKEDIN_PRESET.uniqueKeyColumn,
  fields: LINKEDIN_PRESET.fields,
};

/** Planilha em memória que imita values.get/values.append com INSERT_ROWS. */
function fakeSheets(initialRows) {
  const rows = initialRows.map((r) => [...r]);
  return {
    rows,
    failNextAppend: null,
    async getHeader() {
      return [...rows[0]];
    },
    async getColumnValues(_id, _sheet, columnIndex, headerRow) {
      return rows.slice(headerRow).map((r) => r[columnIndex] ?? '');
    },
    async appendRows(_id, _sheet, newRows) {
      if (this.failNextAppend) {
        const err = this.failNextAppend;
        this.failNextAppend = null;
        throw err;
      }
      const start = rows.length + 1;
      for (const row of newRows) rows.push(row.map((v) => v ?? ''));
      return { updatedRows: newRows.length, updatedRange: `'CRM'!A${start}:I${rows.length}` };
    },
  };
}

function memoryStore() {
  const data = new Map();
  return {
    get: async (key) => structuredClone(data.get(key)),
    set: async (key, value) => void data.set(key, structuredClone(value)),
  };
}

/** Páginas "visitadas" no Chrome: tabId -> valores extraídos do DOM. */
const PAGES = {
  1: { Company: 'Acme', Contact: 'Jane Doe', Level: 'CTO', Country: 'Brazil', 'Linkedin profile': 'https://www.linkedin.com/in/jane-doe/', Date: '2026-10-09' },
  2: { Company: 'Globex', Contact: 'John Roe', Level: 'VP Sales', Country: 'UK', 'Linkedin profile': 'https://www.linkedin.com/in/john-roe/', Date: '2026-10-09' },
  3: { Company: 'Initech', Contact: 'Old Lead', 'Linkedin profile': 'https://linkedin.com/in/old-lead', Date: '2026-10-09' },
};

function setup() {
  const existing = [
    HEADER,
    ['Initech', 'Software', 'USA', '', 'Old Lead', 'CEO', 'https://www.linkedin.com/in/old-lead/', 'Replied', '2026-01-02'],
    ['Umbrella', 'Pharma', 'USA', '', 'Someone', 'CFO', '', 'Sent', '=TODAY()'],
  ];
  const sheets = fakeSheets(existing);
  let n = 0;
  const service = createService({
    store: memoryStore(),
    loadConfig: async () => CONFIG,
    sheets,
    newId: () => `r${++n}`,
    now: () => Date.UTC(2026, 9, 9),
    async extract(tabId, fields) {
      const values = Object.fromEntries(fields.map((f) => [f.column, PAGES[tabId][f.column] ?? '']));
      return { values, missing: [], pageUrl: PAGES[tabId]['Linkedin profile'] };
    },
  });
  return { service, sheets, existing };
}

test('fluxo completo: extrair, pré-visualizar, adicionar sem tocar nas linhas existentes', async () => {
  const { service, sheets, existing } = setup();
  const before = structuredClone(existing);

  await service.extract(1);
  await service.extract(2);
  await service.extract(3); // já existe na planilha

  const plan = await service.prepare();
  assert.deepEqual(plan.missingColumns, []);
  assert.deepEqual(plan.toAppendIds, ['r1', 'r2']);
  assert.deepEqual(plan.duplicateIds, ['r3']);
  // A prévia não grava nada.
  assert.equal(sheets.rows.length, 3);

  const result = await service.commit([...plan.toAppendIds, ...plan.duplicateIds]);
  assert.equal(result.updatedRows, 2);
  assert.equal(result.skippedDuplicates, 1);

  // Linhas anteriores (incluindo cabeçalho e fórmula) intactas.
  assert.deepEqual(sheets.rows.slice(0, 3), before);
  assert.deepEqual(sheets.rows[3], ['Acme', '', 'Brazil', '', 'Jane Doe', 'CTO', 'https://www.linkedin.com/in/jane-doe/', '', '2026-10-09']);
  assert.equal(sheets.rows[4][4], 'John Roe');

  const state = await service.getState();
  assert.deepEqual(state.queue, []);
  assert.equal(state.lastResult.updatedRows, 2);
});

test('executar a extração novamente não duplica registros já enviados', async () => {
  const { service, sheets } = setup();
  await service.extract(1);
  let plan = await service.prepare();
  await service.commit(plan.toAppendIds);
  assert.equal(sheets.rows.length, 4);

  // Mesmo perfil extraído de novo (e duas vezes seguidas na fila).
  await service.extract(1);
  const { replaced } = await service.extract(1);
  assert.equal(replaced, true);
  assert.equal((await service.getState()).queue.length, 1);

  plan = await service.prepare();
  assert.deepEqual(plan.toAppendIds, []);
  assert.equal(plan.duplicateIds.length, 1);
  const result = await service.commit([...plan.toAppendIds, ...plan.duplicateIds]);
  assert.equal(result.updatedRows, 0);
  assert.equal(sheets.rows.length, 4);
  assert.deepEqual((await service.getState()).queue, []);
});

test('linha adicionada por outra pessoa entre a prévia e a confirmação não é duplicada', async () => {
  const { service, sheets } = setup();
  await service.extract(2);
  const plan = await service.prepare();
  sheets.rows.push(['Globex', '', '', '', 'John Roe', '', 'linkedin.com/in/john-roe', '', '']);

  const result = await service.commit(plan.toAppendIds);
  assert.equal(result.updatedRows, 0);
  assert.equal(result.skippedDuplicates, 1);
  assert.equal(sheets.rows.length, 4);
});

test('falha de conexão ou autenticação mantém os dados na fila', async () => {
  const { service, sheets } = setup();
  await service.extract(1);
  await service.extract(2);
  const plan = await service.prepare();

  for (const kind of ['network', 'auth']) {
    sheets.failNextAppend = new SheetsError('falhou', { kind });
    await assert.rejects(service.commit(plan.toAppendIds), { kind });
    const { queue } = await service.getState();
    assert.equal(queue.length, 2);
    assert.equal(queue[0].values.Contact, 'Jane Doe');
    assert.equal(sheets.rows.length, 3);
  }

  const result = await service.commit(plan.toAppendIds);
  assert.equal(result.updatedRows, 2);
});

test('colunas mapeadas ausentes no cabeçalho bloqueiam o envio', async () => {
  const { service, sheets } = setup();
  sheets.rows[0] = HEADER.filter((h) => h !== 'Level');
  await service.extract(1);
  const plan = await service.prepare();
  assert.deepEqual(plan.missingColumns, ['Level']);
  await assert.rejects(service.commit(plan.toAppendIds), /Level/);
  assert.equal(sheets.rows.length, 3);
});

test('edição na prévia é enviada à planilha', async () => {
  const { service, sheets } = setup();
  await service.extract(1);
  await service.updateRecord('r1', 'Sector', 'Fintech');
  const plan = await service.prepare();
  await service.commit(plan.toAppendIds);
  assert.equal(sheets.rows[3][1], 'Fintech');
});

test('commit concorrente é bloqueado', async () => {
  const { service } = setup();
  await service.extract(1);
  const plan = await service.prepare();
  const [a, b] = await Promise.allSettled([service.commit(plan.toAppendIds), service.commit(plan.toAppendIds)]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason.kind, 'busy');
});

test('captura de seletores guarda a última varredura da página', async () => {
  const store = memoryStore();
  const candidates = [{ selector: '[id$="Topcard"] h2', attribute: '', text: 'Jane Doe', tag: 'h2', section: '', matches: 1 }];
  const service = createService({
    store,
    loadConfig: async () => CONFIG,
    sheets: fakeSheets([HEADER]),
    extract: async () => ({}),
    now: () => Date.UTC(2026, 9, 9),
    scan: async (tabId) => ({ url: `https://www.linkedin.com/in/tab-${tabId}/`, title: 'Jane', candidates: tabId === 1 ? candidates : [] }),
  });

  assert.deepEqual(await service.scan(1), { count: 1, url: 'https://www.linkedin.com/in/tab-1/' });
  const saved = await store.get('pageScan');
  assert.equal(saved.candidates[0].selector, '[id$="Topcard"] h2');
  assert.equal(saved.at, '2026-10-09T00:00:00.000Z');

  await assert.rejects(service.scan(2), { kind: 'extract' });
  assert.equal((await store.get('pageScan')).url, 'https://www.linkedin.com/in/tab-1/');
});
