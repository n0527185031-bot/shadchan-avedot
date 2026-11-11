// בדיקה תקופתית: האם האוטובוס שבו מישהו איבד חפץ התחיל עכשיו נסיעה חדשה? אם כן - צינתוק.
// המאבד מנתק, מתקשר חזרה, ושומע באיזה קו ובאיזו שעה האוטובוס יצא.
const cfg = require('./config');
const T = require('./time');
const yemot = require('./yemot');
const { list } = require('./match');

// נסיעה "התחילה עכשיו" אם שעת היציאה הרשמית שלה הייתה ב-20 הדקות האחרונות (או עוד מעט)
const JUST_STARTED_MIN = 20;

async function checkOnce(db, openbus, now = () => Date.now()) {
  const reports = db.trackable(T.addDays(T.dateIL(new Date(now())), -2));
  let sent = 0;
  for (const r of reports) {
    const vs = list(r.vehicles);
    if (vs.length !== 1) continue; // רק כשהרכב זוהה בוודאות
    let ride;
    try { ride = await openbus.currentRide(vs[0]); } catch { continue; }
    if (!ride || ride.rideId === r.last_alert_ride) continue;
    if (r.notify_lines !== '*' && !list(r.notify_lines).includes(String(ride.lineRef))) continue;
    const startedAgo = (now() - new Date(ride.scheduledStart)) / 60000;
    if (startedAgo > JUST_STARTED_MIN || startedAgo < -10) continue;
    db.saveAlert(r.id, ride.rideId, `קו ${ride.line} לכיוון ${ride.to}`);
    yemot.tzintuk(r.phone, `bus ${vs[0]} started line ${ride.line} report ${r.id}`);
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

module.exports = { start, checkOnce, JUST_STARTED_MIN };
