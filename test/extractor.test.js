import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractFromPage } from '../src/lib/extractor.js';

test('data e data e hora usam o horário local no formato reconhecido pelo Sheets', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 9, 8, 5, 42) });
  globalThis.location = { origin: 'https://www.linkedin.com', pathname: '/in/jane/', href: 'https://www.linkedin.com/in/jane/?x=1' };
  globalThis.document = { title: 'Jane | LinkedIn', querySelector: () => null };
  try {
    const { values } = extractFromPage([
      { column: 'Date', source: 'date' },
      { column: 'When', source: 'datetime' },
      { column: 'Profile', source: 'url' },
    ]);
    assert.deepEqual(values, { Date: '2026-10-09', When: '2026-10-09 08:05', Profile: 'https://www.linkedin.com/in/jane/' });
  } finally {
    delete globalThis.location;
    delete globalThis.document;
  }
});
