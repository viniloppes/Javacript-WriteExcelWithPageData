import {
  LINKEDIN_PRESET,
  SOURCES,
  exportConfig,
  loadConfig,
  normalizeSheets,
  parseImportedConfig,
  saveConfig,
  validateConfig,
} from '../lib/config.js';
import { normalizeHeader, parseSpreadsheetId, resolveColumns } from '../lib/mapping.js';
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

    const valueCell = document.createElement('div');
    valueCell.className = 'value-cell';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'pick';
    pick.textContent = '🔍';
    pick.title = 'Escolher entre os seletores capturados da página';
    pick.setAttribute('aria-label', `Escolher seletor para ${field.column || 'este campo'}`);
    pick.addEventListener('click', () => openPicker(field));
    valueCell.append(valueControl, pick);

    for (const control of [columnInput, sourceSelect, valueCell, attributeInput, remove]) {
      const td = document.createElement('td');
      td.append(control);
      tr.append(td);
    }
    return tr;
  });
  $('fields').tBodies[0].replaceChildren(...rows);
  renderUniqueKey();
}

// --- Escolha de seletor a partir da captura feita no popup -------------------

let pickerField = null;

async function loadScan() {
  const { pageScan } = await chrome.storage.local.get('pageScan');
  return pageScan ?? null;
}

function applyCandidate(candidate, mode) {
  const field = pickerField;
  if (mode === 'append' && field.source === 'selector' && field.selector?.trim()) {
    const lines = field.selector.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.includes(candidate.selector)) lines.push(candidate.selector);
    field.selector = lines.join('\n');
  } else {
    field.selector = candidate.selector;
    field.attribute = candidate.attribute;
  }
  field.source = 'selector';
  $('picker').close();
  renderFields();
  setStatus(`Seletor aplicado em "${field.column}". Clique em Salvar para manter.`);
}

function renderPickerRows(scan) {
  const filter = $('picker-filter').value.trim().toLowerCase();
  const rows = scan.candidates.filter(
    (c) => !filter || `${c.text} ${c.section} ${c.selector}`.toLowerCase().includes(filter),
  );
  $('picker-empty').hidden = rows.length > 0;
  $('picker-empty').textContent = 'Nenhum seletor corresponde ao filtro.';

  $('picker-rows').replaceChildren(
    ...rows.slice(0, 300).map((candidate) => {
      const tr = document.createElement('tr');
      if (candidate.matches > 1) tr.className = 'warn';

      const section = document.createElement('td');
      section.textContent = candidate.section;
      const text = document.createElement('td');
      text.textContent = candidate.text;
      const selector = document.createElement('td');
      const code = document.createElement('code');
      code.textContent = candidate.attribute ? `${candidate.selector}  @${candidate.attribute}` : candidate.selector;
      selector.append(code);
      const matches = document.createElement('td');
      matches.textContent = candidate.matches;
      matches.title =
        candidate.matches > 1
          ? 'O seletor encontra mais de um elemento; a extração usa o primeiro, que é este.'
          : 'O seletor encontra só este elemento.';

      const actions = document.createElement('td');
      const use = document.createElement('button');
      use.type = 'button';
      use.textContent = 'Usar';
      use.title = 'Substitui o seletor do campo';
      use.addEventListener('click', () => applyCandidate(candidate, 'replace'));
      const append = document.createElement('button');
      append.type = 'button';
      append.textContent = '+ Alternativa';
      append.title = 'Adiciona como linha extra (usada se as anteriores não acharem nada)';
      append.addEventListener('click', () => applyCandidate(candidate, 'append'));
      actions.append(use, ' ', append);

      tr.append(section, text, selector, matches, actions);
      return tr;
    }),
  );
}

async function openPicker(field) {
  pickerField = field;
  const scan = await loadScan();
  $('picker-title').textContent = `Escolher seletor para "${field.column || 'campo'}"`;
  $('picker-filter').value = '';
  if (!scan) {
    $('picker-source').textContent = '';
    $('picker-rows').replaceChildren();
    $('picker-filter').hidden = true;
    $('picker-empty').hidden = false;
    $('picker-empty').textContent =
      'Nenhuma captura ainda. Abra a página desejada (ex.: um perfil do LinkedIn), clique no ícone da extensão e em "Capturar seletores". Depois volte aqui.';
  } else {
    $('picker-filter').hidden = false;
    const at = new Date(scan.at).toLocaleString();
    $('picker-source').textContent = `Capturado de ${scan.title || scan.url} em ${at} · ${scan.candidates.length} seletores. Prefira seletores sem :nth-of-type, que resistem melhor a mudanças no site.`;
    $('picker-filter').oninput = () => renderPickerRows(scan);
    renderPickerRows(scan);
  }
  $('picker').showModal();
  $('picker-filter').focus();
}

function readForm() {
  const spreadsheetInput = $('spreadsheet').value.trim();
  const spreadsheetId = spreadsheetInput ? parseSpreadsheetId(spreadsheetInput) : '';
  if (spreadsheetId === null) throw new Error('URL ou ID da planilha inválido.');
  uniqueKeyColumn = $('unique-key').value;
  return normalizeSheets({
    oauthClientId: $('client-id').value.trim(),
    spreadsheetId,
    sheetNames: $('sheet-names').value.split('\n'),
    headerRow: Number.parseInt($('header-row').value, 10),
    uniqueKeyColumn,
    fields: fields.map((f) => ({ ...f, column: f.column.trim() })),
  });
}

function fillForm(config) {
  $('client-id').value = config.oauthClientId;
  $('spreadsheet').value = config.spreadsheetId;
  $('sheet-names').value = config.sheetNames.join('\n');
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

    // As demais abas precisam ter as colunas mapeadas (em qualquer ordem).
    const warnings = [];
    for (const sheetName of config.sheetNames.slice(1)) {
      try {
        const other = await call('loadHeaders', { spreadsheetId: config.spreadsheetId, sheetName, headerRow: config.headerRow });
        const { missing } = resolveColumns(other, fields);
        if (missing.length) warnings.push(`aba "${sheetName}" sem as colunas ${missing.join(', ')}`);
      } catch (err) {
        warnings.push(`aba "${sheetName}": ${err.message}`);
      }
    }
    const loaded = `${columns.length} colunas carregadas da aba "${config.sheetName}" e salvas: ${columns.join(', ')}.`;
    if (warnings.length) setStatus(`${loaded} Atenção: ${warnings.join('; ')}.`, true);
    else setStatus(`Conexão OK. ${loaded}${config.sheetNames.length > 1 ? ' As outras abas têm as mesmas colunas.' : ''}`);
  } catch (err) {
    setStatus(err.message, true);
  }
});

$('export').addEventListener('click', () => {
  try {
    const blob = new Blob([exportConfig(readForm())], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'pagina-para-google-sheets-config.json';
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus('Arquivo de configurações exportado.');
  } catch (err) {
    setStatus(err.message, true);
  }
});

$('open-import').addEventListener('click', () => {
  $('import-text').value = '';
  $('import-file').value = '';
  $('import-error').textContent = '';
  $('import-dialog').showModal();
});

$('import-file').addEventListener('change', async () => {
  const [file] = $('import-file').files;
  if (file) $('import-text').value = await file.text();
});

$('import').addEventListener('click', async () => {
  try {
    const config = parseImportedConfig($('import-text').value);
    await saveConfig(config);
    fillForm(config);
    $('import-dialog').close();
    const problems = validateConfig(config);
    setStatus(
      problems.length
        ? `Configurações importadas e salvas. Ainda falta: ${problems.join(' ')}`
        : 'Configurações importadas e salvas.',
      problems.length > 0,
    );
  } catch (err) {
    $('import-error').textContent = err.message;
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
