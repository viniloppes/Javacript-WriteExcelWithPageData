// Regras de negócio da extensão: fila de registros extraídos, verificação de
// duplicados e envio à planilha. As dependências do Chrome são injetadas para
// que o fluxo completo possa ser testado em Node.

import { mergeIntoQueue, planAppend, resolveColumns } from './mapping.js';
import { normalizeSheets, resolveSheet, validateConfig } from './config.js';
import { SheetsError } from './sheets.js';

/**
 * @param {object} deps
 * @param {{get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>}} deps.store
 *   armazenamento local persistente (fila e último resultado)
 * @param {() => Promise<object>} deps.loadConfig
 * @param {ReturnType<import('./sheets.js').createSheetsClient>} deps.sheets
 * @param {(tabId: number, fields: object[]) => Promise<object>} deps.extract
 * @param {(tabId: number) => Promise<{url: string, title: string, candidates: object[]}>} [deps.scan]
 * @param {() => string} [deps.newId]
 * @param {() => number} [deps.now]
 */
export function createService({ store, loadConfig: loadRawConfig, sheets, extract, scan, newId = () => crypto.randomUUID(), now = () => Date.now() }) {
  let busy = false;
  const loadConfig = async () => normalizeSheets(await loadRawConfig());

  const getQueue = async () => (await store.get('queue')) ?? [];
  const setQueue = (queue) => store.set('queue', queue);

  async function requireConfig() {
    const config = await loadConfig();
    const problems = validateConfig(config);
    if (problems.length) throw new SheetsError(problems.join(' '), { kind: 'config' });
    return config;
  }

  async function readSheetState(config, sheetName) {
    const header = await sheets.getHeader(config.spreadsheetId, sheetName, config.headerRow);
    if (!header.some((h) => h.trim())) {
      throw new SheetsError(`A linha ${config.headerRow} da aba "${sheetName}" não tem cabeçalhos.`, {
        kind: 'config',
      });
    }
    let existingKeys = [];
    if (config.uniqueKeyColumn) {
      const keyField = [{ column: config.uniqueKeyColumn }];
      const { positions } = resolveColumns(header, keyField);
      const keyIndex = positions.get(config.uniqueKeyColumn);
      if (keyIndex !== undefined) {
        existingKeys = await sheets.getColumnValues(config.spreadsheetId, sheetName, keyIndex, config.headerRow);
      }
    }
    return { header, existingKeys };
  }

  /**
   * Agrupa os registros pela aba de destino e monta um plano por aba. Cada aba
   * tem seu próprio cabeçalho (a ordem das colunas pode variar) e a checagem
   * de duplicados é feita na aba de destino de cada registro.
   */
  async function planBySheet(config, records) {
    const groups = new Map();
    for (const record of records) {
      const sheetName = resolveSheet(config, record.sheetName);
      if (!groups.has(sheetName)) groups.set(sheetName, []);
      groups.get(sheetName).push(record);
    }
    const plans = [];
    for (const [sheetName, group] of groups) {
      const { header, existingKeys } = await readSheetState(config, sheetName);
      const plan = planAppend({ records: group, header, fields: config.fields, uniqueKeyColumn: config.uniqueKeyColumn, existingKeys });
      plans.push({ sheetName, ...plan });
    }
    return plans;
  }

  const missingColumns = (plans) =>
    plans.flatMap((p) => p.missingColumns.map((column) => `${column} (aba "${p.sheetName}")`));

  async function withLock(fn) {
    if (busy) throw new SheetsError('Já existe um envio em andamento.', { kind: 'busy' });
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }

  return {
    async getState() {
      const config = await loadConfig();
      return {
        config,
        problems: validateConfig(config),
        queue: await getQueue(),
        statuses: (await store.get('statuses')) ?? {},
        lastResult: (await store.get('lastResult')) ?? null,
        busy,
      };
    },

    /**
     * Lê os campos configurados na aba do navegador e adiciona o registro à
     * fila local, destinado à aba da planilha escolhida (ou à padrão).
     */
    async extract(tabId, sheetName) {
      const config = await loadConfig();
      if (!config.fields?.length) throw new SheetsError('Nenhum campo mapeado nas opções.', { kind: 'config' });
      const result = await extract(tabId, config.fields);
      if (!Object.values(result.values).some((v) => String(v).trim())) {
        throw new SheetsError('Nenhum campo configurado foi encontrado nesta página.', { kind: 'extract' });
      }
      const record = {
        id: newId(),
        extractedAt: new Date(now()).toISOString(),
        pageUrl: result.pageUrl,
        sheetName: resolveSheet(config, sheetName),
        values: result.values,
      };
      const { queue, replaced } = mergeIntoQueue(await getQueue(), record, config.uniqueKeyColumn);
      await setQueue(queue);
      return { record, replaced, missing: result.missing };
    },

    /**
     * Captura seletores candidatos da página para a escolha de seletores nas
     * configurações. Guarda apenas a captura mais recente.
     */
    async scan(tabId) {
      const result = await scan(tabId);
      if (!result.candidates.length) {
        throw new SheetsError('Nenhum texto visível encontrado nesta página.', { kind: 'extract' });
      }
      await store.set('pageScan', { ...result, at: new Date(now()).toISOString() });
      return { count: result.candidates.length, url: result.url };
    },

    async updateRecord(id, column, value) {
      const queue = await getQueue();
      await setQueue(queue.map((r) => (r.id === id ? { ...r, values: { ...r.values, [column]: value } } : r)));
    },

    async setRecordSheet(id, sheetName) {
      const config = await loadConfig();
      const queue = await getQueue();
      await setQueue(queue.map((r) => (r.id === id ? { ...r, sheetName: resolveSheet(config, sheetName) } : r)));
    },

    async removeRecord(id) {
      await setQueue((await getQueue()).filter((r) => r.id !== id));
    },

    async clearQueue() {
      await setQueue([]);
      await store.set('statuses', {});
    },

    /**
     * Consulta a planilha (cabeçalho e identificadores existentes) e devolve a
     * prévia do que será enviado. Não grava nada na planilha.
     */
    async prepare() {
      const config = await requireConfig();
      const queue = await getQueue();
      if (!queue.length) throw new SheetsError('Nenhum registro na fila. Extraia dados de uma página primeiro.', { kind: 'empty' });

      const plans = await planBySheet(config, queue);
      const statuses = Object.assign({}, ...plans.map((p) => p.statuses));
      await store.set('statuses', statuses);
      return {
        spreadsheetId: config.spreadsheetId,
        missingColumns: missingColumns(plans),
        toAppendIds: plans.flatMap((p) => p.toAppend.map((item) => item.record.id)),
        duplicateIds: plans.flatMap((p) => p.duplicates.map((r) => r.id)),
        sheets: plans.map((p) => ({ sheetName: p.sheetName, adds: p.toAppend.length, duplicates: p.duplicates.length })),
        statuses,
      };
    },

    /**
     * Envia os registros confirmados pelo usuário. Os identificadores são lidos
     * novamente logo antes do append para não duplicar linhas adicionadas
     * entre a prévia e a confirmação. Registros só saem da fila após sucesso.
     */
    async commit(recordIds) {
      return withLock(async () => {
        const config = await requireConfig();
        const confirmed = new Set(recordIds);
        const records = (await getQueue()).filter((r) => confirmed.has(r.id));
        if (!records.length) throw new SheetsError('Nenhum registro confirmado para envio.', { kind: 'empty' });

        // Todas as abas são verificadas antes de qualquer gravação.
        const plans = await planBySheet(config, records);
        const missing = missingColumns(plans);
        if (missing.length) {
          throw new SheetsError(`Colunas não encontradas no cabeçalho da planilha: ${missing.join(', ')}.`, { kind: 'config' });
        }

        const done = new Set();
        const perSheet = [];
        const finish = async () => {
          await setQueue((await getQueue()).filter((r) => !done.has(r.id)));
          const statuses = (await store.get('statuses')) ?? {};
          for (const id of done) delete statuses[id];
          await store.set('statuses', statuses);
          const result = {
            at: new Date(now()).toISOString(),
            updatedRows: perSheet.reduce((sum, s) => sum + s.updatedRows, 0),
            skippedDuplicates: perSheet.reduce((sum, s) => sum + s.skippedDuplicates, 0),
            sheets: perSheet,
          };
          await store.set('lastResult', result);
          return result;
        };

        for (const plan of plans) {
          let appended = { updatedRows: 0, updatedRange: '' };
          if (plan.toAppend.length) {
            try {
              appended = await sheets.appendRows(
                config.spreadsheetId,
                plan.sheetName,
                plan.toAppend.map((p) => p.row),
                config.headerRow,
              );
            } catch (err) {
              // Abas já gravadas saem da fila; esta e as seguintes continuam nela.
              const partial = await finish();
              if (partial.updatedRows) {
                const sent = partial.sheets.map((s) => `${s.updatedRows} em "${s.sheetName}"`).join(', ');
                err.message = `Linhas já adicionadas: ${sent}. Falha na aba "${plan.sheetName}": ${err.message}`;
              }
              throw err;
            }
          }
          for (const item of plan.toAppend) done.add(item.record.id);
          for (const record of plan.duplicates) done.add(record.id);
          perSheet.push({
            sheetName: plan.sheetName,
            updatedRows: appended.updatedRows,
            updatedRange: appended.updatedRange,
            skippedDuplicates: plan.duplicates.length,
          });
        }
        return finish();
      });
    },

    /** Lê o cabeçalho com a configuração informada (ainda não salva) nas opções. */
    async loadHeaders({ spreadsheetId, sheetName, headerRow }) {
      return sheets.getHeader(spreadsheetId, sheetName, headerRow);
    },
  };
}
