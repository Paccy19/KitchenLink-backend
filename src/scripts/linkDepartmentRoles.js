/**
 * Limits each kitchen's starting roles to their kind of department when the
 * department already exists (the server does it by itself when a department
 * is created): the Chef to the Kitchen, the Baker to the
 * Bakery, the Barista to Coffee, the Bartender to the Bar.
 *
 * Roles whose departments an administrator chose are left alone, as are roles
 * the kitchen made itself. Shows what it would do unless --apply is given.
 *
 *   npm run link:department-roles              # preview
 *   npm run link:department-roles -- --apply
 */
const mongoose = require('mongoose');
const config = require('../config');
const access = require('../config/kitchenAccess');

const apply = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(config.mongoUri, { autoIndex: false });
  const { Department, KitchenRole } = require('../models');
  const departmentService = require('../services/kitchen/departmentService');

  const departments = await Department.find({ deleted_at: null }).sort({ created_at: 1 }).lean();
  let changes = 0;
  for (const department of departments) {
    const keys = Object.entries(access.ROLE_DEPARTMENT_CATEGORIES)
      .filter(([, categories]) => categories.includes(department.category))
      .map(([key]) => key);
    if (!keys.length) continue;
    const roles = await KitchenRole.find({
      vendor_id: department.vendor_id,
      deleted_at: null,
      template_key: { $in: keys },
      department_ids: { $ne: department._id },
      $or: [{ department_ids: { $size: 0 } }, { departments_auto: true }],
    }).lean();
    for (const role of roles) {
      changes += 1;
      console.log(`${role.name} (kitchen …${String(department.vendor_id).slice(-6)}) → ${department.name}`);
    }
    if (apply && roles.length) await departmentService.linkRoles(department.vendor_id, department);
  }
  console.log(changes ? (apply ? `Done: ${changes} role link${changes === 1 ? '' : 's'}.` : 'Preview only. Run again with --apply.') : 'Nothing to link.');
  await mongoose.disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
