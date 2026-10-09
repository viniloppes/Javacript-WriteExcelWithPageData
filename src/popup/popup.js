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
  for (const id of ['extract', 'clear', 'append', 'confirm-send']) $(id).disabled = busy;
  if (!busy) updateButtons();
}

function updateButtons() {
  const hasQueue = state.queue.length > 0;
  $('append').disabled = !hasQueue || state.problems.length > 0 || state.busy;
  $('clear').disabled = !hasQueue;
}

function renderTarget() {
  const { spreadsheetId, sheetName } = state.config;
  const target = $('target');
  target.replaceChildren();
  if (!spreadsheetId) return;
  target.append('Destino: aba ');
  const strong = document.createElement('strong');
  strong.textContent = sheetName;
  target.append(strong, ' da ');
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
  for (const label of ['Status', ...columns, '']) {
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

$('extract').addEventListener('click', () =>
  run(async () => {
    hideConfirm();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Nenhuma aba ativa encontrada.');
    const { replaced, missing } = await call('extract', { tabId: tab.id });
    let text = replaced ? 'Registro já estava na fila e foi atualizado.' : 'Registro adicionado à fila.';
    if (missing.length) text += ` Campos não encontrados na página: ${missing.join(', ')}.`;
    showMessage(text, missing.length ? 'warning' : 'success');
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
    parts.push(
      adds
        ? `${adds} ${adds === 1 ? 'linha será adicionada' : 'linhas serão adicionadas'} ao final da aba "${plan.sheetName}".`
        : 'Nenhuma linha nova para adicionar.',
    );
    if (dups) parts.push(`${dups} ${dups === 1 ? 'registro já existe' : 'registros já existem'} e será ignorado (e removido da fila).`);
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
    let text = `${rows} ${rows === 1 ? 'linha adicionada' : 'linhas adicionadas'} à aba "${result.sheetName}"`;
    text += result.updatedRange ? ` (${result.updatedRange}).` : '.';
    if (result.skippedDuplicates) text += ` ${result.skippedDuplicates} duplicado(s) ignorado(s).`;
    showMessage(text, 'success');
  }),
);

refresh().catch((err) => showMessage(err.message, 'error'));
