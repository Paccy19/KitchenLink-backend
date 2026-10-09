/* eslint-disable no-console */
/**
 * Seeds a fully working Vendor Dashboard demo account:
 *
 *   Email:    vendor@ofk.rw
 *   Password: Vendor@123
 *
 * Idempotent: re-running replaces the demo vendor's menu, options and orders.
 * Usage: npm run seed
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const {
  Vendor,
  Category,
  MenuItem,
  MenuItemOption,
  Customer,
  Order,
} = require('../models');
const { hashPassword } = require('../utils/password');

const DEMO = {
  email: 'vendor@ofk.rw',
  password: 'Vendor@123',
  name: 'Mama Keza Kitchen',
  vendor_type: 'Restaurant',
  phone: '+250788123456',
  neighborhood: 'Kimironko',
  address: 'KG 11 Ave, Kimironko, Kigali',
  coordinates: [30.1269, -1.9391], // [lng, lat]
  available_balance: 1870000,
  total_sales: 2345000,
  rating: 4.7,
};

const startOfToday = () => {
  const now = new Date();
  const shifted = new Date(now.getTime() + config.vendor.timezoneOffsetHours * 3600000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - config.vendor.timezoneOffsetHours * 3600000);
};

const orderNumber = () => {
  const date = new Date();
  const ymd =
    date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0');
  return `OFK-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const CATEGORY_SEED = [
  { name: 'Main Dishes', sort_order: 1 },
  { name: 'Grilled & BBQ', sort_order: 2 },
  { name: 'Drinks', sort_order: 3 },
  { name: 'Desserts', sort_order: 4 },
];

const buildMenu = (categoryIds) => [
  {
    name: 'Isombe with Beef',
    description: 'Cassava leaves slow-cooked with beef, served with rice.',
    price_rwf: 6500,
    preparation_time_minutes: 25,
    category_id: categoryIds['Main Dishes'],
    options: [
      { group_name: 'Size', name: 'Regular', additional_price_rwf: 0 },
      { group_name: 'Size', name: 'Large', additional_price_rwf: 1500 },
      { group_name: 'Extras', name: 'Extra beef', additional_price_rwf: 2000 },
    ],
  },
  {
    name: 'Kigali Pilau',
    description: 'Spiced rice with tender beef and vegetables.',
    price_rwf: 4500,
    preparation_time_minutes: 20,
    category_id: categoryIds['Main Dishes'],
    options: [
      { group_name: 'Extras', name: 'Avocado', additional_price_rwf: 500 },
    ],
  },
  {
    name: 'Brochettes (5 sticks)',
    description: 'Charcoal-grilled beef skewers with fried plantain.',
    price_rwf: 5000,
    preparation_time_minutes: 18,
    category_id: categoryIds['Grilled & BBQ'],
    options: [
      { group_name: 'Spice level', name: 'Mild', additional_price_rwf: 0 },
      { group_name: 'Spice level', name: 'Hot', additional_price_rwf: 300 },
    ],
  },
  {
    name: 'Grilled Tilapia',
    description: 'Whole grilled tilapia with chips and salad.',
    price_rwf: 9000,
    preparation_time_minutes: 30,
    category_id: categoryIds['Grilled & BBQ'],
  },
  {
    name: 'Passion Fruit Juice',
    description: 'Freshly squeezed passion fruit juice.',
    price_rwf: 2500,
    preparation_time_minutes: 5,
    category_id: categoryIds['Drinks'],
    options: [
      { group_name: 'Size', name: 'Regular', additional_price_rwf: 0 },
      { group_name: 'Size', name: 'Large', additional_price_rwf: 800 },
    ],
  },
  {
    name: 'Mandazi (6 pcs)',
    description: 'Soft, lightly sweet fried dough.',
    price_rwf: 2000,
    preparation_time_minutes: 10,
    category_id: categoryIds['Desserts'],
  },
];

const run = async () => {
  await mongoose.connect(config.mongoUri);
  console.log(`Connected to ${config.mongoUri}`);

  const password_hash = await hashPassword(DEMO.password);

  const vendor = await Vendor.findOneAndUpdate(
    { email: DEMO.email },
    {
      $set: {
        name: DEMO.name,
        vendor_type: DEMO.vendor_type,
        owner_name: 'Keza Mukamana',
        description:
          'Home-style Rwandan cooking made fresh daily in Kimironko.',
        phone: DEMO.phone,
        password_hash,
        location: { type: 'Point', coordinates: DEMO.coordinates },
        neighborhood: DEMO.neighborhood,
        address: DEMO.address,
        rating: DEMO.rating,
        estimated_prep_time: 25,
        is_active: true,
        delivery_available: true,
        operating_hours: [
          { day: 'monday', open_time: '08:00', close_time: '21:00' },
          { day: 'tuesday', open_time: '08:00', close_time: '21:00' },
          { day: 'wednesday', open_time: '08:00', close_time: '21:00' },
          { day: 'thursday', open_time: '08:00', close_time: '21:00' },
          { day: 'friday', open_time: '08:00', close_time: '22:00' },
          { day: 'saturday', open_time: '09:00', close_time: '22:00' },
          { day: 'sunday', is_closed: true },
        ],
        payment_information: {
          payout_method: 'mobile_money',
          account_name: 'Keza Mukamana',
          mobile_money_number: '+250788123456',
        },
        verification_status: 'approved',
        verification_documents: [
          { label: 'National ID', url: '/uploads/sample-id.pdf' },
        ],
        available_balance: DEMO.available_balance,
        total_sales: DEMO.total_sales,
        deleted_at: null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  // Clean previous demo data for an idempotent seed.
  await Promise.all([
    Order.deleteMany({ vendor_id: vendor._id }),
    MenuItemOption.deleteMany({ vendor_id: vendor._id }),
    MenuItem.deleteMany({ vendor_id: vendor._id }),
  ]);

  const categoryIds = {};
  for (const category of CATEGORY_SEED) {
    const doc = await Category.findOneAndUpdate(
      { name: category.name },
      { $set: { sort_order: category.sort_order } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    categoryIds[category.name] = doc._id;
  }

  await Vendor.updateOne(
    { _id: vendor._id },
    {
      $set: {
        food_category_ids: Object.values(categoryIds),
        food_categories: Object.keys(categoryIds),
      },
    }
  );

  const menuDocs = [];
  for (const item of buildMenu(categoryIds)) {
    const { options, ...fields } = item;
    const created = await MenuItem.create({
      ...fields,
      vendor_id: vendor._id,
      is_available: true,
    });
    menuDocs.push(created.toObject());
    if (options) {
      await MenuItemOption.insertMany(
        options.map((option, index) => ({
          menu_item_id: created._id,
          vendor_id: vendor._id,
          group_name: option.group_name,
          name: option.name,
          additional_price_rwf: option.additional_price_rwf,
          sort_order: index,
        }))
      );
    }
  }
  console.log(`Seeded ${menuDocs.length} menu items with options.`);

  const customer = await Customer.findOneAndUpdate(
    { phone_number: '+250788000999' },
    { $set: { name: 'Demo Customer', is_verified: true } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  const itemByName = Object.fromEntries(menuDocs.map((item) => [item.name, item]));
  const buildItem = (name, quantity) => {
    const item = itemByName[name];
    return {
      menu_item_id: item._id,
      name: item.name,
      price_rwf: item.price_rwf,
      quantity,
      subtotal_rwf: item.price_rwf * quantity,
      image_url: '',
      options: [],
    };
  };

  const deliveryLocation = {
    address: 'KG 7 Ave, Remera, Kigali',
    note: 'Near the roundabout',
    neighborhood: 'Remera',
    latitude: -1.9565,
    longitude: 30.1044,
  };

  const dayStart = startOfToday();
  const completedTotals = [25000, 18000, 12000, 16000, 14000, 20000, 15000, 10000, 15000];
  const createdOrders = [];

  // 9 completed orders today -> today_sales_rwf = 145,000
  for (let i = 0; i < completedTotals.length; i += 1) {
    const createdAt = new Date(dayStart.getTime() + (i + 1) * 3600000);
    const order = await Order.create({
      order_number: orderNumber(),
      customer_id: customer._id,
      vendor_id: vendor._id,
      items: [buildItem('Isombe with Beef', 1), buildItem('Passion Fruit Juice', 1)],
      subtotal_rwf: completedTotals[i],
      delivery_fee_rwf: 0,
      total_rwf: completedTotals[i],
      delivery_location: deliveryLocation,
      payment_method: i % 2 === 0 ? 'momo' : 'cash_on_delivery',
      payment_status: 'paid',
      status: 'delivered',
      status_history: [
        { status: 'placed', at: createdAt, note: 'Order placed' },
        { status: 'delivered', at: createdAt, note: 'Delivered' },
      ],
      completed_at: createdAt,
    });
    await Order.updateOne(
      { _id: order._id },
      { $set: { created_at: createdAt, updated_at: createdAt } }
    );
    createdOrders.push(order._id);
  }

  // 3 pending orders today -> pending_orders = 3
  const pending = [
    { status: 'placed', total: 9000 },
    { status: 'confirmed', total: 11500 },
    { status: 'preparing', total: 5000 },
  ];
  for (let i = 0; i < pending.length; i += 1) {
    const createdAt = new Date(dayStart.getTime() + (i + 10) * 3600000);
    const order = await Order.create({
      order_number: orderNumber(),
      customer_id: customer._id,
      vendor_id: vendor._id,
      items: [buildItem('Brochettes (5 sticks)', 1)],
      subtotal_rwf: pending[i].total,
      delivery_fee_rwf: 1000,
      total_rwf: pending[i].total,
      delivery_location: deliveryLocation,
      payment_method: 'cash_on_delivery',
      payment_status: 'pending',
      status: pending[i].status,
      status_history: [
        { status: 'placed', at: createdAt, note: 'Order placed' },
        ...(pending[i].status !== 'placed'
          ? [{ status: pending[i].status, at: createdAt, note: pending[i].status }]
          : []),
      ],
    });
    await Order.updateOne(
      { _id: order._id },
      { $set: { created_at: createdAt, updated_at: createdAt } }
    );
    createdOrders.push(order._id);
  }

  console.log(`Seeded ${createdOrders.length} orders (9 completed, 3 pending).`);
  console.log('\nDemo vendor login:');
  console.log(`  email:    ${DEMO.email}`);
  console.log(`  password: ${DEMO.password}`);
  console.log(`  vendor_id: ${vendor._id}`);

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Seed failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
