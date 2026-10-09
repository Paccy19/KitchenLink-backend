/**
 * Day-boundary helpers. Rwanda runs on CAT (UTC+2) year-round, so "today"
 * is computed against a fixed offset without DST complications.
 */

const startOfDay = (date, offsetHours) => {
  const shifted = new Date(date.getTime() + offsetHours * 60 * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetHours * 60 * 60 * 1000);
};

const todayRange = (offsetHours, now = new Date()) => {
  const start = startOfDay(now, offsetHours);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
};

module.exports = { startOfDay, todayRange };
