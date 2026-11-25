// One sign-in field for an email or a phone, for customers, kitchens and
// delivery workers (admins use passwords); email codes are
// never exposed, SMS codes only on an explicit development server; one
// customer per phone, enforced by the server and the database.
const http = require('node:http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let models;
let config;
let authService;
let vendorAuthService;
let driverAuthService;
let normalizePhone;
let hashPassword;
let setTestTransport;
let migrateCustomerIdentity;
let PHONE_TAKEN_MESSAGE;
const outbox = [];
const smsSent = [];
let smsServer;

let seq = 0;
// Airtel 073…/072… with a middle part of their own; never testServer's 078… numbers.
const freshPhone = () => {
  seq += 1;
  return `073${String((process.pid + 2500) % 10000).padStart(4, '0')}${String(seq).padStart(3, '0')}`;
};
const freshEmail = (label = 'person') => {
  seq += 1;
  return `${label}${seq}.${process.pid}@kitchenlink.test`;
};
const codeFromMail = (to) => {
  const mail = [...outbox].reverse().find((message) => message.to === to);
  return mail?.text.match(/\b(\d{6})\b/)?.[1] || null;
};
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
/** Customer sign-in codes keep a 60 s gap per phone/email: move earlier ones back. */
const ageCodes = (to) => models.OtpCode.collection.updateMany({ phone_number: to }, { $set: { created_at: new Date(Date.now() - 5 * 60 * 1000) } });

before(async () => {
  await h.start();
  models = require('../../src/models');
  config = require('../../src/config');
  authService = require('../../src/services/authService');
  ({ PHONE_TAKEN_MESSAGE } = authService);
  vendorAuthService = require('../../src/services/vendorAuthService');
  driverAuthService = require('../../src/services/driverAuthService');
  ({ normalizePhone } = require('../../src/utils/validators'));
  ({ hashPassword } = require('../../src/utils/password'));
  ({ setTestTransport } = require('../../src/utils/email'));
  migrateCustomerIdentity = require('../../src/scripts/migrateCustomerIdentity');
  setTestTransport((message) => {
    outbox.push(message);
    return { status: 'sent' };
  });
  // A stand-in SMS gateway, used only by the "live server" test.
  smsServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      smsSent.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => smsServer.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  setTestTransport(null);
  await new Promise((resolve) => smsServer.close(resolve));
  await h.stop();
});

/* ------------------------------ sign-in ------------------------------ */

test('customer: phone sign-in (any format) and email sign-in reach the same verified account', async () => {
  const phone = freshPhone();
  const sent = await h.api('POST', '/auth/send-otp', { body: { identifier: phone, name: 'Aline Uwase' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.identifier_type, 'phone');
  assert.ok(sent.body.dev_otp, 'a development server shows SMS codes (no SMS gateway yet)');
  const first = await h.api('POST', '/auth/verify-otp', { body: { identifier: phone, code: sent.body.dev_otp, name: 'Aline Uwase' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.customer.phone_number, normalizePhone(phone));

  // 07…, 2507… and +2507… are one number: the same account, no second one.
  await ageCodes(normalizePhone(phone));
  const intl = `+250${phone.slice(1)}`;
  const again = await authService.sendOtp({ identifier: intl.slice(1), name: '' });
  const second = await authService.verifyOtp({ identifier: intl, code: again.dev_otp });
  assert.equal(second.customer.id, first.body.customer.id);
  assert.equal(await models.Customer.countDocuments({ phone_number: normalizePhone(phone) }), 1);

  // Verify an email, then sign in with it: the email code is never in a response.
  const email = freshEmail('aline');
  const start = await authService.startEmailVerification({ ...(await models.Customer.findById(first.body.customer.id).lean()) }, { email });
  assert.equal(start.dev_otp, undefined);
  const me = await models.Customer.findById(first.body.customer.id).lean();
  await authService.confirmEmailVerification(me, { code: codeFromMail(email) });

  await ageCodes(email);
  const byEmail = await h.api('POST', '/auth/send-otp', { body: { identifier: `  ${email.toUpperCase()} `, name: 'Aline Uwase' } });
  assert.equal(byEmail.status, 200, JSON.stringify(byEmail.body));
  assert.equal(byEmail.body.identifier_type, 'email');
  const emailCode = codeFromMail(email);
  assert.equal(byEmail.body.dev_otp, undefined, 'email codes are never returned');
  assert.ok(!JSON.stringify(byEmail.body).includes(emailCode));
  const signedIn = await h.api('POST', '/auth/verify-otp', { body: { identifier: email, code: emailCode } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.customer.id, first.body.customer.id);
  assert.equal(signedIn.body.customer.email_verified, true);
});

test('vendor and delivery worker sign in with their phone or their email; the account found decides the role', async () => {
  const vendorPhone = normalizePhone(freshPhone());
  const vendorEmail = freshEmail('kitchen');
  await h.createKitchen({ name: 'Email Kitchen', owner_name: 'Jean Bosco', phone: vendorPhone, email: vendorEmail });
  const byPhone = await vendorAuthService.sendLoginOtp({ phone: vendorPhone });
  assert.ok((await vendorAuthService.verifyLoginOtp({ phone: vendorPhone, code: byPhone.dev_otp })).token);
  const byEmail = await vendorAuthService.sendLoginOtp({ identifier: vendorEmail });
  assert.equal(byEmail.dev_otp, undefined);
  const vendorSession = await vendorAuthService.verifyLoginOtp({ identifier: vendorEmail, code: codeFromMail(vendorEmail) });
  assert.equal(vendorSession.vendor.phone, vendorPhone);
  assert.equal(require('../../src/utils/jwt').verifyToken(vendorSession.token).role, config.vendor.jwtRole);

  const driverPhone = normalizePhone(freshPhone());
  const driverEmail = freshEmail('rider');
  await models.Driver.create({ name: 'Eric Habimana', phone: driverPhone, email: driverEmail });
  const dPhone = await driverAuthService.sendLoginOtp({ identifier: driverPhone });
  assert.ok((await driverAuthService.verifyLoginOtp({ identifier: driverPhone, code: dPhone.dev_otp })).token);
  const dEmail = await driverAuthService.sendLoginOtp({ phone: driverEmail });
  assert.equal(dEmail.dev_otp, undefined);
  const driverSession = await driverAuthService.verifyLoginOtp({ identifier: driverEmail, code: codeFromMail(driverEmail) });
  assert.equal(require('../../src/utils/jwt').verifyToken(driverSession.token).role, config.delivery.jwtRole);

  // A kitchen's email is not a delivery worker account (no account is created at sign-in).
  await rejects(driverAuthService.sendLoginOtp({ identifier: vendorEmail }), 'DRIVER_NOT_FOUND');
  await rejects(vendorAuthService.sendLoginOtp({ identifier: freshEmail('nobody') }), 'VENDOR_NOT_FOUND');
});

test('admin identifiers use password-only login and never enter the OTP flow', async () => {
  const phone = normalizePhone(freshPhone());
  const email = freshEmail('admin');
  await models.Admin.create({
    name: 'Grace Admin', email, password_hash: await hashPassword('Admin-Password-2026!'),
    role: 'super_admin', status: 'active', is_active: true, phone, two_factor_enabled: true,
  });
  for (const identifier of [phone, email]) {
    const start = await h.api('POST', '/auth/login/send-otp', { body: { identifier, role: 'customer' } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.equal(start.body.role, 'admin');
    assert.equal(start.body.requires_password, true);
    assert.equal(start.body.dev_otp, undefined);
  }
  assert.equal(await models.OtpCode.countDocuments({ phone_number: { $in: [phone, email] } }), 0);

  const legacySend = await h.api('POST', '/auth/send-otp', { body: { identifier: phone, name: 'Grace Admin' } });
  assert.equal(legacySend.status, 400);
  assert.equal(legacySend.body.error.code, 'PASSWORD_REQUIRED');
  const legacyVerify = await h.api('POST', '/auth/login/verify-otp', {
    body: { identifier: phone, role: 'customer', code: '123456' },
  });
  assert.equal(legacyVerify.status, 400);
  assert.equal(legacyVerify.body.error.code, 'PASSWORD_REQUIRED');

  const wrongPassword = await h.api('POST', '/admin/auth/login', {
    body: { identifier: phone, password: 'wrong-password' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.token, undefined);
  const session = await h.api('POST', '/admin/auth/login', {
    body: { identifier: phone, password: 'Admin-Password-2026!' },
  });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  assert.ok(session.body.token);
  assert.equal(session.body.admin.email, email);
  assert.equal(await models.OtpCode.countDocuments({ phone_number: { $in: [phone, email] } }), 0);

  const asCustomer = await h.api('POST', '/auth/send-otp', { body: { identifier: email, name: 'Grace Admin' } });
  assert.equal(asCustomer.status, 400);
  assert.equal(asCustomer.body.error.code, 'PASSWORD_REQUIRED');
});

test('codes: wrong, expired, reused and too many tries are all refused', async () => {
  const email = freshEmail('codes');
  await authService.sendOtp({ identifier: email, name: 'Code Tester' });
  const code = codeFromMail(email);
  const wrong = code === '111111' ? '222222' : '111111';
  await rejects(authService.verifyOtp({ identifier: email, code: wrong }), 'OTP_INVALID');

  await models.OtpCode.collection.updateMany({ phone_number: email }, { $set: { expires_at: new Date(Date.now() - 1000) } });
  await rejects(authService.verifyOtp({ identifier: email, code }), 'OTP_EXPIRED');

  await ageCodes(email);
  await authService.sendOtp({ identifier: email, name: 'Code Tester' });
  const fresh = codeFromMail(email);
  await authService.verifyOtp({ identifier: email, code: fresh });
  await rejects(authService.verifyOtp({ identifier: email, code: fresh }), 'OTP_NOT_FOUND');

  const phone = freshPhone();
  const sent = await authService.sendOtp({ identifier: phone, name: 'Many Tries' });
  const bad = sent.dev_otp === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i += 1) await assert.rejects(authService.verifyOtp({ identifier: phone, code: bad }));
  await assert.rejects(authService.verifyOtp({ identifier: phone, code: sent.dev_otp }), 'the right code no longer works');

  // A new code cancels the previous one.
  const other = freshPhone();
  const one = await authService.sendOtp({ identifier: other, name: 'Two Codes' });
  await ageCodes(normalizePhone(other));
  const two = await authService.sendOtp({ identifier: other, name: 'Two Codes' });
  if (one.dev_otp !== two.dev_otp) await assert.rejects(authService.verifyOtp({ identifier: other, code: one.dev_otp }));
  assert.ok((await authService.verifyOtp({ identifier: other, code: two.dev_otp, name: 'Two Codes' })).token);
});

test('a live server (not NODE_ENV=development) never returns SMS codes; email codes never reach logs', async () => {
  const { sms } = config.notifications;
  const saved = { ...sms, explicitDev: config.explicitDev };
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  try {
    Object.assign(sms, { enabled: true, apiUrl: `http://127.0.0.1:${smsServer.address().port}/sms`, apiKey: 'test-key' });
    config.explicitDev = false;
    for (const level of ['log', 'error', 'warn']) console[level] = (...args) => lines.push(args.join(' '));

    const phone = freshPhone();
    const sent = await h.api('POST', '/auth/send-otp', { body: { identifier: phone, name: 'Live Customer' } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.dev_otp, undefined, 'no code in a live response');
    const smsCode = smsSent.at(-1).message.match(/\b(\d{6})\b/)[1];
    assert.ok(!JSON.stringify(sent.body).includes(smsCode));
    assert.ok((await authService.verifyOtp({ identifier: phone, code: smsCode, name: 'Live Customer' })).token, 'the SMS code works');

    const email = freshEmail('live');
    const mailed = await authService.sendOtp({ identifier: email, name: 'Live Customer' });
    assert.equal(mailed.dev_otp, undefined);
    const emailCode = codeFromMail(email);
    assert.ok(!lines.some((line) => line.includes(smsCode) || line.includes(emailCode)), 'no code in the logs');
  } finally {
    Object.assign(sms, { enabled: saved.enabled, apiUrl: saved.apiUrl, apiKey: saved.apiKey });
    config.explicitDev = saved.explicitDev;
    Object.assign(console, original);
  }
});

/* ------------------------- one customer per phone ------------------------ */

test('a phone that is another customer’s is refused under a different name; harmless name differences are fine', async () => {
  const phone = freshPhone();
  const sent = await authService.sendOtp({ identifier: phone, name: 'Aline Uwase' });
  const owner = await authService.verifyOtp({ identifier: phone, code: sent.dev_otp, name: 'Aline Uwase' });
  await ageCodes(normalizePhone(phone));

  const taken = await h.api('POST', '/auth/send-otp', { body: { identifier: phone, name: 'Eric Mugisha' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.message, PHONE_TAKEN_MESSAGE);
  assert.equal(taken.body.dev_otp, undefined, 'no code is sent');
  assert.ok(!JSON.stringify(taken.body).includes('Aline'), 'nothing about the owner is revealed');

  // Sharing one word is not the same name.
  await rejects(authService.sendOtp({ identifier: phone, name: 'Aline' }), 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER');
  await rejects(authService.sendOtp({ identifier: phone, name: 'Aline Mukamana' }), 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER');
  // Case, spacing and word order are harmless.
  const same = await authService.sendOtp({ identifier: phone, name: '  uwase   ALINE ' });
  const back = await authService.verifyOtp({ identifier: phone, code: same.dev_otp, name: '  uwase   ALINE ' });
  assert.equal(back.customer.id, owner.customer.id);
  assert.equal(await models.Customer.countDocuments({ phone_number: normalizePhone(phone) }), 1);
});

test('email sign-up: without a phone; with a new phone (saved unverified); with someone else’s phone (refused)', async () => {
  const noPhone = freshEmail('nophone');
  await authService.sendOtp({ identifier: noPhone, name: 'No Phone' });
  const created = await authService.verifyOtp({ identifier: noPhone, code: codeFromMail(noPhone) });
  assert.equal(created.customer.phone_number, null);
  assert.equal(created.customer.email_verified, true);

  // A second email-only customer (the phone index allows several without a phone).
  const noPhone2 = freshEmail('nophone');
  await authService.sendOtp({ identifier: noPhone2, name: 'Also No Phone' });
  assert.ok((await authService.verifyOtp({ identifier: noPhone2, code: codeFromMail(noPhone2) })).token);

  const newPhone = freshPhone();
  const withPhone = freshEmail('withphone');
  await authService.sendOtp({ identifier: withPhone, name: 'Phone Giver', phone_number: newPhone });
  const giver = await authService.verifyOtp({ identifier: withPhone, code: codeFromMail(withPhone) });
  assert.equal(giver.customer.phone_number, null, 'an unverified phone is not the account’s phone');
  assert.equal(giver.customer.pending_phone_number, normalizePhone(newPhone));

  // Someone else's phone: refused before any code is sent.
  const ownerPhone = freshPhone();
  const s = await authService.sendOtp({ identifier: ownerPhone, name: 'Real Owner' });
  await authService.verifyOtp({ identifier: ownerPhone, code: s.dev_otp, name: 'Real Owner' });
  const thief = freshEmail('thief');
  const before = outbox.length;
  await rejects(authService.sendOtp({ identifier: thief, name: 'Someone Else', phone_number: ownerPhone }), 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER');
  assert.equal(outbox.length, before, 'no email was sent');
  // The owner themself with a new email: sign in with the phone instead (no second account).
  await rejects(authService.sendOtp({ identifier: freshEmail('owner'), name: 'Real Owner', phone_number: ownerPhone }), 'PHONE_HAS_ACCOUNT');
});

test('an unverified phone is never ownership: its real owner can still register, and then keeps it', async () => {
  const phone = freshPhone();
  const email = freshEmail('claimer');
  await authService.sendOtp({ identifier: email, name: 'Early Claimer', phone_number: phone });
  const claimer = await authService.verifyOtp({ identifier: email, code: codeFromMail(email) });

  const sent = await authService.sendOtp({ identifier: phone, name: 'True Owner' });
  const owner = await authService.verifyOtp({ identifier: phone, code: sent.dev_otp, name: 'True Owner' });
  assert.equal(owner.customer.phone_number, normalizePhone(phone));

  // The claimer can't verify it any more.
  const claimerDoc = await models.Customer.findById(claimer.customer.id).lean();
  await rejects(authService.startPhoneChange(claimerDoc, { phone_number: phone }), 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER');
});

test('two sign-ups claiming one phone at the same moment: one account, the other refused', async () => {
  const phone = normalizePhone(freshPhone());
  const results = await Promise.allSettled([
    authService.customerSession(phone, { name: 'First Person' }),
    authService.customerSession(phone, { name: 'Second Person' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.reason?.code)));
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER');
  assert.equal(await models.Customer.countDocuments({ phone_number: phone }), 1);

  // And the database refuses a second record on its own.
  await assert.rejects(models.Customer.create({ name: 'Direct Insert', phone_number: phone }), (error) => error.code === 11000);
});

test('changing phone: an unused number after its code; never another customer’s; the old one stays until verified', async () => {
  const { customer } = await h.createCustomer('Phone Changer');
  const oldPhone = (await models.Customer.findById(customer.id).lean()).phone_number;
  const newPhone = freshPhone();
  const doc = await models.Customer.findById(customer.id).lean();
  const started = await authService.startPhoneChange(doc, { phone_number: newPhone });
  assert.equal((await models.Customer.findById(customer.id).lean()).phone_number, oldPhone, 'unchanged until verified');

  // Setting it directly is refused.
  await rejects(authService.updateProfile(await models.Customer.findById(customer.id).lean(), { phone_number: newPhone }), 'PHONE_VERIFICATION_REQUIRED');
  // A sign-in code for that phone doesn't count as the change code.
  await rejects(authService.confirmPhoneChange(await models.Customer.findById(customer.id).lean(), { code: '000000' === started.dev_otp ? '111111' : '000000' }), 'OTP_INVALID');

  const changed = await authService.confirmPhoneChange(await models.Customer.findById(customer.id).lean(), { code: started.dev_otp });
  assert.equal(changed.customer.phone_number, normalizePhone(newPhone));

  const { customer: other } = await h.createCustomer('Other Customer');
  const otherPhone = (await models.Customer.findById(other.id).lean()).phone_number;
  await rejects(authService.startPhoneChange(await models.Customer.findById(customer.id).lean(), { phone_number: otherPhone }), 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER');
  assert.equal((await models.Customer.findById(other.id).lean()).phone_number, otherPhone, 'the other customer keeps their number');
});

test('renaming can’t take over a kitchen’s phone', async () => {
  const phone = normalizePhone(freshPhone());
  await h.createKitchen({ name: 'Rename Kitchen', owner_name: 'Claudine Ingabire', phone });
  const sent = await authService.sendOtp({ identifier: phone, name: 'Claudine Ingabire' });
  const session = await authService.verifyOtp({ identifier: phone, code: sent.dev_otp, name: 'Claudine Ingabire' });
  const doc = await models.Customer.findById(session.customer.id).lean();
  await rejects(authService.updateProfile(doc, { name: 'Somebody Else' }), 'NAME_DOES_NOT_MATCH');
  assert.equal((await authService.updateProfile(doc, { name: 'ingabire claudine' })).customer.name, 'Ingabire Claudine');
});

test('existing duplicates (one number in two formats) are reported, never merged or changed; a lone old format is normalized', async () => {
  const number = normalizePhone(freshPhone());
  const local = `0${number.slice(4)}`;
  const lone = normalizePhone(freshPhone());
  const { insertedIds } = await models.Customer.collection.insertMany([
    { name: 'Legacy One', phone_number: number, created_at: new Date() },
    { name: 'Legacy Two', phone_number: local, created_at: new Date() },
    { name: 'Legacy Lone', phone_number: `0${lone.slice(4)}`, created_at: new Date() },
  ]);
  const result = await migrateCustomerIdentity();
  const group = result.duplicates.find((d) => d.phone === number);
  assert.ok(group, 'reported');
  assert.equal(group.customers.length, 2);
  assert.equal((await models.Customer.findById(insertedIds[1]).lean()).phone_number, local, 'left exactly as it was');
  assert.equal((await models.Customer.findById(insertedIds[2]).lean()).phone_number, lone, 'normalized');

  // The shared number still can't be registered by a third person.
  await rejects(authService.sendOtp({ identifier: number, name: 'Third Person' }), 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER');
});

test('an invited admin can’t claim a customer’s phone under another name', async () => {
  const teamService = require('../../src/services/teamService');
  const owner = (await models.Admin.create({ name: 'Owner', email: freshEmail('owner'), role: 'super_admin', status: 'active' })).toObject();
  const { TEAM_ROLES } = require('../../src/config/adminAccess');
  const memberEmail = freshEmail('member');
  await teamService.invite(owner, { email: memberEmail, role: TEAM_ROLES[0], name: 'Member Person' }, null);
  // Emailed (the test mail capture accepts it), so the link is in the email.
  const mail = [...outbox].reverse().find((message) => message.to === memberEmail);
  const token = mail.text.match(/admin-invite\?token=([a-f0-9]+)/)[1];
  const { customer } = await h.createCustomer('Different Customer');
  const phone = (await models.Customer.findById(customer.id).lean()).phone_number;
  const sent = await teamService.sendInvitePhoneCode(token, { phone });
  await rejects(teamService.verifyInvitePhone(token, { code: sent.dev_otp }), 'PHONE_BELONGS_TO_ANOTHER_CUSTOMER');
});
