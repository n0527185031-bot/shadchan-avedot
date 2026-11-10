// צינתוקים דרך ה-API של ימות המשיח
const cfg = require('./config');

const log = []; // היסטוריה (לבדיקות ולדף הניהול)

async function tzintuk(phone, reason) {
  log.unshift({ phone, reason, at: new Date().toISOString() });
  log.length = Math.min(log.length, 200);
  if (!cfg.YEMOT_TOKEN) {
    console.log(`[tzintuk - no token] ${phone}: ${reason}`);
    return;
  }
  const url = new URL('https://www.call2all.co.il/ym/api/RunTzintuk');
  url.searchParams.set('token', cfg.YEMOT_TOKEN);
  url.searchParams.set('phones', phone);
  url.searchParams.set('TzintukTimeOut', '9');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => ({}));
    if (body.responseStatus !== 'OK') console.error('Tzintuk failed:', phone, body);
  } catch (e) {
    console.error('Tzintuk error:', e.message);
  }
}

module.exports = { tzintuk, log };
