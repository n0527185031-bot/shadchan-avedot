// לקוח למאגר "Open Bus" של הסדנא לידע ציבורי - נתוני אוטובוסים כמעט בזמן אמת
const cfg = require('./config');
const { dateIL, ilToDate, addDays } = require('./time');

const cache = new Map();
const TIMEOUT_MS = 8000;

async function api(path, params, { cacheMin = 0 } = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  const url = `${cfg.OPEN_BUS_API}${path}?${qs}`;
  if (cacheMin) {
    const hit = cache.get(url);
    if (hit && hit.until > Date.now()) return hit.data;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Open Bus error on ${path}`);
  if (cacheMin) cache.set(url, { data, until: Date.now() + cacheMin * 60000 });
  return data;
}

// "מסוף הרכבת/איסוף-בית שמש<->קליין/אהרונסון-בית שמש-10" -> { from, to }
function parseLongName(name) {
  const [from = '', rest = ''] = String(name).split('<->');
  const to = rest.replace(/-[\d#]+$/, '');
  const pretty = (s) => s.replace(/[/\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return { from: pretty(from), to: pretty(to) };
}

// כל הכיוונים של קו מסוים בתאריך נתון, אופציונלית רק כאלה שעוברים בעיר.
// חלופות של אותו מסלול (אותה חברה ואותו יעד) מאוחדות לאפשרות אחת.
async function findRoutes(date, lineNumber, city) {
  const rows = await api('/gtfs_routes/list', {
    date_from: date, date_to: date, route_short_name: lineNumber,
    route_long_name_contains: city, limit: 200,
  }, { cacheMin: 360 });
  const groups = new Map();
  for (const r of rows) {
    const { from, to } = parseLongName(r.route_long_name);
    const key = `${r.agency_name}|${to}`;
    if (!groups.has(key)) groups.set(key, { agency: r.agency_name, from, to, line: r.route_short_name, lineRefs: [] });
    groups.get(key).lineRefs.push(r.line_ref);
  }
  return [...groups.values()];
}

// מספרי הרכבים שנסעו בקו (לפי line_refs) בחלון הזמן
async function vehiclesAt(lineRefs, from, to) {
  const lists = await Promise.all(lineRefs.map((ref) =>
    api('/siri_vehicle_locations/list', {
      siri_routes__line_ref: ref,
      recorded_at_time_from: from.toISOString(),
      recorded_at_time_to: to.toISOString(),
      limit: 500,
    }).catch(() => [])
  ));
  const set = new Set();
  for (const list of lists) for (const x of list) if (x.siri_ride__vehicle_ref) set.add(String(x.siri_ride__vehicle_ref));
  return [...set];
}

// איפה הרכב עכשיו: באיזו נסיעה הוא נמצא (לפי דיווח מ-15 הדקות האחרונות)
async function currentRide(vehicle) {
  const now = new Date();
  const locs = await api('/siri_vehicle_locations/list', {
    siri_ride__vehicle_ref: vehicle,
    recorded_at_time_from: new Date(now - 15 * 60000).toISOString(),
    recorded_at_time_to: now.toISOString(),
    order_by: 'recorded_at_time desc',
    limit: 1,
  });
  if (!locs.length) return null;
  const loc = locs[0];
  const day = dateIL(new Date(loc.recorded_at_time));
  const routes = await api('/gtfs_routes/list', {
    date_from: day, date_to: day, line_refs: loc.siri_route__line_ref, limit: 1,
  }, { cacheMin: 360 }).catch(() => []);
  const r = routes[0];
  const { from, to } = r ? parseLongName(r.route_long_name) : { from: '', to: '' };
  return {
    rideId: loc.siri_ride__id,
    lineRef: loc.siri_route__line_ref,
    recordedAt: loc.recorded_at_time,
    scheduledStart: loc.siri_ride__scheduled_start_time,
    line: r ? r.route_short_name : '',
    agency: r ? r.agency_name : '',
    from, to,
    longName: r ? r.route_long_name : '',
  };
}

// איזה קווים במספר הזה עוברים בתחנה (לפי מספר התחנה שעל השלט) בתאריך נתון.
// מזהה לבד את החברה ואת הכיוון.
async function routesAtStop(date, stopCode, lineNumber) {
  const rows = await api('/gtfs_ride_stops/list', {
    gtfs_stop__code: stopCode,
    gtfs_route__route_short_name: lineNumber,
    gtfs_stop__date_from: date, gtfs_stop__date_to: date,
    gtfs_route__date_from: date, gtfs_route__date_to: date,
    arrival_time_from: ilToDate(addDays(date, -1), 20 * 60).toISOString(),
    arrival_time_to: ilToDate(addDays(date, 1), 6 * 60).toISOString(),
    limit: 500,
  }, { cacheMin: 360 });
  const groups = new Map();
  for (const r of rows) {
    const { from, to } = parseLongName(r.gtfs_route__route_long_name);
    const key = `${r.gtfs_route__agency_name}|${to}`;
    if (!groups.has(key)) {
      groups.set(key, {
        agency: r.gtfs_route__agency_name, from, to, line: r.gtfs_route__route_short_name,
        stopName: r.gtfs_stop__name, lineRefs: [],
      });
    }
    const g = groups.get(key);
    if (!g.lineRefs.includes(r.gtfs_route__line_ref)) g.lineRefs.push(r.gtfs_route__line_ref);
  }
  return [...groups.values()];
}

// הנסיעות של הקו סביב שעת יציאה רשמית (שעון ישראל), ממוינות לפי שעה.
// כל נסיעה: { start: Date, vehicle, rideId }
async function ridesNear(lineRefs, date, minutes, spanMin = 120) {
  const at = ilToDate(date, minutes);
  const lists = await Promise.all(lineRefs.map((ref) =>
    api('/siri_rides/list', {
      siri_route__line_refs: ref,
      scheduled_start_time_from: new Date(at - spanMin * 60000).toISOString(),
      scheduled_start_time_to: new Date(+at + spanMin * 60000).toISOString(),
      order_by: 'scheduled_start_time asc',
      limit: 100,
    })
  ));
  return lists.flat()
    .filter((r) => r.vehicle_ref)
    .map((r) => ({ start: new Date(r.scheduled_start_time), vehicle: String(r.vehicle_ref), rideId: r.id }))
    .sort((a, b) => a.start - b.start);
}

// מזהה את הנסיעה לפי שעת היציאה הרשמית, ואת הנסיעות שלפניה ואחריה.
// exact=true כשנמצאה נסיעה עד 3 דקות מהשעה שהוקשה; אחרת הנסיעה הקרובה (עד 40 דקות).
function pickRide(rides, date, minutes) {
  const at = +ilToDate(date, minutes);
  let best = -1;
  rides.forEach((r, i) => {
    if (best < 0 || Math.abs(r.start - at) < Math.abs(rides[best].start - at)) best = i;
  });
  if (best < 0 || Math.abs(rides[best].start - at) > 40 * 60000) return null;
  const main = rides[best];
  const before = [...rides.slice(0, best)].reverse().find((r) => r.vehicle !== main.vehicle);
  const after = rides.slice(best + 1).find((r) => r.vehicle !== main.vehicle);
  return { main, before, after, exact: Math.abs(main.start - at) <= 3 * 60000 };
}

module.exports = { findRoutes, vehiclesAt, currentRide, routesAtStop, ridesNear, pickRide, parseLongName, _api: api };
