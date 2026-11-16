/**
 * One queue for every request to the OSRM routing server (delivery prices in
 * routeDistanceService, live tracking in routeNavigationService). The public
 * OSRM server asks for at most about one request per second, so requests run
 * one after another with at least `minIntervalMs` between their starts.
 * A self-hosted OSRM server (OSRM_URL) has no such limit: set
 * OSRM_MIN_INTERVAL_MS=0.
 */
let queue = Promise.resolve();
let lastStart = 0;

/**
 * @template T
 * @param {() => Promise<T>} task the request to run
 * @param {number} minIntervalMs
 * @returns {Promise<T>}
 */
function runOsrm(task, minIntervalMs) {
  const run = queue.then(async () => {
    const wait = lastStart + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastStart = Date.now();
    return task();
  });
  // A failed request must not block the ones after it.
  queue = run.catch(() => {});
  return run;
}

module.exports = { runOsrm };
