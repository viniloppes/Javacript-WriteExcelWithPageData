// Service worker: liga o serviço às APIs do Chrome e atende mensagens do
// popup e da página de opções. O envio roda aqui para continuar mesmo que o
// popup seja fechado no meio da operação.

import { createAuth } from './lib/auth.js';
import { loadConfig } from './lib/config.js';
import { extractFromPage } from './lib/extractor.js';
import { scanPage } from './lib/scanner.js';
import { createService } from './lib/service.js';
import { createSheetsClient } from './lib/sheets.js';

const auth = createAuth(async () => (await loadConfig()).oauthClientId);
const sheets = createSheetsClient({ auth });

async function runInTab(tabId, func, args = []) {
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch (err) {
    throw new Error(`Não foi possível ler esta página (${err.message}). Páginas internas do navegador não são suportadas.`);
  }
  if (!injection?.result) throw new Error('A leitura da página não retornou dados.');
  return injection.result;
}

const service = createService({
  store: {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  },
  loadConfig,
  sheets,
  extract: (tabId, fields) => runInTab(tabId, extractFromPage, [fields]),
  scan: (tabId) => runInTab(tabId, scanPage, [{}]),
});

const handlers = {
  getState: () => service.getState(),
  extract: ({ tabId }) => service.extract(tabId),
  scan: ({ tabId }) => service.scan(tabId),
  updateRecord: ({ id, column, value }) => service.updateRecord(id, column, value),
  removeRecord: ({ id }) => service.removeRecord(id),
  clearQueue: () => service.clearQueue(),
  prepare: () => service.prepare(),
  commit: ({ recordIds }) => service.commit(recordIds),
  loadHeaders: (params) => service.loadHeaders(params),
  signOut: () => auth.signOut(),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: { message: err.message, kind: err.kind ?? 'unknown' } }),
    );
  return true; // resposta assíncrona
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
