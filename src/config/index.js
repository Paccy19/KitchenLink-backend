require('dotenv').config();

const numberFromEnv = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const numberFromEnvOrZero = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const port = Number(process.env.PORT) || 4000;

const config = {
  env: process.env.NODE_ENV || 'development',
  port,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(
    /\/+$/,
    ''
  ),
  mongoUri:
    process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/online_food_kitchen',
  geo: {
    defaultRadiusKm: numberFromEnv(process.env.DEFAULT_RADIUS_KM, 5),
    maxRadiusKm: numberFromEnv(process.env.MAX_RADIUS_KM, 50),
    feedRadiusKm: numberFromEnv(process.env.FEED_RADIUS_KM, 10),
  },
  limits: {
    feedVendors: 10,
    feedDishes: 12,
    categories: 50,
    nearbyDefault: 20,
    nearbyMax: 50,
    searchDefault: 10,
    searchMax: 25,
    searchCandidateCap: 200,
    cartMaxQuantity: 99,
    ordersDefault: 10,
    ordersMax: 50,
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
    otpTtlMinutes: numberFromEnv(process.env.OTP_TTL_MINUTES, 5),
    otpMaxAttempts: 5,
    otpResendCooldownSeconds: 60,
    otpRateWindowMinutes: 10,
    otpRateMaxSends: 5,
  },
  notifications: {
    sms: {
      // When disabled (or missing credentials) messages are logged in dev.
      enabled: process.env.SMS_ENABLED === 'true',
      provider: process.env.SMS_PROVIDER || 'log',
      apiUrl: process.env.SMS_API_URL || '',
      apiKey: process.env.SMS_API_KEY || '',
      apiKeyHeader: process.env.SMS_API_KEY_HEADER || '',
      senderId: process.env.SMS_SENDER_ID || 'FoodKitchen',
    },
  },
  orders: {
    agentKey: process.env.AGENT_API_KEY || 'dev-agent-key',
    deliveryFeeRwf: Number(process.env.DELIVERY_FEE_RWF) || 1000,
    freeDeliveryOverRwf: Number(process.env.FREE_DELIVERY_OVER_RWF) || 15000,
    statuses: [
      'placed',
      'confirmed',
      'preparing',
      'ready',
      'assigned',
      'picked_up',
      'out_for_delivery',
      'delivered',
      'cancelled',
    ],
    timeline: [
      'placed',
      'confirmed',
      'preparing',
      'ready',
      'assigned',
      'picked_up',
      'out_for_delivery',
      'delivered',
    ],
    statusLabels: {
      placed: 'Order placed',
      confirmed: 'Confirmed by kitchen',
      preparing: 'Preparing your food',
      ready: 'Ready for pickup',
      assigned: 'Assigned to driver',
      picked_up: 'Picked up',
      out_for_delivery: 'Out for delivery',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
    },
    paymentMethods: [
      {
        code: 'mobile_money',
        label: 'Mobile Money',
        description: 'Approve the payment prompt sent to your phone',
      },
      {
        code: 'card',
        label: 'Cards',
        description: 'Visa or Mastercard via secure checkout',
      },
      {
        code: 'ekash',
        label: 'eKash',
        description: 'Pay instantly from your eKash wallet',
      },
      {
        code: 'wallet',
        label: 'Wallet',
        description: 'Use your Online Food Kitchen wallet balance',
      },
    ],
  },
  vendor: {
    // Role claim embedded in vendor JWT access tokens.
    jwtRole: 'vendor',
    // Platform commission retained from each completed order payout (percent).
    commissionPercent: numberFromEnvOrZero(process.env.PLATFORM_COMMISSION_PERCENT, 0),
    // Rwanda (CAT / UTC+2, no DST) is used for "today" dashboard calculations.
    timezoneOffsetHours: Number(process.env.TZ_OFFSET_HOURS) || 2,
    uploads: {
      dir: process.env.UPLOAD_DIR || 'uploads',
      publicPath: '/uploads',
      maxFileSizeBytes: numberFromEnv(process.env.UPLOAD_MAX_MB, 5) * 1024 * 1024,
      maxDocumentSizeBytes:
        numberFromEnv(process.env.UPLOAD_DOC_MAX_MB, 10) * 1024 * 1024,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      documentMimeTypes: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
      ],
      maxDocuments: 10,
    },
    limits: {
      menuDefault: 20,
      menuMax: 100,
      optionsMax: 30,
      ordersDefault: 10,
      ordersMax: 50,
    },
    // Vendor-facing order lifecycle (Rwanda food-delivery vocabulary).
    orderStatuses: [
      'new',
      'accepted',
      'preparing',
      'ready',
      'completed',
      'cancelled',
    ],
    orderStatusLabels: {
      new: 'New order',
      accepted: 'Accepted',
      preparing: 'Preparing',
      ready: 'Ready',
      completed: 'Completed',
      cancelled: 'Cancelled',
    },
    // Allowed vendor-initiated transitions. Terminal states have no exits.
    orderTransitions: {
      new: ['accepted', 'cancelled'],
      accepted: ['preparing', 'cancelled'],
      preparing: ['ready', 'cancelled'],
      ready: ['completed', 'cancelled'],
      completed: [],
      cancelled: [],
    },
    // Translation layer over the shared Order.status field.
    vendorToInternalStatus: {
      new: 'placed',
      accepted: 'confirmed',
      preparing: 'preparing',
      ready: 'ready',
      completed: 'delivered',
      cancelled: 'cancelled',
    },
    internalToVendorStatus: {
      placed: 'new',
      confirmed: 'accepted',
      preparing: 'preparing',
      ready: 'ready',
      assigned: 'ready',
      picked_up: 'ready',
      out_for_delivery: 'ready',
      delivered: 'completed',
      cancelled: 'cancelled',
    },
    // Internal statuses considered "pending" (not yet completed/cancelled).
    pendingInternalStatuses: [
      'placed',
      'confirmed',
      'preparing',
      'ready',
      'assigned',
      'picked_up',
      'out_for_delivery',
    ],
  },
  delivery: {
    // Role claim embedded in driver JWT access tokens.
    jwtRole: 'driver',
    // How long a broadcast offer stays open before it can be re-dispatched.
    offerTimeoutSeconds: numberFromEnv(
      process.env.DELIVERY_OFFER_TIMEOUT_SECONDS,
      45
    ),
    // Driver search radius (km) around the pickup point. Only drivers inside
    // this radius receive the order-ready offer notification.
    defaultRadiusKm: numberFromEnv(process.env.DELIVERY_RADIUS_KM, 3),
    // Max concurrent deliveries a driver can hold.
    maxActiveDeliveries: numberFromEnv(process.env.DELIVERY_MAX_ACTIVE, 3),
    // Multiplier applied to straight-line distance to approximate road km.
    roadFactor: Number(process.env.DELIVERY_ROAD_FACTOR) || 1.3,
    // Fee model (RWF): fee = max(min, base + per_km * distance).
    baseFeeRwf: numberFromEnvOrZero(process.env.DELIVERY_BASE_FEE_RWF, 500),
    perKmFeeRwf: numberFromEnvOrZero(process.env.DELIVERY_PER_KM_FEE_RWF, 200),
    minFeeRwf: numberFromEnvOrZero(process.env.DELIVERY_MIN_FEE_RWF, 800),
    // Share of the delivery fee paid to the driver (percent).
    driverSharePercent: numberFromEnvOrZero(
      process.env.DELIVERY_DRIVER_SHARE_PERCENT,
      80
    ),
    // Delivery lifecycle statuses (guarded by `transitions`).
    statuses: [
      'pending',
      'accepted',
      'preparing',
      'ready_for_pickup',
      'assigned_to_driver',
      'picked_up',
      'out_for_delivery',
      'delivered',
      'completed',
      'cancelled',
      'rejected',
    ],
    statusLabels: {
      pending: 'Pending pickup',
      accepted: 'Accepted',
      preparing: 'Preparing',
      ready_for_pickup: 'Ready for pickup',
      assigned_to_driver: 'Assigned to driver',
      picked_up: 'Picked up',
      out_for_delivery: 'Out for delivery',
      delivered: 'Delivered',
      completed: 'Completed',
      cancelled: 'Cancelled',
      rejected: 'Rejected',
    },
    // Allowed driver-initiated transitions. Terminal states have no exits.
    transitions: {
      pending: ['ready_for_pickup', 'accepted', 'assigned_to_driver', 'cancelled', 'rejected'],
      accepted: ['preparing', 'ready_for_pickup', 'assigned_to_driver', 'cancelled'],
      preparing: ['ready_for_pickup', 'assigned_to_driver', 'cancelled'],
      ready_for_pickup: ['assigned_to_driver', 'cancelled', 'rejected'],
      assigned_to_driver: ['picked_up', 'ready_for_pickup', 'cancelled'],
      picked_up: ['out_for_delivery', 'cancelled'],
      out_for_delivery: ['delivered', 'cancelled'],
      delivered: ['completed'],
      completed: [],
      cancelled: [],
      rejected: [],
    },
    // Statuses considered "active" for a driver.
    activeStatuses: ['assigned_to_driver', 'picked_up', 'out_for_delivery'],
    // Statuses shown to drivers as available offers.
    availableStatuses: ['pending', 'ready_for_pickup'],
    // Statuses that can still be re-broadcast after a timeout.
    dispatchableStatuses: ['pending', 'ready_for_pickup'],
    // Statuses that count as a finished (historical) delivery.
    terminalStatuses: ['completed', 'cancelled', 'rejected'],
  },
};

module.exports = config;
