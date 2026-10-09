// Função injetada na página com chrome.scripting.executeScript. Ela é
// serializada pelo Chrome, então precisa ser autocontida: não pode usar
// imports nem variáveis de fora do próprio corpo.

/**
 * Lê os campos configurados no DOM da página atual.
 * @param {Array<{column: string, source: string, selector?: string, attribute?: string, value?: string}>} fields
 * @returns {{values: Record<string, string>, missing: string[], pageUrl: string, pageTitle: string}}
 */
export function extractFromPage(fields) {
  const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

  const readElement = (el, attribute) => {
    if (!attribute) return el.innerText || el.textContent;
    // href/src como propriedade retornam a URL absoluta.
    if ((attribute === 'href' || attribute === 'src') && typeof el[attribute] === 'string') return el[attribute];
    return el.getAttribute(attribute);
  };

  const today = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const values = {};
  const missing = [];

  for (const field of fields) {
    let value = '';
    switch (field.source) {
      case 'url':
        value = location.origin + location.pathname;
        break;
      case 'title':
        value = document.title;
        break;
      case 'constant':
        value = field.value ?? '';
        break;
      case 'date':
        value = today();
        break;
      case 'selector': {
        // Um seletor por linha: o primeiro que retornar texto é usado.
        const selectors = String(field.selector ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const selector of selectors) {
          let el = null;
          try {
            el = document.querySelector(selector);
          } catch {
            continue; // seletor inválido
          }
          value = el ? clean(readElement(el, field.attribute?.trim())) : '';
          if (value) break;
        }
        if (!value) missing.push(field.column);
        break;
      }
      default:
        value = '';
    }
    values[field.column] = clean(value);
  }

  return { values, missing, pageUrl: location.href, pageTitle: document.title };
}
