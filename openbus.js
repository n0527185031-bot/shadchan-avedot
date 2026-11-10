// לקוח למאגר "Open Bus" של הסדנא לידע ציבורי - נתוני אוטובוסים כמעט בזמן אמת
const cfg = require('./config');

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

// איפה הרכב עכשיו: הקו והכיוון שבהם הוא נוסע (לפי דיווח מ-15 הדקות האחרונות)
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
  const day = new Date(loc.recorded_at_time).toISOString().slice(0, 10);
  const routes = await api('/gtfs_routes/list', {
    date_from: day, date_to: day, line_refs: loc.siri_route__line_ref, limit: 1,
  }, { cacheMin: 360 }).catch(() => []);
  const r = routes[0];
  const { from, to } = r ? parseLongName(r.route_long_name) : { from: '', to: '' };
  return {
    rideId: loc.siri_ride__id,
    recordedAt: loc.recorded_at_time,
    line: r ? r.route_short_name : '',
    agency: r ? r.agency_name : '',
    from, to,
    longName: r ? r.route_long_name : '',
  };
}

module.exports = { findRoutes, vehiclesAt, currentRide, parseLongName, _api: api };
