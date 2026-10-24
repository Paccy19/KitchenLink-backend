const config = require('../config');
const ApiError = require('../utils/ApiError');
const { sendSms } = require('../utils/sms');
const { parseObjectId, parseOptionalText } = require('../utils/adminValidators');
const payoutDestinationRepository = require('../repositories/payoutDestinationRepository');
const platformWithdrawalRepository = require('../repositories/platformWithdrawalRepository');
const reconciliationRepository = require('../repositories/reconciliationRepository');
const transactionRepository = require('../repositories/transactionRepository');
const platformAccountRepository = require('../repositories/platformAccountRepository');
const platformLedgerService = require('./platformLedgerService');
const adminAuthService = require('./adminAuthService');
const adminActionLogService = require('./adminActionLogService');
const notificationService = require('./notificationService');
const ownerPayoutSettingsRepository = require('../repositories/ownerPayoutSettingsRepository');
const { activeProvider } = require('./payoutProviders');
const { parsePayoutPhone } = require('../utils/withdrawals');

// Audit-log actor for actions the system takes on the owner's behalf.
const SYSTEM_ACTOR = { _id: null, name: 'System (payout schedule)', email: 'system' };

const owner = config.admin.owner;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const money = (value) => `${Math.round(value).toLocaleString()} RWF`;

const requiredText = (raw, field, { min = 2, max = 120 } = {}) => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length < min || value.length > max) {
    throw ApiError.badRequest(`${field} is required.`, { [field]: `expected ${min}-${max} characters` });
  }
  return value;
};

const parseWholeRwf = (raw, field, { allowNegative = false } = {}) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value === 0 || (!allowNegative && value < 0)) {
    throw ApiError.badRequest(`${field} must be a ${allowNegative ? 'non-zero' : 'positive'} whole number.`, {
      [field]: allowNegative ? 'expected a non-zero integer (negative to reduce)' : 'expected an integer greater than 0',
    });
  }
  return value;
};

const serializeDestination = (destination) => ({
  id: String(destination._id),
  label: destination.label,
  type: destination.type,
  provider: destination.provider,
  account_name: destination.account_name,
  account_number: destination.account_number,
  status: destination.status,
  activates_at: destination.activates_at,
  ready: destination.status === 'active' && new Date(destination.activates_at).getTime() <= Date.now(),
  created_at: destination.created_at,
});

const serializeWithdrawal = (withdrawal) => ({
  id: String(withdrawal._id),
  amount_rwf: withdrawal.amount_rwf,
  destination: withdrawal.destination || null,
  status: withdrawal.status,
  source: withdrawal.source,
  reference: withdrawal.reference || null,
  failure_reason: withdrawal.failure_reason || null,
  processed_at: withdrawal.processed_at ?? null,
  created_at: withdrawal.created_at,
});

const serializeCheck = (check) => ({
  id: String(check._id),
  account_label: check.account_label,
  statement_date: check.statement_date,
  statement_balance_rwf: check.statement_balance_rwf,
  system_cash_rwf: check.system_cash_rwf,
  difference_rwf: check.difference_rwf,
  matches: check.difference_rwf === 0,
  note: check.note || '',
  created_at: check.created_at,
});

/**
 * The owner's side of the platform money: withdrawing commission to locked
 * company accounts (manual transfer, confirmed by reference), books
 * adjustments, statement reconciliation and the weekly sweep reminder.
 * Every money action needs a fresh SMS code and a non-default password.
 */
class PlatformOwnerService {
  /** Everything the owner's wallet page needs, computed fresh. */
  async overview(admin) {
    const [books, destinations, withdrawals, checks, weekTotal, usesDefaultPassword] = await Promise.all([
      platformLedgerService.snapshot(),
      payoutDestinationRepository.listActive(),
      platformWithdrawalRepository.list({ limit: 30 }),
      reconciliationRepository.list({ limit: 12 }),
      platformWithdrawalRepository.totalSince(new Date(Date.now() - WEEK_MS)),
      adminAuthService.usesDefaultPassword(admin),
    ]);
    const limits = this.#limits(books, weekTotal);
    const processing = withdrawals.find((entry) => entry.status === 'processing');
    const readyDestinations = destinations.filter((d) => new Date(d.activates_at).getTime() <= Date.now());

    const blockers = [];
    if (usesDefaultPassword) blockers.push({ code: 'DEFAULT_PASSWORD', message: 'Change the default admin password in Settings.' });
    if (!admin.two_factor_enabled || !admin.phone) blockers.push({ code: 'TWO_FACTOR_REQUIRED', message: 'Turn on SMS codes in Settings.' });
    if (books.unreconciled_rwf !== 0) blockers.push({ code: 'BOOKS_UNBALANCED', message: `The books are off by ${money(books.unreconciled_rwf)}. Record an adjustment first.` });
    if (processing) blockers.push({ code: 'WITHDRAWAL_IN_PROGRESS', message: 'Confirm or cancel the withdrawal in progress first.' });
    if (readyDestinations.length === 0) blockers.push({ code: 'NO_DESTINATION', message: 'Add a company payout account (usable after the waiting period).' });

    const sweepAccount = await platformAccountRepository.getOrCreate();
    const payoutSettings = await this.getPayoutSettings();
    return {
      payout_settings: payoutSettings,
      books: {
        cash_balance_rwf: books.cash_balance_rwf,
        held_balance_rwf: books.held_balance_rwf,
        vendor_payable_rwf: books.vendor_payable_rwf,
        driver_payable_rwf: books.driver_payable_rwf,
        owner_balance_rwf: books.commission_balance_rwf,
        unreconciled_rwf: books.unreconciled_rwf,
        balanced: books.unreconciled_rwf === 0,
        total_commission_rwf: books.total_commission_rwf,
        total_adjustments_rwf: books.total_adjustments_rwf,
        total_owner_withdrawn_rwf: books.total_owner_withdrawn_rwf,
        computed_at: books.computed_at,
      },
      withdrawable: { ...limits, can_withdraw_now: blockers.length === 0 && limits.max_now_rwf > 0 },
      blockers,
      security: {
        two_factor_enabled: Boolean(admin.two_factor_enabled && admin.phone),
        uses_default_password: usesDefaultPassword,
        default_jwt_secret: Boolean(config.auth.jwtSecretProblem),
      },
      destinations: destinations.map(serializeDestination),
      withdrawals: withdrawals.map(serializeWithdrawal),
      reconciliations: checks.map(serializeCheck),
      sweep: {
        enabled: payoutSettings.schedule.mode !== 'off',
        mode: payoutSettings.schedule.mode,
        frequency: payoutSettings.schedule.frequency,
        weekday: payoutSettings.schedule.weekday,
        day_of_month: payoutSettings.schedule.day_of_month,
        hour: payoutSettings.schedule.hour,
        min_rwf: owner.sweep.minRwf,
        last_week: sweepAccount.last_sweep_week || null,
        last_at: sweepAccount.last_sweep_at || null,
        last_amount_rwf: sweepAccount.last_sweep_amount_rwf || 0,
      },
    };
  }

  #limits(books, weekTotal) {
    const ownerBalance = Math.max(0, books.commission_balance_rwf);
    const reserve = Math.round((ownerBalance * owner.reservePercent) / 100);
    const available = Math.max(0, ownerBalance - books.owner_processing_rwf - reserve);
    const weeklyRemaining = Math.max(0, owner.maxWeeklyRwf - weekTotal);
    return {
      owner_balance_rwf: ownerBalance,
      reserve_percent: owner.reservePercent,
      reserve_rwf: reserve,
      processing_rwf: books.owner_processing_rwf,
      available_rwf: available,
      max_per_withdrawal_rwf: owner.maxWithdrawalRwf,
      max_weekly_rwf: owner.maxWeeklyRwf,
      withdrawn_this_week_rwf: weekTotal,
      weekly_remaining_rwf: weeklyRemaining,
      max_now_rwf: Math.min(available, owner.maxWithdrawalRwf, weeklyRemaining),
    };
  }

  async #assertNoDefaultPassword(admin) {
    if (await adminAuthService.usesDefaultPassword(admin)) {
      throw ApiError.forbidden('Change the default admin password before moving money.', 'DEFAULT_PASSWORD');
    }
  }

  async #alertOwner(admin, message) {
    notificationService
      .notifyAdmin({ type: 'owner_finance', title: 'Platform money', body: message, link: '/admin-dashboard/platform' })
      .catch(() => null);
    if (admin?.phone) sendSms(admin.phone, `KitchenLink: ${message}`).catch(() => null);
  }

  /* ---------------------------- withdrawals ---------------------------- */

  /** Destination must exist, be active and past its waiting period. */
  async #readyDestination(destinationId) {
    const destination = await payoutDestinationRepository.findById(destinationId);
    if (!destination || destination.status !== 'active') {
      throw ApiError.notFound('Payout account not found.', 'DESTINATION_NOT_FOUND');
    }
    if (new Date(destination.activates_at).getTime() > Date.now()) {
      throw ApiError.conflict(
        `This payout account can be used from ${new Date(destination.activates_at).toLocaleString('en-GB', { timeZone: 'Africa/Kigali' })} (new accounts have a waiting period).`,
        'DESTINATION_NOT_READY'
      );
    }
    return destination;
  }

  /** Books balanced, nothing in progress, within limits and available. */
  async #assertWithdrawable(amount) {
    const books = await platformLedgerService.snapshot();
    if (books.unreconciled_rwf !== 0) {
      throw ApiError.conflict(
        `The books are off by ${money(books.unreconciled_rwf)}. Record an adjustment before withdrawing.`,
        'BOOKS_UNBALANCED'
      );
    }
    if (await platformWithdrawalRepository.findProcessing()) {
      throw ApiError.conflict('A withdrawal is already in progress. Confirm or cancel it first.', 'WITHDRAWAL_IN_PROGRESS');
    }
    const limits = this.#limits(books, await platformWithdrawalRepository.totalSince(new Date(Date.now() - WEEK_MS)));
    if (amount > limits.max_per_withdrawal_rwf) {
      throw ApiError.badRequest(`The most you can withdraw at once is ${money(limits.max_per_withdrawal_rwf)}.`, { amount_rwf: 'over the per-withdrawal limit' });
    }
    if (amount > limits.weekly_remaining_rwf) {
      throw ApiError.badRequest(`Only ${money(limits.weekly_remaining_rwf)} more can be withdrawn this week.`, { amount_rwf: 'over the weekly limit' });
    }
    if (amount > limits.available_rwf) {
      throw ApiError.badRequest(
        `Only ${money(limits.available_rwf)} is available (commission minus the ${limits.reserve_percent}% reserve).`,
        { amount_rwf: 'more than the available commission' }
      );
    }
    return limits;
  }

  async #createWithdrawal({ admin, amount, destination, source, req }) {
    const provider = activeProvider();
    let withdrawal;
    try {
      withdrawal = await platformWithdrawalRepository.create({
        amount_rwf: amount,
        destination_id: destination._id,
        destination: {
          label: destination.label,
          type: destination.type,
          provider: destination.provider,
          account_name: destination.account_name,
          account_number: destination.account_number,
        },
        status: 'processing',
        source,
        provider: config.admin.owner.payoutProvider,
        requested_by: admin?._id || null,
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw ApiError.conflict('A withdrawal is already in progress. Confirm or cancel it first.', 'WITHDRAWAL_IN_PROGRESS');
      }
      throw error;
    }

    await adminActionLogService.record(admin || SYSTEM_ACTOR, {
      action: 'platform.withdrawal.requested',
      target_type: 'platform_withdrawal',
      target_id: withdrawal._id,
      target_label: String(amount),
      metadata: { amount_rwf: amount, destination: withdrawal.destination, source },
    }, req);

    // Hand it to the payout service. With `manual`, the owner transfers it.
    let result = { status: 'manual' };
    if (provider.automatic && provider.supports(destination)) {
      result = await provider
        .send({ amountRwf: amount, destination, reference: String(withdrawal._id) })
        .catch((error) => ({ status: 'failed', error: error?.message || 'payout service error' }));
    }
    if (result.status === 'sent') {
      withdrawal = await this.#finalizeCompleted(withdrawal._id, { reference: result.providerReference, adminId: null });
    } else if (result.status === 'failed') {
      withdrawal = await platformWithdrawalRepository.finalizeProcessing(withdrawal._id, {
        status: 'failed',
        failure_reason: `Payout service: ${result.error}`,
        processed_at: new Date(),
      });
    }
    return { withdrawal, result };
  }

  /** Records a finished transfer: ledger debit, audit, alert. Once only. */
  async #finalizeCompleted(withdrawalId, { reference, adminId, admin = null, req }) {
    const withdrawal = await platformWithdrawalRepository.finalizeProcessing(withdrawalId, {
      status: 'completed',
      reference,
      processed_by: adminId,
      processed_at: new Date(),
    });
    if (!withdrawal) {
      throw ApiError.conflict('This withdrawal is not in progress.', 'WITHDRAWAL_FINALIZED');
    }
    await transactionRepository.create({
      type: 'platform_withdrawal',
      direction: 'debit',
      status: 'settled',
      amount_rwf: withdrawal.amount_rwf,
      reference,
      description: `Owner withdrawal to ${withdrawal.destination?.label} (${withdrawal.destination?.account_number})`,
      metadata: { platform_withdrawal_id: String(withdrawal._id), source: withdrawal.source, provider: withdrawal.provider },
    });
    await adminActionLogService.record(admin || SYSTEM_ACTOR, {
      action: 'platform.withdrawal.completed',
      target_type: 'platform_withdrawal',
      target_id: withdrawal._id,
      target_label: String(withdrawal.amount_rwf),
      metadata: { reference },
    }, req);
    return withdrawal;
  }

  async requestWithdrawal(admin, body = {}, req) {
    const amount = parseWholeRwf(body.amount_rwf, 'amount_rwf');
    const destinationId = parseObjectId(body.destination_id, 'destination_id');
    const source = body.source === 'weekly_sweep' ? 'weekly_sweep' : 'manual';

    // Check every rule first so a rejected request does not use up the code.
    await this.#assertNoDefaultPassword(admin);
    adminAuthService.assertTwoFactor(admin);
    const destination = await this.#readyDestination(destinationId);
    await this.#assertWithdrawable(amount);
    await adminAuthService.verifyActionCode(admin, 'platform_withdrawal', body.otp_code);

    const { withdrawal, result } = await this.#createWithdrawal({ admin, amount, destination, source, req });
    this.#alertOwner(
      admin,
      result.status === 'sent'
        ? `Withdrawal of ${money(amount)} to ${destination.label} (${destination.account_number}) was sent automatically.`
        : `Withdrawal of ${money(amount)} to ${destination.label} (${destination.account_number}) was requested. If this wasn't you, change your password now.`
    );
    return { withdrawal: serializeWithdrawal(withdrawal) };
  }

  /** The owner made the transfer: record it with its reference. */
  async completeWithdrawal(admin, withdrawalId, body = {}, req) {
    parseObjectId(withdrawalId, 'withdrawal_id');
    const reference = requiredText(body.reference, 'reference', { min: 3, max: 120 });
    const withdrawal = await this.#finalizeCompleted(withdrawalId, { reference, adminId: admin._id, admin, req });
    this.#alertOwner(admin, `Withdrawal of ${money(withdrawal.amount_rwf)} to ${withdrawal.destination?.label} recorded as paid (ref ${reference}).`);
    return { withdrawal: serializeWithdrawal(withdrawal) };
  }

  /** The transfer didn't happen: release the reserved amount. */
  async cancelWithdrawal(admin, withdrawalId, body = {}, req) {
    parseObjectId(withdrawalId, 'withdrawal_id');
    const reason = parseOptionalText(body.reason, { field: 'reason', max: 200 }) || 'Cancelled by owner';
    const withdrawal = await platformWithdrawalRepository.finalizeProcessing(withdrawalId, {
      status: 'failed',
      failure_reason: reason,
      processed_by: admin._id,
      processed_at: new Date(),
    });
    if (!withdrawal) {
      throw ApiError.conflict('This withdrawal is not in progress.', 'WITHDRAWAL_FINALIZED');
    }
    await adminActionLogService.record(admin, {
      action: 'platform.withdrawal.cancelled',
      target_type: 'platform_withdrawal',
      target_id: withdrawal._id,
      target_label: String(withdrawal.amount_rwf),
      metadata: { reason },
    }, req);
    return { withdrawal: serializeWithdrawal(withdrawal) };
  }

  /* -------------------------- payout settings -------------------------- */

  async getPayoutSettings() {
    const settings = await ownerPayoutSettingsRepository.get();
    const destination = settings.destination_id
      ? await payoutDestinationRepository.findById(settings.destination_id)
      : null;
    const provider = activeProvider();
    return {
      method: settings.method,
      account: destination && destination.status === 'active' ? serializeDestination(destination) : null,
      schedule: settings.schedule,
      provider: { key: config.admin.owner.payoutProvider, label: provider.label, automatic: provider.automatic },
      updated_at: settings.updated_at,
    };
  }

  /**
   * Saves where commission goes (bank account or mobile money number) and
   * when it is withdrawn. Needs an SMS code. A new or changed account becomes
   * a locked payout account (waiting period) and replaces the previous one.
   */
  async savePayoutSettings(admin, body = {}, req) {
    const method = body.method === 'mobile_money' ? 'mobile_money' : body.method === 'bank' ? 'bank' : null;
    if (!method) throw ApiError.badRequest('method is required.', { method: 'expected bank or mobile_money' });

    const account =
      method === 'bank'
        ? {
            type: 'bank',
            provider: requiredText(body.bank_name, 'bank_name', { max: 60 }),
            account_name: requiredText(body.account_name, 'account_name'),
            account_number: requiredText(body.account_number, 'account_number', { min: 6, max: 30 }).replace(/[\s-]/g, ''),
          }
        : {
            type: 'mobile_money',
            provider: body.network === 'Airtel Money' ? 'Airtel Money' : 'MTN Mobile Money',
            account_name: requiredText(body.account_name, 'account_name'),
            account_number: parsePayoutPhone(body.phone, 'phone'),
          };
    if (method === 'bank' && !/^\d{6,30}$/.test(account.account_number)) {
      throw ApiError.badRequest('account_number must contain only digits.', { account_number: 'expected 6-30 digits' });
    }

    const raw = body.schedule || {};
    const mode = ['off', 'reminder', 'auto'].includes(raw.mode) ? raw.mode : 'reminder';
    const frequency = raw.frequency === 'monthly' ? 'monthly' : 'weekly';
    const intIn = (value, min, max, field) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw ApiError.badRequest(`schedule.${field} is invalid.`, { [field]: `expected ${min}-${max}` });
      }
      return n;
    };
    const schedule = {
      mode,
      frequency,
      weekday: intIn(raw.weekday ?? 5, 0, 6, 'weekday'),
      day_of_month: intIn(raw.day_of_month ?? 1, 1, 28, 'day_of_month'),
      hour: intIn(raw.hour ?? 9, 0, 23, 'hour'),
      amount_mode: raw.amount_mode === 'fixed' ? 'fixed' : 'all_available',
      fixed_amount_rwf: 0,
    };
    if (schedule.amount_mode === 'fixed') {
      schedule.fixed_amount_rwf = parseWholeRwf(raw.fixed_amount_rwf, 'fixed_amount_rwf');
      if (schedule.fixed_amount_rwf > owner.maxWithdrawalRwf) {
        throw ApiError.badRequest(`The fixed amount can be at most ${money(owner.maxWithdrawalRwf)} (per-withdrawal limit).`, {
          fixed_amount_rwf: 'over the per-withdrawal limit',
        });
      }
    }

    await this.#assertNoDefaultPassword(admin);
    adminAuthService.assertTwoFactor(admin);
    await adminAuthService.verifyActionCode(admin, 'payout_settings', body.otp_code);

    // Same account as saved? Keep it (no new waiting period). Otherwise lock in
    // the new one and retire the previous settings account.
    const current = await ownerPayoutSettingsRepository.get();
    const previous = current.destination_id ? await payoutDestinationRepository.findById(current.destination_id) : null;
    const sameAccount =
      previous &&
      previous.status === 'active' &&
      previous.type === account.type &&
      previous.provider === account.provider &&
      previous.account_name === account.account_name &&
      previous.account_number === account.account_number;

    let destination = previous;
    if (!sameAccount) {
      destination = await payoutDestinationRepository.create({
        ...account,
        label: method === 'bank' ? `${account.provider} account` : `${account.provider} number`,
        activates_at: new Date(Date.now() + owner.destinationCooldownHours * 60 * 60 * 1000),
        created_by: admin._id,
      });
      if (previous && previous.status === 'active') await payoutDestinationRepository.remove(previous._id);
      this.#alertOwner(
        admin,
        `Your payout account was changed to ${account.provider} ${account.account_number} (${account.account_name}). It can receive withdrawals after ${owner.destinationCooldownHours} hours. If this wasn't you, change your password now.`
      );
    }

    await ownerPayoutSettingsRepository.save({
      method,
      destination_id: destination._id,
      schedule,
      updated_by: admin._id,
    });
    await adminActionLogService.record(admin, {
      action: 'platform.payout_settings.saved',
      target_type: 'payout_destination',
      target_id: destination._id,
      target_label: `${account.provider} ${account.account_number}`,
      metadata: { method, schedule, account_changed: !sameAccount },
    }, req);
    return { settings: await this.getPayoutSettings(), account_changed: !sameAccount };
  }

  /**
   * Scheduled automatic withdrawal (called by platformSweepService): creates
   * the withdrawal to the saved account under the same rules as a manual one.
   * The owner authorized it by saving the settings with an SMS code. Returns
   * what happened instead of throwing, so the scheduler can report it.
   */
  async autoWithdraw() {
    const settings = await ownerPayoutSettingsRepository.get();
    if (!settings.destination_id) return { status: 'skipped', reason: 'No payout account saved in payout settings.' };
    try {
      const destination = await this.#readyDestination(settings.destination_id);
      const books = await platformLedgerService.snapshot();
      const limits = this.#limits(books, await platformWithdrawalRepository.totalSince(new Date(Date.now() - WEEK_MS)));
      const amount =
        settings.schedule.amount_mode === 'fixed'
          ? settings.schedule.fixed_amount_rwf
          : limits.max_now_rwf;
      if (!amount || amount < owner.sweep.minRwf) {
        return { status: 'skipped', reason: `Only ${money(amount || 0)} is available (minimum ${money(owner.sweep.minRwf)}).` };
      }
      await this.#assertWithdrawable(amount);
      const { withdrawal, result } = await this.#createWithdrawal({ admin: null, amount, destination, source: 'auto' });
      return { status: result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'awaiting_transfer', withdrawal, destination };
    } catch (error) {
      return { status: 'skipped', reason: error.message };
    }
  }

  /* --------------------------- destinations ---------------------------- */

  async addDestination(admin, body = {}, req) {
    const type = body.type === 'mobile_money' ? 'mobile_money' : body.type === 'bank' ? 'bank' : null;
    if (!type) throw ApiError.badRequest('type is required.', { type: 'expected bank or mobile_money' });
    const doc = {
      type,
      label: requiredText(body.label, 'label', { max: 60 }),
      provider: requiredText(body.provider, 'provider', { max: 60 }),
      account_name: requiredText(body.account_name, 'account_name'),
      account_number:
        type === 'mobile_money'
          ? parsePayoutPhone(body.account_number, 'account_number')
          : requiredText(body.account_number, 'account_number', { min: 4, max: 40 }).replace(/[\s-]/g, ''),
    };
    if (type === 'bank' && !/^\d{4,30}$/.test(doc.account_number)) {
      throw ApiError.badRequest('account_number must contain only digits.', { account_number: 'expected 4-30 digits' });
    }
    await this.#assertNoDefaultPassword(admin);
    await adminAuthService.verifyActionCode(admin, 'payout_destination', body.otp_code);

    const activatesAt = new Date(Date.now() + owner.destinationCooldownHours * 60 * 60 * 1000);
    const destination = await payoutDestinationRepository.create({ ...doc, activates_at: activatesAt, created_by: admin._id });
    await adminActionLogService.record(admin, {
      action: 'platform.destination.added',
      target_type: 'payout_destination',
      target_id: destination._id,
      target_label: doc.label,
      metadata: { ...doc, activates_at: activatesAt },
    }, req);
    this.#alertOwner(admin, `New payout account "${doc.label}" (${doc.provider} ${doc.account_number}) was added. It can receive withdrawals after ${owner.destinationCooldownHours} hours. If this wasn't you, remove it and change your password.`);
    return { destination: serializeDestination(destination) };
  }

  async removeDestination(admin, destinationId, body = {}, req) {
    parseObjectId(destinationId, 'destination_id');
    await adminAuthService.verifyActionCode(admin, 'remove_destination', body.otp_code);
    const removed = await payoutDestinationRepository.remove(destinationId);
    if (!removed) throw ApiError.notFound('Payout account not found.', 'DESTINATION_NOT_FOUND');
    await adminActionLogService.record(admin, {
      action: 'platform.destination.removed',
      target_type: 'payout_destination',
      target_id: removed._id,
      target_label: removed.label,
    }, req);
    return { destination: serializeDestination(removed) };
  }

  /* ---------------------------- adjustments ---------------------------- */

  /**
   * Corrects the owner's balance (e.g. writing off money lost before the
   * books were fixed). Negative reduces it. Recorded on the ledger, never
   * deleted.
   */
  async recordAdjustment(admin, body = {}, req) {
    const amount = parseWholeRwf(body.amount_rwf, 'amount_rwf', { allowNegative: true });
    const reason = requiredText(body.reason, 'reason', { min: 5, max: 300 });
    await this.#assertNoDefaultPassword(admin);
    await adminAuthService.verifyActionCode(admin, 'adjustment', body.otp_code);

    const entry = await transactionRepository.create({
      type: 'adjustment',
      direction: 'internal',
      status: 'settled',
      amount_rwf: amount,
      reference: 'ADJ',
      description: reason,
      metadata: { recorded_by: String(admin._id) },
    });
    await adminActionLogService.record(admin, {
      action: 'platform.adjustment',
      target_type: 'transaction',
      target_id: entry._id,
      target_label: String(amount),
      metadata: { amount_rwf: amount, reason },
    }, req);
    const books = await platformLedgerService.snapshot();
    return { adjustment: { id: String(entry._id), amount_rwf: amount, reason }, balanced: books.unreconciled_rwf === 0, unreconciled_rwf: books.unreconciled_rwf };
  }

  /* --------------------------- reconciliation -------------------------- */

  /** Compare the real statement balance with the cash the books expect. */
  async recordReconciliation(admin, body = {}, req) {
    const statementBalance = Number(body.statement_balance_rwf);
    if (!Number.isInteger(statementBalance)) {
      throw ApiError.badRequest('statement_balance_rwf must be a whole number.', { statement_balance_rwf: 'expected an integer' });
    }
    const statementDate = body.statement_date ? new Date(body.statement_date) : new Date();
    if (Number.isNaN(statementDate.getTime())) {
      throw ApiError.badRequest('statement_date is invalid.', { statement_date: 'expected a date' });
    }
    const books = await platformLedgerService.snapshot();
    const check = await reconciliationRepository.create({
      account_label: requiredText(body.account_label, 'account_label', { max: 60 }),
      statement_date: statementDate,
      statement_balance_rwf: statementBalance,
      system_cash_rwf: books.cash_balance_rwf,
      difference_rwf: statementBalance - books.cash_balance_rwf,
      note: parseOptionalText(body.note, { field: 'note', max: 300 }) || '',
      recorded_by: admin._id,
    });
    await adminActionLogService.record(admin, {
      action: 'platform.reconciliation',
      target_type: 'reconciliation',
      target_id: check._id,
      target_label: check.account_label,
      metadata: { statement_balance_rwf: statementBalance, system_cash_rwf: books.cash_balance_rwf },
    }, req);
    return { reconciliation: serializeCheck(check) };
  }
}

module.exports = new PlatformOwnerService();
