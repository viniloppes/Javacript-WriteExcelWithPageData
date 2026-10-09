import { call } from '../lib/messaging.js';

const STATUS_LABELS = {
  new: 'Novo',
  'no-key': 'Sem identificador',
  duplicate: 'Já na planilha',
  'duplicate-batch': 'Repetido na fila',
};

const $ = (id) => document.getElementById(id);
let state = null;
let plan = null;

function showMessage(text, kind = 'info') {
  const el = $('message');
  el.textContent = text;
  el.className = `notice ${kind}`;
  el.hidden = !text;
}

function hideConfirm() {
  plan = null;
  $('confirm').hidden = true;
}

function setBusy(busy) {
  for (const id of ['extract', 'scan', 'clear', 'append', 'confirm-send']) $(id).disabled = busy;
  if (!busy) updateButtons();
}

function updateButtons() {
  const hasQueue = state.queue.length > 0;
  $('append').disabled = !hasQueue || state.problems.length > 0 || state.busy;
  $('clear').disabled = !hasQueue;
}

const multipleSheets = () => state.config.sheetNames.length > 1;

function sheetSelect(selected, onChange) {
  const select = document.createElement('select');
  for (const name of state.config.sheetNames) select.add(new Option(name, name));
  select.value = state.config.sheetNames.includes(selected) ? selected : state.config.sheetNames[0];
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

async function loadCurrentSheet() {
  try {
    const { currentSheet } = await chrome.storage.local.get('currentSheet');
    return currentSheet;
  } catch {
    return undefined;
  }
}

async function renderSheetPicker() {
  $('sheet-picker').hidden = !multipleSheets();
  if (!multipleSheets()) return;
  const current = await loadCurrentSheet();
  const select = sheetSelect(current, (value) => chrome.storage.local.set({ currentSheet: value }));
  select.id = 'current-sheet';
  $('current-sheet').replaceWith(select);
}

function renderTarget() {
  const { spreadsheetId, sheetNames } = state.config;
  const target = $('target');
  target.replaceChildren();
  if (!spreadsheetId) return;
  target.append(sheetNames.length > 1 ? 'Destino: abas ' : 'Destino: aba ');
  sheetNames.forEach((name, i) => {
    const strong = document.createElement('strong');
    strong.textContent = name;
    target.append(...(i ? [', ', strong] : [strong]));
  });
  target.append(' da ');
  const link = document.createElement('a');
  link.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'planilha configurada';
  target.append(link);
}

function renderProblems() {
  const el = $('problems');
  el.hidden = state.problems.length === 0;
  el.textContent = state.problems.length ? `Configuração incompleta: ${state.problems.join(' ')}` : '';
}

function renderTable() {
  const { queue, statuses, config } = state;
  const columns = config.fields.map((f) => f.column);
  $('count').textContent = queue.length ? `(${queue.length} na fila)` : '';
  $('empty').hidden = queue.length > 0;
  $('preview').hidden = queue.length === 0;

  const headRow = document.createElement('tr');
  for (const label of ['Status', ...(multipleSheets() ? ['Aba'] : []), ...columns, '']) {
    const th = document.createElement('th');
    th.textContent = label;
    if (label === config.uniqueKeyColumn) th.title = 'Identificador único';
    headRow.append(th);
  }
  $('preview').tHead.replaceChildren(headRow);

  const rows = queue.map((record) => {
    const tr = document.createElement('tr');

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    const status = statuses[record.id];
    badge.className = `badge ${status ?? ''}`;
    badge.textContent = STATUS_LABELS[status] ?? 'Não verificado';
    statusCell.append(badge);
    tr.append(statusCell);

    if (multipleSheets()) {
      const sheetCell = document.createElement('td');
      sheetCell.append(
        sheetSelect(record.sheetName, async (value) => {
          hideConfirm();
          await call('setRecordSheet', { id: record.id, sheetName: value });
          await refresh();
        }),
      );
      tr.append(sheetCell);
    }

    for (const column of columns) {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.value = record.values[column] ?? '';
      input.title = input.value;
      input.addEventListener('change', async () => {
        hideConfirm();
        await call('updateRecord', { id: record.id, column, value: input.value });
        record.values[column] = input.value;
        input.title = input.value;
      });
      td.append(input);
      tr.append(td);
    }

    const actions = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remover';
    remove.addEventListener('click', async () => {
      hideConfirm();
      await call('removeRecord', { id: record.id });
      await refresh();
    });
    actions.append(remove);
    tr.append(actions);
    return tr;
  });
  $('preview').tBodies[0].replaceChildren(...rows);
}

async function refresh() {
  state = await call('getState');
  renderTarget();
  await renderSheetPicker();
  renderProblems();
  renderTable();
  updateButtons();
}

async function run(action) {
  setBusy(true);
  try {
    await action();
  } catch (err) {
    const keep = state?.queue.length ? ' Os dados extraídos continuam salvos na fila.' : '';
    showMessage(`${err.message}${keep}`, 'error');
  } finally {
    await refresh().catch(() => {});
    setBusy(false);
  }
}

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Nenhuma aba ativa encontrada.');
  return tab.id;
}

$('extract').addEventListener('click', () =>
  run(async () => {
    hideConfirm();
    const tabId = await activeTabId();
    const sheetName = multipleSheets() ? $('current-sheet').value : undefined;
    const { replaced, missing, record } = await call('extract', { tabId, sheetName });
    let text = replaced ? 'Registro já estava na fila e foi atualizado' : 'Registro adicionado à fila';
    text += multipleSheets() ? ` (aba "${record.sheetName}").` : '.';
    if (missing.length) text += ` Campos não encontrados na página: ${missing.join(', ')}.`;
    showMessage(text, missing.length ? 'warning' : 'success');
  }),
);

$('scan').addEventListener('click', () =>
  run(async () => {
    showMessage('Capturando seletores da página…');
    const { count } = await call('scan', { tabId: await activeTabId() });
    showMessage(
      `${count} seletores capturados. Em Configurações, clique em 🔍 ao lado de um campo para escolher o seletor.`,
      'success',
    );
  }),
);

$('clear').addEventListener('click', () =>
  run(async () => {
    hideConfirm();
    await call('clearQueue');
    showMessage('');
  }),
);

$('append').addEventListener('click', () =>
  run(async () => {
    showMessage('Verificando a planilha…');
    plan = await call('prepare');
    if (plan.missingColumns.length) {
      const missing = plan.missingColumns.join(', ');
      plan = null;
      throw new Error(`Colunas não encontradas no cabeçalho da planilha: ${missing}. Ajuste o mapeamento nas configurações.`);
    }
    showMessage('');
    const adds = plan.toAppendIds.length;
    const dups = plan.duplicateIds.length;
    const parts = [];
    const lines = (n) => `${n} ${n === 1 ? 'linha' : 'linhas'}`;
    if (!adds) parts.push('Nenhuma linha nova para adicionar.');
    else if (plan.sheets.length === 1) {
      parts.push(`${lines(adds)} ${adds === 1 ? 'será adicionada' : 'serão adicionadas'} ao final da aba "${plan.sheets[0].sheetName}".`);
    } else {
      const perSheet = plan.sheets.filter((s) => s.adds).map((s) => `${lines(s.adds)} na aba "${s.sheetName}"`);
      parts.push(`Serão adicionadas ao final de cada aba: ${perSheet.join(', ')}.`);
    }
    if (dups) parts.push(`${dups} ${dups === 1 ? 'registro já existe' : 'registros já existem'} na aba de destino e será ignorado (e removido da fila).`);
    parts.push('Confira a prévia acima antes de confirmar.');
    $('confirm-text').textContent = parts.join(' ');
    $('confirm-send').textContent = adds ? 'Confirmar envio' : 'Remover duplicados da fila';
    $('confirm').hidden = false;
  }),
);

$('confirm-cancel').addEventListener('click', hideConfirm);

$('confirm-send').addEventListener('click', () =>
  run(async () => {
    if (!plan) return;
    const recordIds = [...plan.toAppendIds, ...plan.duplicateIds];
    hideConfirm();
    showMessage('Enviando…');
    const result = await call('commit', { recordIds });
    const rows = result.updatedRows;
    const detail = result.sheets
      .filter((s) => s.updatedRows)
      .map((s) => `${s.updatedRows} em "${s.sheetName}"${s.updatedRange ? ` (${s.updatedRange})` : ''}`)
      .join(', ');
    let text = `${rows} ${rows === 1 ? 'linha adicionada' : 'linhas adicionadas'}${detail ? `: ${detail}` : ''}.`;
    if (result.skippedDuplicates) text += ` ${result.skippedDuplicates} duplicado(s) ignorado(s).`;
    showMessage(text, 'success');
  }),
);

refresh().catch((err) => showMessage(err.message, 'error'));
