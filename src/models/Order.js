const mongoose = require('mongoose');
const timestamps = require('./timestamps');
const config = require('../config');

// A delivery address is only needed when the order is delivered.
function requiredForDelivery() {
  return !['pickup', 'dine_in'].includes(this.fulfillment);
}

// Dine-in orders from a table QR code may be placed by a guest with no account.
function requiredUnlessDineIn() {
  return this.fulfillment !== 'dine_in';
}

const { ObjectId } = mongoose.Schema.Types;

// Who moved a ticket or an item along (the kitchen account or an employee).
const actorSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['owner', 'staff', 'system', 'customer'], default: 'system' },
    id: { type: String, default: null },
    name: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * One department's share of an order (Food ticket F1024, Coffee ticket C1024 …).
 * Each department prepares its ticket on its own; the order's status follows
 * from its tickets (ticketService.recompute). Preparation stages are in
 * kitchenAccess.PREP_STAGES; what happens after (collected, served) is per item.
 */
const ticketSchema = new mongoose.Schema({
  department_id: { type: ObjectId, ref: 'Department', default: null },
  department_name: { type: String, default: '' },
  code: { type: String, required: true },
  status: { type: String, enum: ['pending', 'accepted', 'preparing', 'ready', 'cancelled'], default: 'pending' },
  station_id: { type: String, default: null },
  assigned_staff_id: { type: ObjectId, ref: 'KitchenStaff', default: null },
  assigned_staff_name: { type: String, default: '' },
  history: [
    {
      _id: false,
      status: { type: String, required: true },
      at: { type: Date, default: Date.now },
      by: { type: actorSchema, default: () => ({}) },
      note: { type: String, default: '' },
    },
  ],
  accepted_at: { type: Date, default: null },
  started_at: { type: Date, default: null },
  ready_at: { type: Date, default: null },
  cancelled_at: { type: Date, default: null },
  stock_deducted_at: { type: Date, default: null },
});

const orderSchema = new mongoose.Schema(
  {
    order_number: { type: String, required: true, unique: true },
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: requiredUnlessDineIn,
      default: null,
    },
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },
    items: [
      {
        // Null on big-event orders: their one line is the kitchen's event plate.
        menu_item_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'MenuItem',
          default: null,
        },
        name: { type: String, required: true },
        price_rwf: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 },
        subtotal_rwf: { type: Number, required: true },
        image_url: { type: String, default: '' },
        // Which department prepares it (snapshot), and its ticket.
        department_id: { type: ObjectId, ref: 'Department', default: null },
        department_name: { type: String, default: '' },
        ticket_id: { type: ObjectId, default: null },
        note: { type: String, default: '' },
        // After preparation: kitchenAccess.SERVICE_STATUSES.
        service_status: { type: String, default: 'pending' },
        collected_at: { type: Date, default: null },
        collected_by: { type: actorSchema, default: null },
        served_at: { type: Date, default: null },
        served_by: { type: actorSchema, default: null },
        options: [
          {
            option_id: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItemOption' },
            group_name: { type: String, default: 'Options' },
            name: { type: String, required: true },
            additional_price_rwf: { type: Number, min: 0, default: 0 },
          },
        ],
      },
    ],
    // One preparation ticket per department (see ticketSchema).
    tickets: { type: [ticketSchema], default: [] },
    // Dine-in orders: the table the QR code belongs to (snapshot of its label).
    table: {
      table_id: { type: ObjectId, ref: 'DiningTable', default: null },
      label: { type: String, default: '' },
    },
    // Guests ordering from a table without an account: the name they gave,
    // and a hash of the secret their browser keeps to follow the order.
    guest: {
      name: { type: String, default: '' },
      key_hash: { type: String, default: '', select: false },
    },
    // Where the order came from.
    source: { type: String, enum: ['marketplace', 'table_qr', 'event'], default: 'marketplace' },
    invoice_id: { type: ObjectId, ref: 'Invoice', default: null },
    // Dine-in orders paid in person: the point the bill must be paid by,
    // fixed when ordered from the kitchen's rule ('preparation', 'collection', 'none').
    payment_gate: { type: String, enum: ['preparation', 'collection', 'none', null], default: null },
    // Big-event orders (Big Event button): what the customer booked from the
    // kitchen's event offer, kept as it was when they ordered.
    event: {
      package_id: { type: String, default: '' },
      package_name: { type: String, default: '' },
      guests: { type: Number, min: 1, default: null },
      price_per_plate_rwf: { type: Number, min: 0, default: null },
      menu: [{ type: String }],
      portion: { type: String, default: '' },
      service_style_label: { type: String, default: '' },
      service_details: { type: String, default: '' },
      delivery_details: { type: String, default: '' },
    },
    // Paid in two parts (big events): the deposit when ordering, the balance
    // by balance_due_at (a day before the event). payment_status is 'paid'
    // once the deposit is in; balance_paid_at says the rest is paid too.
    deposit: {
      deposit_rwf: { type: Number, min: 0, default: null },
      balance_rwf: { type: Number, min: 0, default: null },
      balance_due_at: { type: Date, default: null },
      balance_paid_at: { type: Date, default: null },
      // Balance reminders already sent ('due_soon', 'due_today', 'overdue').
      reminders_sent: [{ type: String }],
    },
    // What the customer has actually paid (set on two-part orders; the others
    // pay total_rwf at once). Refunds send back this much.
    amount_paid_rwf: { type: Number, min: 0, default: null },
    subtotal_rwf: { type: Number, required: true },
    delivery_fee_rwf: { type: Number, required: true },
    // Road distance kitchen -> drop-off used to price delivery at checkout.
    delivery_distance_km: { type: Number, min: 0, default: null },
    delivery_distance_source: { type: String, enum: ['google', 'osrm', 'estimate', null], default: null },
    // Standard platform delivery: the approved route and the exact prices it
    // was charged with (see deliveryPricingService.pricingRecord). Fixed when
    // the order is placed: admins changing prices later, or the worker taking
    // a longer road, never change it. Null for pickup, kitchen-delivered and
    // older orders.
    delivery_pricing: {
      type: new mongoose.Schema(
        {
          mode: { type: String, enum: ['per_meter', 'ranges', 'formula'], required: true },
          distance_m: { type: Number, min: 0, required: true },
          distance_km: { type: Number, min: 0, default: null },
          distance_source: { type: String, enum: ['google', 'osrm', 'estimate'], required: true },
          duration_minutes: { type: Number, min: 0, default: null },
          base_fee_rwf: { type: Number, min: 0, default: null },
          per_meter_rwf: { type: Number, min: 0, default: null },
          per_km_fee_rwf: { type: Number, min: 0, default: null },
          min_fee_rwf: { type: Number, min: 0, default: null },
          max_fee_rwf: { type: Number, min: 0, default: null },
          range: {
            type: new mongoose.Schema(
              { from_km: Number, to_km: { type: Number, default: null }, fee_rwf: Number },
              { _id: false }
            ),
            default: null,
          },
          formula_fee_rwf: { type: Number, default: null },
          fee_rwf: { type: Number, min: 0, required: true },
          pickup: { latitude: Number, longitude: Number },
          dropoff: { latitude: Number, longitude: Number },
          priced_at: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    // Big-event delivery (the kitchen delivers an event order): how its
    // delivery fee was set, kept apart from delivery_pricing (the standard
    // fee). 'automatic' = the platform's big-event formula; 'negotiated' =
    // the quotation the customer accepted. Fixed when the order is placed.
    big_event_delivery: {
      type: new mongoose.Schema(
        {
          mode: { type: String, enum: ['automatic', 'negotiated'], required: true },
          fee_rwf: { type: Number, min: 0, required: true },
          distance_m: { type: Number, min: 0, default: null },
          distance_source: { type: String, default: null },
          starting_fee_rwf: { type: Number, min: 0, default: null },
          per_meter_rwf: { type: Number, min: 0, default: null },
          min_fee_rwf: { type: Number, min: 0, default: null },
          auto_ceiling_rwf: { type: Number, min: 0, default: null },
          formula_fee_rwf: { type: Number, default: null },
          in_coverage: { type: Boolean, default: null },
          destination_district: { type: String, default: null },
          special_delivery_reference: { type: String, default: null },
          quotation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryQuotation', default: null },
          quotation_reference: { type: String, default: null },
          pickup: { latitude: Number, longitude: Number },
          dropoff: { latitude: Number, longitude: Number },
          priced_at: { type: Date, required: true },
          // Support lowered the fee when resolving a dispute: fee_rwf stays
          // the agreed price; the order's delivery_fee_rwf / total_rwf are
          // what the customer finally pays. refund_rwf = sent back in cash
          // (the rest came off the unpaid balance).
          adjustments: [
            {
              _id: false,
              reduced_by_rwf: { type: Number, min: 0, required: true },
              refund_rwf: { type: Number, min: 0, default: 0 },
              refund_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Refund', default: null },
              reason: { type: String, default: '' },
              by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
              at: { type: Date, default: Date.now },
            },
          ],
        },
        { _id: false }
      ),
      default: null,
    },
    // The special delivery agreement this order's delivery fee comes from.
    special_delivery_request_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SpecialDeliveryRequest',
      default: null,
    },
    total_rwf: { type: Number, required: true },
    // 'delivery': a delivery worker brings it. 'pickup': the customer collects
    // it at the kitchen — no delivery fee, no delivery worker, and the vendor
    // completes the order with the customer's pickup code.
    fulfillment: {
      type: String,
      enum: config.orders.fulfillmentModes,
      default: 'delivery',
    },
    // Pickup orders: the address is not needed (only `note` is kept).
    delivery_location: {
      address: { type: String, required: requiredForDelivery },
      note: { type: String, default: '' },
      neighborhood: { type: String, default: '' },
      latitude: { type: Number, required: requiredForDelivery },
      longitude: { type: Number, required: requiredForDelivery },
    },
    // Pickup orders: code sent to the customer when the food is ready; the
    // vendor enters it to confirm the customer collected the order.
    pickup_code: { type: String, default: '', select: false },
    pickup_code_sent_at: { type: Date, default: null },
    pickup_code_attempts: { type: Number, min: 0, default: 0 },
    collected_at: { type: Date, default: null },
    payment_method: {
      type: String,
      // 'in_person': dine-in, paid to the kitchen's cashier (see Invoice).
      enum: [...config.orders.paymentMethods.map((m) => m.code), 'in_person'],
      required: true,
    },
    payment_status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    // Payer details captured at checkout: phone for mobile wallets, card for cards.
    payment_details: {
      phone: { type: String, default: '' },
      // Masked: only the last 4 digits ("•••• 1234"), never the full number.
      card_number: { type: String, default: '' },
      card_expiry: { type: String, default: '' },
    },
    // Order timing: immediate (ASAP), scheduled (customer-picked slot) or
    // preorder (against a vendor's announced special). scheduled_for is the
    // intended delivery time; special_text snapshots the vendor announcement.
    order_type: {
      type: String,
      enum: config.orders.orderTypes,
      default: 'immediate',
    },
    scheduled_for: { type: Date, default: null },
    special_text: { type: String, default: '' },
    status: {
      type: String,
      enum: config.orders.statuses,
      default: 'placed',
    },
    status_history: [
      {
        status: { type: String, required: true },
        at: { type: Date, default: Date.now },
        note: { type: String, default: '' },
      },
    ],
    rider: {
      name: { type: String },
      phone: { type: String },
    },
    // Delivery leg (set automatically when the order is ready for pickup).
    driver_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      default: null,
    },
    delivery_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Delivery',
      default: null,
    },
    eta_minutes: { type: Number },
    estimated_delivery_at: { type: Date },
    picked_up_at: { type: Date },
    delivered_at: { type: Date },
    completed_at: { type: Date },
    cancelled_at: { type: Date },
    cancel_reason: { type: String, default: '' },
    // Settlement snapshot. Captured when the customer pays (funds held by the
    // platform) and released to the vendor/rider when the order completes.
    // Commission is calculated on the food subtotal only, never the delivery
    // fee: the vendor receives subtotal - commission, the rider receives the
    // full delivery fee.
    commission_percent: { type: Number, min: 0, max: 100, default: 0 },
    // An admin's commission for this one order, used instead of the
    // commission rules (vendor > category > type > global). Can only change
    // before the order is settled (the kitchen paid); every change is kept.
    commission_override: {
      type: new mongoose.Schema(
        {
          percent: { type: Number, min: 0, max: 100, required: true },
          reason: { type: String, default: '' },
          set_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
          set_at: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    commission_history: [
      {
        _id: false,
        from_percent: { type: Number, default: null },
        to_percent: { type: Number, default: null }, // null = back to the commission rules
        commission_rwf: { type: Number, default: null },
        vendor_payout_rwf: { type: Number, default: null },
        reason: { type: String, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        at: { type: Date, default: Date.now },
      },
    ],
    commission_rwf: { type: Number, min: 0, default: 0 },
    vendor_payout_rwf: { type: Number, min: 0, default: 0 },
    rider_payout_rwf: { type: Number, min: 0, default: 0 },
    settlement_status: {
      type: String,
      enum: ['unpaid', 'held', 'settled', 'refunded'],
      default: 'unpaid',
    },
    settled_at: { type: Date, default: null },
    // Set when the delivery fee is allocated to the rider who delivered it.
    // Until then the fee stays held (e.g. no rider has delivered the order).
    rider_payout_settled_at: { type: Date, default: null },
  },
  { timestamps }
);

orderSchema.index({ customer_id: 1, created_at: -1 });
orderSchema.index({ vendor_id: 1, status: 1 });
orderSchema.index({ vendor_id: 1, completed_at: -1 });
orderSchema.index({ status: 1, created_at: -1 });
orderSchema.index({ driver_id: 1, status: 1 });
orderSchema.index({ order_type: 1, scheduled_for: 1 });
// "Money still held": only orders that can still hold money (see heldTotal).
orderSchema.index({ settlement_status: 1, rider_payout_settled_at: 1 });
// Admin: delivery fee records (orders priced with the standard delivery fee).
orderSchema.index({ 'delivery_pricing.priced_at': -1 }, { sparse: true });

orderSchema.index({ special_delivery_request_id: 1 }, { sparse: true });
// Preparation queues and table activity.
orderSchema.index({ vendor_id: 1, 'tickets.department_id': 1, 'tickets.status': 1 });
orderSchema.index({ 'table.table_id': 1, status: 1 }, { sparse: true });

// An order with a special delivery agreement keeps the request in step when
// it is delivered or cancelled, whichever service made the change.
orderSchema.post('findOneAndUpdate', function syncSpecialDelivery(doc) {
  if (!doc?.special_delivery_request_id) return;
  if (!['delivered', 'completed', 'cancelled'].includes(doc.status)) return;
  // Required here: the service needs the models (no import cycle at load time).
  // eslint-disable-next-line global-require
  require('../services/specialDeliveryService')
    .syncWithOrder(doc)
    .catch((error) => console.error('[special-delivery] could not follow the order:', error.message));
});

// However an order is cancelled (kitchen, customer, admin, sweep), its
// department tickets stop and its lines leave the bill.
orderSchema.post('findOneAndUpdate', function cancelTicketsAndBill(doc) {
  if (!doc || doc.status !== 'cancelled') return;
  const openTickets = (doc.tickets || []).some((t) => t.status !== 'cancelled');
  /* eslint-disable global-require */
  if (openTickets) {
    require('../services/kitchen/ticketService')
      .cascadeFromOrder(doc._id, 'cancelled')
      .catch((error) => console.error('[tickets] could not cancel the tickets of', doc.order_number, error.message));
  }
  if (doc.invoice_id) {
    require('../services/kitchen/invoiceService')
      .voidOrderLines(doc._id)
      .catch((error) => console.error('[invoice] could not update the bill of', doc.order_number, error.message));
  }
  /* eslint-enable global-require */
});

module.exports = mongoose.model('Order', orderSchema);
