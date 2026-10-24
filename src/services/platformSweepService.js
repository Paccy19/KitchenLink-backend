const config = require('../config');
const { sendSms } = require('../utils/sms');
const adminRepository = require('../repositories/adminRepository');
const payoutDestinationRepository = require('../repositories/payoutDestinationRepository');
const platformAccountRepository = require('../repositories/platformAccountRepository');
const platformWithdrawalRepository = require('../repositories/platformWithdrawalRepository');
const ownerPayoutSettingsRepository = require('../repositories/ownerPayoutSettingsRepository');
const platformLedgerService = require('./platformLedgerService');
const platformOwnerService = require('./platformOwnerService');
const notificationService = require('./notificationService');

const { sweep, reservePercent, maxWithdrawalRwf, maxWeeklyRwf } = config.admin.owner;
const KIGALI_OFFSET_MS = config.vendor.timezoneOffsetHours * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const kigali = (date) => new Date(date.getTime() + KIGALI_OFFSET_MS);
const money = (value) => `${Math.round(value).toLocaleString()} RWF`;

/** ISO week label ("2026-W41") of a date, in Kigali time. */
function isoWeek(date) {
  const local = kigali(date);
  const day = local.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 4 - day));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The schedule period a date falls in: ISO week or calendar month (Kigali). */
function periodKey(date, frequency) {
  if (frequency === 'monthly') {
    const local = kigali(date);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return isoWeek(date);
}

/**
 * Runs the owner's saved payout schedule (Payout settings on Platform Wallet),
 * once per week or month at the chosen day and hour (Kigali time):
 *  - reminder: SMS + notification with the amount ready to withdraw;
 *  - auto: creates the withdrawal to the saved account (sent by the payout
 *    service when one is connected, otherwise the owner transfers it and
 *    confirms with the reference).
 */
class PlatformSweepService {
  isDue(now = new Date(), schedule = { mode: sweep.enabled ? 'reminder' : 'off', frequency: 'weekly', weekday: sweep.weekday, hour: sweep.hour }) {
    if (!schedule || schedule.mode === 'off') return false;
    const local = kigali(now);
    const dayMatches =
      schedule.frequency === 'monthly'
        ? local.getUTCDate() === schedule.day_of_month
        : local.getUTCDay() === schedule.weekday;
    return dayMatches && local.getUTCHours() >= schedule.hour;
  }

  /** Runs this period's reminder or automatic withdrawal if due and not done yet. */
  async runIfDue(now = new Date(), { force = false } = {}) {
    const settings = await ownerPayoutSettingsRepository.get();
    const { schedule } = settings;
    if (!force && !this.isDue(now, schedule)) return { sent: false, reason: 'not_due' };
    if (schedule.mode === 'off') return { sent: false, reason: 'off' };

    const period = periodKey(now, schedule.frequency);
    const account = await platformAccountRepository.getOrCreate();
    if (account.last_sweep_week === period) return { sent: false, reason: 'already_sent', week: period };
    // Claim the period first so a restart or second server can't run it twice.
    await platformAccountRepository.saveSnapshot({ last_sweep_week: period, last_sweep_at: now });

    if (schedule.mode === 'auto') return this.#runAutomatic(now, period);
    return this.#runReminder(now, period);
  }

  async #runReminder(now, period) {
    const books = await platformLedgerService.snapshot();
    const ownerBalance = Math.max(0, books.commission_balance_rwf);
    const reserve = Math.round((ownerBalance * reservePercent) / 100);
    const weekTotal = await platformWithdrawalRepository.totalSince(new Date(now.getTime() - WEEK_MS));
    const amount = Math.max(
      0,
      Math.min(ownerBalance - books.owner_processing_rwf - reserve, maxWithdrawalRwf, maxWeeklyRwf - weekTotal)
    );
    await platformAccountRepository.saveSnapshot({ last_sweep_amount_rwf: amount });
    if (amount < sweep.minRwf) return { sent: false, reason: 'below_minimum', week: period, amount_rwf: amount };

    const destinations = (await payoutDestinationRepository.listActive()).filter(
      (d) => new Date(d.activates_at).getTime() <= now.getTime()
    );
    const target = destinations[0];
    const where = target ? ` to ${target.label} (${target.account_number})` : '';
    const unbalanced = books.unreconciled_rwf !== 0 ? ' Note: the books need an adjustment first.' : '';
    await this.#notify({
      title: 'Weekly sweep ready',
      message: `Weekly sweep: ${amount.toLocaleString()} RWF of commission is ready to withdraw${where}. Open Platform Wallet to confirm.${unbalanced}`,
      link: `/admin-dashboard/platform?sweep=${amount}`,
      data: { amount_rwf: amount, week: period, destination_id: target ? String(target._id) : null },
    });
    return { sent: true, week: period, amount_rwf: amount };
  }

  async #runAutomatic(now, period) {
    const outcome = await platformOwnerService.autoWithdraw();
    const amount = outcome.withdrawal?.amount_rwf || 0;
    await platformAccountRepository.saveSnapshot({ last_sweep_amount_rwf: amount });
    const d = outcome.destination;
    const to = d ? `${d.provider} ${d.account_number}` : 'your payout account';

    const messages = {
      sent: `Automatic withdrawal: ${money(amount)} was sent to ${to}.`,
      awaiting_transfer: `Automatic withdrawal: ${money(amount)} to ${to} is ready. Transfer it from the platform account, then confirm it with the reference in Platform Wallet.`,
      failed: `Automatic withdrawal of ${money(amount)} to ${to} failed: ${outcome.withdrawal?.failure_reason || 'payout service error'}. The money stays in your balance.`,
      skipped: `Automatic withdrawal skipped this time: ${outcome.reason}`,
    };
    await this.#notify({
      title: outcome.status === 'skipped' ? 'Automatic withdrawal skipped' : 'Automatic withdrawal',
      message: messages[outcome.status],
      link: '/admin-dashboard/platform',
      data: { status: outcome.status, amount_rwf: amount, period },
    });
    return {
      sent: outcome.status === 'sent' || outcome.status === 'awaiting_transfer',
      status: outcome.status,
      reason: outcome.reason,
      week: period,
      amount_rwf: amount,
    };
  }

  async #notify({ title, message, link, data }) {
    await notificationService.notifyAdmin({ type: 'owner_finance', title, body: message, link, data }).catch(() => null);
    const owners = await adminRepository.listSuperAdmins();
    await Promise.all(
      owners.filter((admin) => admin.two_factor_enabled && admin.phone).map((admin) => sendSms(admin.phone, `KitchenLink: ${message}`))
    );
  }

  /** Checks every 15 minutes while the server runs. */
  start(intervalMs = 15 * 60 * 1000) {
    const tick = () =>
      this.runIfDue().catch((error) => console.error('[sweep] payout schedule check failed:', error.message));
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return timer;
  }
}

module.exports = new PlatformSweepService();
module.exports.isoWeek = isoWeek;
module.exports.periodKey = periodKey;
