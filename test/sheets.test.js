import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSheetsClient } from '../src/lib/sheets.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

function fakeAuth() {
  let n = 0;
  return {
    invalidated: 0,
    async getToken() {
      n += 1;
      return `token-${n}`;
    },
    async invalidateToken() {
      this.invalidated += 1;
    },
  };
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function client(responses, auth = fakeAuth()) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { sheets: createSheetsClient({ auth, fetchImpl, sleep: async () => {} }), calls, auth };
}

test('appendRows usa values.append com INSERT_ROWS e USER_ENTERED', async () => {
  const { sheets, calls } = client([json(200, { tableRange: "'CRM'!A1:I3", updates: { updatedRows: 2, updatedRange: "'CRM'!A4:I5" } })]);
  const result = await sheets.appendRows(ID, 'CRM', [['a', null, 'c'], ['d']], 1);

  assert.deepEqual(result, { updatedRows: 2, updatedRange: "'CRM'!A4:I5", tableRange: "'CRM'!A1:I3" });
  const url = new URL(calls[0].url);
  assert.equal(decodeURIComponent(url.pathname), `/v4/spreadsheets/${ID}/values/'CRM'!A1:C1:append`);
  assert.equal(url.searchParams.get('insertDataOption'), 'INSERT_ROWS');
  assert.equal(url.searchParams.get('valueInputOption'), 'USER_ENTERED');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { majorDimension: 'ROWS', values: [['a', null, 'c'], ['d']] });
});

test('getColumnValues lê a coluna abaixo do cabeçalho com fórmulas', async () => {
  const { sheets, calls } = client([json(200, { values: [['x'], [], ['y']] })]);
  const values = await sheets.getColumnValues(ID, "John's", 6, 2);
  assert.deepEqual(values, ['x', '', 'y']);
  const url = new URL(calls[0].url);
  assert.equal(decodeURIComponent(url.pathname), `/v4/spreadsheets/${ID}/values/'John''s'!G3:G`);
  assert.equal(url.searchParams.get('valueRenderOption'), 'FORMULA');
});

test('401 renova o token uma vez e repete a requisição', async () => {
  const { sheets, calls, auth } = client([json(401, { error: { message: 'expired' } }), json(200, { values: [['Company']] })]);
  assert.deepEqual(await sheets.getHeader(ID, 'CRM'), ['Company']);
  assert.equal(auth.invalidated, 1);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer token-2');
});

test('401 persistente vira erro de autenticação', async () => {
  const { sheets } = client([json(401, {}), json(401, {})]);
  await assert.rejects(sheets.getHeader(ID, 'CRM'), { kind: 'auth' });
});

test('falha de rede no append não é repetida (evita linhas duplicadas)', async () => {
  const { sheets, calls } = client([new TypeError('Failed to fetch'), json(200, {})]);
  await assert.rejects(sheets.appendRows(ID, 'CRM', [['a']]), { kind: 'network' });
  assert.equal(calls.length, 1);
});

test('falha de rede em leitura é repetida', async () => {
  const { sheets, calls } = client([new TypeError('Failed to fetch'), json(200, { values: [['Company']] })]);
  assert.deepEqual(await sheets.getHeader(ID, 'CRM'), ['Company']);
  assert.equal(calls.length, 2);
});

test('erros da API são classificados', async () => {
  const cases = [
    [json(400, { error: { message: 'Unable to parse range: Nope!1:1' } }), 'not_found'],
    [json(403, { error: { message: 'The caller does not have permission' } }), 'permission'],
    [json(404, { error: { message: 'Requested entity was not found.' } }), 'not_found'],
  ];
  for (const [response, kind] of cases) {
    const { sheets } = client([response]);
    await assert.rejects(sheets.getHeader(ID, 'Nope'), { kind });
  }
});
