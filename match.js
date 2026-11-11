// מנוע השידוך: מחפש לדיווח חדש דיווחים מהצד השני ויוצר שידוכים
const { addDays } = require('./time');
const yemot = require('./yemot');

const list = (s) => (s ? String(s).split(',').filter(Boolean) : []);

// האם דיווח האבידה L ודיווח המציאה F מתאימים? מחזיר 'auto' / 'suggest' / null
function compare(L, F) {
  if (L.place !== F.place) return null;

  if (L.place === 'bus') {
    if (F.date < L.date || F.date > addDays(L.date, 1)) return null;
    const lv = list(L.vehicles), fv = list(F.vehicles);
    // אם זה אותו יום - המציאה לא בנסיעה שיצאה הרבה לפני האבידה
    const tooEarly = F.date === L.date && F.time_min != null && L.time_min != null && F.time_min < L.time_min - 60;
    if (lv.length && fv.length) {
      if (lv.some((v) => fv.includes(v))) return tooEarly ? null : 'auto';
      // הרכב של הנסיעה הקודמת / הבאה - אולי המתקשר טעה בשעה
      const la = [...lv, ...list(L.alt_vehicles)], fa = [...fv, ...list(F.alt_vehicles)];
      if (la.some((v) => fa.includes(v))) return tooEarly ? null : 'suggest';
      return null;
    }
    // לא אותרו רכבים (תקלה במאגר) - הצעה לפי קו ושעה קרובה (ועיר, אם ידועה לשניהם)
    const sameCity = L.city_key == null || F.city_key == null || L.city_key === F.city_key;
    if (L.line && L.line === F.line && sameCity && L.date === F.date
        && Math.abs((F.time_min ?? 0) - (L.time_min ?? 0)) <= 120) return 'suggest';
    return null;
  }

  // רחוב / מקום אחר: אותה קטגוריה ואותה עיר, המציאה עד שבועיים אחרי האבידה
  if (L.category === F.category && L.city_key === F.city_key
      && F.date >= addDays(L.date, -1) && F.date <= addDays(L.date, 14)) return 'suggest';
  return null;
}

// מריץ שידוך לדיווח חדש. המתקשר עצמו שומע את התוצאה בשיחה; הצד השני מקבל צינתוק.
function run(db, report) {
  const other = report.kind === 'lost' ? 'found' : 'lost';
  const cands = db.candidates({
    kind: other, place: report.place,
    dateFrom: addDays(report.date, report.kind === 'lost' ? -1 : -14),
    dateTo: addDays(report.date, report.kind === 'lost' ? 14 : 1),
    excludePhone: report.phone,
  });

  const created = [];
  for (const c of cands) {
    const L = report.kind === 'lost' ? report : c;
    const F = report.kind === 'lost' ? c : report;
    const kind = compare(L, F);
    if (!kind) continue;
    if (!db.addMatch(L.id, F.id, kind)) continue;
    created.push({ kind, other: c });
    // צינתוק לצד השני: בשידוך ודאי - תמיד; בהצעה - רק למאבד
    if (kind === 'auto' || c.kind === 'lost') yemot.tzintuk(c.phone, `match ${kind} L${L.id} F${F.id}`);
  }
  return created;
}

module.exports = { run, compare, list };
