// עזרי זמן לפי שעון ישראל (כולל שעון קיץ)
const TZ = 'Asia/Jerusalem';

function offsetMin(date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName').value; // "GMT+02:00"
  const m = s.match(/([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// תאריך בישראל בפורמט YYYY-MM-DD
function dateIL(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// תאריך + דקות מחצות (שעון ישראל) -> Date
function ilToDate(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off = offsetMin(new Date(guess - offsetMin(new Date(guess)) * 60000));
  return new Date(guess - off * 60000);
}

// Date -> דקות מחצות לפי שעון ישראל
function minutesIL(d) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(d).split(':').map(Number);
  return h * 60 + m;
}

// "120526" (יום, חודש, שנה) -> "2026-05-12" ; תאריך לא קיים -> null
function parseDDMMYY(s) {
  const m = String(s).match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [dd, mm, yy] = [Number(m[1]), Number(m[2]), 2000 + Number(m[3])];
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return dt.toISOString().slice(0, 10);
}

// "0815" -> 495 ; לא תקין -> null
function parseHHMM(s) {
  const m = String(s).match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

module.exports = { dateIL, addDays, ilToDate, parseHHMM, minutesIL, parseDDMMYY };
