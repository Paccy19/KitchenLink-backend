const ApiError = require('./ApiError');

const roundKm = (value) => Math.round(Number(value) * 10) / 10;

/**
 * Fee by distance ranges (the admin's delivery fees, a kitchen's event
 * delivery). Each range covers [from_km, to_km); the ranges start at 0 km,
 * follow each other with no gaps or overlaps, and the last one has no end
 * ("6 km and more") so every distance has a price. Returns them sorted.
 */
function parseDistanceFeeRanges(rawRanges, { minFee, maxFee, maxKm }) {
  if (!Array.isArray(rawRanges)) {
    throw ApiError.badRequest('ranges is required.', { ranges: 'expected a list of distance ranges' });
  }
  const ranges = rawRanges.map((raw, index) => {
    const label = `Range ${index + 1}`;
    const from = roundKm(raw?.from_km);
    const to = raw?.to_km === null || raw?.to_km === '' || raw?.to_km === undefined ? null : roundKm(raw.to_km);
    const fee = Number(raw?.fee_rwf);
    if (!Number.isFinite(from) || from < 0 || from > maxKm) {
      throw ApiError.badRequest(`${label}: the start must be between 0 and ${maxKm} km.`, { ranges: 'invalid from_km' });
    }
    if (to !== null && (!Number.isFinite(to) || to <= from || to > maxKm)) {
      throw ApiError.badRequest(`${label}: the end must be more than the start (${from} km).`, { ranges: 'invalid to_km' });
    }
    if (!Number.isInteger(fee) || fee < minFee || fee > maxFee) {
      throw ApiError.badRequest(
        `${label}: the fee must be a whole number of at least ${minFee} RWF (and at most ${maxFee.toLocaleString('en-US')} RWF).`,
        { ranges: `fee_rwf must be ${minFee}-${maxFee}` }
      );
    }
    return { from_km: from, to_km: to, fee_rwf: fee };
  });
  ranges.sort((a, b) => a.from_km - b.from_km);

  if (ranges.length) {
    if (ranges[0].from_km !== 0) {
      throw ApiError.badRequest('The first range must start at 0 km.', { ranges: 'must start at 0 km' });
    }
    for (let i = 0; i < ranges.length - 1; i += 1) {
      const current = ranges[i];
      const next = ranges[i + 1];
      if (current.to_km === null) {
        throw ApiError.badRequest('Only the last range can be open-ended ("and more").', { ranges: 'open range must be last' });
      }
      if (next.from_km !== current.to_km) {
        throw ApiError.badRequest(
          next.from_km > current.to_km
            ? `Gap between ${current.to_km} km and ${next.from_km} km: every distance needs a fee.`
            : `Ranges overlap around ${next.from_km} km.`,
          { ranges: 'ranges must follow each other' }
        );
      }
    }
    if (ranges[ranges.length - 1].to_km !== null) {
      throw ApiError.badRequest(
        `The last range must have no end ("${ranges[ranges.length - 1].from_km} km and more") so every distance has a fee.`,
        { ranges: 'last range must be open-ended' }
      );
    }
  }
  return ranges;
}

/** The range covering `distanceKm` (a distance on the edge uses the next range). */
function rangeForDistance(ranges, distanceKm) {
  if (!ranges.length) return null;
  const km = Math.max(0, Number(distanceKm) || 0);
  return (
    ranges.find((entry) => km >= entry.from_km && (entry.to_km === null || km < entry.to_km)) ||
    ranges[ranges.length - 1]
  );
}

module.exports = { parseDistanceFeeRanges, rangeForDistance };
