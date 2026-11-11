// An approved kitchen's type only changes when the vendor asks for it: the
// admin can approve or decline that request, but not change the type directly.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, createKitchen } = require('../helpers/testServer');
const adminVendorService = require('../../src/services/adminVendorService');
const vendorProfileService = require('../../src/services/vendorProfileService');
const { Vendor } = require('../../src/models');

before(start);
after(stop);

const typeOf = async (vendor) => (await Vendor.findById(vendor._id)).vendor_type;
const request = async (vendor, vendorType) =>
  vendorProfileService.requestTypeChange(await Vendor.findById(vendor._id), { vendor_type: vendorType, reason: 'We now cook for weddings' });

test('an approved kitchen without a request cannot have its type changed', async () => {
  const { vendor } = await createKitchen({ name: 'Approved Kitchen', verification_status: 'approved' });
  await assert.rejects(adminVendorService.setType(String(vendor._id), { vendor_type: 'caterer' }, null), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'VENDOR_TYPE_LOCKED');
    return true;
  });
  assert.equal(await typeOf(vendor), 'restaurant');
});

test('the admin approves the vendor\'s request, but cannot pick another type', async () => {
  const { vendor } = await createKitchen({ name: 'Wants Caterer', verification_status: 'approved' });
  await request(vendor, 'caterer');

  // A direct change is still refused while the request waits.
  await assert.rejects(adminVendorService.setType(String(vendor._id), { vendor_type: 'bakery' }, null), { code: 'VENDOR_TYPE_LOCKED' });
  assert.equal(await typeOf(vendor), 'restaurant');

  const { vendor: shown } = await adminVendorService.setType(String(vendor._id), { decision: 'approve' }, null);
  assert.equal(shown.vendor_type, 'caterer');
  assert.equal(shown.vendor_type_request, null, 'the request is answered');
  assert.equal(shown.vendor_type_locked, true);
  assert.equal(await typeOf(vendor), 'caterer');
});

test('declining the request keeps the type', async () => {
  const { vendor } = await createKitchen({ name: 'Declined Kitchen', verification_status: 'approved' });
  await request(vendor, 'bakery');
  const { vendor: shown } = await adminVendorService.setType(String(vendor._id), { decision: 'reject' }, null);
  assert.equal(shown.vendor_type, 'restaurant');
  assert.equal(shown.vendor_type_request, null);
});

test('a decision needs a pending request', async () => {
  const { vendor } = await createKitchen({ name: 'No Request', verification_status: 'approved' });
  await assert.rejects(adminVendorService.setType(String(vendor._id), { decision: 'approve' }, null), { code: 'NO_TYPE_REQUEST' });
});

test('a suspended kitchen was approved, so its type stays locked too', async () => {
  const { vendor } = await createKitchen({ name: 'Suspended Kitchen', verification_status: 'suspended' });
  await assert.rejects(adminVendorService.setType(String(vendor._id), { vendor_type: 'caterer' }, null), { code: 'VENDOR_TYPE_LOCKED' });
});

test('while the application is still under review the admin can set the type', async () => {
  for (const status of ['pending', 'rejected']) {
    const { vendor } = await createKitchen({ name: `Applicant ${status}`, verification_status: status });
    const { vendor: shown } = await adminVendorService.setType(String(vendor._id), { vendor_type: 'home_cook' }, null);
    assert.equal(shown.vendor_type, 'home_cook', status);
    assert.equal(shown.vendor_type_locked, false, status);
  }
});
