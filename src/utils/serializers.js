const config = require('../config');
const { isVendorLive } = require('./vendorPresence');
const { isKitchenReady } = require('./deliveryReady');
const deliverySettings = require('../services/deliverySettingsService');
const dispatchSettingsService = require('../services/dispatchSettingsService');
const access = require('../config/adminAccess');
const { vendorTypeLabel, orderingRulesFor, nationwideFor } = require('../config/vendorTypes');
const { usesHandoverCode, isKitchenDelivered } = require('./fulfillment');

const round1 = (value) =>
  typeof value === 'number' ? Math.round(value * 10) / 10 : null;

/** A vendor's pending request to change their type (null when none). */
function serializeVendorTypeRequest(vendor) {
  const request = vendor.vendor_type_request;
  if (!request?.vendor_type) return null;
  return {
    vendor_type: request.vendor_type,
    vendor_type_label: vendorTypeLabel(request.vendor_type),
    reason: request.reason || '',
    requested_at: request.requested_at || null,
  };
}

function serializeCategory(category) {
  return {
    id: String(category._id),
    name: category.name,
    icon_url: category.icon_url || null,
  };
}

/** Compact vendor card used in feed / nearby / search lists. */
function serializeVendorCard(vendor, { distanceKm } = {}) {
  const [lng, lat] = vendor.location?.coordinates ?? [null, null];
  return {
    id: String(vendor._id),
    name: vendor.name,
    vendor_type: vendor.vendor_type,
    vendor_type_label: vendorTypeLabel(vendor.vendor_type),
    // Caterers, chefs and meal-prep kitchens take advance orders only.
    advance_only: !orderingRulesFor(vendor).order_now,
    // Takes orders anywhere in Rwanda (events), bringing far orders itself.
    nationwide: nationwideFor(vendor).enabled,
    rating: vendor.rating,
    estimated_prep_time: vendor.estimated_prep_time,
    distance_km: typeof distanceKm === 'number' ? round1(distanceKm) : null,
    banner_image_url: vendor.banner_image_url || null,
    avatar_url: vendor.profile_image_url || null,
    delivery_available: Boolean(vendor.delivery_available),
    is_open: isVendorLive(vendor),
    location: {
      latitude: typeof lat === 'number' ? lat : null,
      longitude: typeof lng === 'number' ? lng : null,
    },
  };
}

function serializeNearbyVendor(vendor, { distanceKm } = {}) {
  return {
    ...serializeVendorCard(vendor, { distanceKm }),
    neighborhood: vendor.neighborhood || null,
  };
}

function serializePopularDish(dish) {
  return {
    id: String(dish._id),
    name: dish.name,
    description: dish.description || '',
    price_rwf: dish.price_rwf,
    image_url: dish.image_url || null,
    vendor_name: dish.vendor?.name ?? null,
    vendor_id: String(dish.vendor_id),
  };
}

function serializeSearchDish(dish, { distanceKm } = {}) {
  return {
    id: String(dish._id),
    name: dish.name,
    description: dish.description || '',
    price_rwf: dish.price_rwf,
    image_url: dish.image_url || null,
    vendor_id: String(dish.vendor_id),
    vendor_name: dish.vendor?.name ?? null,
    vendor_type: dish.vendor?.vendor_type ?? null,
    vendor_type_label: dish.vendor?.vendor_type ? vendorTypeLabel(dish.vendor.vendor_type) : null,
    category_name: dish.category?.name ?? null,
    distance_km: typeof distanceKm === 'number' ? round1(distanceKm) : null,
    relevance_score: 0,
  };
}

function serializeMenuItem(item) {
  return {
    id: String(item._id),
    name: item.name,
    description: item.description || '',
    price_rwf: item.price_rwf,
    is_available: Boolean(item.is_available),
    is_preorder: Boolean(item.is_preorder),
    preorder_cutoff: item.preorder_cutoff || '',
    image_url: item.image_url || null,
  };
}

/** A vendor's "Tomorrow's Special" announcement. */
function serializeVendorSpecial(special) {
  if (!special || (!special.text && !special.delivery_at)) return null;
  const cutoffAt = special.cutoff_at ?? null;
  const isActive = Boolean(special.is_active);
  return {
    text: special.text || '',
    cutoff_at: cutoffAt,
    delivery_at: special.delivery_at ?? null,
    is_active: isActive,
    is_orderable: Boolean(
      isActive && cutoffAt && new Date(cutoffAt).getTime() > Date.now()
    ),
    updated_at: special.updated_at ?? null,
  };
}

/** Vendor card tailored for the "Tomorrow's Specials" feed. */
function serializeVendorSpecialCard(vendor) {
  return {
    ...serializeVendorCard(vendor, { distanceKm: vendor.distance_km }),
    neighborhood: vendor.neighborhood || null,
    special: serializeVendorSpecial(vendor.special),
  };
}

function serializeVendorStorefront(vendor, { menu, distanceKm } = {}) {
  const [lng, lat] = vendor.location?.coordinates ?? [null, null];
  return {
    id: String(vendor._id),
    name: vendor.name,
    vendor_type: vendor.vendor_type,
    vendor_type_label: vendorTypeLabel(vendor.vendor_type),
    rating: vendor.rating,
    estimated_prep_time: vendor.estimated_prep_time,
    delivery_available: Boolean(vendor.delivery_available),
    is_open: isVendorLive(vendor),
    location: {
      neighborhood: vendor.neighborhood || null,
      address: vendor.address || null,
      latitude: lat,
      longitude: lng,
    },
    banner_image_url: vendor.banner_image_url || null,
    avatar_url: vendor.profile_image_url || null,
    distance_km: typeof distanceKm === 'number' ? round1(distanceKm) : null,
    special: serializeVendorSpecial(vendor.special),
    menu,
  };
}

/** Authenticated vendor profile (never exposes the password hash). */
function serializeVendorAccount(vendor) {
  const [lng, lat] = vendor.location?.coordinates ?? [null, null];
  return {
    id: String(vendor._id),
    name: vendor.name,
    vendor_type: vendor.vendor_type,
    vendor_type_label: vendorTypeLabel(vendor.vendor_type),
    vendor_type_request: serializeVendorTypeRequest(vendor),
    ordering: orderingRulesFor(vendor),
    nationwide: nationwideFor(vendor),
    owner_name: vendor.owner_name || null,
    description: vendor.description || '',
    email: vendor.email || null,
    phone: vendor.phone || null,
    rating: vendor.rating,
    estimated_prep_time: vendor.estimated_prep_time,
    is_active: Boolean(vendor.is_active),
    is_open: vendor.is_open === undefined ? true : Boolean(vendor.is_open),
    // Open AND location shared recently, i.e. what customers actually see.
    is_live: isVendorLive(vendor),
    delivery_available: Boolean(vendor.delivery_available),
    banner_image_url: vendor.banner_image_url || null,
    profile_image_url: vendor.profile_image_url || null,
    food_category_ids: (vendor.food_category_ids || []).map(String),
    food_categories: vendor.food_categories || [],
    operating_hours: (vendor.operating_hours || []).map((entry) => ({
      day: entry.day,
      open_time: entry.open_time || '',
      close_time: entry.close_time || '',
      is_closed: Boolean(entry.is_closed),
    })),
    special: serializeVendorSpecial(vendor.special),
    payment_information: vendor.payment_information || {},
    verification_status: vendor.verification_status || 'pending',
    verification_documents: (vendor.verification_documents || []).map((doc) => ({
      label: doc.label || '',
      url: doc.url,
      uploaded_at: doc.uploaded_at,
    })),
    available_balance_rwf: vendor.available_balance ?? 0,
    total_sales_rwf: vendor.total_sales ?? 0,
    commission_percent: config.vendor.commissionPercent,
    location: {
      neighborhood: vendor.neighborhood || null,
      address: vendor.address || null,
      latitude: lat,
      longitude: lng,
      updated_at: vendor.location_updated_at ?? null,
      accuracy_m: vendor.location_accuracy_m ?? null,
    },
    created_at: vendor.created_at,
    updated_at: vendor.updated_at,
  };
}

function serializeMenuItemOption(option) {
  return {
    id: String(option._id),
    group_name: option.group_name || 'Options',
    name: option.name,
    additional_price_rwf: option.additional_price_rwf || 0,
    is_available: Boolean(option.is_available),
    sort_order: option.sort_order ?? 0,
  };
}

function serializeVendorMenuItem(item, options = []) {
  const category = item.category_id;
  const categoryPopulated =
    category && typeof category === 'object' && category.name !== undefined;
  return {
    id: String(item._id),
    name: item.name,
    description: item.description || '',
    price_rwf: item.price_rwf,
    preparation_time_minutes: item.preparation_time_minutes ?? 0,
    is_available: Boolean(item.is_available),
    is_preorder: Boolean(item.is_preorder),
    preorder_cutoff: item.preorder_cutoff || '',
    is_popular: Boolean(item.is_popular),
    image_url: item.image_url || null,
    category: categoryPopulated
      ? { id: String(category._id), name: category.name }
      : category
        ? { id: String(category), name: null }
        : null,
    options: options.map(serializeMenuItemOption),
    orders_count: item.orders_count ?? 0,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

const toVendorStatus = (status) =>
  config.vendor.internalToVendorStatus[status] || status;

const vendorStatusLabel = (status) =>
  config.vendor.orderStatusLabels[status] || status;

function serializeVendorOrder(order, { customer } = {}) {
  const status = toVendorStatus(order.status);

  // Pickup orders, and orders the kitchen delivers itself, end with the customer's code.
  const isPickup = usesHandoverCode(order);
  const pickupAttemptsLeft = Math.max(
    0,
    dispatchSettingsService.current().pickup_code_max_attempts - (order.pickup_code_attempts || 0)
  );

  return {
    id: String(order._id),
    order_number: order.order_number,
    status,
    status_label: vendorStatusLabel(status),
    allowed_next_statuses: config.vendor.orderTransitions[status] || [],
    fulfillment: order.fulfillment || 'delivery',
    fulfillment_label: config.orders.fulfillmentLabels[order.fulfillment || 'delivery'],
    // Too far for platform workers: the kitchen brings it and keeps the travel fee.
    kitchen_delivers: isKitchenDelivered(order),
    // Only for orders the customer collects (or the kitchen brings): the
    // vendor completes them with the customer's code.
    can_confirm_pickup: isPickup && order.status === 'ready' && pickupAttemptsLeft > 0,
    pickup_attempts_left: isPickup ? pickupAttemptsLeft : null,
    collected_at: order.collected_at ?? null,
    created_at: order.created_at,
    updated_at: order.updated_at,
    completed_at: order.completed_at ?? null,
    cancelled_at: order.cancelled_at ?? null,
    cancel_reason: order.cancel_reason || null,
    customer: customer
      ? {
          id: String(customer._id),
          name: customer.name,
          phone_number: customer.phone_number,
        }
      : null,
    items: (order.items || []).map((item) => ({
      menu_item_id: String(item.menu_item_id),
      name: item.name,
      price_rwf: item.price_rwf,
      quantity: item.quantity,
      subtotal_rwf: item.subtotal_rwf,
      image_url: item.image_url || null,
      options: (item.options || []).map((option) => ({
        option_id: option.option_id ? String(option.option_id) : null,
        group_name: option.group_name || 'Options',
        name: option.name,
        additional_price_rwf: option.additional_price_rwf || 0,
      })),
    })),
    subtotal_rwf: order.subtotal_rwf,
    delivery_fee_rwf: order.delivery_fee_rwf,
    delivery_distance_km: order.delivery_distance_km ?? null,
    total_amount_rwf: order.total_rwf,
    commission_percent: order.commission_percent ?? 0,
    commission_rwf: order.commission_rwf ?? 0,
    vendor_payout_rwf: order.vendor_payout_rwf ?? 0,
    rider_payout_rwf: order.rider_payout_rwf ?? 0,
    settlement_status: order.settlement_status || 'unpaid',
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    order_type: order.order_type || 'immediate',
    order_type_label:
      config.orders.orderTypeLabels[order.order_type || 'immediate'] || 'Immediate Order',
    scheduled_for: order.scheduled_for ?? null,
    special_text: order.special_text || '',
    delivery_location: { ...order.delivery_location },
    eta_minutes: order.eta_minutes ?? null,
    estimated_delivery_at: order.estimated_delivery_at ?? null,
    status_history: (order.status_history || []).map((entry) => ({
      status: toVendorStatus(entry.status),
      label: vendorStatusLabel(toVendorStatus(entry.status)),
      at: entry.at,
      note: entry.note || '',
    })),
  };
}

function serializeVendorDashboard({
  todayOrders,
  pendingOrders,
  completedOrders,
  todaySalesRwf,
  totalSalesRwf,
  availableBalanceRwf,
  newOrders = 0,
  preparingOrders = 0,
  readyOrders = 0,
  completedOrdersTotal = 0,
  cancelledOrders = 0,
  activeSalesRwf = 0,
  commissionPercent = 0,
  withdrawnRwf = 0,
}) {
  const commissionRate = commissionPercent / 100;
  const netEarnedRwf = Math.round(totalSalesRwf * (1 - commissionRate));
  const pendingBalanceRwf = Math.round(activeSalesRwf * (1 - commissionRate));

  return {
    today_orders: todayOrders,
    pending_orders: pendingOrders,
    completed_orders: completedOrders,
    today_sales_rwf: todaySalesRwf,
    total_sales_rwf: totalSalesRwf,
    available_balance_rwf: availableBalanceRwf,
    new_orders: newOrders,
    preparing_orders: preparingOrders,
    ready_orders: readyOrders,
    completed_orders_total: completedOrdersTotal,
    cancelled_orders: cancelledOrders,
    pending_balance_rwf: pendingBalanceRwf,
    commission_percent: commissionPercent,
    net_earned_rwf: netEarnedRwf,
    withdrawn_rwf: withdrawnRwf,
  };
}

/* --------------------------- delivery / drivers --------------------------- */

const deliveryStatusLabel = (status) =>
  config.delivery.statusLabels[status] || status;

/** Authenticated driver profile (never exposes the password hash). */
function serializeDriverAccount(driver) {
  const [lng, lat] = driver.location?.coordinates ?? [null, null];
  return {
    id: String(driver._id),
    name: driver.name,
    phone: driver.phone || null,
    email: driver.email || null,
    vehicle_type: driver.vehicle_type || 'motorcycle',
    plate_number: driver.plate_number || '',
    license_number: driver.license_number || '',
    rating: driver.rating ?? 5,
    rating_count: driver.rating_count ?? 0,
    is_online: Boolean(driver.is_online),
    is_available: Boolean(driver.is_available),
    status: driver.status || 'offline',
    active_deliveries_count: driver.active_deliveries_count ?? 0,
    max_active_deliveries: dispatchSettingsService.current().max_active_deliveries,
    completed_deliveries: driver.completed_deliveries ?? 0,
    total_earnings_rwf: driver.total_earnings_rwf ?? 0,
    available_balance_rwf: driver.available_balance_rwf ?? 0,
    profile_image_url: driver.profile_image_url || null,
    verification_status: driver.verification_status || 'approved',
    current_location: {
      latitude: lat,
      longitude: lng,
      updated_at: driver.location_updated_at ?? null,
    },
    created_at: driver.created_at,
    updated_at: driver.updated_at,
  };
}

function serializeDelivery(delivery, options = {}) {
  const {
    order,
    driver: driverOverride,
    distanceFromDriverKm,
    revealCustomer = true,
  } = options;

  const vendor =
    options.vendor ||
    (delivery.vendor_id && typeof delivery.vendor_id === 'object'
      ? delivery.vendor_id
      : null);
  const customer =
    options.customer ||
    (delivery.customer_id && typeof delivery.customer_id === 'object'
      ? delivery.customer_id
      : null);
  const driver = driverOverride || (delivery.driver_id && typeof delivery.driver_id === 'object'
    ? delivery.driver_id
    : null);

  const vendorVendor = vendor && vendor.name ? vendor : null;
  const vendorLocation = vendorVendor?.location?.coordinates;
  const [vLng, vLat] = Array.isArray(vendorLocation) ? vendorLocation : [null, null];

  return {
    id: String(delivery._id),
    order_id: String(delivery.order_id),
    order_number: delivery.order_number,
    status: delivery.status,
    status_label: deliveryStatusLabel(delivery.status),
    allowed_next_statuses: config.delivery.transitions[delivery.status] || [],
    driver_id: delivery.driver_id ? String(delivery.driver_id._id || delivery.driver_id) : null,
    vendor: vendorVendor
      ? {
          id: String(vendorVendor._id),
          name: vendorVendor.name,
          phone: vendorVendor.phone || null,
          avatar_url: vendorVendor.profile_image_url || null,
          address: vendorVendor.address || delivery.pickup_location?.address || null,
          neighborhood: vendorVendor.neighborhood || delivery.pickup_location?.neighborhood || null,
          latitude: vLat ?? delivery.pickup_location?.latitude ?? null,
          longitude: vLng ?? delivery.pickup_location?.longitude ?? null,
        }
      : {
          id: String(delivery.vendor_id),
          name: null,
          phone: null,
          address: delivery.pickup_location?.address || null,
          neighborhood: delivery.pickup_location?.neighborhood || null,
          latitude: delivery.pickup_location?.latitude ?? null,
          longitude: delivery.pickup_location?.longitude ?? null,
        },
    customer: {
      id: customer ? String(customer._id) : String(delivery.customer_id),
      name: customer?.name || null,
      phone_number: revealCustomer ? customer?.phone_number || null : null,
    },
    pickup_location: { ...delivery.pickup_location },
    delivery_location: { ...delivery.delivery_location },
    route_distance_km: round1(delivery.route_distance_km),
    distance_from_driver_km:
      typeof distanceFromDriverKm === 'number' ? round1(distanceFromDriverKm) : null,
    delivery_fee_rwf: delivery.delivery_fee_rwf,
    promised_earnings_rwf: delivery.promised_earnings_rwf,
    payment_method: delivery.payment_method || null,
    otp_required: Boolean(delivery.otp_code),
    proof_photo_url: delivery.proof_photo_url || null,
    dispatched_at: delivery.dispatch?.last_broadcast_at ?? null,
    offer_expires_at: delivery.dispatch?.offer_expires_at ?? null,
    // Offered at placement: the kitchen may still be cooking.
    kitchen_ready: isKitchenReady(delivery),
    ready_at: delivery.ready_at ?? null,
    expected_ready_at:
      isKitchenReady(delivery) || !order?.created_at
        ? null
        : new Date(
            new Date(order.created_at).getTime() + (Number(vendorVendor?.estimated_prep_time) || 30) * 60000
          ),
    // This worker's own pickup clock (fixed when it started)...
    pickup_started_at: delivery.pickup_started_at ?? null,
    pickup_warn_at: delivery.pickup_warn_at ?? null,
    pickup_due_at: delivery.pickup_due_at ?? null,
    pickup_reassign_at: delivery.pickup_reassign_at ?? null,
    // ...and the admin's current rules, shown before accepting.
    pickup_rules: (() => {
      const rules = deliverySettings.current();
      return {
        warning_minutes: rules.warning_minutes,
        charge_after_minutes: rules.charge_after_minutes,
        reassign_after_minutes: rules.reassign_after_minutes,
      };
    })(),
    pickup_grace_minutes: delivery.pickup_started_at && delivery.pickup_due_at
      ? Math.round((new Date(delivery.pickup_due_at) - new Date(delivery.pickup_started_at)) / 60000)
      : deliverySettings.current().charge_after_minutes,
    late_pickup: delivery.late_pickup?.flagged_at
      ? {
          flagged_at: delivery.late_pickup.flagged_at,
          minutes_late: delivery.late_pickup.minutes_late ?? null,
          charge_status: delivery.late_pickup.charge_status || 'pending',
          charge_rwf: delivery.late_pickup.charge_rwf ?? null,
          penalty_percent: delivery.late_pickup.penalty_percent ?? null,
          note: delivery.late_pickup.note || '',
        }
      : null,
    // What the worker was paid for this delivery and what was kept as a
    // late-pickup penalty (taken out of this order's delivery fee only).
    paid_earnings_rwf: delivery.paid_earnings_rwf ?? null,
    earnings_penalty_rwf: delivery.earnings_penalty_rwf ?? 0,
    // The assigned driver follows the order the way the customer does.
    order_progress:
      revealCustomer && order
        ? {
            status: order.status,
            label: config.orders.statusLabels[order.status] || order.status,
            history: (order.status_history || []).map((entry) => ({
              status: entry.status,
              label: config.orders.statusLabels[entry.status] || entry.status,
              at: entry.at,
              note: entry.note || '',
            })),
          }
        : null,
    assigned_at: delivery.assigned_at ?? null,
    picked_up_at: delivery.picked_up_at ?? null,
    out_for_delivery_at: delivery.out_for_delivery_at ?? null,
    delivered_at: delivery.delivered_at ?? null,
    completed_at: delivery.completed_at ?? null,
    cancelled_at: delivery.cancelled_at ?? null,
    cancel_reason: delivery.cancel_reason || null,
    created_at: delivery.created_at,
    updated_at: delivery.updated_at,
    items: (order?.items || []).map((item) => ({
      menu_item_id: item.menu_item_id ? String(item.menu_item_id) : null,
      name: item.name,
      price_rwf: item.price_rwf,
      quantity: item.quantity,
      subtotal_rwf: item.subtotal_rwf,
      image_url: item.image_url || null,
      options: (item.options || []).map((option) => ({
        group_name: option.group_name || 'Options',
        name: option.name,
        additional_price_rwf: option.additional_price_rwf || 0,
      })),
    })),
    status_history: (delivery.status_history || []).map((entry) => ({
      status: entry.status,
      label: deliveryStatusLabel(entry.status),
      at: entry.at,
      note: entry.note || '',
      by: entry.by || 'system',
    })),
  };
}

function serializeNotification(notification) {
  return {
    id: String(notification._id),
    type: notification.type || 'general',
    title: notification.title,
    body: notification.body,
    order_id: notification.order_id ? String(notification.order_id) : null,
    data: notification.data || {},
    sms_status: notification.sms_status || 'pending',
    read: Boolean(notification.read_at),
    read_at: notification.read_at ?? null,
    created_at: notification.created_at,
  };
}

function serializeWithdrawal(withdrawal) {
  return {
    id: String(withdrawal._id),
    amount_rwf: withdrawal.amount_rwf,
    method: withdrawal.method,
    method_label: withdrawal.method_label || withdrawal.method,
    account_number: withdrawal.account_number || null,
    account_name: withdrawal.account_name || null,
    bank_name: withdrawal.bank_name || null,
    status: withdrawal.status,
    reference: withdrawal.reference || null,
    failure_reason: withdrawal.failure_reason || null,
    processed_at: withdrawal.processed_at ?? null,
    created_at: withdrawal.created_at,
  };
}

/* -------------------------------- admin -------------------------------- */

function serializeAdmin(admin, { usesDefaultPassword } = {}) {
  return {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    role: access.roleKey(admin.role),
    role_label: access.roleLabel(admin.role),
    is_owner: admin.role === access.OWNER_ROLE,
    // What this admin may do (decided by their role).
    permissions: access.permissionsFor(admin),
    is_active: admin.is_active !== false,
    phone: admin.phone || null,
    two_factor_enabled: Boolean(admin.two_factor_enabled && admin.phone),
    ...(usesDefaultPassword !== undefined ? { uses_default_password: usesDefaultPassword } : {}),
    last_login_at: admin.last_login_at ?? null,
    created_at: admin.created_at,
  };
}

function serializeAdminVendor(vendor) {
  const [lng, lat] = vendor.location?.coordinates ?? [null, null];
  return {
    id: String(vendor._id),
    name: vendor.name,
    owner_name: vendor.owner_name || '',
    vendor_type: vendor.vendor_type,
    vendor_type_label: vendorTypeLabel(vendor.vendor_type),
    vendor_type_request: serializeVendorTypeRequest(vendor),
    ordering: orderingRulesFor(vendor),
    nationwide: nationwideFor(vendor),
    phone: vendor.phone || null,
    email: vendor.email || null,
    neighborhood: vendor.neighborhood || null,
    address: vendor.address || null,
    status: vendor.verification_status || 'approved',
    is_active: vendor.is_active !== false,
    is_open: vendor.is_open !== false,
    is_featured: Boolean(vendor.is_featured),
    rating: vendor.rating ?? 0,
    delivery_available: Boolean(vendor.delivery_available),
    total_sales_rwf: vendor.total_sales ?? 0,
    available_balance_rwf: vendor.available_balance ?? 0,
    rejection_reason: vendor.rejection_reason || '',
    suspension_reason: vendor.suspension_reason || '',
    documents_reviewed_at: vendor.documents_reviewed_at ?? null,
    verification_documents: (vendor.verification_documents || []).map((doc) => ({
      label: doc.label || '',
      url: doc.url,
      uploaded_at: doc.uploaded_at,
    })),
    profile_image_url: vendor.profile_image_url || null,
    banner_image_url: vendor.banner_image_url || null,
    // The kitchen's registered position (entered by the vendor, not GPS).
    location: {
      latitude: typeof lat === 'number' ? lat : null,
      longitude: typeof lng === 'number' ? lng : null,
      updated_at: vendor.location_updated_at ?? null,
    },
    created_at: vendor.created_at,
    updated_at: vendor.updated_at,
  };
}

function serializeAdminCustomer(customer) {
  return {
    id: String(customer._id),
    name: customer.name,
    phone_number: customer.phone_number,
    profile_image_url: customer.profile_image_url || null,
    is_verified: Boolean(customer.is_verified),
    is_active: customer.is_active !== false,
    last_login_at: customer.last_login_at ?? null,
    created_at: customer.created_at,
  };
}

function serializeAdminDriver(driver) {
  const [lng, lat] = driver.location?.coordinates ?? [null, null];
  return {
    id: String(driver._id),
    name: driver.name,
    phone: driver.phone || null,
    email: driver.email || null,
    vehicle_type: driver.vehicle_type || 'motorcycle',
    plate_number: driver.plate_number || '',
    license_number: driver.license_number || '',
    status: driver.status || 'offline',
    verification_status: driver.verification_status || 'approved',
    is_online: Boolean(driver.is_online),
    is_available: Boolean(driver.is_available),
    is_active: driver.is_active !== false,
    rating: driver.rating ?? 5,
    rating_count: driver.rating_count ?? 0,
    completed_deliveries: driver.completed_deliveries ?? 0,
    active_deliveries_count: driver.active_deliveries_count ?? 0,
    total_earnings_rwf: driver.total_earnings_rwf ?? 0,
    available_balance_rwf: driver.available_balance_rwf ?? 0,
    rejection_reason: driver.rejection_reason || '',
    suspension_reason: driver.suspension_reason || '',
    profile_image_url: driver.profile_image_url || null,
    location: {
      latitude: typeof lat === 'number' ? lat : null,
      longitude: typeof lng === 'number' ? lng : null,
      // When the phone last reported it; dispatch ignores positions older
      // than the admin's location age rule.
      updated_at: driver.location_updated_at ?? null,
      heading: driver.location_heading ?? null,
      speed_mps: driver.location_speed_mps ?? null,
      accuracy_m: driver.location_accuracy_m ?? null,
      counts_for_dispatch:
        Boolean(driver.location_updated_at) &&
        Date.now() - new Date(driver.location_updated_at).getTime() <=
          dispatchSettingsService.current().location_max_age_minutes * 60000,
    },
    created_at: driver.created_at,
    updated_at: driver.updated_at,
  };
}

function serializeAdminOrder(order) {
  const vendor = order.vendor_id && typeof order.vendor_id === 'object' ? order.vendor_id : null;
  const customer =
    order.customer_id && typeof order.customer_id === 'object' ? order.customer_id : null;
  const driver = order.driver_id && typeof order.driver_id === 'object' ? order.driver_id : null;

  return {
    id: String(order._id),
    order_number: order.order_number,
    status: order.status,
    status_label:
      (order.fulfillment === 'pickup' && config.orders.pickupStatusLabels[order.status]) ||
      (isKitchenDelivered(order) && config.orders.vendorDeliveryStatusLabels[order.status]) ||
      config.orders.statusLabels[order.status] ||
      order.status,
    fulfillment: order.fulfillment || 'delivery',
    fulfillment_label: config.orders.fulfillmentLabels[order.fulfillment || 'delivery'],
    // Pickup and kitchen-delivered orders: where the handover stands (the code itself is never sent).
    pickup:
      usesHandoverCode(order)
        ? {
            code_sent_at: order.pickup_code_sent_at ?? null,
            wrong_attempts: order.pickup_code_attempts || 0,
            max_attempts: dispatchSettingsService.current().pickup_code_max_attempts,
            locked: (order.pickup_code_attempts || 0) >= dispatchSettingsService.current().pickup_code_max_attempts,
            collected_at: order.collected_at ?? null,
          }
        : null,
    created_at: order.created_at,
    updated_at: order.updated_at,
    completed_at: order.completed_at ?? null,
    cancelled_at: order.cancelled_at ?? null,
    cancel_reason: order.cancel_reason || null,
    vendor: vendor
      ? { id: String(vendor._id), name: vendor.name, neighborhood: vendor.neighborhood || null }
      : order.vendor_id
        ? { id: String(order.vendor_id), name: null, neighborhood: null }
        : null,
    customer: customer
      ? { id: String(customer._id), name: customer.name, phone_number: customer.phone_number }
      : order.customer_id
        ? { id: String(order.customer_id), name: null, phone_number: null }
        : null,
    driver: driver
      ? { id: String(driver._id), name: driver.name, phone: driver.phone || null }
      : null,
    items: (order.items || []).map((item) => ({
      menu_item_id: item.menu_item_id ? String(item.menu_item_id) : null,
      name: item.name,
      price_rwf: item.price_rwf,
      quantity: item.quantity,
      subtotal_rwf: item.subtotal_rwf,
      image_url: item.image_url || null,
    })),
    subtotal_rwf: order.subtotal_rwf,
    delivery_fee_rwf: order.delivery_fee_rwf,
    delivery_distance_km: order.delivery_distance_km ?? null,
    total_amount_rwf: order.total_rwf,
    commission_percent: order.commission_percent ?? 0,
    commission_rwf: order.commission_rwf ?? 0,
    vendor_payout_rwf: order.vendor_payout_rwf ?? 0,
    rider_payout_rwf: order.rider_payout_rwf ?? 0,
    settlement_status: order.settlement_status || 'unpaid',
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    order_type: order.order_type || 'immediate',
    order_type_label:
      config.orders.orderTypeLabels[order.order_type || 'immediate'] || 'Immediate Order',
    scheduled_for: order.scheduled_for ?? null,
    special_text: order.special_text || '',
    delivery_location: { ...order.delivery_location },
    eta_minutes: order.eta_minutes ?? null,
    estimated_delivery_at: order.estimated_delivery_at ?? null,
    status_history: (order.status_history || []).map((entry) => ({
      status: entry.status,
      label: config.orders.statusLabels[entry.status] || entry.status,
      at: entry.at,
      note: entry.note || '',
    })),
  };
}

/** Platform (system admin) money account summary. */
function serializePlatformAccount(account = {}) {
  const n = (value) => value ?? 0;
  const unreconciled = n(account.unreconciled_rwf);
  return {
    // Money that should be in the platform's real account right now...
    cash_balance_rwf: n(account.cash_balance_rwf),
    // ...and what it is made of.
    held_balance_rwf: n(account.held_balance_rwf),
    vendor_payable_rwf: n(account.vendor_payable_rwf),
    driver_payable_rwf: n(account.driver_payable_rwf),
    refunds_owed_rwf: n(account.refunds_owed_rwf),
    commission_balance_rwf: n(account.commission_balance_rwf),
    reconciliation: {
      balanced: unreconciled === 0,
      unreconciled_rwf: unreconciled,
    },
    total_collected_rwf: n(account.total_collected_rwf),
    total_refunded_rwf: n(account.total_refunded_rwf),
    total_commission_rwf: n(account.total_commission_rwf),
    total_vendor_earnings_rwf: n(account.total_vendor_earnings_rwf),
    total_driver_earnings_rwf: n(account.total_driver_earnings_rwf),
    // Late-pickup penalties kept from riders' delivery fees.
    total_driver_penalties_rwf: n(account.total_driver_penalties_rwf),
    // Actually paid out to vendors / riders (completed withdrawals).
    total_vendor_payouts_rwf: n(account.total_vendor_payouts_rwf),
    total_driver_payouts_rwf: n(account.total_driver_payouts_rwf),
    computed_at: account.computed_at ?? null,
  };
}

/** A single platform money-ledger entry. */
function serializeTransaction(transaction = {}) {
  const order =
    transaction.order_id && typeof transaction.order_id === 'object'
      ? transaction.order_id
      : null;
  return {
    id: String(transaction._id),
    type: transaction.type,
    direction: transaction.direction,
    status: transaction.status,
    amount_rwf: transaction.amount_rwf,
    order_id: order ? String(order._id) : transaction.order_id ? String(transaction.order_id) : null,
    order_number: order?.order_number ?? null,
    vendor_id: transaction.vendor_id ? String(transaction.vendor_id) : null,
    driver_id: transaction.driver_id ? String(transaction.driver_id) : null,
    customer_id: transaction.customer_id ? String(transaction.customer_id) : null,
    reference: transaction.reference || '',
    description: transaction.description || '',
    metadata: transaction.metadata || {},
    created_at: transaction.created_at,
  };
}

function serializeAdminPayment(payment) {
  const order = payment.order_id && typeof payment.order_id === 'object' ? payment.order_id : null;
  const customer =
    payment.customer_id && typeof payment.customer_id === 'object' ? payment.customer_id : null;
  return {
    id: String(payment._id),
    order_id: order ? String(order._id) : String(payment.order_id),
    order_number: order?.order_number ?? null,
    customer: customer
      ? { id: String(customer._id), name: customer.name, phone_number: customer.phone_number }
      : null,
    amount_rwf: payment.amount_rwf,
    method: payment.method,
    provider: payment.provider,
    status: payment.status,
    reference: payment.reference,
    failure_reason: payment.failure_reason || '',
    paid_at: payment.paid_at ?? null,
    created_at: payment.created_at,
  };
}

function serializeAdminWithdrawal(withdrawal) {
  const populated = (ref) => (ref && typeof ref === 'object' && ref._id ? ref : null);
  const vendor = populated(withdrawal.vendor_id);
  const driver = populated(withdrawal.driver_id);
  const payeeType = withdrawal.payee_type === 'driver' ? 'driver' : 'vendor';
  const payee = payeeType === 'driver' ? driver : vendor;
  const idOf = (ref) => (ref ? String(ref._id || ref) : null);
  return {
    id: String(withdrawal._id),
    payee_type: payeeType,
    payee_id: idOf(payeeType === 'driver' ? withdrawal.driver_id : withdrawal.vendor_id),
    payee_name: payee?.name ?? null,
    payee_phone: payee?.phone ?? null,
    // Where to send the money: the number given on the request, falling back
    // to the vendor's saved payout details.
    account_number:
      withdrawal.account_number ||
      vendor?.payment_information?.mobile_money_number ||
      vendor?.payment_information?.account_number ||
      null,
    account_name:
      withdrawal.account_name || vendor?.payment_information?.account_name || payee?.name || null,
    bank_name: withdrawal.bank_name || (withdrawal.method === 'bank_transfer' ? vendor?.payment_information?.bank_name || null : null),
    vendor_id: idOf(withdrawal.vendor_id),
    vendor_name: vendor?.name ?? null,
    driver_id: idOf(withdrawal.driver_id),
    driver_name: driver?.name ?? null,
    amount_rwf: withdrawal.amount_rwf,
    method: withdrawal.method,
    method_label: withdrawal.method_label || withdrawal.method,
    status: withdrawal.status,
    reference: withdrawal.reference || null,
    failure_reason: withdrawal.failure_reason || null,
    processed_at: withdrawal.processed_at ?? null,
    created_at: withdrawal.created_at,
  };
}

function serializeAdminCommission(commission) {
  const vendor =
    commission.vendor_id && typeof commission.vendor_id === 'object'
      ? commission.vendor_id
      : null;
  const category =
    commission.category_id && typeof commission.category_id === 'object'
      ? commission.category_id
      : null;
  return {
    id: String(commission._id),
    name: commission.name,
    scope: commission.scope,
    vendor_id: commission.vendor_id ? String(commission.vendor_id._id || commission.vendor_id) : null,
    vendor_name: vendor?.name ?? null,
    category_id: commission.category_id
      ? String(commission.category_id._id || commission.category_id)
      : null,
    category_name: category?.name ?? null,
    vendor_type: commission.vendor_type || '',
    vendor_type_label: commission.vendor_type ? vendorTypeLabel(commission.vendor_type) : '',
    percentage: commission.percentage,
    fixed_fee_rwf: commission.fixed_fee_rwf ?? 0,
    is_active: commission.is_active !== false,
    created_at: commission.created_at,
    updated_at: commission.updated_at,
  };
}

function serializeAdminComplaint(complaint) {
  return {
    id: String(complaint._id),
    reference: complaint.reference,
    subject: complaint.subject,
    description: complaint.description || '',
    category: complaint.category,
    priority: complaint.priority,
    status: complaint.status,
    raised_by: {
      user_id: complaint.raised_by?.user_id ? String(complaint.raised_by.user_id) : null,
      role: complaint.raised_by?.role || 'guest',
      name: complaint.raised_by?.name || '',
      phone: complaint.raised_by?.phone || '',
    },
    related: {
      order_id: complaint.related?.order_id ? String(complaint.related.order_id) : null,
      vendor_id: complaint.related?.vendor_id ? String(complaint.related.vendor_id) : null,
      driver_id: complaint.related?.driver_id ? String(complaint.related.driver_id) : null,
    },
    assigned_to: complaint.assigned_to ? String(complaint.assigned_to) : null,
    // The conversation with the user (support replies are what the user sees).
    messages: (complaint.messages || []).map((message) => ({
      id: String(message._id),
      author_role: message.author_role,
      author_name: message.author_name || '',
      body: message.body,
      at: message.at,
    })),
    unread: Boolean(complaint.unread_by_admin),
    last_message_at: complaint.last_message_at || complaint.created_at,
    notes: (complaint.notes || []).map((note) => ({
      author_id: note.author_id ? String(note.author_id) : null,
      author_name: note.author_name || 'Admin',
      body: note.body || '',
      at: note.at,
    })),
    resolved_at: complaint.resolved_at ?? null,
    created_at: complaint.created_at,
    updated_at: complaint.updated_at,
  };
}

function serializeAdminAction(log) {
  return {
    id: String(log._id),
    admin_id: log.admin_id ? String(log.admin_id) : null,
    admin_name: log.admin_name || '',
    admin_email: log.admin_email || '',
    action: log.action,
    target_type: log.target_type,
    target_id: log.target_id || '',
    target_label: log.target_label || '',
    metadata: log.metadata || {},
    ip: log.ip || '',
    created_at: log.created_at,
  };
}

module.exports = {
  serializeCategory,
  serializeVendorCard,
  serializeVendorSpecial,
  serializeVendorSpecialCard,
  serializeNearbyVendor,
  serializePopularDish,
  serializeSearchDish,
  serializeMenuItem,
  serializeVendorStorefront,
  serializeVendorAccount,
  serializeMenuItemOption,
  serializeVendorMenuItem,
  serializeVendorOrder,
  serializeVendorDashboard,
  serializeWithdrawal,
  serializeDriverAccount,
  serializeDelivery,
  serializeNotification,
  serializeAdmin,
  serializeAdminVendor,
  serializeAdminCustomer,
  serializeAdminDriver,
  serializeAdminOrder,
  serializeAdminPayment,
  serializeAdminWithdrawal,
  serializeAdminCommission,
  serializeAdminComplaint,
  serializeAdminAction,
  serializePlatformAccount,
  serializeTransaction,
};
