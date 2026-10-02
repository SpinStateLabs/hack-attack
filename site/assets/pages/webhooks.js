import { api, categoryCheckboxes, checked, status, turnstile } from '/assets/app.js';
const f = document.getElementById('reg'), st = document.getElementById('st');
categoryCheckboxes(document.getElementById('cats'));
const ts = turnstile(document.getElementById('ts'));
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  status(st, 'Sending verification challenge…');
  try {
    const r = await api('POST', '/v1/webhooks', { url: document.getElementById('url').value, categories: checked(f), min_severity: document.getElementById('sev').value, turnstile_token: ts() });
    status(st, 'Verified. A signed test event is on its way.', 'ok');
    document.getElementById('result').hidden = false;
    document.getElementById('creds').textContent = 'endpoint id:       ' + r.id + '\nsigning secret:    ' + r.secret + '\nmanagement token:  ' + r.management_token;
  } catch (err) { status(st, err.message, 'error'); }
});
