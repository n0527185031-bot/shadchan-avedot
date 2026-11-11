// סימולציית שיחות מול המערכת, עם מאגר אוטובוסים מדומה (בלי אינטרנט ובלי ימות המשיח)
const test = require('node:test');
const assert = require('node:assert');
const { open } = require('./db');
const { createIvr } = require('./ivr');
const yemot = require('./yemot');
const tracker = require('./tracker');
const T = require('./time');

// מאגר מדומה: קו 3 בבית שמש, שני כיוונים. ברכב 1111 נסעו בבוקר, ברכב 2222 בצהריים.
function fakeBus({ down = false } = {}) {
  return {
    async findRoutes(date, line, city) {
      if (down) throw new Error('down');
      if (line !== '3') return [];
      return [
        { agency: 'בית שמש אקספרס', from: 'מסוף הרכבת', to: 'קליין', line: '3', lineRefs: [101] },
        { agency: 'בית שמש אקספרס', from: 'קליין', to: 'מסוף הרכבת', line: '3', lineRefs: [102, 103] },
      ];
    },
    async vehiclesAt(refs, from) {
      const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(from));
      if (!refs.map(String).includes('101')) return ['9999'];
      return h < 12 ? ['1111'] : ['2222'];
    },
    async currentRide(v) {
      return { rideId: 77, line: '417', agency: 'אגד', from: 'בית שמש', to: 'ירושלים', longName: 'ת מרכזית-בית שמש<->ת מרכזית-ירושלים-1#' };
    },
  };
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

test('bus: lost then found on the same vehicle -> sure match, tzintuk, phones exchanged', async () => {
  const db = open(':memory:');
  const h = createIvr(db, fakeBus());
  yemot.log.length = 0;

  // מאבד: איבדתי > היום > קו 3 > בית שמש > כיוון 1 > 08:15 > הקלטה
  const a = await call(h, '0501111111', 'a');
  assert.match(a.last, /שדכן אבדות/);
  let r = await a.press('1', '1', '3', '3', '1', '0815', 'rec');
  assert.match(r, /זיהינו את האוטובוס מספר הרכב.d-1111/);
  assert.match(r, /כרגע אין התאמה/);
  assert.match(r, /בחרו עיר/); // הצעה לצינתוק כשהאוטובוס בעיר
  r = await a.press('1');
  assert.match(r, /נצנתק לכם כשהאוטובוס ייסע בירושלים/);

  // מוצא: מצאתי > היום > קו 3 > בית שמש > כיוון 1 > 09:00 (אותו רכב 1111)
  const b = await call(h, '0522222222', 'b');
  r = await b.press('2', '1', '3', '3', '1', '0900', 'rec');
  assert.match(r, /יש שידוך/);
  assert.match(r, /d-0501111111/); // המוצא שומע את טלפון המאבד
  assert.equal(yemot.log[0].phone, '0501111111'); // המאבד קיבל צינתוק

  // המאבד חוזר: מוכרז שידוך חדש, ושומע את טלפון המוצא
  const a2 = await call(h, '0501111111', 'a2');
  assert.match(a2.last, /יש לכם.n-1.t-שידוכים חדשים/);
  r = await a2.press('3');
  assert.match(r, /שידוך ודאי באותו אוטובוס/);
  assert.match(r, /d-0522222222/);
  r = await a2.press('9');
  assert.match(r, /החפץ הוחזר/);
  assert.equal(db.myReports('0501111111').length, 0);
});

test('bus: different vehicle (afternoon) -> no match', async () => {
  const db = open(':memory:');
  const h = createIvr(db, fakeBus());
  await (await call(h, '0501', 'a')).press('1', '1', '3', '3', '1', '0815', 'rec', '0');
  const r = await (await call(h, '0502', 'b')).press('2', '1', '3', '3', '1', '1500', 'rec');
  assert.match(r, /כרגע אין התאמה/);
});

test('bus: Open Bus down -> report saved by line, suggest match on line+city+time', async () => {
  const db = open(':memory:');
  const h = createIvr(db, fakeBus({ down: true }));
  let r = await (await call(h, '0501', 'a')).press('1', '1', '3', '3');
  assert.match(r, /מאגר האוטובוסים לא זמין/);
  r = await (await call(h, '0501', 'a')).press('0815', 'rec');
  yemot.log.length = 0;
  r = await (await call(h, '0502', 'b')).press('2', '1', '3', '3', '0900', 'rec');
  assert.match(r, /שלחנו צינתוק למי שאיבד חפץ דומה/);
  assert.equal(yemot.log[0].phone, '0501');
});

test('tracker: tzintuk when the bus drives in the chosen city, once per ride', async () => {
  const db = open(':memory:');
  const bus = fakeBus();
  const h = createIvr(db, bus);
  await (await call(h, '0501', 'a')).press('1', '1', '3', '3', '1', '0815', 'rec', '1');
  yemot.log.length = 0;
  assert.equal(await tracker.checkOnce(db, bus), 1);
  assert.equal(await tracker.checkOnce(db, bus), 0);
  const a2 = await call(h, '0501', 'a2');
  assert.match(a2.last, /עדכון על האוטובוס שבו איבדתם.t-האוטובוס נוסע עכשיו בקו 417/);
  const r = await a2.press('4', '4');
  assert.match(r, /האוטובוס נוסע עכשיו בקו 417/);
});

test('time helpers', () => {
  assert.equal(T.parseHHMM('0815'), 495);
  assert.equal(T.parseHHMM('2460'), null);
  // 08:15 בישראל בחורף = 06:15 UTC
  assert.equal(T.ilToDate('2026-01-15', 495).toISOString(), '2026-01-15T06:15:00.000Z');
  // 08:15 בישראל בקיץ = 05:15 UTC
  assert.equal(T.ilToDate('2026-07-15', 495).toISOString(), '2026-07-15T05:15:00.000Z');
});

test('bus only: main menu goes straight to the date question', async () => {
  const h = createIvr(open(':memory:'), fakeBus());
  const a = await call(h, '0501', 'z');
  assert.match(a.last, /שדכן אבדות באוטובוסים/);
  assert.doesNotMatch(a.last, /ברחוב/);
  assert.match(await a.press('1'), /מתי נסעתם/);
  assert.match(await a.press('0'), /איבדתי חפץ באוטובוס הקישו 1/);
});
