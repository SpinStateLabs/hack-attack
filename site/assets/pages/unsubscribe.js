import { api, status, takeToken } from '/assets/app.js';
const t = takeToken(), st = document.getElementById('st'), btn = document.getElementById('go');
if (!t) { status(st, 'This link is missing its token. Use the unsubscribe link in any alert email, or the List-Unsubscribe button in your mail app.', 'error'); btn.disabled = true; }
btn.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    await api('POST', '/v1/subscriptions/email/unsubscribe', { token: t });
    status(st, 'You are unsubscribed. No further alert emails will be sent.', 'ok');
  } catch (err) { status(st, err.message, 'error'); btn.disabled = false; }
});
