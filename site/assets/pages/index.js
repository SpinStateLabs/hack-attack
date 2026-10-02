import { api, categoryCheckboxes, checked, status, turnstile } from '/assets/app.js';
const f = document.getElementById('sub'), st = document.getElementById('st');
categoryCheckboxes(document.getElementById('cats'));
const token = turnstile(document.getElementById('ts'));
api('GET', '/v1/subscriptions/email/consent-text').then((c) => (document.getElementById('consent-text').textContent = c.text)).catch(() => {});
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  status(st, 'Sending…');
  try {
    const r = await api('POST', '/v1/subscriptions/email', {
      email: document.getElementById('email').value, consent: document.getElementById('consent').checked,
      categories: checked(f), min_severity: document.getElementById('sev').value,
      delivery: document.getElementById('delivery').value, turnstile_token: token(),
    });
    status(st, r.message + ' Check your inbox.', 'ok');
  } catch (err) { status(st, err.message, 'error'); }
});
fetch('/events.json').then((r) => r.json()).then((d) => {
  const ul = document.getElementById('events');
  ul.innerHTML = '';
  if (!d.events.length) ul.innerHTML = '<li class="muted">No warnings published yet.</li>';
  for (const ev of d.events.slice(0, 20)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '/events/' + ev.slug + '/';
    a.textContent = ev.title;
    if (ev.status === 'retracted') a.className = 'retracted';
    const s = document.createElement('span');
    s.className = 'sev sev-' + ev.severity;
    s.textContent = (ev.status === 'retracted' ? 'retracted' : ev.severity) + ' ';
    li.append(s, a);
    ul.append(li);
  }
}).catch(() => {});
