// לוגיקת השיחה הטלפונית - מכונת מצבים לכל שיחה (לפי ApiCallId)
const cfg = require('./config');
const T = require('./time');
const match = require('./match');
const yemot = require('./yemot');

// ---------- פורמט הפקודות של ימות המשיח ----------
const clean = (s) => String(s ?? '').replace(/[.,\-=&"'\n<>/]/g, ' ').replace(/\s+/g, ' ').trim();
const t = (s) => (clean(s) ? `t-${clean(s)}` : '');
const d = (digits) => `d-${String(digits).replace(/\D/g, '')}`;
const n = (num) => `n-${Number(num)}`;
const f = (file) => (file ? `f-${file}` : '');
const join = (parts) => parts.flat(Infinity).filter(Boolean).join('.');
const tap = (param, parts, max = 1, min = 1) => `read=${join(parts)}=${param},no,${max},${min},7,No,yes,no`;
const record = (param, parts, folder, file) => `read=${join(parts)}=${param},no,record,${folder},${file},yes,yes,no,1,90`;
const sayAndHangup = (parts) => `id_list_message=${join(parts)}&hangup=yes`;

const menuText = (map) => Object.entries(map).map(([k, v]) => `ל${v} הקישו ${k}`).join(' ');
const timeParts = (min) => (min == null ? [] : [t('בשעה'), n(Math.floor(min / 60)), t('ו'), n(min % 60), t('דקות')]);
const dayParts = (date) => {
  const today = T.dateIL();
  if (date === today) return [t('היום')];
  if (date === T.addDays(today, -1)) return [t('אתמול')];
  const [, m, dd] = date.split('-');
  return [t('בתאריך'), n(Number(dd)), t('לחודש'), n(Number(m))];
};
const describe = (r) => (r.place === 'bus'
  ? [t(`באוטובוס קו ${r.line}`), t(r.route_desc), dayParts(r.date), timeParts(r.time_min)]
  : [t(cfg.CATEGORIES[r.category]), t(`ב${cfg.CITIES[r.city_key]}`), dayParts(r.date)]);

function createIvr(db, openbus, { now = () => Date.now() } = {}) {
  const sessions = new Map();
  setInterval(() => {
    for (const [id, s] of sessions) if (s.touched < now() - 2 * 3600000) sessions.delete(id);
  }, 600000).unref();

  const ask = (s, step, build) => { s.step = step; s.seq += 1; s.expect = `p${s.seq}`; return build(s.expect); };
  const isLost = (s) => s.r.kind === 'lost';

  // ================= מסכים =================
  const screens = {
    main(s, pre = []) {
      s.r = {};
      const parts = [...pre];
      if (!pre.length) {
        parts.push(t('שלום וברוכים הבאים לשדכן אבדות באוטובוסים'));
        // צינתוק "האוטובוס בעיר שלך" מהשעה האחרונה
        for (const r of db.myReports(s.phone)) {
          if (r.last_alert_at && now() - r.last_alert_at < 3600000) {
            parts.push(t('עדכון על האוטובוס שבו איבדתם'), t(r.last_alert_text));
          }
        }
        const unseen = db.myMatches(s.phone).filter((m) => (m.lost_phone === s.phone ? !m.seen_lost : !m.seen_found)).length;
        if (unseen) parts.push(t('יש לכם'), n(unseen), t('שידוכים חדשים לשמיעה הקישו 3'));
      }
      parts.push(
        t('איבדתי חפץ באוטובוס הקישו 1'), t('מצאתי חפץ באוטובוס הקישו 2'),
        t('לשמיעת השידוכים שלי הקישו 3'), t('לניהול הדיווחים שלי הקישו 4'), t('ליציאה הקישו 0')
      );
      return ask(s, 'main', (p) => tap(p, parts));
    },
    // ---- אוטובוס ----
    busDate: (s, pre = []) => ask(s, 'busDate', (p) => tap(p, [...pre,
      t(isLost(s) ? 'מתי נסעתם' : 'מתי מצאתם'), t('היום הקישו 1 אתמול הקישו 2 שלשום הקישו 3'), t('לחזרה לתפריט הראשי הקישו 0')])),
    busLine: (s, pre = []) => ask(s, 'busLine', (p) => tap(p, [...pre,
      t('הקישו את מספר הקו ובסיום סולמית')], 3, 1)),
    busCity: (s, pre = []) => ask(s, 'busCity', (p) => tap(p, [...pre,
      t('באיזו עיר עובר הקו'), t(menuText(cfg.CITIES))])),
    busRoute(s, pre = []) {
      const page = s.routes.slice(s.page * 8, s.page * 8 + 8);
      const parts = [...pre, t('בחרו את הכיוון')];
      page.forEach((r, i) => parts.push(t(`לקו של ${r.agency} לכיוון ${r.to} הקישו ${i + 1}`)));
      if (s.routes.length > (s.page + 1) * 8) parts.push(t('לכיוונים נוספים הקישו 9'));
      parts.push(t('להקשת קו אחר הקישו 0'));
      return ask(s, 'busRoute', (p) => tap(p, parts));
    },
    busTime: (s, pre = []) => ask(s, 'busTime', (p) => tap(p, [...pre,
      t(isLost(s) ? 'הקישו בארבע ספרות את השעה בערך שבה הייתם באוטובוס' : 'הקישו בארבע ספרות את השעה בערך שבה מצאתם את החפץ'),
      t('לדוגמה לשמונה ורבע הקישו אפס שמונה אחת חמש')], 4, 4)),

    record(s) {
      s.recFile = `${now()}${Math.floor(Math.random() * 1000)}`;
      const text = isLost(s)
        ? 'הקליטו תיאור של החפץ וסימן מזהה שרק אתם יודעים ההקלטה תושמע רק למי שמצא את החפץ'
        : 'תארו את החפץ באופן כללי בלבד בלי סימנים מזהים ואמרו איפה הוא נמצא עכשיו';
      return ask(s, 'record', (p) => record(p, [t(text), t('בסיום הקישו סולמית')], cfg.RECORD_FOLDER, s.recFile));
    },

    notify: (s, pre = []) => ask(s, 'notify', (p) => tap(p, [...pre,
      t('כדי שנצנתק לכם כשהאוטובוס נוסע בעיר שלכם בחרו עיר'), t(menuText(cfg.CITIES)),
      t('אם אינכם מעוניינים הקישו 0')])),

    // ---- שידוכים ----
    matches(s, pre = []) {
      const list = s.list;
      if (!list.length) return screens.main(s, [...pre, t('אין לכם שידוכים כרגע')]);
      if (s.idx >= list.length) s.idx = list.length - 1;
      const m = list[s.idx];
      const iAmLost = m.lost_phone === s.phone;
      db.markSeen(m.id, iAmLost ? 'lost' : 'found');
      const mine = db.get(iAmLost ? m.lost_id : m.found_id);
      const other = db.get(iAmLost ? m.found_id : m.lost_id);
      const parts = [...pre];
      if (s.idx === 0 && !pre.length) parts.push(t('יש לכם'), n(list.length), t('שידוכים'));

      if (m.kind === 'suggest') {
        parts.push(t('ייתכן שהחפץ שאיבדתם נמצא'), describe(other),
          other.recording ? [t('תיאור המוצא'), f(other.recording)] : [],
          t('אם זה החפץ שלכם הקישו 1'));
      } else {
        parts.push(
          t(m.kind === 'auto' ? 'שידוך ודאי באותו אוטובוס' : 'המאבד אישר שזה החפץ שלו'),
          t(iAmLost ? 'החפץ שאיבדתם' : 'החפץ שמצאתם'), describe(mine),
          other.recording ? [t(iAmLost ? 'הודעת המוצא' : 'תיאור וסימן מזהה מהמאבד'), f(other.recording)] : [],
          t('מספר הטלפון של הצד השני'), d(other.phone), t('שוב'), d(other.phone),
          t('אם החפץ הוחזר הקישו 9'));
      }
      if (s.idx < list.length - 1) parts.push(t('לשידוך הבא הקישו 2'));
      if (s.idx > 0) parts.push(t('לשידוך הקודם הקישו 3'));
      parts.push(t('לתפריט הראשי הקישו 0'));
      return ask(s, 'matches', (p) => tap(p, parts));
    },

    // ---- הדיווחים שלי ----
    mine(s, pre = []) {
      const list = s.list;
      if (!list.length) return screens.main(s, [...pre, t('אין לכם דיווחים פעילים')]);
      if (s.idx >= list.length) s.idx = list.length - 1;
      const r = list[s.idx];
      const parts = [...pre];
      if (s.idx === 0 && !pre.length) parts.push(t('יש לכם'), n(list.length), t('דיווחים פעילים'));
      parts.push(t('דיווח מספר'), n(r.id), t(r.kind === 'lost' ? 'על חפץ שאיבדתם' : 'על חפץ שמצאתם'), describe(r));
      const vs = match.list(r.vehicles);
      if (r.place === 'bus' && vs.length === 1) parts.push(t('מספר הרכב'), d(vs[0]));
      if (r.kind === 'lost' && r.place === 'bus' && vs.length === 1) parts.push(t('לשמיעת המיקום הנוכחי של האוטובוס הקישו 4'));
      parts.push(t('אם החפץ הוחזר ולמחיקת הדיווח הקישו 9'));
      if (s.idx < list.length - 1) parts.push(t('לדיווח הבא הקישו 2'));
      if (s.idx > 0) parts.push(t('לדיווח הקודם הקישו 3'));
      parts.push(t('לתפריט הראשי הקישו 0'));
      return ask(s, 'mine', (p) => tap(p, parts));
    },
  };

  // ================= שמירת דיווח ושידוך =================
  async function save(s) {
    const r = { ...s.r, phone: s.phone, recording: `${cfg.RECORD_FOLDER}/${s.recFile}` };
    const report = db.addReport(r);
    s.saved = report;
    const created = match.run(db, report);
    const pre = [t('הדיווח נשמר בהצלחה מספר הדיווח'), n(report.id)];
    const vs = match.list(report.vehicles);
    if (report.place === 'bus') {
      if (vs.length === 1) pre.push(t('זיהינו את האוטובוס מספר הרכב'), d(vs[0]));
      else if (vs.length > 1) pre.push(t('באותה שעה נסעו בקו'), n(vs.length), t('אוטובוסים וכולם נבדקים'));
      else pre.push(t('לא הצלחנו לזהות את האוטובוס עצמו נחפש לפי הקו והשעה'));
    }

    const sure = created.filter((c) => c.kind === 'auto');
    if (sure.length) {
      pre.push(t('יש שידוך'), t(isLost(s) ? 'מישהו דיווח שמצא חפץ באותו אוטובוס' : 'מישהו דיווח שאיבד חפץ באותו אוטובוס'),
        t('שלחנו לו צינתוק'));
    } else if (created.length) {
      pre.push(t(isLost(s) ? 'יש חפצים שנמצאו ועשויים להתאים' : 'שלחנו צינתוק למי שאיבד חפץ דומה'));
    } else {
      pre.push(t('כרגע אין התאמה נצנתק לכם כשתימצא'));
    }

    if (created.length && (sure.length || isLost(s))) {
      s.list = db.myMatches(s.phone); s.idx = 0;
      return screens.matches(s, [...pre, t('מיד תשמעו את הפרטים')]);
    }
    if (isLost(s) && report.place === 'bus' && vs.length === 1) return screens.notify(s, pre);
    return screens.main(s, [...pre, t('תודה רבה')]);
  }

  // ================= טיפול בהקשות =================
  const handlers = {
    main(s, v) {
      if (v === '1' || v === '2') { s.r = { kind: v === '1' ? 'lost' : 'found', place: 'bus' }; return screens.busDate(s); }
      if (v === '3') { s.list = db.myMatches(s.phone); s.idx = 0; return screens.matches(s); }
      if (v === '4') { s.list = db.myReports(s.phone); s.idx = 0; return screens.mine(s); }
      if (v === '0') return sayAndHangup([t('תודה ולהתראות')]);
      return screens.main(s, [t('בחירה לא תקינה')]);
    },
    busDate(s, v) {
      if (v === '0') return screens.main(s);
      if (!['1', '2', '3'].includes(v)) return screens.busDate(s, [t('בחירה לא תקינה')]);
      s.r.date = T.addDays(T.dateIL(new Date(now())), -(Number(v) - 1));
      return screens.busLine(s);
    },
    busLine(s, v) {
      if (!/^\d{1,3}$/.test(v) || Number(v) === 0) return screens.busLine(s, [t('מספר קו לא תקין')]);
      s.r.line = String(Number(v));
      return screens.busCity(s);
    },
    async busCity(s, v) {
      if (!cfg.CITIES[v]) return screens.busCity(s, [t('בחירה לא תקינה')]);
      s.r.city_key = Number(v);
      try {
        s.routes = await openbus.findRoutes(s.r.date, s.r.line, v === '9' ? '' : cfg.CITIES[v]);
      } catch (e) {
        console.error('findRoutes', e.message);
        s.routes = null;
      }
      if (s.routes === null) {
        // המאגר לא זמין - ממשיכים בלי זיהוי רכב
        s.r.route_desc = ''; s.r.line_refs = '';
        return screens.busTime(s, [t('מאגר האוטובוסים לא זמין כרגע נשמור את הדיווח לפי הקו והשעה')]);
      }
      if (!s.routes.length) return screens.busLine(s, [t(`לא מצאנו את קו ${s.r.line} בעיר הזו`)]);
      s.page = 0;
      if (s.routes.length === 1) return pickRoute(s, s.routes[0], [t(`קו ${s.r.line} של ${s.routes[0].agency} לכיוון ${s.routes[0].to}`)]);
      return screens.busRoute(s);
    },
    busRoute(s, v) {
      if (v === '0') return screens.busLine(s);
      if (v === '9' && s.routes.length > (s.page + 1) * 8) { s.page += 1; return screens.busRoute(s); }
      const r = s.routes[s.page * 8 + Number(v) - 1];
      if (!r || Number(v) < 1) return screens.busRoute(s, [t('בחירה לא תקינה')]);
      return pickRoute(s, r);
    },
    async busTime(s, v) {
      const min = T.parseHHMM(v);
      if (min == null) return screens.busTime(s, [t('שעה לא תקינה')]);
      s.r.time_min = min;
      s.r.vehicles = '';
      if (s.r.line_refs) {
        const at = T.ilToDate(s.r.date, min);
        const w = cfg.BUS_WINDOW_MIN * 60000;
        try {
          const vs = await openbus.vehiclesAt(s.r.line_refs.split(','), new Date(at - w), new Date(+at + w));
          s.r.vehicles = vs.join(',');
        } catch (e) { console.error('vehiclesAt', e.message); }
      }
      return screens.record(s);
    },

    record: (s) => save(s),

    notify(s, v) {
      if (v === '0') return screens.main(s, [t('תודה רבה')]);
      if (!cfg.CITIES[v] || v === '9') return screens.notify(s, [t('בחירה לא תקינה')]);
      db.setNotify(s.saved.id, Number(v));
      return screens.main(s, [t(`נצנתק לכם כשהאוטובוס ייסע ב${cfg.CITIES[v]}`), t('כשתחזרו אלינו תשמעו איפה הוא נמצא')]);
    },

    matches(s, v) {
      const m = s.list[s.idx];
      const iAmLost = m.lost_phone === s.phone;
      if (v === '1' && m.kind === 'suggest' && iAmLost) {
        db.upgradeMatch(m.id, 'claim');
        yemot.tzintuk(m.found_phone, `claim L${m.lost_id} F${m.found_id}`);
        s.list = db.myMatches(s.phone);
        s.idx = s.list.findIndex((x) => x.id === m.id);
        return screens.matches(s, [t('מצוין שלחנו צינתוק למוצא')]);
      }
      if (v === '9' && m.kind !== 'suggest') {
        db.closeReport(m.lost_id, m.lost_phone);
        db.closeReport(m.found_id, m.found_phone);
        s.list = db.myMatches(s.phone);
        return screens.matches(s, [t('ברוך השם החפץ הוחזר הדיווחים נסגרו')]);
      }
      if (v === '2' && s.idx < s.list.length - 1) { s.idx += 1; return screens.matches(s); }
      if (v === '3' && s.idx > 0) { s.idx -= 1; return screens.matches(s); }
      if (v === '0') return screens.main(s);
      return screens.matches(s, [t('בחירה לא תקינה')]);
    },

    async mine(s, v) {
      const r = s.list[s.idx];
      if (v === '9') {
        db.closeReport(r.id, s.phone);
        s.list.splice(s.idx, 1);
        return screens.mine(s, [t('הדיווח נמחק')]);
      }
      if (v === '4') {
        const vs = match.list(r.vehicles);
        if (r.kind !== 'lost' || vs.length !== 1) return screens.mine(s, [t('בחירה לא תקינה')]);
        try {
          const ride = await openbus.currentRide(vs[0]);
          if (!ride) return screens.mine(s, [t('האוטובוס לא נוסע כרגע')]);
          return screens.mine(s, [t(`האוטובוס נוסע עכשיו בקו ${ride.line} של ${ride.agency} מ${ride.from} ל${ride.to}`)]);
        } catch (e) {
          return screens.mine(s, [t('מאגר האוטובוסים לא זמין כרגע')]);
        }
      }
      if (v === '2' && s.idx < s.list.length - 1) { s.idx += 1; return screens.mine(s); }
      if (v === '3' && s.idx > 0) { s.idx -= 1; return screens.mine(s); }
      if (v === '0') return screens.main(s);
      return screens.mine(s, [t('בחירה לא תקינה')]);
    },
  };

  function pickRoute(s, r, pre = []) {
    s.r.route_desc = `${r.agency} לכיוון ${r.to}`;
    s.r.line_refs = r.lineRefs.join(',');
    return screens.busTime(s, pre);
  }

  // ================= נקודת כניסה =================
  return async function handle(q) {
    const callId = q.ApiCallId || 'no-call-id';
    if (q.hangup === 'yes' || q.ApiHangup === 'yes') { sessions.delete(callId); return ''; }

    let s = sessions.get(callId);
    if (!s) {
      s = { seq: 0, phone: String(q.ApiPhone || '').replace(/\D/g, ''), r: {}, list: [], idx: 0, touched: now() };
      sessions.set(callId, s);
      if (!s.phone) return sayAndHangup([t('לא ניתן לזהות את מספר הטלפון שלכם נא חייגו ממספר מזוהה')]);
      return screens.main(s);
    }
    s.touched = now();
    const value = q[s.expect];
    if (value === undefined) return screens[s.step] ? screens[s.step](s) : screens.main(s);
    return handlers[s.step](s, String(value));
  };
}

module.exports = { createIvr };
