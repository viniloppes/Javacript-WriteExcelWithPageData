import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRow,
  columnLetter,
  mergeIntoQueue,
  normalizeKey,
  parseSpreadsheetId,
  planAppend,
  quoteSheetName,
  resolveColumns,
  sanitizeCell,
} from '../src/lib/mapping.js';

const HEADER = ['Company', 'Sector', 'Country', 'Website', 'Contact', 'Level', 'Linkedin profile', 'Status', 'Date'];
const FIELDS = [
  { column: 'Company' },
  { column: 'Contact' },
  { column: 'Linkedin profile' },
  { column: 'Date' },
];

test('parseSpreadsheetId aceita URL ou ID e rejeita lixo', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';
  assert.equal(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(parseSpreadsheetId(`  ${id} `), id);
  assert.equal(parseSpreadsheetId('não é um id'), null);
  assert.equal(parseSpreadsheetId(''), null);
});

test('columnLetter converte índices para notação A1', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(8), 'I');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(701), 'ZZ');
  assert.equal(columnLetter(702), 'AAA');
});

test('quoteSheetName escapa aspas simples', () => {
  assert.equal(quoteSheetName('Sheet1'), "'Sheet1'");
  assert.equal(quoteSheetName("John's leads"), "'John''s leads'");
});

test('normalizeKey trata variações da mesma URL como iguais', () => {
  const variants = [
    'https://www.linkedin.com/in/jane-doe/',
    'http://linkedin.com/in/jane-doe',
    'linkedin.com/in/Jane-Doe?utm_source=x#about',
    '=HYPERLINK("https://www.linkedin.com/in/jane-doe/"; "Jane")',
  ];
  for (const v of variants) assert.equal(normalizeKey(v), 'linkedin.com/in/jane-doe', v);
  assert.notEqual(normalizeKey('https://linkedin.com/in/john'), normalizeKey('https://linkedin.com/in/jane-doe'));
  assert.equal(normalizeKey('  ACME   Corp '), 'acme corp');
  assert.equal(normalizeKey(''), '');
  assert.equal(normalizeKey(undefined), '');
});

test('sanitizeCell impede que texto da página vire fórmula', () => {
  assert.equal(sanitizeCell('=IMPORTXML("http://evil")'), `'=IMPORTXML("http://evil")`);
  assert.equal(sanitizeCell('+55 11 9999'), `'+55 11 9999`);
  assert.equal(sanitizeCell('@handle'), `'@handle`);
  assert.equal(sanitizeCell('Acme'), 'Acme');
  assert.equal(sanitizeCell('2026-10-09'), '2026-10-09');
  assert.equal(sanitizeCell('   '), null);
  assert.equal(sanitizeCell(undefined), null);
});

test('resolveColumns localiza colunas ignorando maiúsculas e espaços', () => {
  const { positions, missing } = resolveColumns(HEADER, [{ column: 'linkedin  PROFILE' }, { column: 'Phone' }]);
  assert.equal(positions.get('linkedin  PROFILE'), 6);
  assert.deepEqual(missing, ['Phone']);
});

test('buildRow posiciona valores pelo cabeçalho e deixa o resto como null', () => {
  const { positions } = resolveColumns(HEADER, FIELDS);
  const row = buildRow({ Company: 'Acme', Contact: 'Jane', 'Linkedin profile': 'https://linkedin.com/in/jane', Date: '' }, positions);
  assert.deepEqual(row, ['Acme', null, null, null, 'Jane', null, 'https://linkedin.com/in/jane', null, null]);
});

test('planAppend ignora duplicados da planilha e do próprio lote', () => {
  const records = [
    { id: 'a', values: { Contact: 'Jane', 'Linkedin profile': 'https://www.linkedin.com/in/jane/' } },
    { id: 'b', values: { Contact: 'John', 'Linkedin profile': 'https://linkedin.com/in/john' } },
    { id: 'c', values: { Contact: 'John again', 'Linkedin profile': 'linkedin.com/in/john/' } },
    { id: 'd', values: { Contact: 'No key', 'Linkedin profile': '' } },
  ];
  const plan = planAppend({
    records,
    header: HEADER,
    fields: FIELDS,
    uniqueKeyColumn: 'Linkedin profile',
    existingKeys: ['https://linkedin.com/in/jane', ''],
  });
  assert.deepEqual(
    plan.toAppend.map((p) => p.record.id),
    ['b', 'd'],
  );
  assert.deepEqual(
    plan.duplicates.map((r) => r.id),
    ['a', 'c'],
  );
  assert.deepEqual(plan.statuses, { a: 'duplicate', b: 'new', c: 'duplicate-batch', d: 'no-key' });
  assert.deepEqual(plan.missingColumns, []);
});

test('planAppend sem identificador configurado envia tudo', () => {
  const records = [
    { id: 'a', values: { Contact: 'Jane' } },
    { id: 'b', values: { Contact: 'Jane' } },
  ];
  const plan = planAppend({ records, header: HEADER, fields: FIELDS, uniqueKeyColumn: '', existingKeys: [] });
  assert.equal(plan.toAppend.length, 2);
  assert.equal(plan.duplicates.length, 0);
});

test('mergeIntoQueue substitui registro com o mesmo identificador', () => {
  const first = { id: '1', values: { 'Linkedin profile': 'https://linkedin.com/in/jane', Contact: 'Jane' } };
  const again = { id: '2', values: { 'Linkedin profile': 'https://www.linkedin.com/in/jane/', Contact: 'Jane D.' } };
  const other = { id: '3', values: { 'Linkedin profile': 'https://linkedin.com/in/john', Contact: 'John' } };

  let { queue } = mergeIntoQueue([], first, 'Linkedin profile');
  const merged = mergeIntoQueue(queue, again, 'Linkedin profile');
  assert.equal(merged.replaced, true);
  assert.equal(merged.queue.length, 1);
  assert.equal(merged.queue[0].id, '1');
  assert.equal(merged.queue[0].values.Contact, 'Jane D.');

  ({ queue } = mergeIntoQueue(merged.queue, other, 'Linkedin profile'));
  assert.equal(queue.length, 2);
});
