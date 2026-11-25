const ApiError = require('../utils/ApiError');
const { SpecialDeliveryRequest, DeliveryQuotation } = require('../models');
const {
  TRANSITIONS,
  QUOTATION_TRANSITIONS,
  CLOSED_STATUSES,
  STATUS_LABELS,
} = require('../config/specialDelivery');

/**
 * The only way special delivery requests and quotations change status.
 * Each change is checked against config/specialDelivery.js (from → to and who
 * may make it), applied atomically (only if the status is still the one we
 * read, so two clicks can't both win) and logged with the previous status,
 * the new one, the actor, the time and the reason.
 */

const allowed = (table, from, to, role) => Boolean(table[from]?.[to]?.includes(role));

const historyEntry = (from, to, actor, reason) => ({
  from,
  to,
  actor_role: actor.role,
  actor_id: actor.id ?? null,
  reason: reason || '',
  at: new Date(),
});

function canTransition(from, to, role) {
  return allowed(TRANSITIONS, from, to, role);
}

/**
 * Moves `request` to `to`. `set` holds other fields to change in the same
 * write. Throws 409 INVALID_TRANSITION when the move isn't allowed, or
 * REQUEST_CHANGED when someone else changed the request first.
 */
async function transitionRequest(request, to, actor, { reason = '', set = {}, inc = null } = {}) {
  const from = request.status;
  if (!canTransition(from, to, actor.role)) {
    throw new ApiError(
      409,
      'INVALID_TRANSITION',
      `This special delivery is "${STATUS_LABELS[from] || from}", so it can't be moved to "${STATUS_LABELS[to] || to}".`
    );
  }
  const closing = CLOSED_STATUSES.includes(to);
  const update = {
    $set: { ...set, status: to, ...(closing ? { is_active: false } : {}) },
    $push: { status_history: historyEntry(from, to, actor, reason) },
    ...(inc ? { $inc: inc } : {}),
  };
  const updated = await SpecialDeliveryRequest.findOneAndUpdate({ _id: request._id, status: from }, update, {
    returnDocument: 'after',
  }).lean();
  if (!updated) {
    throw ApiError.conflict('This special delivery was just updated. Refresh and try again.', 'REQUEST_CHANGED');
  }
  return updated;
}

/** Moves a quotation to `to` (same rules: checked, atomic, logged). */
async function transitionQuotation(quotation, to, actor, { reason = '', set = {} } = {}) {
  const from = quotation.status;
  if (!allowed(QUOTATION_TRANSITIONS, from, to, actor.role)) {
    throw new ApiError(409, 'INVALID_QUOTATION_TRANSITION', `This quotation is ${from}, so it can't become ${to}.`);
  }
  const updated = await DeliveryQuotation.findOneAndUpdate(
    { _id: quotation._id, status: from },
    {
      $set: { ...set, status: to, decided_at: new Date(), decided_by_role: actor.role, decision_note: reason || '' },
      $push: { status_history: historyEntry(from, to, actor, reason) },
    },
    { returnDocument: 'after' }
  ).lean();
  if (!updated) {
    throw ApiError.conflict('This quotation was just updated. Refresh and try again.', 'QUOTATION_CHANGED');
  }
  return updated;
}

/** Actions the actor may take now (shown as buttons; still checked on every call). */
function allowedNext(status, role) {
  return Object.entries(TRANSITIONS[status] || {})
    .filter(([, roles]) => roles.includes(role))
    .map(([to]) => to);
}

module.exports = { transitionRequest, transitionQuotation, canTransition, allowedNext, historyEntry };
