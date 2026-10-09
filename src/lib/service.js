// Regras de negócio da extensão: fila de registros extraídos, verificação de
// duplicados e envio à planilha. As dependências do Chrome são injetadas para
// que o fluxo completo possa ser testado em Node.

import { mergeIntoQueue, planAppend, resolveColumns } from './mapping.js';
import { validateConfig } from './config.js';
import { SheetsError } from './sheets.js';

/**
 * @param {object} deps
 * @param {{get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>}} deps.store
 *   armazenamento local persistente (fila e último resultado)
 * @param {() => Promise<object>} deps.loadConfig
 * @param {ReturnType<import('./sheets.js').createSheetsClient>} deps.sheets
 * @param {(tabId: number, fields: object[]) => Promise<object>} deps.extract
 * @param {() => string} [deps.newId]
 * @param {() => number} [deps.now]
 */
export function createService({ store, loadConfig, sheets, extract, newId = () => crypto.randomUUID(), now = () => Date.now() }) {
  let busy = false;

  const getQueue = async () => (await store.get('queue')) ?? [];
  const setQueue = (queue) => store.set('queue', queue);

  async function requireConfig() {
    const config = await loadConfig();
    const problems = validateConfig(config);
    if (problems.length) throw new SheetsError(problems.join(' '), { kind: 'config' });
    return config;
  }

  async function readSheetState(config) {
    const header = await sheets.getHeader(config.spreadsheetId, config.sheetName, config.headerRow);
    if (!header.some((h) => h.trim())) {
      throw new SheetsError(`A linha ${config.headerRow} da aba "${config.sheetName}" não tem cabeçalhos.`, {
        kind: 'config',
      });
    }
    let existingKeys = [];
    if (config.uniqueKeyColumn) {
      const keyField = [{ column: config.uniqueKeyColumn }];
      const { positions } = resolveColumns(header, keyField);
      const keyIndex = positions.get(config.uniqueKeyColumn);
      if (keyIndex !== undefined) {
        existingKeys = await sheets.getColumnValues(config.spreadsheetId, config.sheetName, keyIndex, config.headerRow);
      }
    }
    return { header, existingKeys };
  }

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

    /** Lê os campos configurados na aba e adiciona o registro à fila local. */
    async extract(tabId) {
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
        values: result.values,
      };
      const { queue, replaced } = mergeIntoQueue(await getQueue(), record, config.uniqueKeyColumn);
      await setQueue(queue);
      return { record, replaced, missing: result.missing };
    },

    async updateRecord(id, column, value) {
      const queue = await getQueue();
      await setQueue(queue.map((r) => (r.id === id ? { ...r, values: { ...r.values, [column]: value } } : r)));
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

      const { header, existingKeys } = await readSheetState(config);
      const plan = planAppend({ records: queue, header, fields: config.fields, uniqueKeyColumn: config.uniqueKeyColumn, existingKeys });
      await store.set('statuses', plan.statuses);
      return {
        spreadsheetId: config.spreadsheetId,
        sheetName: config.sheetName,
        missingColumns: plan.missingColumns,
        toAppendIds: plan.toAppend.map((p) => p.record.id),
        duplicateIds: plan.duplicates.map((r) => r.id),
        statuses: plan.statuses,
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

        const { header, existingKeys } = await readSheetState(config);
        const plan = planAppend({ records, header, fields: config.fields, uniqueKeyColumn: config.uniqueKeyColumn, existingKeys });
        if (plan.missingColumns.length) {
          throw new SheetsError(`Colunas não encontradas no cabeçalho da planilha: ${plan.missingColumns.join(', ')}.`, {
            kind: 'config',
          });
        }

        let appended = { updatedRows: 0, updatedRange: '' };
        if (plan.toAppend.length) {
          appended = await sheets.appendRows(
            config.spreadsheetId,
            config.sheetName,
            plan.toAppend.map((p) => p.row),
            config.headerRow,
          );
        }

        const done = new Set([...plan.toAppend.map((p) => p.record.id), ...plan.duplicates.map((r) => r.id)]);
        await setQueue((await getQueue()).filter((r) => !done.has(r.id)));
        const statuses = (await store.get('statuses')) ?? {};
        for (const id of done) delete statuses[id];
        await store.set('statuses', statuses);

        const result = {
          at: new Date(now()).toISOString(),
          updatedRows: appended.updatedRows,
          updatedRange: appended.updatedRange,
          skippedDuplicates: plan.duplicates.length,
          sheetName: config.sheetName,
        };
        await store.set('lastResult', result);
        return result;
      });
    },

    /** Lê o cabeçalho com a configuração informada (ainda não salva) nas opções. */
    async loadHeaders({ spreadsheetId, sheetName, headerRow }) {
      return sheets.getHeader(spreadsheetId, sheetName, headerRow);
    },
  };
}
