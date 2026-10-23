const crypto = require('crypto');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const { parseObjectId } = require('../utils/adminValidators');
const { parseEmail, parsePassword } = require('../utils/vendorValidators');
const { NAME_MAX_LENGTH, parseName } = require('../utils/validators');
const { hashPassword } = require('../utils/password');
const { sendEmail, escapeHtml } = require('../utils/email');
const { Admin } = require('../models');
const access = require('../config/adminAccess');
const adminAuthService = require('./adminAuthService');
const adminActionLogService = require('./adminActionLogService');

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const maskPhone = (phone = '') => (phone ? `${phone.slice(0, -4).replace(/\d/g, '•')}${phone.slice(-4)}` : '');

const memberStatus = (admin) => {
  if (admin.is_active === false) return 'deactivated';
  if (admin.status === 'invited') {
    return admin.invite_expires_at && admin.invite_expires_at < new Date() ? 'invite_expired' : 'invited';
  }
  return 'active';
};

const serializeMember = (admin) => ({
  id: String(admin._id),
  name: admin.name || '',
  email: admin.email,
  role: access.roleKey(admin.role),
  role_label: access.roleLabel(admin.role),
  is_owner: admin.role === access.OWNER_ROLE,
  status: memberStatus(admin),
  phone: maskPhone(admin.phone),
  two_factor_enabled: Boolean(admin.two_factor_enabled && admin.phone),
  invited_at: admin.invited_at,
  invite_expires_at: admin.invite_expires_at,
  accepted_at: admin.accepted_at,
  deactivated_at: admin.deactivated_at,
  last_login_at: admin.last_login_at ?? null,
  created_at: admin.created_at,
});

const parseRole = (raw) => {
  const role = String(raw || '');
  if (!access.TEAM_ROLES.includes(role)) {
    throw ApiError.badRequest('Choose a role for this team member.', {
      role: `expected one of: ${access.TEAM_ROLES.join(', ')}`,
    });
  }
  return role;
};

/**
 * The owner's team. Only the owner (super admin) can invite, change or remove
 * members. A member is invited by email with a role and sets their own password
 * from the link, then signs in on the admin sign-in page with their email and
 * the password they set.
 */
class TeamService {
  async list() {
    const admins = await Admin.find({ deleted_at: null }).sort({ role: 1, created_at: 1 }).lean();
    // The owner first, then members.
    admins.sort((a, b) => (b.role === access.OWNER_ROLE) - (a.role === access.OWNER_ROLE));
    return { members: admins.map(serializeMember), ...access.describe() };
  }

  async #findMember(memberId) {
    parseObjectId(memberId, 'member_id');
    const member = await Admin.findOne({ _id: memberId, deleted_at: null }).lean();
    if (!member) throw ApiError.notFound('Team member not found.', 'MEMBER_NOT_FOUND');
    if (member.role === access.OWNER_ROLE) {
      throw ApiError.forbidden('The owner account cannot be changed here.', 'OWNER_ACCOUNT');
    }
    return member;
  }

  /** New token + email. Returns the link only when the email could not be sent. */
  async #sendInvitation(member, owner) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.team.inviteValidHours * 3600 * 1000);
    await Admin.updateOne(
      { _id: member._id },
      {
        $set: {
          status: 'invited',
          invite_token_hash: hashToken(token),
          invite_expires_at: expiresAt,
          invited_at: new Date(),
          invited_by: owner._id,
        },
      }
    );
    const link = `${config.frontendUrl}/admin-invite?token=${token}`;
    const role = access.ROLES[access.roleKey(member.role)];
    const hours = config.team.inviteValidHours;
    const greeting = member.name ? `Hello ${member.name},` : 'Hello,';
    const sent = await sendEmail({
      to: member.email,
      subject: `You're invited to the Online Food Kitchen admin team (${role.label})`,
      text: `${greeting}\n\n${owner.name || 'The owner'} invited you to join the Online Food Kitchen admin team as ${role.label}.\n\nWhat you will be able to do: ${role.description}\n\nCreate your password here (the link works for ${hours} hours):\n${link}\n\nThen sign in on the website: Sign in > Admin, with this email and the password you set.\n\nIf you did not expect this, ignore this email.`,
      html: `<p>${escapeHtml(greeting)}</p><p><strong>${escapeHtml(owner.name || 'The owner')}</strong> invited you to join the Online Food Kitchen admin team as <strong>${escapeHtml(role.label)}</strong>.</p><p>${escapeHtml(role.description)}</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1f2937;color:#fff;border-radius:8px;text-decoration:none">Create my password</a></p><p style="color:#666">The link works for ${hours} hours. Then sign in on the website: Sign in &gt; Admin, with this email and the password you set.</p>`,
    });
    return {
      email_status: sent.status,
      expires_at: expiresAt,
      // The owner can share the link another way if the email did not go out.
      ...(sent.status === 'sent' ? {} : { invite_url: link }),
    };
  }

  async invite(owner, body = {}, req) {
    const email = parseEmail(body.email);
    const role = parseRole(body.role);
    const name = parseName(body.name, { required: false }) || '';

    const existing = await Admin.findOne({ email }).lean();
    let member;
    if (existing && !existing.deleted_at) {
      throw ApiError.conflict(
        existing.role === access.OWNER_ROLE
          ? 'That is the owner\'s email.'
          : 'This email is already on the team. Use "Send new invitation" on their row instead.',
        'MEMBER_EXISTS'
      );
    } else if (existing) {
      // A removed member coming back.
      member = await Admin.findOneAndUpdate(
        { _id: existing._id },
        { $set: { name, role, deleted_at: null, is_active: true, status: 'invited', phone: '', two_factor_enabled: false, deactivated_at: null }, $unset: { password_hash: 1 } },
        { new: true }
      ).lean();
    } else {
      member = (await Admin.create({ email, name, role, status: 'invited', is_active: true, permissions: [] })).toObject();
    }

    const delivery = await this.#sendInvitation(member, owner);
    await this.#audit(owner, req, 'team.invite', member, { role, email_status: delivery.email_status });
    const fresh = await Admin.findById(member._id).lean();
    return { member: serializeMember(fresh), ...delivery };
  }

  /** A new link (also how a member who lost their password or phone gets back in). */
  async resendInvitation(owner, memberId, req) {
    const member = await this.#findMember(memberId);
    if (member.is_active === false) {
      throw ApiError.conflict('Reactivate this member before sending a new invitation.', 'MEMBER_DEACTIVATED');
    }
    const delivery = await this.#sendInvitation(member, owner);
    await this.#audit(owner, req, 'team.resend_invitation', member, { email_status: delivery.email_status });
    return { member: serializeMember(await Admin.findById(member._id).lean()), ...delivery };
  }

  async changeRole(owner, memberId, body = {}, req) {
    const member = await this.#findMember(memberId);
    const role = parseRole(body.role);
    await adminAuthService.verifyActionCode(owner, 'team_change', body.action_code);
    const updated = await Admin.findOneAndUpdate({ _id: member._id }, { $set: { role } }, { new: true }).lean();
    await this.#audit(owner, req, 'team.change_role', member, { from: access.roleKey(member.role), to: role });
    return { member: serializeMember(updated) };
  }

  /** Access ends immediately: every request checks the account. */
  async deactivate(owner, memberId, req) {
    const member = await this.#findMember(memberId);
    const updated = await Admin.findOneAndUpdate(
      { _id: member._id },
      { $set: { is_active: false, deactivated_at: new Date() } },
      { new: true }
    ).lean();
    await this.#audit(owner, req, 'team.deactivate', member);
    return { member: serializeMember(updated) };
  }

  async reactivate(owner, memberId, body = {}, req) {
    const member = await this.#findMember(memberId);
    await adminAuthService.verifyActionCode(owner, 'team_change', body.action_code);
    const updated = await Admin.findOneAndUpdate(
      { _id: member._id },
      { $set: { is_active: true, deactivated_at: null } },
      { new: true }
    ).lean();
    await this.#audit(owner, req, 'team.reactivate', member);
    return { member: serializeMember(updated) };
  }

  /** Removes the member; their past actions stay in the audit log. */
  async remove(owner, memberId, req) {
    const member = await this.#findMember(memberId);
    await Admin.updateOne(
      { _id: member._id },
      { $set: { deleted_at: new Date(), is_active: false, invite_token_hash: null }, $unset: { password_hash: 1 } }
    );
    await this.#audit(owner, req, 'team.remove', member);
    return { removed: true };
  }

  /* ------------------------- invitation (public) ------------------------- */

  async #findInvitation(token) {
    const member = token
      ? await Admin.findOne({ invite_token_hash: hashToken(token), deleted_at: null }).lean()
      : null;
    if (!member || member.status !== 'invited' || member.is_active === false) {
      throw ApiError.notFound('This invitation link is not valid. Ask the owner to send a new one.', 'INVITATION_INVALID');
    }
    if (!member.invite_expires_at || member.invite_expires_at < new Date()) {
      throw ApiError.conflict('This invitation link has expired. Ask the owner to send a new one.', 'INVITATION_EXPIRED');
    }
    return member;
  }

  async getInvitation(token) {
    const member = await this.#findInvitation(token);
    const role = access.ROLES[access.roleKey(member.role)];
    return {
      invitation: {
        email: member.email,
        name: member.name || '',
        role: access.roleKey(member.role),
        role_label: role?.label || member.role,
        role_description: role?.description || '',
        expires_at: member.invite_expires_at,
      },
    };
  }

  /** The invited person sets their own password; the account is then ready. */
  async acceptInvitation(token, body = {}) {
    const member = await this.#findInvitation(token);
    const provided = parseName(body.name, { required: false });
    const name = provided || member.name || member.email.split('@')[0].slice(0, NAME_MAX_LENGTH) || 'Team member';
    const password = parsePassword(body.password, { field: 'password' });
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      throw ApiError.badRequest('Use at least 8 characters with letters and numbers.', { password: 'too weak' });
    }
    if (password === config.admin.seedPassword) {
      throw ApiError.badRequest('Choose a different password.', { password: 'too common' });
    }

    await Admin.updateOne(
      { _id: member._id },
      {
        $set: {
          name,
          two_factor_enabled: false,
          password_hash: await hashPassword(password),
          status: 'active',
          accepted_at: new Date(),
          invite_token_hash: null,
          invite_expires_at: null,
        },
      }
    );
    return { accepted: true, email: member.email };
  }

  async #audit(owner, req, action, member, metadata = {}) {
    await adminActionLogService.record(
      owner,
      {
        action,
        target_type: 'admin_member',
        target_id: member._id,
        target_label: member.email,
        metadata: { role: access.roleKey(member.role), ...metadata },
      },
      req
    );
  }
}

module.exports = new TeamService();
module.exports.serializeMember = serializeMember;
