// Envia uma mensagem ao service worker e converte a resposta em Promise.
export async function call(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('Sem resposta do serviço da extensão.');
  if (!response.ok) {
    const error = new Error(response.error.message);
    error.kind = response.error.kind;
    throw error;
  }
  return response.data;
}
