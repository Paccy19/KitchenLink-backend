const ApiError = require('../utils/ApiError');
const config = require('../config');
const {
  Customer,
  Order,
  Delivery,
  Refund,
  ChatConversation,
  ChatMessage,
  Complaint,
  Notification,
  CartItem,
  WishlistItem,
  OtpCode,
  OtpGuard,
  AdminActionLog,
} = require('../models');
const { deleteLocalUpload } = require('../utils/uploads');
const adminActionLogService = require('./adminActionLogService');

const ERASED_NAME = 'Erased customer';
const ERASED_TEXT = '(erased at the customer’s request)';

// Delivery addresses: text removed, coordinates kept only to ~1 km (2 decimals),
// enough for delivery statistics, not enough to find someone's home.
const eraseLocation = (field) => [
  {
    $set: {
      [`${field}.address`]: { $cond: [{ $ifNull: [`$${field}.address`, false] }, 'Erased', `$${field}.address`] },
      [`${field}.note`]: '',
      [`${field}.neighborhood`]: '',
      [`${field}.latitude`]: { $cond: [{ $isNumber: `$${field}.latitude` }, { $round: [`$${field}.latitude`, 2] }, `$${field}.latitude`] },
      [`${field}.longitude`]: { $cond: [{ $isNumber: `$${field}.longitude` }, { $round: [`$${field}.longitude`, 2] }, `$${field}.longitude`] },
    },
  },
];

/**
 * Erases a customer's personal data on request (right to erasure, Rwanda Law
 * No. 058/2021), while keeping the money records the business must keep:
 *  - the account: name, phone, email, photo, GPS position removed; blocked;
 *    every session signed out;
 *  - orders and deliveries kept for accounting, with the address, note and
 *    payer details erased (coordinates kept to ~1 km);
 *  - refunds kept, refund phone removed;
 *  - chats, notifications, cart, wishlist, sign-in codes and lockouts deleted;
 *  - complaints kept for support history, with the customer's name, phone and
 *    own messages erased; audit-log entries no longer show their name.
 * Refused while an order is in progress or a refund is still owed. Cannot be
 * undone. See DATA_RETENTION.md.
 */
class CustomerErasureService {
  async erase(customerId, admin, req) {
    const customer = await Customer.findById(customerId).lean().catch(() => null);
    if (!customer) throw ApiError.notFound('Customer not found.', 'USER_NOT_FOUND');
    if (customer.erased_at) throw ApiError.conflict('This customer’s data was already erased.', 'ALREADY_ERASED');

    const [openOrders, owedRefunds] = await Promise.all([
      Order.countDocuments({ customer_id: customer._id, status: { $in: config.vendor.pendingInternalStatuses } }),
      Refund.countDocuments({ customer_id: customer._id, status: { $in: ['pending', 'failed'] } }),
    ]);
    if (openOrders || owedRefunds) {
      throw ApiError.conflict(
        `This customer still has ${[openOrders && `${openOrders} order(s) in progress`, owedRefunds && `${owedRefunds} refund(s) not yet paid`]
          .filter(Boolean)
          .join(' and ')}. Finish or cancel them first, so no money is left unpaid.`,
        'ERASURE_BLOCKED'
      );
    }

    const id = customer._id;
    const now = new Date();
    const summary = {};

    // Every step can safely run twice, and the account is marked erased only
    // at the end: if a step fails, running the erase again finishes the job.
    // Signed out and blocked straight away while the rest runs.
    await Customer.updateOne({ _id: id }, { $set: { is_active: false, sessions_valid_after: now, sessions_kept_jti: null } });

    summary.orders = (
      await Order.updateMany(
        { customer_id: id },
        [
          ...eraseLocation('delivery_location'),
          { $set: { 'payment_details.phone': '', 'payment_details.card_number': '', 'payment_details.card_expiry': '' } },
        ],
        { updatePipeline: true }
      )
    ).modifiedCount;
    summary.deliveries = (
      await Delivery.updateMany({ customer_id: id }, eraseLocation('delivery_location'), { updatePipeline: true })
    ).modifiedCount;
    summary.refunds = (await Refund.updateMany({ customer_id: id }, { $set: { 'destination.phone': '' } })).modifiedCount;

    const conversations = await ChatConversation.find({ customer_id: id }).select('_id').lean();
    const conversationIds = conversations.map((c) => c._id);
    summary.chat_messages = (await ChatMessage.deleteMany({ conversation_id: { $in: conversationIds } })).deletedCount;
    await ChatConversation.deleteMany({ _id: { $in: conversationIds } });

    summary.complaints = (
      await Complaint.updateMany(
        { 'raised_by.user_id': id },
        {
          $set: {
            'raised_by.name': ERASED_NAME,
            'raised_by.phone': '',
            'messages.$[mine].author_name': ERASED_NAME,
            'messages.$[mine].body': ERASED_TEXT,
          },
        },
        { arrayFilters: [{ 'mine.author_id': id }] }
      )
    ).modifiedCount;

    summary.notifications = (await Notification.deleteMany({ customer_id: id })).deletedCount;
    await Promise.all([
      CartItem.deleteMany({ customer_id: id }),
      WishlistItem.deleteMany({ customer_id: id }),
      OtpCode.deleteMany({ phone_number: customer.phone_number }),
      OtpGuard.deleteMany({ key: `customer:${customer.phone_number}` }),
      // Earlier audit entries keep what happened, without the name.
      AdminActionLog.updateMany({ target_type: 'customer', target_id: String(id) }, { $set: { target_label: ERASED_NAME } }),
    ]);

    // Last: the account itself (marks the erase as complete).
    if (customer.profile_image_url) deleteLocalUpload(customer.profile_image_url);
    await Customer.updateOne(
      { _id: id },
      {
        $set: {
          name: ERASED_NAME,
          // Unique and not a real number: the phone can sign up again as a new account.
          phone_number: `erased-${id}`,
          profile_image_url: '',
          is_active: false,
          last_location_accuracy_m: null,
          last_location_at: null,
          erased_at: now,
          erased_by: admin?._id || null,
        },
        $unset: { email: '', last_location: '' },
      }
    );

    await adminActionLogService.record(
      admin,
      {
        action: 'customer.erased',
        target_type: 'customer',
        target_id: String(id),
        target_label: ERASED_NAME,
        // Counts only: no personal data in the log.
        metadata: summary,
      },
      req
    );

    return { erased: true, erased_at: now, summary };
  }
}

module.exports = new CustomerErasureService();
