import { api, status, takeToken, turnstile } from '/assets/app.js';
const t = takeToken(), st = document.getElementById('st'), btn = document.getElementById('go');
const ts = turnstile(document.getElementById('ts'));
if (!t) { status(st, 'This link is missing its token. Use the link from your email.', 'error'); btn.disabled = true; }
btn.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    await api('POST', '/v1/subscriptions/email/confirm', { token: t, turnstile_token: ts() });
    status(st, 'Confirmed. You will receive alerts that match your preferences.', 'ok');
  } catch (err) { status(st, err.message, 'error'); btn.disabled = false; }
});
