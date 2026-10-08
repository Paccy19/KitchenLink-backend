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
  },
};

module.exports = config;
