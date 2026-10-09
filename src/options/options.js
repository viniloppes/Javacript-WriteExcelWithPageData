import { LINKEDIN_PRESET, SOURCES, loadConfig, saveConfig, validateConfig } from '../lib/config.js';
import { normalizeHeader, parseSpreadsheetId } from '../lib/mapping.js';
import { call } from '../lib/messaging.js';

const $ = (id) => document.getElementById(id);
let fields = [];
let uniqueKeyColumn = '';

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').className = isError ? 'error' : '';
}

function renderUniqueKey() {
  const select = $('unique-key');
  const none = new Option('(nenhum — não verificar duplicados)', '');
  const options = fields.filter((f) => f.column.trim()).map((f) => new Option(f.column, f.column));
  select.replaceChildren(none, ...options);
  select.value = fields.some((f) => f.column === uniqueKeyColumn) ? uniqueKeyColumn : '';
}

function renderFields() {
  const rows = fields.map((field, index) => {
    const tr = document.createElement('tr');

    const columnInput = document.createElement('input');
    columnInput.value = field.column;
    columnInput.setAttribute('aria-label', 'Coluna na planilha');
    columnInput.addEventListener('change', () => {
      const wasKey = uniqueKeyColumn === field.column;
      field.column = columnInput.value.trim();
      if (wasKey) uniqueKeyColumn = field.column;
      renderUniqueKey();
    });

    const sourceSelect = document.createElement('select');
    sourceSelect.setAttribute('aria-label', 'Origem');
    for (const [value, label] of Object.entries(SOURCES)) sourceSelect.add(new Option(label, value));
    sourceSelect.value = field.source;
    sourceSelect.addEventListener('change', () => {
      field.source = sourceSelect.value;
      renderFields();
    });

    let valueControl;
    if (field.source === 'selector') {
      valueControl = document.createElement('textarea');
      valueControl.rows = Math.max(2, String(field.selector ?? '').split('\n').length);
      valueControl.value = field.selector ?? '';
      valueControl.placeholder = 'main h1';
      valueControl.spellcheck = false;
      valueControl.addEventListener('change', () => (field.selector = valueControl.value));
    } else if (field.source === 'constant') {
      valueControl = document.createElement('input');
      valueControl.value = field.value ?? '';
      valueControl.placeholder = 'Valor padrão (editável na prévia)';
      valueControl.addEventListener('change', () => (field.value = valueControl.value));
    } else {
      valueControl = document.createElement('span');
      valueControl.className = 'hint';
      valueControl.textContent = 'Preenchido automaticamente';
    }

    const attributeInput = document.createElement('input');
    attributeInput.value = field.attribute ?? '';
    attributeInput.placeholder = 'texto';
    attributeInput.disabled = field.source !== 'selector';
    attributeInput.setAttribute('aria-label', 'Atributo');
    attributeInput.addEventListener('change', () => (field.attribute = attributeInput.value.trim()));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remover';
    remove.addEventListener('click', () => {
      fields.splice(index, 1);
      renderFields();
    });

    for (const control of [columnInput, sourceSelect, valueControl, attributeInput, remove]) {
      const td = document.createElement('td');
      td.append(control);
      tr.append(td);
    }
    return tr;
  });
  $('fields').tBodies[0].replaceChildren(...rows);
  renderUniqueKey();
}

function readForm() {
  const spreadsheetInput = $('spreadsheet').value.trim();
  const spreadsheetId = spreadsheetInput ? parseSpreadsheetId(spreadsheetInput) : '';
  if (spreadsheetId === null) throw new Error('URL ou ID da planilha inválido.');
  uniqueKeyColumn = $('unique-key').value;
  return {
    oauthClientId: $('client-id').value.trim(),
    spreadsheetId,
    sheetName: $('sheet-name').value.trim(),
    headerRow: Number.parseInt($('header-row').value, 10),
    uniqueKeyColumn,
    fields: fields.map((f) => ({ ...f, column: f.column.trim() })),
  };
}

function fillForm(config) {
  $('client-id').value = config.oauthClientId;
  $('spreadsheet').value = config.spreadsheetId;
  $('sheet-name').value = config.sheetName;
  $('header-row').value = config.headerRow;
  fields = structuredClone(config.fields);
  uniqueKeyColumn = config.uniqueKeyColumn;
  renderFields();
}

async function save() {
  const config = readForm();
  await saveConfig(config);
  const problems = validateConfig(config);
  if (problems.length) setStatus(`Salvo, mas ainda falta: ${problems.join(' ')}`, true);
  else setStatus('Configurações salvas.');
  return config;
}

$('redirect-uri').textContent = chrome.identity.getRedirectURL();

$('copy-redirect').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('redirect-uri').textContent);
  setStatus('URI de redirecionamento copiado.');
});

$('save').addEventListener('click', () => save().catch((err) => setStatus(err.message, true)));

$('add-field').addEventListener('click', () => {
  fields.push({ column: '', source: 'selector', selector: '' });
  renderFields();
});

$('apply-linkedin').addEventListener('click', () => {
  fields = structuredClone(LINKEDIN_PRESET.fields);
  uniqueKeyColumn = LINKEDIN_PRESET.uniqueKeyColumn;
  renderFields();
  setStatus('Modelo LinkedIn aplicado. Clique em Salvar para manter.');
});

$('load-headers').addEventListener('click', async () => {
  try {
    const config = await save();
    if (!config.oauthClientId || !config.spreadsheetId || !config.sheetName) {
      throw new Error('Informe o Client ID, a planilha e a aba antes de carregar as colunas.');
    }
    setStatus('Lendo cabeçalhos da planilha…');
    const header = await call('loadHeaders', {
      spreadsheetId: config.spreadsheetId,
      sheetName: config.sheetName,
      headerRow: config.headerRow,
    });
    const columns = header.map((h) => h.trim()).filter(Boolean);
    if (!columns.length) throw new Error(`A linha ${config.headerRow} da aba "${config.sheetName}" está vazia.`);

    const existing = new Map(fields.map((f) => [normalizeHeader(f.column), f]));
    fields = columns.map((column) => {
      const current = existing.get(normalizeHeader(column));
      return current ? { ...current, column } : { column, source: 'constant', value: '' };
    });
    renderFields();
    await save();
    setStatus(`Conexão OK. ${columns.length} colunas carregadas e salvas: ${columns.join(', ')}.`);
  } catch (err) {
    setStatus(err.message, true);
  }
});

$('sign-out').addEventListener('click', async () => {
  try {
    await call('signOut');
    setStatus('Acesso revogado e token removido.');
  } catch (err) {
    setStatus(err.message, true);
  }
});

loadConfig().then(fillForm);
