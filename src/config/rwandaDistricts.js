const { haversineKm } = require('../utils/geo');

/**
 * Rwanda's 30 districts with an approximate centre point, used for kitchens'
 * big-event delivery coverage ("I deliver to Gasabo, Kicukiro and Bugesera").
 *
 * KitchenLink has no district boundary data, so a point belongs to the
 * district whose centre (or, in Kigali, a known sector) is nearest — a
 * Voronoi approximation. That is right well inside a district and can be
 * wrong within a few km of a border; a
 * customer near a border who is told "outside coverage" can still request a
 * special delivery, so a wrong guess never blocks an order.
 */
const DISTRICTS = [
  // Kigali City
  // Kigali's districts are small and interlocked, so they get extra
  // reference points (well-known sectors) besides their centre.
  {
    code: 'gasabo', name: 'Gasabo', province: 'Kigali City', lat: -1.885, lng: 30.135,
    seeds: [[-1.955, 30.105], [-1.945, 30.125], [-1.94, 30.085], [-1.92, 30.06], [-1.93, 30.18], [-1.89, 30.05], [-1.84, 30.12]],
  },
  {
    code: 'kicukiro', name: 'Kicukiro', province: 'Kigali City', lat: -2.01, lng: 30.13,
    seeds: [[-1.982, 30.1], [-1.97, 30.15], [-1.978, 30.075], [-1.99, 30.115], [-2.03, 30.12], [-2.0, 30.2]],
  },
  {
    code: 'nyarugenge', name: 'Nyarugenge', province: 'Kigali City', lat: -1.96, lng: 30.04,
    seeds: [[-1.948, 30.06], [-1.98, 30.04], [-1.952, 30.045], [-2.03, 29.99], [-1.93, 30.0]],
  },
  // Eastern Province
  { code: 'bugesera', name: 'Bugesera', province: 'Eastern', lat: -2.23, lng: 30.16 },
  { code: 'gatsibo', name: 'Gatsibo', province: 'Eastern', lat: -1.58, lng: 30.45 },
  { code: 'kayonza', name: 'Kayonza', province: 'Eastern', lat: -1.9, lng: 30.62 },
  { code: 'kirehe', name: 'Kirehe', province: 'Eastern', lat: -2.26, lng: 30.7 },
  { code: 'ngoma', name: 'Ngoma', province: 'Eastern', lat: -2.16, lng: 30.47 },
  { code: 'nyagatare', name: 'Nyagatare', province: 'Eastern', lat: -1.3, lng: 30.33 },
  { code: 'rwamagana', name: 'Rwamagana', province: 'Eastern', lat: -1.95, lng: 30.43 },
  // Northern Province
  { code: 'burera', name: 'Burera', province: 'Northern', lat: -1.47, lng: 29.83 },
  { code: 'gakenke', name: 'Gakenke', province: 'Northern', lat: -1.69, lng: 29.78 },
  { code: 'gicumbi', name: 'Gicumbi', province: 'Northern', lat: -1.63, lng: 30.07 },
  { code: 'musanze', name: 'Musanze', province: 'Northern', lat: -1.5, lng: 29.6 },
  { code: 'rulindo', name: 'Rulindo', province: 'Northern', lat: -1.73, lng: 30.0 },
  // Southern Province
  { code: 'gisagara', name: 'Gisagara', province: 'Southern', lat: -2.6, lng: 29.83 },
  { code: 'huye', name: 'Huye', province: 'Southern', lat: -2.6, lng: 29.74 },
  { code: 'kamonyi', name: 'Kamonyi', province: 'Southern', lat: -2.0, lng: 29.9 },
  { code: 'muhanga', name: 'Muhanga', province: 'Southern', lat: -2.08, lng: 29.75 },
  { code: 'nyamagabe', name: 'Nyamagabe', province: 'Southern', lat: -2.45, lng: 29.45 },
  { code: 'nyanza', name: 'Nyanza', province: 'Southern', lat: -2.35, lng: 29.75 },
  { code: 'nyaruguru', name: 'Nyaruguru', province: 'Southern', lat: -2.7, lng: 29.5 },
  { code: 'ruhango', name: 'Ruhango', province: 'Southern', lat: -2.22, lng: 29.78 },
  // Western Province
  { code: 'karongi', name: 'Karongi', province: 'Western', lat: -2.08, lng: 29.4 },
  { code: 'ngororero', name: 'Ngororero', province: 'Western', lat: -1.87, lng: 29.62 },
  { code: 'nyabihu', name: 'Nyabihu', province: 'Western', lat: -1.65, lng: 29.5 },
  { code: 'nyamasheke', name: 'Nyamasheke', province: 'Western', lat: -2.33, lng: 29.1 },
  { code: 'rubavu', name: 'Rubavu', province: 'Western', lat: -1.7, lng: 29.33 },
  { code: 'rusizi', name: 'Rusizi', province: 'Western', lat: -2.48, lng: 28.95 },
  { code: 'rutsiro', name: 'Rutsiro', province: 'Western', lat: -1.93, lng: 29.33 },
];

const BY_CODE = new Map(DISTRICTS.map((district) => [district.code, district]));
const DISTRICT_CODES = DISTRICTS.map((district) => district.code);

const districtByCode = (code) => BY_CODE.get(code) || null;

/** The district a point falls in (nearest district centre), or null for bad input. */
function districtFor(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  let best = null;
  let bestKm = Infinity;
  for (const district of DISTRICTS) {
    for (const [lat, lng] of [[district.lat, district.lng], ...(district.seeds || [])]) {
      const km = haversineKm(latitude, longitude, lat, lng);
      if (km < bestKm) {
        best = district;
        bestKm = km;
      }
    }
  }
  return best;
}

const publicDistrict = ({ code, name, province }) => ({ code, name, province });

module.exports = { DISTRICTS, DISTRICT_CODES, districtByCode, districtFor, publicDistrict };
