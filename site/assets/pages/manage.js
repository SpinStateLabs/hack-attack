import { api, categoryCheckboxes, checked, status, takeToken, turnstile } from '/assets/app.js';
const t = takeToken();
if (!t) {
  document.getElementById('request').hidden = false;
  const ts = turnstile(document.getElementById('ts1')), st = document.getElementById('st1');
  document.getElementById('req').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/v1/subscriptions/email/manage-link', { email: document.getElementById('email').value, turnstile_token: ts() });
      status(st, r.message, 'ok');
    } catch (err) { status(st, err.message, 'error'); }
  });
} else {
  const sec = document.getElementById('prefs'), st = document.getElementById('st2'), f = document.getElementById('pf');
  const ts = turnstile(document.getElementById('ts2'));
  api('POST', '/v1/subscriptions/email/preferences/view', { token: t }).then((p) => {
    sec.hidden = false;
    document.getElementById('who').textContent = p.email;
    categoryCheckboxes(document.getElementById('cats'), p.categories);
    document.getElementById('sev').value = p.min_severity;
    document.getElementById('delivery').value = p.delivery;
  }).catch((err) => { document.body.querySelector('main').insertAdjacentHTML('beforeend', '<p class="status error"></p>'); document.querySelector('.status.error').textContent = err.message; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/v1/subscriptions/email/preferences', { token: t, categories: checked(f), min_severity: document.getElementById('sev').value, delivery: document.getElementById('delivery').value, turnstile_token: ts() });
      status(st, 'Saved.', 'ok');
    } catch (err) { status(st, err.message, 'error'); }
  });
  document.getElementById('unsub').addEventListener('click', async () => {
    try { await api('POST', '/v1/subscriptions/email/unsubscribe', { token: t }); sec.innerHTML = '<p class="status ok">You are unsubscribed.</p>'; }
    catch (err) { status(st, err.message, 'error'); }
  });
}
