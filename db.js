const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

function open(dbPath = cfg.DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      kind TEXT NOT NULL,            -- lost / found
      place TEXT NOT NULL,           -- bus / street
      date TEXT NOT NULL,            -- YYYY-MM-DD (שעון ישראל)
      time_min INTEGER,              -- דקות מחצות
      line TEXT,                     -- מספר קו
      route_desc TEXT,               -- חברה וכיוון
      line_refs TEXT,                -- מזהי מסלול במאגר, מופרדים בפסיק
      vehicles TEXT,                 -- מספרי רכב שאותרו, מופרדים בפסיק
      city_key INTEGER,
      category INTEGER,
      recording TEXT,
      notify_city INTEGER,           -- צינתוק כשהרכב נוסע בעיר הזו
      alerts_sent INTEGER NOT NULL DEFAULT 0,
      last_alert_ride INTEGER,
      last_alert_text TEXT,
      last_alert_at INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_r_match ON reports(kind, place, status, date);
    CREATE INDEX IF NOT EXISTS idx_r_phone ON reports(phone, status);
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lost_id INTEGER NOT NULL,
      found_id INTEGER NOT NULL,
      kind TEXT NOT NULL,            -- auto (אותו רכב) / suggest (הצעה) / claim (המאבד אישר)
      seen_lost INTEGER NOT NULL DEFAULT 0,
      seen_found INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(lost_id, found_id)
    );
  `);

  const minCreated = () => Date.now() - cfg.EXPIRE_DAYS * 86400000;
  const get = (id) => db.prepare('SELECT * FROM reports WHERE id=?').get(id);

  return {
    raw: db,
    get,
    addReport(r) {
      const cols = ['phone', 'kind', 'place', 'date', 'time_min', 'line', 'route_desc', 'line_refs', 'vehicles', 'city_key', 'category', 'recording'];
      const res = db.prepare(`INSERT INTO reports (${cols.join(',')},created_at) VALUES (${cols.map(() => '?').join(',')},?)`)
        .run(...cols.map((c) => r[c] ?? null), Date.now());
      return get(Number(res.lastInsertRowid));
    },
    setNotify(id, cityKey) {
      db.prepare('UPDATE reports SET notify_city=? WHERE id=?').run(cityKey, id);
    },
    candidates({ kind, place, dateFrom, dateTo, excludePhone }) {
      return db.prepare(`SELECT * FROM reports WHERE kind=? AND place=? AND status='open'
        AND date BETWEEN ? AND ? AND phone<>? AND created_at>=?`)
        .all(kind, place, dateFrom, dateTo, excludePhone, minCreated());
    },
    myReports(phone) {
      return db.prepare("SELECT * FROM reports WHERE phone=? AND status='open' AND created_at>=? ORDER BY created_at DESC")
        .all(phone, minCreated());
    },
    closeReport(id, phone) {
      return db.prepare("UPDATE reports SET status='closed' WHERE id=? AND phone=?").run(id, phone).changes > 0;
    },

    addMatch(lostId, foundId, kind) {
      const r = db.prepare('INSERT OR IGNORE INTO matches (lost_id,found_id,kind,created_at) VALUES (?,?,?,?)')
        .run(lostId, foundId, kind, Date.now());
      return r.changes > 0;
    },
    upgradeMatch(id, kind) {
      db.prepare('UPDATE matches SET kind=?, seen_found=0 WHERE id=?').run(kind, id);
    },
    // השידוכים של מתקשר. הצעות (suggest) מוצגות רק למאבד.
    myMatches(phone) {
      return db.prepare(`
        SELECT m.*, l.phone AS lost_phone, f.phone AS found_phone
        FROM matches m JOIN reports l ON l.id=m.lost_id JOIN reports f ON f.id=m.found_id
        WHERE l.status='open' AND f.status='open'
          AND (l.phone=? OR (f.phone=? AND m.kind<>'suggest'))
        ORDER BY m.created_at DESC`).all(phone, phone);
    },
    markSeen(matchId, side) {
      db.prepare(`UPDATE matches SET ${side === 'lost' ? 'seen_lost' : 'seen_found'}=1 WHERE id=?`).run(matchId);
    },

    // דיווחי "איבדתי באוטובוס" שביקשו צינתוק כשהרכב בעיר שלהם
    trackable(minDate) {
      return db.prepare(`SELECT * FROM reports WHERE kind='lost' AND place='bus' AND status='open'
        AND notify_city IS NOT NULL AND vehicles IS NOT NULL AND vehicles<>'' AND date>=? AND alerts_sent<?`)
        .all(minDate, cfg.MAX_ALERTS_PER_REPORT);
    },
    saveAlert(id, rideId, text) {
      db.prepare('UPDATE reports SET alerts_sent=alerts_sent+1, last_alert_ride=?, last_alert_text=?, last_alert_at=? WHERE id=?')
        .run(rideId, text, Date.now(), id);
    },

    allReports() { return db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 1000').all(); },
    allMatches() { return db.prepare('SELECT * FROM matches ORDER BY created_at DESC LIMIT 1000').all(); },
  };
}

module.exports = { open };
