const crypto = require('crypto');
const { TableSession, Order } = require('../../models');
const ApiError = require('../../utils/ApiError');
const { parseOptionalText } = require('../../utils/vendorValidators');

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const sameHash = (key, savedHash) => {
  if (typeof key !== 'string' || !key || typeof savedHash !== 'string') return false;
  const actual = Buffer.from(hashKey(key), 'hex');
  const expected = Buffer.from(savedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

async function physicalSessionFor(table, vendor) {
  const filter = { vendor_id: vendor._id, table_id: table._id, status: 'active' };
  let existing = await TableSession.findOne(filter).select('+customer_sessions.key_hash').lean();
  if (existing) {
    const now = new Date();
    const hasLiveCustomer = (existing.customer_sessions || []).some(
      (entry) => entry.status === 'active' && entry.expires_at > now
    );
    if (!hasLiveCustomer) {
      const hasOutstandingOrder = await Order.exists({
        table_session_id: existing._id,
        payment_status: { $ne: 'paid' },
        status: { $ne: 'cancelled' },
      });
      if (!hasOutstandingOrder) {
        await TableSession.updateOne({ _id: existing._id, status: 'active' }, { $set: { status: 'closed', closed_at: now } });
        existing = null;
      }
    }
    if (existing) return existing;
  }
  try {
    return (await TableSession.create({ vendor_id: vendor._id, table_id: table._id })).toObject();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return TableSession.findOne(filter).select('+customer_sessions.key_hash').lean();
  }
}

async function expireSeatSession(tableSession, customerSession, vendorId, now) {
  const hasOutstandingOrder = await Order.exists({
    vendor_id: vendorId,
    table_session_id: tableSession._id,
    customer_session_id: customerSession._id,
    payment_status: { $ne: 'paid' },
    status: { $ne: 'cancelled' },
  });
  if (hasOutstandingOrder) {
    throw ApiError.conflict(
      'This seat has an expired session with an outstanding order. Ask a staff member to resolve its bill.',
      'DINING_SESSION_HAS_OUTSTANDING_ORDER'
    );
  }
  await TableSession.updateOne(
    {
      _id: tableSession._id,
      customer_sessions: {
        $elemMatch: { _id: customerSession._id, status: 'active', expires_at: { $lte: now } },
      },
    },
    { $set: { 'customer_sessions.$.status': 'expired' } }
  );
}

function serializedSession(tableSession, customerSession, sessionKey = null) {
  return {
    table_session_id: String(tableSession._id),
    customer_session_id: String(customerSession._id),
    seat_number: customerSession.seat_number,
    guest_name: customerSession.guest_name || '',
    status: customerSession.status,
    expires_at: customerSession.expires_at,
    session_key: sessionKey,
  };
}

class DiningSessionService {
  async open(table, vendor, body = {}, customer = null, suppliedKey = null) {
    const seatNumber = table._qr_seat_number;
    if (!seatNumber) {
      throw ApiError.conflict('This QR code is for the table. Scan an individual seat QR code to start a private ordering session.', 'SEAT_QR_REQUIRED');
    }
    const now = new Date();
    const tableSession = await physicalSessionFor(table, vendor);
    if (!tableSession) throw ApiError.conflict('Could not open this table session. Please try again.', 'TABLE_SESSION_UNAVAILABLE');

    let active = (tableSession.customer_sessions || []).find(
      (entry) => entry.seat_number === seatNumber && entry.status === 'active'
    );
    if (active && active.expires_at <= now) {
      await expireSeatSession(tableSession, active, vendor._id, now);
      active = null;
    }

    if (active) {
      const ownerMatches = customer?._id && active.customer_id && String(customer._id) === String(active.customer_id);
      const keyMatches = sameHash(suppliedKey, active.key_hash);
      if (!ownerMatches && !keyMatches) {
        throw ApiError.conflict('This seat already has an active customer session. Ask a server to help you.', 'SEAT_SESSION_OCCUPIED');
      }
      if (body.guest_name && !active.guest_name) {
        const guestName = parseOptionalText(body.guest_name, { field: 'guest_name', max: 40 }) || '';
        if (guestName) {
          await TableSession.updateOne(
            { _id: tableSession._id, 'customer_sessions._id': active._id },
            { $set: { 'customer_sessions.$.guest_name': guestName } }
          );
          active.guest_name = guestName;
        }
      }
      return serializedSession(tableSession, active, keyMatches ? suppliedKey : null);
    }
    if (table._qr_seat_token_current === false) {
      throw ApiError.conflict('This seat QR code was replaced. Scan the current code or ask a server for help.', 'SEAT_QR_REPLACED');
    }

    const sessionKey = crypto.randomBytes(32).toString('base64url');
    const customerSession = {
      seat_number: seatNumber,
      customer_id: customer?._id || null,
      guest_name: parseOptionalText(body.guest_name, { field: 'guest_name', max: 40 }) || customer?.name || '',
      key_hash: hashKey(sessionKey),
      status: 'active',
      expires_at: new Date(now.getTime() + SESSION_TTL_MS),
      started_at: now,
    };
    const saved = await TableSession.findOneAndUpdate(
      {
        _id: tableSession._id,
        status: 'active',
        customer_sessions: { $not: { $elemMatch: { seat_number: seatNumber, status: 'active' } } },
      },
      { $push: { customer_sessions: customerSession } },
      { returnDocument: 'after' }
    ).lean();
    if (!saved) {
      const raced = await TableSession.findById(tableSession._id).select('+customer_sessions.key_hash').lean();
      const occupied = (raced?.customer_sessions || []).find(
        (entry) => entry.seat_number === seatNumber && entry.status === 'active'
      );
      if (occupied && sameHash(suppliedKey, occupied.key_hash)) {
        return serializedSession(raced, occupied, suppliedKey);
      }
      throw ApiError.conflict('This seat already has an active customer session. Ask a server to help you.', 'SEAT_SESSION_OCCUPIED');
    }
    const created = saved.customer_sessions.find((entry) => entry.seat_number === seatNumber && entry.status === 'active');
    return serializedSession(saved, created, sessionKey);
  }

  async requireOwned(table, customer, sessionKey) {
    const seatNumber = table._qr_seat_number;
    if (!seatNumber) return null;
    const now = new Date();
    const tableSession = await TableSession.findOne({
      vendor_id: table.vendor_id,
      table_id: table._id,
      status: 'active',
    }).select('+customer_sessions.key_hash').lean();
    const customerSession = (tableSession?.customer_sessions || []).find(
      (entry) => entry.seat_number === seatNumber && entry.status === 'active'
    );
    if (!tableSession || !customerSession || customerSession.expires_at <= now) {
      throw ApiError.unauthorized('Your seat session has expired or is no longer active. Scan the seat QR again.', 'DINING_SESSION_EXPIRED');
    }
    const ownerMatches = customer?._id && customerSession.customer_id && String(customer._id) === String(customerSession.customer_id);
    if (!ownerMatches && !sameHash(sessionKey, customerSession.key_hash)) {
      throw ApiError.unauthorized('This seat session belongs to another customer. Scan your own seat QR code.', 'DINING_SESSION_INVALID');
    }
    return { tableSession, customerSession };
  }
}

module.exports = new DiningSessionService();
module.exports.SESSION_TTL_MS = SESSION_TTL_MS;
module.exports.hashKey = hashKey;
