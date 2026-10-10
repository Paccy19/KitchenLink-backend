const config = require('../config');

const round1 = (value) =>
  typeof value === 'number' ? Math.round(value * 10) / 10 : null;

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
    rating: vendor.rating,
    estimated_prep_time: vendor.estimated_prep_time,
    distance_km: typeof distanceKm === 'number' ? round1(distanceKm) : null,
    banner_image_url: vendor.banner_image_url || null,
    avatar_url: vendor.profile_image_url || null,
    delivery_available: Boolean(vendor.delivery_available),
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
    image_url: item.image_url || null,
  };
}

function serializeVendorStorefront(vendor, { menu, distanceKm } = {}) {
  const [lng, lat] = vendor.location?.coordinates ?? [null, null];
  return {
    id: String(vendor._id),
    name: vendor.name,
    vendor_type: vendor.vendor_type,
    rating: vendor.rating,
    estimated_prep_time: vendor.estimated_prep_time,
    delivery_available: Boolean(vendor.delivery_available),
    location: {
      neighborhood: vendor.neighborhood || null,
      address: vendor.address || null,
      latitude: lat,
      longitude: lng,
    },
    banner_image_url: vendor.banner_image_url || null,
    avatar_url: vendor.profile_image_url || null,
    distance_km: typeof distanceKm === 'number' ? round1(distanceKm) : null,
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
    owner_name: vendor.owner_name || null,
    description: vendor.description || '',
    email: vendor.email || null,
    phone: vendor.phone || null,
    rating: vendor.rating,
    estimated_prep_time: vendor.estimated_prep_time,
    is_active: Boolean(vendor.is_active),
    is_open: vendor.is_open === undefined ? true : Boolean(vendor.is_open),
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

  return {
    id: String(order._id),
    order_number: order.order_number,
    status,
    status_label: vendorStatusLabel(status),
    allowed_next_statuses: config.vendor.orderTransitions[status] || [],
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
    total_amount_rwf: order.total_rwf,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
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
    max_active_deliveries: driver.max_active_deliveries ?? config.delivery.maxActiveDeliveries,
    completed_deliveries: driver.completed_deliveries ?? 0,
    total_earnings_rwf: driver.total_earnings_rwf ?? 0,
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
    status: withdrawal.status,
    reference: withdrawal.reference || null,
    processed_at: withdrawal.processed_at ?? null,
    created_at: withdrawal.created_at,
  };
}

module.exports = {
  serializeCategory,
  serializeVendorCard,
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
};
