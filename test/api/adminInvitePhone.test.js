// Accepting an admin invitation: the invitee must verify a phone with an SMS
// code before they can create their password, and the account becomes active
// only then. The phone is kept by the server, so a page that skips ahead (or
// sends another number) cannot finish. Sign-in routes allow 20 requests a
// minute, so the main path goes through HTTP and the rest calls the services.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/testServer');

let models;
let teamService;
let authService;
let hashPassword;
let comparePassword;
let normalizePhone;
let TEAM_ROLES;
let owner;

let seq = 0;
// Airtel 072… with a different middle part from adminPhoneLogin.test.js and
// never the 078… numbers testServer.createCustomer makes.
const freshPhone = () => {
  seq += 1;
  return `072${String((process.pid + 5000) % 10000).padStart(4, '0')}${String(seq).padStart(3, '0')}`;
};
const PASSWORD = 'Joined-Team-2026';

/** A new invitation; returns the member and the raw link token. */
async function invite(name = 'New Member') {
  seq += 1;
  const result = await teamService.invite(owner, { email: `member${seq}.${process.pid}@kitchenlink.test`, role: TEAM_ROLES[0], name }, null);
  assert.ok(result.invite_url, 'no email service in tests: the link is returned');
  return { member: result.member, token: new URL(result.invite_url).searchParams.get('token') };
}

const memberRecord = (id) =>
  models.Admin.findById(id).select('+password_hash +invite_phone_pending +invite_phone_verified +invite_phone_verified_at').lean();

/** Steps 1 and 2 through the services. */
async function verifyPhone(token, phone = freshPhone()) {
  const sent = await teamService.sendInvitePhoneCode(token, { phone });
  await teamService.verifyInvitePhone(token, { code: sent.dev_otp });
  return phone;
}

const rejects = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, `${error.code}: ${error.message}`);
  return true;
});

before(async () => {
  await h.start();
  models = require('../../src/models');
  teamService = require('../../src/services/teamService');
  authService = require('../../src/services/authService');
  ({ hashPassword, comparePassword } = require('../../src/utils/password'));
  ({ normalizePhone } = require('../../src/utils/validators'));
  ({ TEAM_ROLES } = require('../../src/config/adminAccess'));
  owner = (await models.Admin.create({
    name: 'Owner',
    email: `owner.${process.pid}@kitchenlink.test`,
    password_hash: await hashPassword('Owner-Password-2026!'),
    role: 'super_admin',
    status: 'active',
    is_active: true,
  })).toObject();
});
after(() => h.stop());

test('full invite journey activates the account and normal admin sign-in requires only its password', async () => {
  const { member, token } = await invite('Aline Uwase');
  const path = `/admin/auth/invitations/${token}`;
  const phone = freshPhone();

  const opened = await h.api('GET', path);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.invitation.phone_verified, false);

  // Straight to the password: refused, nothing activated.
  const skipped = await h.api('POST', `${path}/accept`, { body: { password: PASSWORD, confirm_password: PASSWORD, phone } });
  assert.equal(skipped.status, 403);
  assert.equal(skipped.body.error?.code ?? skipped.body.code, 'PHONE_VERIFICATION_REQUIRED');
  assert.equal((await memberRecord(member.id)).status, 'invited');

  const invalidPhone = await h.api('POST', `${path}/phone/send-code`, { body: { phone: '12345' } });
  assert.equal(invalidPhone.status, 400);

  const sent = await h.api('POST', `${path}/phone/send-code`, { body: { phone } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.ok(sent.body.expires_in_seconds > 0);
  assert.equal(sent.body.resend_after_seconds, 30);
  assert.ok(!sent.body.sent_to.includes(phone.slice(1, 7)), 'the number is masked');

  const wrong = await h.api('POST', `${path}/phone/verify`, { body: { code: sent.body.dev_otp === '111111' ? '222222' : '111111' } });
  assert.equal(wrong.status, 400);

  const verified = await h.api('POST', `${path}/phone/verify`, { body: { code: sent.body.dev_otp } });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.phone_verified, true);

  // Reopening the link resumes at the password step (decided by the server).
  assert.equal((await h.api('GET', path)).body.invitation.phone_verified, true);

  const mismatch = await h.api('POST', `${path}/accept`, { body: { password: PASSWORD, confirm_password: 'Something-else-1' } });
  assert.equal(mismatch.status, 400);
  const weak = await h.api('POST', `${path}/accept`, { body: { password: 'password', confirm_password: 'password' } });
  assert.equal(weak.status, 400);

  const accepted = await h.api('POST', `${path}/accept`, { body: { password: PASSWORD, confirm_password: PASSWORD } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.accepted, true);
  assert.equal(accepted.body.token, undefined, 'no admin session is handed out here');

  const saved = await memberRecord(member.id);
  assert.equal(saved.status, 'active');
  assert.equal(saved.phone, normalizePhone(phone));
  assert.equal(saved.two_factor_enabled, true);
  assert.ok(await comparePassword(PASSWORD, saved.password_hash), 'the password is stored hashed');
  assert.notEqual(saved.password_hash, PASSWORD);
  assert.equal(saved.invite_phone_pending, '');
  assert.equal(saved.invite_phone_verified, '');

  // The link is used up.
  assert.equal((await h.api('GET', path)).status, 404);

  // Audit trail, never with the code or the password.
  const actions = (await models.AdminActionLog.find({ target_id: String(member.id) }).lean()).map((log) => log.action);
  for (const action of ['team.invite', 'team.invite_phone_failed', 'team.invite_phone_verified', 'team.invite_accepted']) {
    assert.ok(actions.includes(action), `${action} logged`);
  }
  const logText = JSON.stringify(await models.AdminActionLog.find({ target_id: String(member.id) }).lean());
  assert.ok(!logText.includes(PASSWORD) && !logText.includes(sent.body.dev_otp));

  // Invitation phone verification is separate from normal sign-in. Once
  // active, this admin signs in with the password alone, even with 2FA enabled.
  await assert.rejects(
    authService.sendOtp({ phone_number: phone, name: 'Aline' }),
    (error) => error.code === 'PASSWORD_REQUIRED'
  );
  const session = await h.api('POST', '/admin/auth/login', {
    body: { identifier: saved.email, password: PASSWORD },
  });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  assert.ok(session.body.token);
  assert.equal(session.body.two_factor_required, undefined);
});

test('a phone the browser sends is never trusted: only the number the code went to can be verified', async () => {
  const { member, token } = await invite();
  const first = freshPhone();
  const firstCode = (await teamService.sendInvitePhoneCode(token, { phone: first })).dev_otp;

  // Switching to another number starts over: the first number's code no longer counts.
  const second = freshPhone();
  await teamService.sendInvitePhoneCode(token, { phone: second });
  await assert.rejects(teamService.verifyInvitePhone(token, { code: firstCode, phone: first }));
  await rejects(teamService.acceptInvitation(token, { password: PASSWORD, phone: first }), 'PHONE_VERIFICATION_REQUIRED');

  // No code requested at all.
  const other = await invite();
  await rejects(teamService.verifyInvitePhone(other.token, { code: '123456' }), 'PHONE_CODE_NOT_SENT');
  assert.equal((await memberRecord(member.id)).status, 'invited');
});

test('a phone that already belongs to another admin is refused after the code, and nothing is activated', async () => {
  const taken = freshPhone();
  await models.Admin.create({ name: 'Existing', email: `existing.${process.pid}@kitchenlink.test`, role: TEAM_ROLES[0], status: 'active', phone: normalizePhone(taken) });
  const { member, token } = await invite();
  const sent = await teamService.sendInvitePhoneCode(token, { phone: taken });
  await rejects(teamService.verifyInvitePhone(token, { code: sent.dev_otp }), 'PHONE_ALREADY_REGISTERED');
  await rejects(teamService.acceptInvitation(token, { password: PASSWORD }), 'PHONE_VERIFICATION_REQUIRED');
  assert.equal((await memberRecord(member.id)).status, 'invited');
});

test('too many wrong codes burn the code; a code from another purpose does not work', async () => {
  const { token } = await invite();
  const phone = freshPhone();
  const sent = await teamService.sendInvitePhoneCode(token, { phone });
  const wrong = sent.dev_otp === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(teamService.verifyInvitePhone(token, { code: wrong }));
  }
  await assert.rejects(teamService.verifyInvitePhone(token, { code: sent.dev_otp }), 'the right code no longer works');

  // A customer sign-in code for the same phone is not an invitation code.
  const { token: token2 } = await invite();
  const phone2 = freshPhone();
  await teamService.sendInvitePhoneCode(token2, { phone: phone2 });
  await models.OtpCode.collection.updateMany({ phone_number: normalizePhone(phone2) }, { $set: { created_at: new Date(Date.now() - 5 * 60 * 1000) } });
  const customerCode = (await authService.sendOtp({ phone_number: phone2, name: 'Test Customer' })).dev_otp;
  await assert.rejects(teamService.verifyInvitePhone(token2, { code: customerCode }));
});

test('codes cannot be re-sent immediately', async () => {
  const { token } = await invite();
  const phone = freshPhone();
  await teamService.sendInvitePhoneCode(token, { phone });
  await rejects(teamService.sendInvitePhoneCode(token, { phone }), 'OTP_RESEND_TOO_SOON');
});

test('a stale phone verification must be redone', async () => {
  const { member, token } = await invite();
  await verifyPhone(token);
  await models.Admin.updateOne({ _id: member.id }, { $set: { invite_phone_verified_at: new Date(Date.now() - 31 * 60 * 1000) } });
  assert.equal((await teamService.getInvitation(token)).invitation.phone_verified, false);
  await rejects(teamService.acceptInvitation(token, { password: PASSWORD }), 'PHONE_VERIFICATION_REQUIRED');
});

test('a new invitation cancels the old link and the phone progress', async () => {
  const { member, token } = await invite();
  await verifyPhone(token);
  const resent = await teamService.resendInvitation(owner, member.id, null);
  const newToken = new URL(resent.invite_url).searchParams.get('token');
  await rejects(teamService.acceptInvitation(token, { password: PASSWORD }), 'INVITATION_INVALID');
  await rejects(teamService.acceptInvitation(newToken, { password: PASSWORD }), 'PHONE_VERIFICATION_REQUIRED');

  // And the new link works end to end.
  const phone = await verifyPhone(newToken);
  const done = await teamService.acceptInvitation(newToken, { password: PASSWORD, confirm_password: PASSWORD });
  assert.equal(done.accepted, true);
  assert.equal((await memberRecord(member.id)).phone, normalizePhone(phone));
});
