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
    // In the all-kitchens list, kitchens within this distance are "near you"
    // and listed first.
    nearYouRadiusKm: numberFromEnv(process.env.NEAR_YOU_RADIUS_KM, 5),
  },
  limits: {
    feedVendors: 10,
    feedDishes: 12,
    categories: 50,
    nearbyDefault: 20,
    nearbyMax: 50,
    // Open kitchens drawn on the customer map in one response (safety cap).
    mapVendorsMax: 1000,
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
  maps: {
    // Server-side Google Maps key used for real road distances (Routes API).
    // When empty, distances fall back to straight-line km x roadFactor.
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    // DRIVE works everywhere; TWO_WHEELER is closer to moto delivery where
    // Google supports it.
    travelMode: process.env.GOOGLE_MAPS_TRAVEL_MODE || 'DRIVE',
    timeoutMs: numberFromEnv(process.env.GOOGLE_MAPS_TIMEOUT_MS, 4000),
    cacheTtlSeconds: numberFromEnv(process.env.GOOGLE_MAPS_CACHE_TTL_SECONDS, 600),
    // Place search for vendors setting their kitchen location. Uses Google
    // Places when the key above allows it, otherwise (or when Google fails)
    // the free OpenStreetMap services: Photon for search-as-you-type and
    // Nominatim for an area's outline once a place is picked.
    photonUrl: process.env.PHOTON_URL || 'https://photon.komoot.io',
    // Road routes + turn-by-turn steps for live delivery tracking when no
    // Google key is set. The public demo server is fine for light use; point
    // this at your own OSRM server for production traffic.
    osrmUrl: process.env.OSRM_URL || 'https://router.project-osrm.org',
    nominatimUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    // OpenStreetMap's usage policy asks for an identifying User-Agent.
    geocoderUserAgent:
      process.env.GEOCODER_USER_AGENT || 'OnlineFoodKitchen/1.0 (kitchen location search)',
    // Results are limited to this country (ISO code) and biased to this point.
    geocoderCountry: process.env.GEOCODER_COUNTRY || 'rw',
    // The free public servers can be slow; stay under the website's 8 s limit.
    geocoderTimeoutMs: numberFromEnv(process.env.GEOCODER_TIMEOUT_MS, 6500),
    geocoderBounds: [28.86, -2.84, 30.9, -1.05], // Rwanda: west, south, east, north
    geocoderBias: { lat: -1.9441, lng: 30.0619 }, // Kigali
  },
  // Where the website runs; used for links in emails (e.g. team invitations).
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  mail: {
    // Two delivery options. If EMAIL_PROVIDER + EMAIL_API_KEY are set, an HTTP
    // email API (resend | sendgrid | mailgun | brevo) is used. Otherwise an
    // SMTP account (SMTP_HOST...) is used. Without either, emails are not sent:
    // they are logged (development) and the owner gets the link to share.
    provider: (process.env.EMAIL_PROVIDER || '').toLowerCase(),
    apiKey: process.env.EMAIL_API_KEY || '',
    // Optional endpoint override (e.g. Mailgun's region or a self-hosted API).
    apiUrl: process.env.EMAIL_API_URL || '',
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Online Food Kitchen <no-reply@foodkitchen.rw>',
  },
  team: {
    // How long an invitation link works.
    inviteValidHours: numberFromEnv(process.env.TEAM_INVITE_VALID_HOURS, 72),
    // Refunds and payouts of this amount or more need an SMS code.
    largeMoneyActionRwf: numberFromEnv(process.env.LARGE_MONEY_ACTION_RWF, 50000),
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
      assigned: 'Assigned to a delivery worker',
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
    // Order timing. Immediate = ASAP; scheduled = a slot the customer picks;
    // preorder = ordered against a vendor's announced "Tomorrow's Special".
    // How the customer gets the food: brought by a delivery worker, or
    // collected at the kitchen (no delivery fee).
    fulfillmentModes: ['delivery', 'pickup'],
    fulfillmentLabels: { delivery: 'Delivery', pickup: 'Pickup at the kitchen' },
    // Customer tracking for pickup orders ('delivered' = collected).
    pickupTimeline: ['placed', 'confirmed', 'preparing', 'ready', 'delivered'],
    pickupStatusLabels: { ready: 'Ready for you to collect', delivered: 'Collected' },
    // Wrong pickup codes a vendor may enter before the order is locked.
    pickupCodeMaxAttempts: 5,
    orderTypes: ['immediate', 'scheduled', 'preorder'],
    orderTypeLabels: {
      immediate: 'Immediate Order',
      scheduled: 'Scheduled Order',
      preorder: 'Pre-order',
    },
    schedule: {
      minLeadMinutes: Number(process.env.SCHEDULE_MIN_LEAD_MINUTES) || 45,
      maxDaysAhead: Number(process.env.SCHEDULE_MAX_DAYS_AHEAD) || 7,
      // A scheduled order may only be marked "ready" this close to its slot so
      // drivers are dispatched near the delivery time, not hours in advance.
      readyWindowMinutes: Number(process.env.SCHEDULE_READY_WINDOW_MINUTES) || 60,
    },
    special: {
      textMax: 160,
      maxDaysAhead: Number(process.env.SPECIAL_MAX_DAYS_AHEAD) || 14,
    },
    // "Offer Days": a vendor announces a deal on a chosen future day.
    offerDays: {
      titleMax: 80,
      detailsMax: 300,
      maxDaysAhead: Number(process.env.OFFER_MAX_DAYS_AHEAD) || 60,
      maxUpcomingPerVendor: Number(process.env.OFFER_MAX_UPCOMING) || 3,
      // Kigali hour (0-23) from which the day-before reminder is sent.
      reminderHour: numberFromEnvOrZero(process.env.OFFER_REMINDER_HOUR, 9),
    },
  },
  vendor: {
    // Role claim embedded in vendor JWT access tokens.
    jwtRole: 'vendor',
    // Platform commission retained from each completed order's food subtotal
    // (percent). The delivery fee is never commissioned — the rider keeps it.
    commissionPercent: numberFromEnvOrZero(process.env.PLATFORM_COMMISSION_PERCENT, 15),
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
    // Vendors never complete orders: an order completes only when the delivery
    // worker confirms the code the customer gives them.
    orderTransitions: {
      new: ['accepted', 'cancelled'],
      accepted: ['preparing', 'cancelled'],
      preparing: ['ready', 'cancelled'],
      ready: ['cancelled'],
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
    // Driver search radius (km) around the kitchen. Every online driver inside
    // it is offered an order the moment it is placed (paid), at the same time
    // the kitchen hears about it; the first to accept gets the delivery.
    defaultRadiusKm: numberFromEnv(process.env.DELIVERY_RADIUS_KM, 7.5),
    // A driver's position older than this doesn't count for matching (their
    // app updates it every minute while they are online).
    locationMaxAgeMinutes: numberFromEnv(process.env.DELIVERY_LOCATION_MAX_AGE_MINUTES, 60),
    // Most drivers offered one order in a broadcast.
    maxOfferRecipients: numberFromEnv(process.env.DELIVERY_MAX_OFFER_RECIPIENTS, 50),
    // Once the food is ready (or once the driver accepts, if later) the
    // assigned driver has this long to collect it. They are warned at
    // `pickupWarningMinutes`; after the grace period the pickup is recorded
    // as late and a late-pickup charge is marked pending.
    pickupGraceMinutes: numberFromEnv(process.env.DELIVERY_PICKUP_GRACE_MINUTES, 15),
    pickupWarningMinutes: numberFromEnv(process.env.DELIVERY_PICKUP_WARNING_MINUTES, 10),
    // How often open offers are re-broadcast and pickups checked for lateness.
    dispatchTickSeconds: numberFromEnv(process.env.DELIVERY_DISPATCH_TICK_SECONDS, 60),
    // Max concurrent deliveries a driver can hold.
    maxActiveDeliveries: numberFromEnv(process.env.DELIVERY_MAX_ACTIVE, 3),
    // Multiplier applied to straight-line distance to approximate road km.
    roadFactor: Number(process.env.DELIVERY_ROAD_FACTOR) || 1.3,
    // Fee model (RWF): fee = max(min, base + per_km * distance).
    baseFeeRwf: numberFromEnvOrZero(process.env.DELIVERY_BASE_FEE_RWF, 500),
    perKmFeeRwf: numberFromEnvOrZero(process.env.DELIVERY_PER_KM_FEE_RWF, 200),
    minFeeRwf: numberFromEnvOrZero(process.env.DELIVERY_MIN_FEE_RWF, 800),
    // Share of the delivery fee paid to the driver (percent). Drivers keep the
    // entire delivery fee — no platform commission is taken from it.
    driverSharePercent: numberFromEnvOrZero(
      process.env.DELIVERY_DRIVER_SHARE_PERCENT,
      100
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
      assigned_to_driver: 'Assigned to a delivery worker',
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
  refunds: {
    // What customers are told about how long a refund takes to reach them.
    expectedWithinHours: Number(process.env.REFUND_EXPECTED_HOURS) || 24,
  },
  support: {
    // Longest message a user or admin can send in a support conversation.
    maxMessageLength: 2000,
    maxSubjectLength: 120,
    // Contact shown to suspended/rejected accounts that are blocked from login.
    phone: process.env.SUPPORT_PHONE || '',
    email: process.env.SUPPORT_EMAIL || '',
  },
  admin: {
    // Role claim embedded in admin JWT access tokens.
    jwtRole: 'admin',
    // Seeded super-admin credentials (override in production via env).
    seedName: process.env.ADMIN_SEED_NAME || 'Platform Admin',
    seedEmail: process.env.ADMIN_SEED_EMAIL || 'admin@foodkitchen.rw',
    seedPassword: process.env.ADMIN_SEED_PASSWORD || 'Admin@12345',
    // Default platform commission applied when no commission config matches.
    commissionDefaultPercent: numberFromEnvOrZero(
      process.env.PLATFORM_COMMISSION_PERCENT,
      15
    ),
    // Flat handling fee shown on payout estimates (RWF).
    payoutFeeRwf: numberFromEnvOrZero(process.env.PAYOUT_FEE_RWF, 0),
    // Codes sent to the admin's phone for sign-in and money actions.
    otpTtlMinutes: numberFromEnv(process.env.ADMIN_OTP_TTL_MINUTES, 5),
    // The owner's own commission withdrawals.
    owner: {
      maxWithdrawalRwf: numberFromEnv(process.env.OWNER_MAX_WITHDRAWAL_RWF, 500000),
      maxWeeklyRwf: numberFromEnv(process.env.OWNER_MAX_WEEKLY_RWF, 2000000),
      // Share of the commission balance always kept back for refunds/disputes.
      reservePercent: numberFromEnvOrZero(process.env.OWNER_RESERVE_PERCENT, 10),
      // A newly added payout destination can only be used after this wait.
      destinationCooldownHours: numberFromEnvOrZero(
        process.env.OWNER_DESTINATION_COOLDOWN_HOURS,
        48
      ),
      // Service that sends payouts automatically ('manual' = owner transfers).
      payoutProvider: process.env.PAYOUT_PROVIDER || 'manual',
      // Default schedule until the owner saves payout settings (Kigali time):
      // weekday 0=Sun..6=Sat.
      sweep: {
        enabled: process.env.OWNER_SWEEP_ENABLED !== 'false',
        weekday: numberFromEnvOrZero(process.env.OWNER_SWEEP_WEEKDAY, 5),
        hour: numberFromEnvOrZero(process.env.OWNER_SWEEP_HOUR, 9),
        minRwf: numberFromEnvOrZero(process.env.OWNER_SWEEP_MIN_RWF, 5000),
      },
    },
    limits: {
      listDefault: 20,
      listMax: 100,
      complaintsDefault: 20,
      complaintsMax: 100,
      actionsDefault: 25,
      actionsMax: 100,
    },
    // Lightweight in-memory rate limiting for admin API traffic.
    rateLimit: {
      windowMs: numberFromEnv(process.env.ADMIN_RATE_WINDOW_MS, 60 * 1000),
      max: numberFromEnv(process.env.ADMIN_RATE_MAX, 300),
    },
  },
};

module.exports = config;
