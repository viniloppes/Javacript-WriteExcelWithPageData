// Função injetada na página com chrome.scripting.executeScript para capturar
// seletores CSS candidatos de todos os textos visíveis. Assim como o
// extractor, precisa ser autocontida (o Chrome serializa só o corpo dela).
//
// Os seletores evitam classes geradas automaticamente (ex.: "fmbkzy") e se
// apoiam em âncoras estáveis: id/componentkey/data-testid (usando só a parte
// fixa do valor), aria-label, padrão do href, classes legíveis e tags. Cada
// seletor é validado: document.querySelector(seletor) precisa retornar o
// próprio elemento, que é exatamente como a extração usa o seletor.

/**
 * @returns {{url: string, title: string, candidates: Array<{selector: string, attribute: string, text: string, tag: string, section: string, matches: number}>}}
 */
export function scanPage({ maxCandidates = 600, maxText = 160 } = {}) {
  const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'TITLE', 'OPTION', 'HEAD']);
  const LANDMARKS = new Set(['main', 'aside', 'header', 'nav', 'footer', 'article']);

  // Trecho "aleatório": longo e misturando letras e números (IDs internos, hashes).
  const isRandomToken = (token) => token.length >= 12 && /\d/.test(token) && /[a-z]/i.test(token);
  const isUuidLike = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v);

  /** Seletor de atributo usando só a parte estável do valor (ou null). */
  function stableAttr(name, value) {
    if (!value || value.length > 200 || isUuidLike(value)) return null;
    const tokens = value.split(/[.:/\s]+/);
    if (!tokens.some(isRandomToken)) return `[${name}=${quote(value)}]`;
    // Ex.: "com.linkedin...refACoAAB…2ULQATopcard" -> [componentkey$="Topcard"]
    const suffix = value.match(/[A-Z][a-z]{3,}$/) ?? value.match(/[-_.:][A-Za-z]{4,}$/);
    return suffix ? `[${name}$=${quote(suffix[0])}]` : null;
  }

  function ariaLabelSelector(el) {
    const label = el.getAttribute('aria-label');
    if (!label) return null;
    const tag = el.tagName.toLowerCase();
    // "Current company: Red Marketing…" -> prefixo antes de ":" (o resto muda por perfil).
    const prefix = label.split(':')[0].trim();
    if (label.includes(':') && prefix.length >= 4) return `${tag}[aria-label^=${quote(prefix)}]`;
    if (label.length <= 40 && !/\d/.test(label)) return `${tag}[aria-label=${quote(label)}]`;
    return null;
  }

  function hrefSelector(el) {
    if (el.tagName !== 'A' || !el.getAttribute('href')) return null;
    try {
      const url = new URL(el.href);
      const segment = url.pathname.split('/')[1];
      if (/^https?:$/.test(url.protocol) && /^[a-z-]{2,20}$/.test(segment)) return `a[href*=${quote(`/${segment}/`)}]`;
    } catch {
      // href inválido
    }
    return null;
  }

  function stableClasses(el) {
    return [...el.classList].filter(
      (c) => /[-_]/.test(c) && !/^(css|sc|jsx|emotion)-/.test(c) && !c.split(/[-_]/).some(isRandomToken) && c.length <= 40,
    );
  }

  /** Seletores que identificam o próprio elemento, do mais genérico ao mais específico. */
  function ownParts(el) {
    const tag = el.tagName.toLowerCase();
    const parts = [];
    const add = (p) => p && !parts.includes(p) && parts.push(p);
    add(hrefSelector(el));
    add(ariaLabelSelector(el));
    for (const name of ['data-testid', 'id', 'componentkey']) {
      const attr = stableAttr(name, el.getAttribute(name));
      if (attr) add(`${tag}${attr}`);
    }
    const classes = stableClasses(el);
    if (classes.length) add(`${tag}.${classes.map((c) => CSS.escape(c)).join('.')}`);
    add(tag);
    const sameTag = el.parentElement ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName) : [];
    if (sameTag.length > 1) add(`${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`);
    return parts;
  }

  /** Âncoras estáveis entre os ancestrais (a mais próxima primeiro). */
  function ancestorAnchors(el) {
    const anchors = [];
    for (let node = el.parentElement; node && node !== document.documentElement && anchors.length < 8; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      for (const name of ['data-testid', 'id', 'componentkey']) {
        const attr = stableAttr(name, node.getAttribute(name));
        if (attr) anchors.push(attr);
      }
      const aria = ariaLabelSelector(node);
      if (aria) anchors.push(aria);
      const href = hrefSelector(node);
      if (href) anchors.push(href);
      const classes = stableClasses(node);
      if (classes.length) anchors.push(`${tag}.${classes.map((c) => CSS.escape(c)).join('.')}`);
      if (LANDMARKS.has(tag)) anchors.push(tag);
    }
    anchors.push(''); // documento inteiro
    return [...new Set(anchors)];
  }

  const matchesFirst = (selector, el) => {
    try {
      return document.querySelector(selector) === el;
    } catch {
      return false;
    }
  };

  /** Até dois seletores válidos para o elemento, preferindo os sem :nth-of-type. */
  function selectorsFor(el) {
    const found = [];
    const parts = ownParts(el);
    const anchors = ancestorAnchors(el);
    for (const part of parts) {
      for (const anchor of anchors) {
        const selector = anchor ? `${anchor} ${part}` : part;
        if (!found.includes(selector) && matchesFirst(selector, el)) {
          found.push(selector);
          break; // próxima variação do elemento
        }
      }
      if (found.length >= 2) break;
    }
    if (!found.length) {
      // Último recurso: caminho estrutural (filho a filho) a partir do ancestral
      // mais próximo que tenha uma âncora estável.
      const path = [];
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const parent = node.parentElement;
        const siblings = parent ? [...parent.children].filter((c) => c.tagName === node.tagName) : [];
        const tag = node.tagName.toLowerCase();
        path.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
        const anchors = parent ? ancestorAnchors(node).filter((a) => a && parent.matches(a)) : [];
        const selector = `${anchors[0] ?? 'body'} > ${path.join(' > ')}`;
        if ((anchors.length || parent === document.body) && matchesFirst(selector, el)) {
          found.push(selector);
          break;
        }
      }
    }
    const score = (s) => (s.match(/:nth-of-type/g) ?? []).length * 100 + s.length;
    return found.sort((a, b) => score(a) - score(b));
  }

  function sectionLabel(el) {
    const section = el.closest('section, article, [role="region"]');
    if (!section) return '';
    const heading = section.querySelector('h1, h2, h3');
    return clean(heading?.innerText || section.getAttribute('aria-label')).slice(0, 40);
  }

  const visible = (el) => el.getClientRects().length > 0;
  const candidates = [];
  const seen = new Set();
  const push = (el, selector, attribute, text) => {
    const key = `${selector}|${attribute}`;
    if (seen.has(key) || candidates.length >= maxCandidates) return;
    seen.add(key);
    let matches = 0;
    try {
      matches = document.querySelectorAll(selector).length;
    } catch {
      return;
    }
    candidates.push({ selector, attribute, text, tag: el.tagName.toLowerCase(), section: sectionLabel(el), matches });
  };

  // 1. Elementos com texto próprio visível (h2, p, span, a…).
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => (SKIP.has(node.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let el = walker.nextNode(); el && candidates.length < maxCandidates; el = walker.nextNode()) {
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!hasOwnText || !visible(el)) continue;
    const text = clean(el.innerText);
    if (!text || text.length > maxText) continue;
    for (const selector of selectorsFor(el)) push(el, selector, '', text);
  }

  // 2. Links externos (ex.: coluna Website), lidos pelo atributo href.
  for (const a of document.querySelectorAll('a[href^="http"]')) {
    if (candidates.length >= maxCandidates) break;
    if (!visible(a) || a.origin === location.origin) continue;
    const [selector] = selectorsFor(a);
    if (selector) push(a, selector, 'href', a.href);
  }

  // 3. Metadados da página (og:title, description…), lidos pelo atributo content.
  for (const meta of document.querySelectorAll('meta[property^="og:"][content], meta[name="description"][content]')) {
    const name = meta.hasAttribute('property') ? 'property' : 'name';
    push(meta, `meta[${name}=${quote(meta.getAttribute(name))}]`, 'content', clean(meta.content).slice(0, maxText));
  }

  return { url: location.href, title: document.title, candidates };
}
