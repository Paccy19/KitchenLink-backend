const config = require('../config');
const mongoose = require('mongoose');
const {
  CartItem,
  Customer,
  MenuItem,
  MenuItemOption,
  Order,
  OtpCode,
  Payment,
  Vendor,
  WishlistItem,
  Withdrawal,
} = require('../models');

const execute = process.argv.includes('--execute');
const customerQuery = {
  $or: [
    { name: /^Kevin Mugabo$/i },
    { name: /^Demo Customer$/i },
    { phone_number: '+250788000999' },
  ],
};
const demoVendorQuery = {
  $or: [
    { email: 'vendor@ofk.rw' },
    { phone: '+250788123456' },
  ],
};

async function run() {
  if (config.env === 'production') {
    throw new Error('Refusing to clean demo data when NODE_ENV is production.');
  }

  await mongoose.connect(config.mongoUri);
  const customers = await Customer.find(customerQuery).select('_id phone_number name').lean();
  const vendors = await Vendor.find(demoVendorQuery).select('_id email phone').lean();
  const customerIds = customers.map(({ _id }) => _id);
  const vendorIds = vendors.map(({ _id }) => _id);
  const orders = await Order.find({
    $or: [
      ...(customerIds.length ? [{ customer_id: { $in: customerIds } }] : []),
      ...(vendorIds.length ? [{ vendor_id: { $in: vendorIds } }] : []),
    ],
  }).select('_id').lean();
  const orderIds = orders.map(({ _id }) => _id);
  const menuItems = await MenuItem.find({ vendor_id: { $in: vendorIds } })
    .select('_id')
    .lean();
  const menuItemIds = menuItems.map(({ _id }) => _id);
  const otpPhones = [
    ...new Set([
      ...customers.map(({ phone_number }) => phone_number),
      ...vendors.map(({ phone }) => phone),
    ].filter(Boolean)),
  ];

  const targets = {
    customers: customers.length,
    demoVendors: vendors.length,
    orders: orderIds.length,
    payments: await Payment.countDocuments({
      $or: [
        ...(customerIds.length ? [{ customer_id: { $in: customerIds } }] : []),
        ...(orderIds.length ? [{ order_id: { $in: orderIds } }] : []),
      ],
    }),
    cartItems: await CartItem.countDocuments({ customer_id: { $in: customerIds } }),
    wishlistItems: await WishlistItem.countDocuments({ customer_id: { $in: customerIds } }),
    menuItems: menuItemIds.length,
    menuOptions: await MenuItemOption.countDocuments({
      $or: [
        ...(vendorIds.length ? [{ vendor_id: { $in: vendorIds } }] : []),
        ...(menuItemIds.length ? [{ menu_item_id: { $in: menuItemIds } }] : []),
      ],
    }),
    withdrawals: await Withdrawal.countDocuments({ vendor_id: { $in: vendorIds } }),
    otpCodes: await OtpCode.countDocuments({ phone_number: { $in: otpPhones } }),
  };

  console.log(JSON.stringify({
    database: mongoose.connection.name,
    mode: execute ? 'execute' : 'dry-run',
    targets,
    customers: customers.map(({ name, phone_number }) => ({ name, phone_number })),
    vendors: vendors.map(({ email, phone }) => ({ email, phone })),
  }, null, 2));

  if (!execute) {
    console.log('Dry run only. Re-run with --execute to permanently delete these records.');
    return;
  }

  await Promise.all([
    Payment.deleteMany({
      $or: [
        ...(customerIds.length ? [{ customer_id: { $in: customerIds } }] : []),
        ...(orderIds.length ? [{ order_id: { $in: orderIds } }] : []),
      ],
    }),
    CartItem.deleteMany({ customer_id: { $in: customerIds } }),
    WishlistItem.deleteMany({ customer_id: { $in: customerIds } }),
    OtpCode.deleteMany({ phone_number: { $in: otpPhones } }),
    MenuItemOption.deleteMany({
      $or: [
        ...(vendorIds.length ? [{ vendor_id: { $in: vendorIds } }] : []),
        ...(menuItemIds.length ? [{ menu_item_id: { $in: menuItemIds } }] : []),
      ],
    }),
    MenuItem.deleteMany({ vendor_id: { $in: vendorIds } }),
    Withdrawal.deleteMany({ vendor_id: { $in: vendorIds } }),
    Order.deleteMany({ _id: { $in: orderIds } }),
    Customer.deleteMany({ _id: { $in: customerIds } }),
    Vendor.deleteMany({ _id: { $in: vendorIds } }),
  ]);
  console.log('Demo customer and demo vendor records, with their related data, have been deleted.');
}

run()
  .catch((error) => {
    console.error('Demo data cleanup failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
