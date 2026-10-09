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
  orders: {
    agentKey: process.env.AGENT_API_KEY || 'dev-agent-key',
    deliveryFeeRwf: Number(process.env.DELIVERY_FEE_RWF) || 1000,
    freeDeliveryOverRwf: Number(process.env.FREE_DELIVERY_OVER_RWF) || 15000,
    statuses: [
      'placed',
      'confirmed',
      'preparing',
      'ready',
      'out_for_delivery',
      'delivered',
      'cancelled',
    ],
    timeline: ['placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered'],
    statusLabels: {
      placed: 'Order placed',
      confirmed: 'Confirmed by kitchen',
      preparing: 'Preparing your food',
      ready: 'Ready for pickup',
      out_for_delivery: 'Out for delivery',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
    },
    paymentMethods: [
      {
        code: 'momo',
        label: 'MTN Mobile Money',
        description: 'Approve the MoMo prompt sent to your phone',
      },
      {
        code: 'card',
        label: 'Credit / Debit Card',
        description: 'Visa or Mastercard via secure checkout',
      },
      {
        code: 'cash_on_delivery',
        label: 'Cash on Delivery',
        description: 'Pay the rider when your order arrives',
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
      'out_for_delivery',
    ],
  },
};

module.exports = config;
