// OAuth 2.0 com o Google via chrome.identity.launchWebAuthFlow.
//
// - O Client ID é informado pelo usuário na página de opções; nada fica no código.
// - Escopo único: spreadsheets (ler cabeçalho/identificadores e adicionar linhas).
// - O access token fica apenas em chrome.storage.session (memória, apagado ao
//   fechar o navegador) e nunca é gravado em disco ou sincronizado.

import { SheetsError } from './sheets.js';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const TOKEN_KEY = 'oauthToken';

export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

async function readCachedToken() {
  const { [TOKEN_KEY]: cached } = await chrome.storage.session.get(TOKEN_KEY);
  if (cached?.accessToken && cached.expiresAt - Date.now() > 60_000) return cached.accessToken;
  return null;
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function launchFlow(clientId, interactive) {
  const state = randomState();
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', getRedirectUri());
  url.searchParams.set('scope', SHEETS_SCOPE);
  url.searchParams.set('state', state);

  const redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  const params = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (params.get('error')) throw new Error(params.get('error'));
  if (params.get('state') !== state) throw new Error('state inválido na resposta OAuth');
  const accessToken = params.get('access_token');
  if (!accessToken) throw new Error('resposta OAuth sem access_token');

  const expiresIn = Number(params.get('expires_in') ?? 3600);
  await chrome.storage.session.set({
    [TOKEN_KEY]: { accessToken, expiresAt: Date.now() + expiresIn * 1000 },
  });
  return accessToken;
}

/**
 * Cria o provedor de token usado pelo cliente da Sheets API.
 * @param {() => Promise<string>} getClientId
 */
export function createAuth(getClientId) {
  return {
    async getToken({ interactive = true } = {}) {
      const cached = await readCachedToken();
      if (cached) return cached;

      const clientId = (await getClientId())?.trim();
      if (!clientId) {
        throw new SheetsError('Configure o OAuth Client ID na página de opções.', { kind: 'auth' });
      }
      try {
        // Primeiro tenta sem interface (consentimento já concedido).
        return await launchFlow(clientId, false);
      } catch (silentError) {
        if (!interactive) throw new SheetsError('Login necessário.', { kind: 'auth', detail: String(silentError) });
      }
      try {
        return await launchFlow(clientId, true);
      } catch (err) {
        throw new SheetsError('Não foi possível autenticar com o Google. Tente novamente.', {
          kind: 'auth',
          detail: String(err?.message ?? err),
        });
      }
    },

    async invalidateToken() {
      await chrome.storage.session.remove(TOKEN_KEY);
    },

    /** Revoga o token atual no Google e o remove da sessão. */
    async signOut() {
      const token = await readCachedToken();
      await chrome.storage.session.remove(TOKEN_KEY);
      if (token) {
        try {
          await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' });
        } catch {
          // Sem conexão: o token expira sozinho em até 1 hora.
        }
      }
    },
  };
}
