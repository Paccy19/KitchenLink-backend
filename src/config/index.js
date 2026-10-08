require('dotenv').config();

const numberFromEnv = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4000,
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
};

module.exports = config;
