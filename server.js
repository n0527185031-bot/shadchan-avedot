const express = require('express');
const cfg = require('./config');
const { open } = require('./db');
const { createIvr } = require('./ivr');
const openbus = require('./openbus');
const tracker = require('./tracker');
const yemot = require('./yemot');

const db = open();
const handle = createIvr(db, openbus);
tracker.start(db, openbus);

const app = express();
app.use(express.urlencoded({ extended: true }));

// הכתובת שמגדירים ב-api_link של השלוחה בימות המשיח
app.all('/ivr', async (req, res) => {
  let out;
  try {
    out = await handle({ ...req.query, ...req.body });
  } catch (e) {
    console.error(e);
    out = 'id_list_message=t-אירעה תקלה נא נסו שוב מאוחר יותר&hangup=yes';
  }
  res.type('text/plain; charset=utf-8').send(out);
});

app.get('/', (req, res) => res.send('שדכן אבדות - השרת פועל'));

// לבדיקה איזו גרסה רצה בשרת
const STARTED = new Date().toISOString();
app.get('/version', (req, res) => res.json({ commit: process.env.RENDER_GIT_COMMIT || 'local', started: STARTED }));

// דף ניהול: /admin?key=...
app.get('/admin', (req, res) => {
  if (req.query.key !== cfg.ADMIN_KEY) return res.status(403).send('אין הרשאה');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const time = (m) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const reports = db.allReports().map((r) => `<tr>
    <td>${r.id}</td><td>${r.kind === 'lost' ? 'אבד' : 'נמצא'}</td>
    <td>${r.place === 'bus' ? `קו ${esc(r.line)} - ${esc(r.route_desc)}` : esc(cfg.CATEGORIES[r.category])}</td>
    <td>${esc(cfg.CITIES[r.city_key])}</td><td>${r.date} ${time(r.time_min)}</td>
    <td dir="ltr">${esc(r.vehicles)}</td><td dir="ltr">${esc(r.phone)}</td>
    <td>${r.status === 'open' ? 'פעיל' : 'סגור'}</td></tr>`).join('');
  const matches = db.allMatches().map((m) => `<tr><td>${m.id}</td><td>${m.lost_id}</td><td>${m.found_id}</td>
    <td>${{ auto: 'ודאי (אותו רכב)', suggest: 'הצעה', claim: 'המאבד אישר' }[m.kind]}</td>
    <td>${new Date(m.created_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</td></tr>`).join('');
  const tz = yemot.log.slice(0, 30).map((x) => `<tr><td dir="ltr">${esc(x.phone)}</td><td dir="ltr">${esc(x.reason)}</td><td>${esc(x.at)}</td></tr>`).join('');
  res.send(`<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>שדכן אבדות - ניהול</title>
  <style>body{font-family:Arial,sans-serif;margin:16px;background:#f6f6f6}table{border-collapse:collapse;width:100%;background:#fff;margin-bottom:28px;font-size:14px}
  td,th{border:1px solid #ddd;padding:6px;text-align:right}th{background:#1b6f68;color:#fff}.wrap{overflow-x:auto}</style>
  <h1>שדכן אבדות</h1>
  <h2>דיווחים</h2><div class="wrap"><table><tr><th>#</th><th>סוג</th><th>פרטים</th><th>עיר</th><th>מתי</th><th>רכבים</th><th>טלפון</th><th>סטטוס</th></tr>${reports}</table></div>
  <h2>שידוכים</h2><div class="wrap"><table><tr><th>#</th><th>דיווח אבידה</th><th>דיווח מציאה</th><th>סוג</th><th>נוצר</th></tr>${matches}</table></div>
  <h2>צינתוקים אחרונים</h2><div class="wrap"><table><tr><th>טלפון</th><th>סיבה</th><th>זמן</th></tr>${tz}</table></div></html>`);
});

app.listen(cfg.PORT, () => console.log(`Shadchan Avedot listening on port ${cfg.PORT}`));
