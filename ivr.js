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
// 495 -> "8 ו 15" ; 480 -> "8"
const clock = (min) => (min % 60 ? [n(Math.floor(min / 60)), t('ו'), n(min % 60)] : [n(Math.floor(min / 60))]);
const timeParts = (min) => (min == null ? [] : [t('של השעה'), clock(min)]);
const dayParts = (date) => {
  const today = T.dateIL();
  if (date === today) return [t('היום')];
  if (date === T.addDays(today, -1)) return [t('אתמול')];
  const [, m, dd] = date.split('-');
  return [t('בתאריך'), n(Number(dd)), t('לחודש'), n(Number(m))];
};
const describe = (r) => [t(`באוטובוס קו ${r.line}`), t(r.route_desc), timeParts(r.time_min), dayParts(r.date)];

// "הקו התחיל כעת קו 3 של השעה 9 לכיוון X שידר לפני 2 דקות"
function rideParts(ride, nowMs) {
  const ago = Math.max(0, Math.floor((nowMs - new Date(ride.recordedAt)) / 60000));
  return [
    t(`קו ${ride.line} של ${ride.agency}`),
    ride.scheduledStart ? timeParts(T.minutesIL(new Date(ride.scheduledStart))) : [],
    t(`לכיוון ${ride.to}`),
    ago ? [t('שידר לפני'), n(ago), t('דקות')] : t('שידר לפני פחות מדקה'),
  ];
}

function createIvr(db, openbus, { now = () => Date.now() } = {}) {
  const sessions = new Map();
  setInterval(() => {
    for (const [id, s] of sessions) if (s.touched < now() - 2 * 3600000) sessions.delete(id);
  }, 600000).unref();

  const ask = (s, step, build) => { s.step = step; s.seq += 1; s.expect = `p${s.seq}`; return build(s.expect); };
  const isLost = (s) => s.r.kind === 'lost';
  const today = () => T.dateIL(new Date(now()));

  // ================= מסכים =================
  const screens = {
    async main(s, pre = []) {
      s.r = {};
      const parts = [...pre];
      if (!pre.length) {
        parts.push(t('שלום וברוכים הבאים לשדכן אבדות באוטובוסים'));
        // צינתוק "האוטובוס התחיל מסלול חדש" מ-3 השעות האחרונות
        for (const r of db.myReports(s.phone)) {
          if (!r.last_alert_at || now() - r.last_alert_at > 3 * 3600000) continue;
          const v = match.list(r.vehicles)[0];
          let ride = null;
          try { ride = await openbus.currentRide(v); } catch { /* המאגר לא זמין */ }
          parts.push(t('האוטובוס שבו איבדתם מספר רישוי'), d(v));
          if (ride) parts.push(t(ride.rideId === r.last_alert_ride ? 'התחיל כעת' : 'נוסע כעת ב'), rideParts(ride, now()));
          else parts.push(t(`יצא לאחרונה ב${r.last_alert_text}`));
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

    date: (s, pre = []) => ask(s, 'date', (p) => tap(p, [...pre,
      t(isLost(s) ? 'מתי נסעתם' : 'מתי מצאתם'),
      t('לתאריך של היום הקישו 0 וסולמית'),
      t('לתאריך אחר הקישו שתי ספרות ליום שתי ספרות לחודש ושתי ספרות לשנה')], 6, 1)),

    stopKnown: (s, pre = []) => ask(s, 'stopKnown', (p) => tap(p, [...pre,
      t('אם אתם זוכרים את מספר התחנה הקישו 1'), t('אם לא הקישו 2')])),

    stopCode: (s, pre = []) => ask(s, 'stopCode', (p) => tap(p, [...pre,
      t('הקישו את מספר התחנה כפי שמופיע בשלט התחנה ובסיום סולמית')], 6, 1)),

    line: (s, pre = []) => ask(s, 'line', (p) => tap(p, [...pre,
      t('הקישו את מספר הקו ובסיום סולמית')], 3, 1)),

    city: (s, pre = []) => ask(s, 'city', (p) => tap(p, [...pre,
      t('באיזו עיר עובר הקו'), t(menuText(cfg.CITIES))])),

    route(s, pre = []) {
      const page = s.routes.slice(s.page * 8, s.page * 8 + 8);
      const parts = [...pre, t('בחרו את הכיוון')];
      page.forEach((r, i) => parts.push(t(`לקו של ${r.agency} לכיוון ${r.to} הקישו ${i + 1}`)));
      if (s.routes.length > (s.page + 1) * 8) parts.push(t('לכיוונים נוספים הקישו 9'));
      parts.push(t('להקשת קו אחר הקישו 0'));
      return ask(s, 'route', (p) => tap(p, parts));
    },

    depTime: (s, pre = []) => ask(s, 'depTime', (p) => tap(p, [...pre,
      t('הקישו בארבע ספרות את שעת היציאה הרשמית של הקו מתחנת המוצא'),
      t('לדוגמה לשמונה ורבע הקישו אפס שמונה אחת חמש')], 4, 4)),

    confirm: (s, pre = []) => ask(s, 'confirm', (p) => tap(p, [...pre,
      t(s.r.vehicles ? 'לשמירת מספר הרישוי בדיווח הקישו 1' : 'לשמירת הדיווח בלי מספר רישוי הקישו 1'),
      t('להקשת שעה אחרת הקישו 2')])),

    record(s) {
      s.recFile = `${now()}${Math.floor(Math.random() * 1000)}`;
      const text = isLost(s)
        ? 'הקליטו תיאור של החפץ וסימן מזהה שרק אתם יודעים ההקלטה תושמע רק למי שמצא את החפץ'
        : 'תארו את החפץ באופן כללי בלבד בלי סימנים מזהים ואמרו איפה הוא נמצא עכשיו';
      return ask(s, 'record', (p) => record(p, [t(text), t('בסיום הקישו סולמית')], cfg.RECORD_FOLDER, s.recFile));
    },

    notifyAsk: (s, pre = []) => ask(s, 'notifyAsk', (p) => tap(p, [...pre,
      t('לקבלת צינתוק כאשר האוטובוס הזה מתחיל מסלול חדש הקישו 1'), t('אם לא הקישו 2')])),

    notifyDir(s, pre = []) {
      const parts = [...pre, t('בחרו כיוון')];
      s.dirs.slice(0, 8).forEach((r, i) => parts.push(t(`כשהאוטובוס יוצא בקו ${r.line} לכיוון ${r.to} הקישו ${i + 1}`)));
      parts.push(t('לכל מסלול חדש של האוטובוס בכל קו הקישו 9'));
      return ask(s, 'notifyDir', (p) => tap(p, parts));
    },

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
        parts.push(t('ייתכן שהחפץ שאיבדתם נמצא'), t('מישהו מצא חפץ'), describe(other),
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
      if (vs.length === 1) parts.push(t('מספר הרישוי'), d(vs[0]));
      if (r.kind === 'lost' && vs.length === 1) parts.push(t('לשמיעת המיקום הנוכחי של האוטובוס הקישו 4'));
      parts.push(t('אם החפץ הוחזר ולמחיקת הדיווח הקישו 9'));
      if (s.idx < list.length - 1) parts.push(t('לדיווח הבא הקישו 2'));
      if (s.idx > 0) parts.push(t('לדיווח הקודם הקישו 3'));
      parts.push(t('לתפריט הראשי הקישו 0'));
      return ask(s, 'mine', (p) => tap(p, parts));
    },
  };

  // ================= שמירת דיווח ושידוך =================
  async function save(s) {
    const r = { ...s.r, place: 'bus', phone: s.phone, recording: `${cfg.RECORD_FOLDER}/${s.recFile}` };
    const report = db.addReport(r);
    s.saved = report;
    const created = match.run(db, report);
    const pre = [t('הדיווח נשמר בהצלחה מספר הדיווח'), n(report.id)];
    if (report.alt_vehicles) pre.push(t('שמרנו גם את האוטובוסים של הנסיעה הקודמת והבאה למקרה של טעות בשעה'));

    const sure = created.filter((c) => c.kind === 'auto');
    if (sure.length) {
      pre.push(t('יש שידוך'), t(isLost(s) ? 'מישהו דיווח שמצא חפץ באותו אוטובוס' : 'מישהו דיווח שאיבד חפץ באותו אוטובוס'),
        t('שלחנו לו צינתוק'));
    } else if (created.length) {
      pre.push(t(isLost(s) ? 'יש חפצים שנמצאו ועשויים להתאים' : 'שלחנו צינתוק למי שאיבד חפץ באוטובוס שעשוי להתאים'));
    } else {
      pre.push(t('כרגע אין התאמה נצנתק לכם כשתימצא'));
    }

    if (created.length && (sure.length || isLost(s))) {
      s.list = db.myMatches(s.phone); s.idx = 0;
      return screens.matches(s, [...pre, t('מיד תשמעו את הפרטים')]);
    }
    if (isLost(s) && match.list(report.vehicles).length === 1) return screens.notifyAsk(s, pre);
    return screens.main(s, [...pre, t('תודה רבה')]);
  }

  function pickRoute(s, r, pre = []) {
    s.r.route_desc = `${r.agency} לכיוון ${r.to}`;
    s.r.agency = r.agency;
    s.r.line_refs = r.lineRefs.join(',');
    return screens.depTime(s, pre);
  }

  // ================= טיפול בהקשות =================
  const handlers = {
    main(s, v) {
      if (v === '1' || v === '2') { s.r = { kind: v === '1' ? 'lost' : 'found' }; return screens.date(s); }
      if (v === '3') { s.list = db.myMatches(s.phone); s.idx = 0; return screens.matches(s); }
      if (v === '4') { s.list = db.myReports(s.phone); s.idx = 0; return screens.mine(s); }
      if (v === '0') return sayAndHangup([t('תודה ולהתראות')]);
      return screens.main(s, [t('בחירה לא תקינה')]);
    },

    date(s, v) {
      let date = null;
      if (v === '0' || v === '') date = today();
      else date = T.parseDDMMYY(v);
      if (!date) return screens.date(s, [t('תאריך לא תקין')]);
      if (date > today()) return screens.date(s, [t('התאריך שהקשתם עוד לא הגיע')]);
      if (date < T.addDays(today(), -30)) return screens.date(s, [t('אפשר לדווח רק על החודש האחרון')]);
      s.r.date = date;
      return screens.stopKnown(s);
    },

    stopKnown(s, v) {
      if (v === '1') return screens.stopCode(s);
      if (v === '2') { s.r.stop_code = null; return screens.line(s); }
      return screens.stopKnown(s, [t('בחירה לא תקינה')]);
    },

    stopCode(s, v) {
      if (!/^\d{1,6}$/.test(v) || Number(v) === 0) return screens.stopCode(s, [t('מספר תחנה לא תקין')]);
      s.r.stop_code = String(Number(v));
      return screens.line(s);
    },

    async line(s, v) {
      if (!/^\d{1,3}$/.test(v) || Number(v) === 0) return screens.line(s, [t('מספר קו לא תקין')]);
      s.r.line = String(Number(v));
      if (!s.r.stop_code) return screens.city(s);

      // יש תחנה: המערכת מזהה לבד את החברה ואת הכיוון
      try {
        s.routes = await openbus.routesAtStop(s.r.date, s.r.stop_code, s.r.line);
      } catch (e) {
        console.error('routesAtStop', e.message);
        return noDatabase(s);
      }
      if (!s.routes.length) {
        return screens.stopKnown(s, [t(`לא מצאנו את קו ${s.r.line} בתחנה מספר`), d(s.r.stop_code), t('נסו שוב')]);
      }
      s.page = 0;
      if (s.routes.length === 1) {
        const r = s.routes[0];
        return pickRoute(s, r, [t(`קו ${r.line} של ${r.agency} לכיוון ${r.to}`), t(`מתחנת ${r.stopName}`)]);
      }
      return screens.route(s);
    },

    async city(s, v) {
      if (!cfg.CITIES[v]) return screens.city(s, [t('בחירה לא תקינה')]);
      s.r.city_key = Number(v);
      try {
        s.routes = await openbus.findRoutes(s.r.date, s.r.line, v === '9' ? '' : cfg.CITIES[v]);
      } catch (e) {
        console.error('findRoutes', e.message);
        return noDatabase(s);
      }
      if (!s.routes.length) return screens.line(s, [t(`לא מצאנו את קו ${s.r.line} בעיר הזו`)]);
      s.page = 0;
      if (s.routes.length === 1) return pickRoute(s, s.routes[0], [t(`קו ${s.r.line} של ${s.routes[0].agency} לכיוון ${s.routes[0].to}`)]);
      return screens.route(s);
    },

    route(s, v) {
      if (v === '0') return screens.line(s);
      if (v === '9' && s.routes.length > (s.page + 1) * 8) { s.page += 1; return screens.route(s); }
      const r = s.routes[s.page * 8 + Number(v) - 1];
      if (!r || Number(v) < 1) return screens.route(s, [t('בחירה לא תקינה')]);
      return pickRoute(s, r);
    },

    async depTime(s, v) {
      const min = T.parseHHMM(v);
      if (min == null) return screens.depTime(s, [t('שעה לא תקינה')]);
      s.r.time_min = min;
      s.r.vehicles = '';
      s.r.alt_vehicles = '';
      if (!s.r.line_refs) return screens.record(s); // המאגר לא זמין - שומרים לפי קו ושעה

      let pick = null;
      try {
        const rides = await openbus.ridesNear(s.r.line_refs.split(','), s.r.date, min);
        pick = openbus.pickRide(rides, s.r.date, min);
      } catch (e) {
        console.error('ridesNear', e.message);
        return screens.confirm(s, [t('מאגר האוטובוסים לא זמין כרגע')]);
      }
      if (!pick) return screens.confirm(s, [t('לא מצאנו נסיעה של הקו סביב השעה הזו')]);

      s.r.time_min = T.minutesIL(pick.main.start);
      s.r.vehicles = pick.main.vehicle;
      s.r.alt_vehicles = [pick.before, pick.after].filter(Boolean).map((x) => x.vehicle).join(',');
      const pre = pick.exact
        ? [t('האוטובוס זוהה')]
        : [t('לא מצאנו נסיעה שיצאה בדיוק בשעה הזו'), t('הנסיעה הקרובה יצאה'), timeParts(s.r.time_min)];
      pre.push(t('מספר הרישוי'), d(s.r.vehicles), t('שוב'), d(s.r.vehicles));
      return screens.confirm(s, pre);
    },

    confirm(s, v) {
      if (v === '1') return screens.record(s);
      if (v === '2') return screens.depTime(s);
      return screens.confirm(s, [t('בחירה לא תקינה')]);
    },

    record: (s) => save(s),

    async notifyAsk(s, v) {
      if (v === '2') return screens.main(s, [t('תודה רבה')]);
      if (v !== '1') return screens.notifyAsk(s, [t('בחירה לא תקינה')]);
      s.dirs = [];
      if (s.r.line && s.r.agency) {
        try {
          s.dirs = (await openbus.findRoutes(today(), s.r.line, '')).filter((r) => r.agency === s.r.agency);
        } catch (e) { console.error('findRoutes(dirs)', e.message); }
      }
      if (!s.dirs.length) return subscribe(s, '*');
      return screens.notifyDir(s);
    },

    notifyDir(s, v) {
      if (v === '9') return subscribe(s, '*');
      const r = s.dirs[Number(v) - 1];
      if (!r || Number(v) < 1 || Number(v) > 8) return screens.notifyDir(s, [t('בחירה לא תקינה')]);
      return subscribe(s, r.lineRefs.join(','));
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
          return screens.mine(s, [t('האוטובוס נוסע כעת ב'), rideParts(ride, now())]);
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

  // המאגר לא זמין: ממשיכים בלי זיהוי רכב, הדיווח יישמר לפי הקו והשעה
  function noDatabase(s) {
    s.r.route_desc = ''; s.r.line_refs = '';
    return screens.depTime(s, [t('מאגר האוטובוסים לא זמין כרגע נשמור את הדיווח לפי הקו והשעה')]);
  }

  // רישום לצינתוק. הנסיעה שהרכב נמצא בה עכשיו לא תיחשב "מסלול חדש".
  async function subscribe(s, lines) {
    let rideId = null;
    try { rideId = (await openbus.currentRide(match.list(s.saved.vehicles)[0]))?.rideId ?? null; } catch { /* לא חובה */ }
    db.setNotify(s.saved.id, lines, rideId);
    return screens.main(s, [
      t('נרשמתם בהצלחה'),
      t('כאשר האוטובוס יתחיל מסלול חדש תקבלו צינתוק'),
      t('נתקו והתקשרו אלינו ותשמעו באיזה קו ובאיזו שעה הוא יצא'),
    ]);
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
