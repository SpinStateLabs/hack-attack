// Shared helpers for the static pages. Config comes from /config.js, generated at build time.
const CFG = window.HACK_ATTACK || { apiUrl: 'http://localhost:8080', turnstileSiteKey: '' };
export const CATEGORIES = [
  'prompt-injection', 'jailbreak', 'agent-hijack', 'model-supply-chain', 'data-poisoning',
  'data-exfiltration', 'credential-leak', 'deepfake-fraud', 'model-theft', 'other',
];
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

/** Tokens arrive in the URL fragment so they never reach server logs. Remove them from the address bar. */
export function takeToken() {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) history.replaceState(null, '', location.pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function api(method, path, body) {
  const res = await fetch(CFG.apiUrl + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(msg === 'rate_limited' ? 'Too many attempts. Try again later.' : msg === 'turnstile_failed' ? 'Bot check failed. Reload and try again.' : msg);
  }
  return data;
}

/** Render a Turnstile widget into `el`; resolves the current token on demand. */
export function turnstile(el) {
  let token = '';
  if (!CFG.turnstileSiteKey) return () => '';
  const render = () => window.turnstile.render(el, { sitekey: CFG.turnstileSiteKey, callback: (t) => (token = t), 'expired-callback': () => (token = '') });
  if (window.turnstile) render(); else window.addEventListener('turnstile-ready', render, { once: true });
  return () => token;
}

export function status(el, msg, kind) {
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

export function categoryCheckboxes(container, selected = []) {
  container.innerHTML = '<legend>Categories (none = all)</legend>' + CATEGORIES.map((c) =>
    `<label><input type="checkbox" name="categories" value="${c}" ${selected.includes(c) ? 'checked' : ''}>${c}</label>`).join('');
}

export const checked = (form) => [...form.querySelectorAll('input[name=categories]:checked')].map((i) => i.value);
