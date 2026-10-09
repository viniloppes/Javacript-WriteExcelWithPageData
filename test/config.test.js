import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, exportConfig, normalizeSheets, parseImportedConfig, resolveSheet } from '../src/lib/config.js';

const CONFIG = {
  ...DEFAULT_CONFIG,
  oauthClientId: '123-abc.apps.googleusercontent.com',
  spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  sheetName: 'CRM',
  fields: [
    { column: 'Contact', source: 'selector', selector: '[id$="Topcard"] h2\nmain h1' },
    { column: 'Website', source: 'selector', selector: '[id$="Topcard"] a:nth-of-type(2)', attribute: 'href' },
    { column: 'Linkedin profile', source: 'url' },
    { column: 'Status', source: 'constant', value: 'To contact' },
  ],
};

test('exportar e importar preserva a configuração', () => {
  const text = exportConfig(CONFIG);
  assert.match(text, /"format": "pagina-para-google-sheets\/config"/);
  const imported = parseImportedConfig(text);
  assert.deepEqual(imported, {
    oauthClientId: CONFIG.oauthClientId,
    spreadsheetId: CONFIG.spreadsheetId,
    sheetName: 'CRM',
    sheetNames: ['CRM'],
    headerRow: 1,
    uniqueKeyColumn: 'Linkedin profile',
    fields: CONFIG.fields,
  });
});

test('importar aceita o JSON da configuração colado diretamente', () => {
  assert.equal(parseImportedConfig(JSON.stringify(CONFIG)).sheetName, 'CRM');
});

test('importar descarta valores inválidos e campos estranhos', () => {
  const imported = parseImportedConfig(
    JSON.stringify({
      spreadsheetId: 'curto',
      headerRow: -3,
      uniqueKeyColumn: 'Inexistente',
      fields: [{ column: 'A', source: 'hack', extra: 1 }, { column: '' }, null, { column: 'B', source: 'date' }],
      accessToken: 'nao-deve-entrar',
    }),
  );
  assert.deepEqual(imported.fields, [{ column: 'A', source: 'constant', value: '' }, { column: 'B', source: 'date' }]);
  assert.equal(imported.spreadsheetId, '');
  assert.equal(imported.headerRow, 1);
  assert.equal(imported.uniqueKeyColumn, '');
  assert.equal('accessToken' in imported, false);
});

test('importar rejeita conteúdo que não é configuração', () => {
  assert.throws(() => parseImportedConfig('não é json'), /JSON válido/);
  assert.throws(() => parseImportedConfig('{"a":1}'), /fields/);
  assert.throws(() => parseImportedConfig('{"fields":[]}'), /nenhum campo/);
});

test('várias abas: lista normalizada, a primeira é a padrão', () => {
  const config = normalizeSheets({ sheetName: 'antiga', sheetNames: [' Clientes ', 'Parceiros', 'clientes', ''] });
  assert.deepEqual(config.sheetNames, ['Clientes', 'Parceiros']);
  assert.equal(config.sheetName, 'Clientes');
  assert.equal(resolveSheet(config, 'parceiros'), 'Parceiros');
  assert.equal(resolveSheet(config, 'Removida'), 'Clientes');
  assert.equal(resolveSheet(config, undefined), 'Clientes');
});

test('configuração antiga com uma só aba continua funcionando', () => {
  assert.deepEqual(normalizeSheets({ sheetName: 'CRM' }).sheetNames, ['CRM']);
  const imported = parseImportedConfig(JSON.stringify({ sheetName: 'CRM', fields: [{ column: 'A', source: 'url' }] }));
  assert.deepEqual(imported.sheetNames, ['CRM']);
});

test('exportar e importar preserva várias abas', () => {
  const imported = parseImportedConfig(exportConfig({ ...CONFIG, sheetNames: ['Clientes', 'Parceiros'] }));
  assert.deepEqual(imported.sheetNames, ['Clientes', 'Parceiros']);
  assert.equal(imported.sheetName, 'Clientes');
});
