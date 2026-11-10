// בדיקה תקופתית: האם אוטובוס שבו מישהו איבד חפץ נוסע עכשיו בעיר שלו? אם כן - צינתוק
const cfg = require('./config');
const T = require('./time');
const yemot = require('./yemot');
const { list } = require('./match');

async function checkOnce(db, openbus) {
  const reports = db.trackable(T.addDays(T.dateIL(), -2));
  let sent = 0;
  for (const r of reports) {
    const vs = list(r.vehicles);
    if (vs.length !== 1) continue; // רק כשהרכב זוהה בוודאות
    let ride;
    try { ride = await openbus.currentRide(vs[0]); } catch { continue; }
    if (!ride || !ride.longName || ride.rideId === r.last_alert_ride) continue;
    const city = cfg.CITIES[r.notify_city];
    if (!ride.longName.includes(city)) continue;
    const text = `האוטובוס נוסע עכשיו בקו ${ride.line} של ${ride.agency} מ${ride.from} ל${ride.to}`;
    db.saveAlert(r.id, ride.rideId, text);
    yemot.tzintuk(r.phone, `bus in ${city} report ${r.id}`);
    sent += 1;
  }
  return sent;
}

function start(db, openbus) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await checkOnce(db, openbus); } catch (e) { console.error('tracker', e.message); }
    busy = false;
  }, cfg.TRACK_EVERY_MIN * 60000);
  timer.unref();
}

module.exports = { start, checkOnce };
