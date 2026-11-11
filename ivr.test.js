// סימולציית שיחות מול המערכת, עם מאגר אוטובוסים מדומה (בלי אינטרנט ובלי ימות המשיח)
const test = require('node:test');
const assert = require('node:assert');
const { open } = require('./db');
const { createIvr } = require('./ivr');
const yemot = require('./yemot');
const tracker = require('./tracker');
const T = require('./time');
const { pickRide } = require('./openbus');

// מאגר מדומה: קו 3 של "בית שמש אקספרס". תחנה 1992 נמצאת רק בכיוון לקליין (מסלול 101).
// יציאות כל רבע שעה מ-08:00 עד 10:00; לכל יציאה רכב אחר ("V0800", "V0815"...).
function fakeBus({ down = false, ride = null } = {}) {
  const routes = [
    { agency: 'בית שמש אקספרס', from: 'מסוף הרכבת', to: 'קליין', line: '3', stopName: 'מרכז מסחרי', lineRefs: [101] },
    { agency: 'בית שמש אקספרס', from: 'קליין', to: 'מסוף הרכבת', line: '3', stopName: 'מרכז מסחרי', lineRefs: [102] },
  ];
  const bus = {
    calls: [],
    async routesAtStop(date, stop, line) {
      if (down) throw new Error('down');
      return stop === '1992' && line === '3' ? [routes[0]] : [];
    },
    async findRoutes(date, line) {
      if (down) throw new Error('down');
      return line === '3' ? routes : [];
    },
    async ridesNear(refs, date) {
      bus.calls.push(refs);
      const out = [];
      for (let m = 8 * 60; m <= 10 * 60; m += 15) {
        const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
        out.push({ start: T.ilToDate(date, m), vehicle: `${refs[0]}${hhmm}`, rideId: m });
      }
      return out;
    },
    pickRide,
    async currentRide() { return ride; },
  };
  return bus;
}

function call(handle, phone, id) {
  const params = { ApiCallId: id, ApiPhone: phone };
  let last;
  const c = {
    async start() { last = await handle({ ...params }); return c; },
    get last() { return last; },
    async press(...vals) {
      for (const v of vals) {
        const m = last.match(/=([^=,&]+),no,/);
        assert.ok(m, `no read in: ${last}`);
        params[m[1]] = v;
        last = await handle({ ...params });
      }
      return last;
    },
  };
  return c.start();
}

test('stop flow: date today, stop+line identify company, departure time -> plate, before/after saved', async () => {
  const db = open(':memory:');
  const h = createIvr(db, fakeBus());
  const a = await call(h, '0501111111', 'a');
  assert.match(a.last, /שדכן אבדות באוטובוסים/);

  let r = await a.press('1');                       // איבדתי
  assert.match(r, /לתאריך של היום הקישו 0 וסולמית/);
  r = await a.press('0');                           // היום
  assert.match(r, /אם אתם זוכרים את מספר התחנה הקישו 1/);
  r = await a.press('1', '1992');                   // תחנה
  assert.match(r, /הקישו את מספר הקו/);
  r = await a.press('3');                           // קו -> החברה מזוהה לבד
  assert.match(r, /קו 3 של בית שמש אקספרס לכיוון קליין.t-מתחנת מרכז מסחרי/);
  assert.match(r, /שעת היציאה הרשמית/);
  r = await a.press('0900');                        // שעת יציאה
  assert.match(r, /האוטובוס זוהה.t-מספר הרישוי.d-1010900/);
  assert.match(r, /לשמירת מספר הרישוי בדיווח הקישו 1/);
  r = await a.press('1', 'rec');
  assert.match(r, /הדיווח נשמר בהצלחה/);
  assert.match(r, /שמרנו גם את האוטובוסים של הנסיעה הקודמת והבאה/);
  assert.match(r, /לקבלת צינתוק כאשר האוטובוס הזה מתחיל מסלול חדש הקישו 1/);

  const saved = db.myReports('0501111111')[0];
  assert.equal(saved.vehicles, '1010900');
  assert.equal(saved.alt_vehicles, '1010845,1010915');
  assert.equal(saved.stop_code, '1992');
  assert.equal(saved.time_min, 540);
});

test('date: other date DDMMYY, invalid and future dates rejected', async () => {
  const h = createIvr(open(':memory:'), fakeBus());
  const a = await call(h, '0501', 'd');
  await a.press('1');
  assert.match(await a.press('310299'), /תאריך לא תקין/);
  const tomorrow = T.addDays(T.dateIL(), 1).split('-');
  assert.match(await a.press(tomorrow[2] + tomorrow[1] + tomorrow[0].slice(2)), /עוד לא הגיע/);
  const y = T.addDays(T.dateIL(), -1).split('-');
  assert.match(await a.press(y[2] + y[1] + y[0].slice(2)), /מספר התחנה/);
});

test('departure time not exact -> nearest ride announced', async () => {
  const h = createIvr(open(':memory:'), fakeBus());
  const a = await call(h, '0501', 'n');
  const r = await a.press('1', '0', '1', '1992', '3', '0911');
  assert.match(r, /לא מצאנו נסיעה שיצאה בדיוק בשעה הזו.t-הנסיעה הקרובה יצאה.t-של השעה.n-9.t-ו.n-15/);
  assert.match(r, /d-1010915/);
  assert.match(await a.press('2'), /שעת היציאה הרשמית/); // 2 = להקיש שעה אחרת
});

test('stop not found -> back to stop question', async () => {
  const h = createIvr(open(':memory:'), fakeBus());
  const a = await call(h, '0501', 's');
  const r = await a.press('1', '0', '1', '5555', '3');
  assert.match(r, /לא מצאנו את קו 3 בתחנה מספר.d-5555/);
  assert.match(r, /אם אתם זוכרים את מספר התחנה/);
});

test('no stop: line + city + direction, then same departure-time flow', async () => {
  const h = createIvr(open(':memory:'), fakeBus());
  const a = await call(h, '0501', 'x');
  let r = await a.press('1', '0', '2', '3', '3');
  assert.match(r, /בחרו את הכיוון/);
  r = await a.press('2', '0815');
  assert.match(r, /d-1020815/);
});

test('lost then found on the same vehicle -> sure match, tzintuk, phones exchanged', async () => {
  const db = open(':memory:');
  const h = createIvr(db, fakeBus());
  yemot.log.length = 0;
  await (await call(h, '0501111111', 'a')).press('1', '0', '1', '1992', '3', '0900', '1', 'rec', '2');
  const r = await (await call(h, '0522222222', 'b')).press('2', '0', '1', '1992', '3', '0900', '1', 'rec');
  assert.match(r, /יש שידוך/);
  assert.match(r, /d-0501111111/);
  assert.equal(yemot.log[0].phone, '0501111111');

  const a2 = await call(h, '0501111111', 'a2');
  assert.match(a2.last, /יש לכם.n-1.t-שידוכים חדשים/);
  assert.match(await a2.press('3'), /שידוך ודאי באותו אוטובוס.*d-0522222222/);
});

test('neighbour ride (caller off by one departure) -> suggestion, not sure match', async () => {
  const db = open(':memory:');
  const h = createIvr(db, fakeBus());
  await (await call(h, '0501', 'a')).press('1', '0', '1', '1992', '3', '0900', '1', 'rec', '2');
  yemot.log.length = 0;
  const r = await (await call(h, '0502', 'b')).press('2', '0', '1', '1992', '3', '0915', '1', 'rec');
  assert.match(r, /שלחנו צינתוק למי שאיבד חפץ באוטובוס שעשוי להתאים/);
  assert.equal(yemot.log[0].phone, '0501');
  assert.equal(db.allMatches()[0].kind, 'suggest');
});

test('Open Bus down -> report saved by line and time', async () => {
  const db = open(':memory:');
  const h = createIvr(db, fakeBus({ down: true }));
  const a = await call(h, '0501', 'a');
  let r = await a.press('1', '0', '1', '1992', '3');
  assert.match(r, /מאגר האוטובוסים לא זמין/);
  r = await a.press('0900', 'rec');
  assert.match(r, /הדיווח נשמר בהצלחה/);
  assert.equal(db.myReports('0501')[0].line, '3');
});

test('tzintuk subscription: choose direction, alert only when the bus starts a new ride in that direction', async () => {
  const db = open(':memory:');
  const bus = fakeBus();
  const h = createIvr(db, bus);
  const a = await call(h, '0501', 'a');
  let r = await a.press('1', '0', '1', '1992', '3', '0900', '1', 'rec', '1');
  assert.match(r, /בחרו כיוון/);
  assert.match(r, /כשהאוטובוס יוצא בקו 3 לכיוון מסוף הרכבת הקישו 2/);
  assert.match(r, /לכל מסלול חדש של האוטובוס בכל קו הקישו 9/);
  r = await a.press('2'); // רק כשהוא חוזר לכיוון מסוף הרכבת (מסלול 102)
  assert.match(r, /נרשמתם בהצלחה.*נתקו והתקשרו אלינו/);
  assert.equal(db.myReports('0501')[0].notify_lines, '102');

  const nowMs = Date.now();
  yemot.log.length = 0;
  // נסיעה בכיוון השני (101) - אין צינתוק
  bus.currentRide = async () => ({ rideId: 1, lineRef: 101, line: '3', agency: 'בית שמש אקספרס', to: 'קליין',
    scheduledStart: new Date(nowMs - 2 * 60000).toISOString(), recordedAt: new Date(nowMs - 60000).toISOString() });
  assert.equal(await tracker.checkOnce(db, bus), 0);
  // נסיעה שהתחילה לפני שעה - אין צינתוק
  bus.currentRide = async () => ({ rideId: 2, lineRef: 102, line: '3', agency: 'בית שמש אקספרס', to: 'מסוף הרכבת',
    scheduledStart: new Date(nowMs - 60 * 60000).toISOString(), recordedAt: new Date(nowMs - 60000).toISOString() });
  assert.equal(await tracker.checkOnce(db, bus), 0);
  // נסיעה חדשה בכיוון שנבחר - צינתוק פעם אחת
  const fresh = { rideId: 3, lineRef: 102, line: '3', agency: 'בית שמש אקספרס', to: 'מסוף הרכבת',
    scheduledStart: T.ilToDate(T.dateIL(new Date(nowMs)), T.minutesIL(new Date(nowMs - 3 * 60000))).toISOString(),
    recordedAt: new Date(nowMs - 2 * 60000).toISOString() };
  bus.currentRide = async () => fresh;
  assert.equal(await tracker.checkOnce(db, bus), 1);
  assert.equal(await tracker.checkOnce(db, bus), 0);
  assert.equal(yemot.log[0].phone, '0501');

  // המאבד מתקשר חזרה ושומע: התחיל כעת קו 3 של השעה... לכיוון... שידר לפני 2 דקות
  const back = await call(h, '0501', 'back');
  assert.match(back.last, /האוטובוס שבו איבדתם מספר רישוי.d-1010900.t-התחיל כעת.t-קו 3 של בית שמש אקספרס.t-של השעה/);
  assert.match(back.last, /לכיוון מסוף הרכבת.t-שידר לפני.n-2.t-דקות/);
});

test('time helpers', () => {
  assert.equal(T.parseHHMM('0815'), 495);
  assert.equal(T.parseHHMM('2460'), null);
  assert.equal(T.parseDDMMYY('120526'), '2026-05-12');
  assert.equal(T.parseDDMMYY('300226'), null);
  assert.equal(T.ilToDate('2026-01-15', 495).toISOString(), '2026-01-15T06:15:00.000Z');
  assert.equal(T.ilToDate('2026-07-15', 495).toISOString(), '2026-07-15T05:15:00.000Z');
  assert.equal(T.minutesIL(new Date('2026-11-11T07:00:00Z')), 540);
});
