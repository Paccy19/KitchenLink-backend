/**
 * Opening-hours helpers. A kitchen's weekly schedule is
 * `[{ day: 'monday', open_time: '08:00', close_time: '22:00', is_closed }]`,
 * in Rwanda local time (config.vendor.timezoneOffsetHours, UTC+2, no DST).
 */
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const toMinutes = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
};

/**
 * The next time the kitchen opens after `now`, from its weekly schedule:
 * `{ day, time, day_offset }` (0 = later today, 1 = tomorrow…), or null when
 * the schedule has no usable opening time.
 */
function nextOpening(operatingHours, { now = new Date(), offsetHours = 2 } = {}) {
  if (!Array.isArray(operatingHours) || operatingHours.length === 0) return null;
  const local = new Date(now.getTime() + offsetHours * 3_600_000);
  const today = local.getUTCDay();
  const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();

  const byDay = new Map();
  operatingHours.forEach((entry) => {
    const day = String(entry?.day || '').toLowerCase();
    const open = toMinutes(entry?.open_time);
    if (DAYS.includes(day) && !entry.is_closed && open !== null) byDay.set(day, { open, time: entry.open_time });
  });

  for (let offset = 0; offset <= 7; offset += 1) {
    const day = DAYS[(today + offset) % 7];
    const slot = byDay.get(day);
    if (slot && (offset > 0 || slot.open > nowMinutes)) {
      return { day, time: slot.time, day_offset: offset };
    }
  }
  return null;
}

module.exports = { nextOpening };
