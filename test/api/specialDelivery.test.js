// Big-event delivery: platform pricing (starting fee + road meters, automatic
// ceiling), kitchen coverage, and the special delivery negotiation workflow
// (request → kitchen review → chat → formal quotations → customer approval →
// order with the agreed fee). Road distances come from a local OSRM stub.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const stub = { distanceM: 2000 };
const osrm = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: stub.distanceM, duration: 3600 }] }));
});

let h;
let config;
let models;
let specialDeliveryService;
let bigEventDeliverySettingsService;
let signToken;
let caterer; // delivers within 20 km and to Musanze
let pickupOnly; // big events, but no delivery
let caterTok;

const DAY_MS = 24 * 60 * 60 * 1000;
const MUSANZE = { address: 'Musanze town, NM 12 St', latitude: -1.5, longitude: 29.6 };
const HUYE = { address: 'Huye, Ngoma sector', latitude: -2.6, longitude: 29.74 };

const PACKAGE = {
  id: 'wedding1',
  name: 'Wedding buffet',
  enabled: true,
  tiers: [{ min_guests: 50, max_guests: 300, price_per_plate_rwf: 5000 }],
  menu: ['Rice', 'Beef'],
};

before(async () => {
  await new Promise((resolve) => osrm.listen(0, '127.0.0.1', resolve));
  process.env.ROUTING_PROVIDER = 'osrm';
  process.env.OSRM_URL = `http://127.0.0.1:${osrm.address().port}`;
  process.env.OSRM_MIN_INTERVAL_MS = '0';
  h = require('../helpers/testServer');
  config = require('../../src/config');
  models = require('../../src/models');
  specialDeliveryService = require('../../src/services/specialDeliveryService');
  bigEventDeliverySettingsService = require('../../src/services/bigEventDeliverySettingsService');
  ({ signToken } = require('../../src/utils/jwt'));
  await h.start();
  await bigEventDeliverySettingsService.load();

  ({ vendor: caterer } = await h.createKitchen({
    name: 'Far Caterer',
    event_package: { enabled: true, packages: [PACKAGE] },
    delivery_coverage: {
      big_event_enabled: true,
      areas: [
        { id: 'radius01', kind: 'radius', radius_km: 20 },
        { id: 'distr001', kind: 'district', district: 'musanze' },
      ],
    },
  }));
  ({ vendor: pickupOnly } = await h.createKitchen({
    name: 'Pickup Caterer',
    event_package: { enabled: true, packages: [PACKAGE] },
  }));
  caterTok = signToken({ sub: String(caterer._id), role: config.vendor.jwtRole });
});
after(async () => {
  await h.stop();
  await new Promise((resolve) => osrm.close(resolve));
});

const eventAt = () => new Date(Date.now() + 10 * DAY_MS).toISOString();
const quoteBody = (location, vendor = caterer) => ({
  vendor_id: String(vendor._id),
  package_id: 'wedding1',
  guests: 100,
  fulfillment: 'delivery',
  delivery_location: location,
});
const requestBody = (location, extra = {}) => ({
  ...quoteBody(location),
  event_at: eventAt(),
  instructions: 'Gate 2, call on arrival',
  ...extra,
});
const vendorApi = (method, path, body) => h.api(method, `/vendor/special-deliveries${path}`, { token: caterTok, body });

test('in coverage and under the ceiling: the automatic fee is 3,000 RWF + meters × rate', async () => {
  stub.distanceM = 70000;
  const res = await h.api('POST', '/orders/event-quote', { body: quoteBody(MUSANZE) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.delivery.status, 'automatic');
  assert.equal(res.body.quote.delivery_fee_rwf, 3000 + 70000 * 0.5);
  assert.equal(res.body.delivery.destination_district.name, 'Musanze');
});

test('above the 40,000 RWF ceiling: no automatic charge, negotiation required', async () => {
  stub.distanceM = 90000;
  const res = await h.api('POST', '/orders/event-quote', { body: quoteBody({ ...MUSANZE, latitude: -1.501 }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { delivery, quote } = res.body;
  assert.equal(delivery.status, 'negotiation_required');
  assert.deepEqual(delivery.reasons, ['above_ceiling']);
  assert.equal(delivery.fee_rwf, null);
  assert.equal(delivery.calculated_fee_rwf, 48000, 'not truncated to 40,000');
  assert.equal(quote.delivery_fee_rwf, null);
  assert.match(delivery.message, /special delivery arrangement/);

  const { token } = await h.createCustomer();
  const checkout = await h.api('POST', '/orders/event-checkout', {
    token,
    body: { ...requestBody({ ...MUSANZE, latitude: -1.501 }), ...h.MOBILE_MONEY },
  });
  assert.equal(checkout.status, 409);
  assert.equal(checkout.body.error.code, 'SPECIAL_DELIVERY_REQUIRED');
});

test('outside coverage: negotiation required even when the fee would be low', async () => {
  stub.distanceM = 120000;
  const res = await h.api('POST', '/orders/event-quote', { body: quoteBody(HUYE) });
  assert.ok(res.body.delivery.reasons.includes('outside_coverage'));
  assert.equal(res.body.delivery.in_coverage, false);
});

test('a kitchen without big-event delivery offers pick-up only and gets no requests', async () => {
  const quote = await h.api('POST', '/orders/event-quote', { body: quoteBody(h.NEARBY_ADDRESS, pickupOnly) });
  assert.equal(quote.body.delivery.status, 'unavailable');
  const { token } = await h.createCustomer();
  const res = await h.api('POST', '/special-deliveries', {
    token,
    body: { ...requestBody(h.NEARBY_ADDRESS), vendor_id: String(pickupOnly._id) },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'BIG_EVENT_DELIVERY_UNAVAILABLE');
});

test('no special request when the automatic price applies', async () => {
  stub.distanceM = 2000;
  const { token } = await h.createCustomer();
  const res = await h.api('POST', '/special-deliveries', { token, body: requestBody(h.NEARBY_ADDRESS) });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'AUTOMATIC_PRICE_AVAILABLE');
});

test('full negotiation: request, chat, revised quotations, approval, order with the agreed fee, cancellation kept in history', async () => {
  stub.distanceM = 130000;
  const customer = await h.createCustomer('Event Host');
  const token = customer.token;

  // 1. The request.
  const created = await h.api('POST', '/special-deliveries', { token, body: requestBody(HUYE) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const request = created.body;
  assert.match(request.reference, /^SD-\d{6}$/);
  assert.equal(request.status, 'pending_vendor_review');
  assert.ok(request.trigger_reasons.includes('outside_coverage'));
  assert.equal(request.agreed_fee_rwf, null);

  const duplicate = await h.api('POST', '/special-deliveries', { token, body: requestBody(HUYE) });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'ACTIVE_REQUEST_EXISTS');

  // Nothing before the kitchen accepts: no chat, no quotation.
  const early = await h.api('POST', `/special-deliveries/${request.id}/messages`, { token, body: { body: 'Hello?' } });
  assert.equal(early.body.error.code, 'CHAT_CLOSED');
  const earlyQuote = await vendorApi('POST', `/${request.id}/quotations`, { fee_rwf: 50000, arrangements: ['own_vehicle'], arrangement_description: 'Van' });
  assert.equal(earlyQuote.status, 409);
  // Customers can't use kitchen actions.
  const forged = await h.api('POST', `/vendor/special-deliveries/${request.id}/accept-negotiation`, { token, body: {} });
  assert.equal(forged.status, 403);

  // 2. The kitchen is notified and accepts to negotiate.
  const note = await models.Notification.findOne({ vendor_id: caterer._id, type: 'special_delivery_request' }).lean();
  assert.ok(note, 'kitchen notified');
  const accepted = await vendorApi('POST', `/${request.id}/accept-negotiation`, { message: 'Happy to help, Huye is far though.' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.status, 'negotiation_accepted');

  // 3. Chat: text and a shared location.
  const msg = await h.api('POST', `/special-deliveries/${request.id}/messages`, { token, body: { body: 'The venue is behind the stadium.' } });
  assert.equal(msg.status, 201, JSON.stringify(msg.body));
  const loc = await h.api('POST', `/special-deliveries/${request.id}/messages`, {
    token,
    body: { kind: 'location', latitude: -2.6, longitude: 29.74, label: 'Venue gate' },
  });
  assert.equal(loc.body.message.kind, 'location');
  const afterChat = await h.api('GET', `/special-deliveries/${request.id}`, { token });
  assert.equal(afterChat.body.status, 'negotiating');
  const vendorView = await vendorApi('GET', `/${request.id}/messages`);
  assert.ok(vendorView.body.messages.some((m) => m.kind === 'location'));
  const customerView = await h.api('GET', `/special-deliveries/${request.id}/messages`, { token });
  const mine = customerView.body.messages.filter((m) => m.mine);
  assert.ok(mine.length >= 2 && mine.every((m) => m.read === true), 'read receipts once the kitchen opened the chat');
  // Negotiation chats never show up in the general chat list.
  const general = await h.api('GET', '/chats', { token });
  assert.equal(general.body.conversations.length, 0);

  // 4. Formal quotation, then a revision (the first is superseded, never edited).
  const bad = await vendorApi('POST', `/${request.id}/quotations`, { fee_rwf: -5, arrangements: ['own_vehicle'], arrangement_description: 'Van' });
  assert.equal(bad.status, 400);
  const q1 = await vendorApi('POST', `/${request.id}/quotations`, {
    fee_rwf: 60000,
    arrangements: ['rented_vehicle', 'multiple_trips'],
    arrangement_description: 'Two rented vans, two trips',
    conditions: 'Unloading point within 50 m of the road',
    valid_hours: 24,
  });
  assert.equal(q1.status, 201, JSON.stringify(q1.body));
  assert.equal(q1.body.status, 'quotation_submitted');
  const q1Id = q1.body.active_quotation.id;
  assert.equal(q1.body.active_quotation.version, 1);

  const q2 = await vendorApi('POST', `/${request.id}/quotations`, {
    fee_rwf: 56000,
    arrangements: ['rented_vehicle'],
    arrangement_description: 'One larger rented truck',
  });
  assert.equal(q2.status, 201, JSON.stringify(q2.body));
  assert.equal(q2.body.active_quotation.version, 2);
  assert.equal(q2.body.quotations.find((q) => q.id === q1Id).status, 'superseded');
  const stale = await h.api('POST', `/special-deliveries/${request.id}/quotations/${q1Id}/accept`, { token });
  assert.equal(stale.status, 409, 'a superseded quotation cannot be accepted');

  // 5. Customer asks for another price.
  const q2Id = q2.body.active_quotation.id;
  const revision = await h.api('POST', `/special-deliveries/${request.id}/quotations/${q2Id}/request-revision`, {
    token,
    body: { note: 'Could you do 50,000?' },
  });
  assert.equal(revision.body.status, 'quotation_revision_requested');
  assert.equal(revision.body.quotations.find((q) => q.id === q2Id).status, 'rejected');

  const q3 = await vendorApi('POST', `/${request.id}/quotations`, {
    fee_rwf: 50000,
    arrangements: ['third_party'],
    arrangement_description: 'Partner transport company',
  });
  const q3Id = q3.body.active_quotation.id;
  const vendorAccept = await vendorApi('POST', `/${request.id}/quotations/${q3Id}/accept`);
  assert.equal(vendorAccept.status, 404, 'kitchens cannot accept their own quotation');

  // 6. Customer accepts: the fee is locked.
  const agreed = await h.api('POST', `/special-deliveries/${request.id}/quotations/${q3Id}/accept`, { token });
  assert.equal(agreed.status, 200, JSON.stringify(agreed.body));
  assert.equal(agreed.body.status, 'quotation_accepted');
  assert.equal(agreed.body.agreed_fee_rwf, 50000);
  assert.equal(agreed.body.can_checkout, true);
  const lateRevise = await vendorApi('POST', `/${request.id}/quotations`, { fee_rwf: 90000, arrangements: ['other'], arrangement_description: 'x' });
  assert.equal(lateRevise.status, 409, 'no new price after agreement');

  // 7. Book the event with the agreed fee (food + 50,000), through the normal payment.
  const booked = await h.api('POST', '/orders/event-checkout', {
    token,
    body: {
      ...requestBody(HUYE),
      ...h.MOBILE_MONEY,
      special_delivery_request_id: request.id,
      // Anything the client sends about the fee is ignored.
      delivery_fee_rwf: 1,
    },
  });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.equal(booked.body.subtotal_rwf, 100 * 5000);
  assert.equal(booked.body.delivery_fee_rwf, 50000);
  assert.equal(booked.body.total_rwf, 100 * 5000 + 50000);
  assert.equal(booked.body.big_event_delivery.mode, 'negotiated');
  assert.equal(booked.body.payment_status, 'paid');

  const confirmed = await h.api('GET', `/special-deliveries/${request.id}`, { token });
  assert.equal(confirmed.body.status, 'delivery_confirmed');
  assert.equal(confirmed.body.order.id, booked.body.id);

  const reuse = await h.api('POST', '/orders/event-checkout', {
    token,
    body: { ...requestBody(HUYE), ...h.MOBILE_MONEY, special_delivery_request_id: request.id },
  });
  assert.equal(reuse.status, 409);

  // 8. Cancelling the order closes the agreement; the history is kept.
  const cancelled = await h.api('POST', `/orders/${booked.body.id}/cancel`, { token, body: {} });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const closed = await h.api('GET', `/special-deliveries/${request.id}`, { token });
  assert.equal(closed.body.status, 'customer_cancelled');
  assert.equal(closed.body.quotations.length, 3);
  assert.equal(closed.body.agreed_fee_rwf, 50000);
  const path = closed.body.status_history.map((entry) => entry.to);
  assert.deepEqual(path.slice(0, 3), ['pending_vendor_review', 'negotiation_accepted', 'negotiating']);
  assert.ok(closed.body.status_history.every((entry) => entry.actor_role && entry.at));
});

test('the kitchen can decline with a reason; the customer may then ask again', async () => {
  stub.distanceM = 130000;
  const { token } = await h.createCustomer();
  const req = (await h.api('POST', '/special-deliveries', { token, body: requestBody({ ...HUYE, latitude: -2.601 }) })).body;
  const noReason = await vendorApi('POST', `/${req.id}/decline`, {});
  assert.equal(noReason.status, 400);
  const declined = await vendorApi('POST', `/${req.id}/decline`, { reason: 'Too far for our vehicles' });
  assert.equal(declined.body.status, 'vendor_declined');
  assert.equal(declined.body.agreed_fee_rwf, null);
  const again = await h.api('POST', '/special-deliveries', { token, body: requestBody({ ...HUYE, latitude: -2.601 }) });
  assert.equal(again.status, 201);
});

test('the kitchen can ask for more information; the customer answers', async () => {
  stub.distanceM = 130000;
  const { token } = await h.createCustomer();
  const req = (await h.api('POST', '/special-deliveries', { token, body: requestBody({ ...HUYE, latitude: -2.602 }) })).body;
  const asked = await vendorApi('POST', `/${req.id}/request-information`, { message: 'Is there truck access?' });
  assert.equal(asked.body.status, 'awaiting_customer_information');
  const answered = await h.api('POST', `/special-deliveries/${req.id}/information`, { token, body: { message: 'Yes, a paved road.' } });
  assert.equal(answered.body.status, 'pending_vendor_review');
});

test('an expired quotation cannot be accepted', async () => {
  stub.distanceM = 130000;
  const { token } = await h.createCustomer();
  const req = (await h.api('POST', '/special-deliveries', { token, body: requestBody({ ...HUYE, latitude: -2.603 }) })).body;
  await vendorApi('POST', `/${req.id}/accept-negotiation`, {});
  const quoted = await vendorApi('POST', `/${req.id}/quotations`, { fee_rwf: 45000, arrangements: ['own_vehicle'], arrangement_description: 'Our van' });
  const qId = quoted.body.active_quotation.id;
  await models.DeliveryQuotation.updateOne({ _id: qId }, { $set: { valid_until: new Date(Date.now() - 1000) } });
  const res = await h.api('POST', `/special-deliveries/${req.id}/quotations/${qId}/accept`, { token });
  assert.equal(res.status, 409);
  const after = await h.api('GET', `/special-deliveries/${req.id}`, { token });
  assert.equal(after.body.status, 'quotation_expired');
  assert.equal(after.body.quotations[0].status, 'expired');
});

test('chat accepts image attachments', async () => {
  stub.distanceM = 130000;
  const sharp = require('sharp');
  const { token } = await h.createCustomer();
  const req = (await h.api('POST', '/special-deliveries', { token, body: requestBody({ ...HUYE, latitude: -2.604 }) })).body;
  await vendorApi('POST', `/${req.id}/accept-negotiation`, {});
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'venue.png');
  form.append('caption', 'Venue entrance');
  const res = await fetch(`${h.baseUrl()}/special-deliveries/${req.id}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.message.kind, 'image');
  assert.match(body.message.attachment_url, /upload-/);
});

test('kitchens set coverage only, never prices; the server checks coverage', async () => {
  const forbidden = await h.api('PUT', '/vendor/delivery-coverage', {
    token: caterTok,
    body: { big_event_enabled: true, areas: [{ kind: 'radius', radius_km: 20 }], per_meter_rwf: 0 },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'PRICING_NOT_EDITABLE');

  const mine = await h.api('GET', '/vendor/delivery-coverage', { token: caterTok });
  assert.equal(mine.body.platform_pricing.starting_fee_rwf, 3000);
  assert.equal(mine.body.platform_pricing.auto_ceiling_rwf, 40000);
  assert.equal(mine.body.districts.length, 30);

  const inside = await h.api('GET', '/vendor/delivery-coverage/check?lat=-1.5&lng=29.6', { token: caterTok });
  assert.equal(inside.body.covered, true);
  const outside = await h.api('GET', '/vendor/delivery-coverage/check?lat=-2.6&lng=29.74', { token: caterTok });
  assert.equal(outside.body.covered, false);
});

test('admin settings change the automatic price and ceiling for new quotes only', async () => {
  stub.distanceM = 90000;
  await bigEventDeliverySettingsService.update(null, { starting_fee_rwf: 3000, per_meter_rwf: 0.5, auto_ceiling_rwf: 50000 });
  try {
    const res = await h.api('POST', '/orders/event-quote', { body: quoteBody({ ...MUSANZE, latitude: -1.505 }) });
    assert.equal(res.body.delivery.status, 'automatic');
    assert.equal(res.body.delivery.fee_rwf, 48000);
  } finally {
    await bigEventDeliverySettingsService.update(null, { starting_fee_rwf: 3000, per_meter_rwf: 0.5, auto_ceiling_rwf: 40000 });
  }
});

test('expiry sweep marks overdue quotations expired', async () => {
  assert.equal(typeof specialDeliveryService.expireQuotations, 'function');
  assert.equal(await specialDeliveryService.expireQuotations(), 0);
});
