/**
 * Whether the kitchen has marked a delivery's food ready.
 *
 * Deliveries offered at placement start with `ready_at: null` and get a date
 * when the food is ready. Deliveries created before early dispatch existed
 * have no `ready_at` field at all; they were only ever created once the food
 * was ready, so a missing field counts as ready.
 */
function isKitchenReady(delivery) {
  return Boolean(delivery) && delivery.ready_at !== null;
}

module.exports = { isKitchenReady };
