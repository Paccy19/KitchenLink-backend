/**
 * Merges copies of the same starting role in one kitchen (e.g. three
 * "Cashier" roles made by older versions of the role setup) into one.
 *
 * - Keeps the newest copy in each group: it has the current default
 *   permissions. Its departments become every copy's departments together.
 * - Moves the employees on the other copies to it, then removes those copies
 *   (soft delete, so they stay in the database).
 * - Only starting roles (same kitchen, template and name) are merged; roles a
 *   kitchen made itself are never touched.
 *
 * Shows what it would do unless --apply is given. With --backup <file> it
 * first writes the affected roles and employees to that file.
 *
 *   npm run fix:duplicate-roles                       # preview
 *   npm run fix:duplicate-roles -- --apply --backup roles-backup.json
 */
const fs = require('fs');
const mongoose = require('mongoose');
const config = require('../config');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const backupAt = args.includes('--backup') ? args[args.indexOf('--backup') + 1] : null;

(async () => {
  await mongoose.connect(config.mongoUri, { autoIndex: false });
  const db = mongoose.connection.db;
  const roles = db.collection('kitchenroles');
  const staff = db.collection('kitchenstaffs');

  const groups = await roles
    .aggregate([
      { $match: { deleted_at: null, template_key: { $ne: null } } },
      { $sort: { created_at: -1, _id: -1 } },
      { $group: { _id: { vendor: '$vendor_id', template: '$template_key', name: '$name' }, copies: { $push: '$$ROOT' } } },
      { $match: { 'copies.1': { $exists: true } } },
    ])
    .toArray();

  if (!groups.length) {
    console.log('No duplicate roles.');
    await mongoose.disconnect();
    return;
  }

  const oldIds = groups.flatMap((g) => g.copies.slice(1).map((c) => c._id));
  const affectedStaff = await staff.find({ role_ids: { $in: oldIds } }).toArray();
  if (backupAt) {
    fs.writeFileSync(backupAt, JSON.stringify({ roles: groups.flatMap((g) => g.copies), staff: affectedStaff }, null, 2));
    console.log(`Backup written to ${backupAt}`);
  }

  for (const { _id: key, copies } of groups) {
    const [keep, ...old] = copies;
    const ids = old.map((c) => c._id);
    const departments = [...new Map(copies.flatMap((c) => c.department_ids || []).map((id) => [String(id), id])).values()];
    const moved = affectedStaff.filter((s) => (s.role_ids || []).some((r) => ids.some((id) => String(id) === String(r))));
    const before = Math.max(...old.map((c) => (c.permissions || []).length));
    console.log(
      `${key.name} (kitchen …${String(key.vendor).slice(-6)}): keep ${keep._id}, remove ${ids.length} cop${ids.length === 1 ? 'y' : 'ies'}; ` +
        `${moved.length} employee${moved.length === 1 ? '' : 's'} moved${moved.length ? `: ${moved.map((s) => s.name).join(', ')} (${before} → ${(keep.permissions || []).length} permissions)` : ''}`
    );
    if (!apply) continue;
    await roles.updateOne(
      { _id: keep._id },
      { $set: { department_ids: departments, departments_auto: copies.some((c) => c.departments_auto) || Boolean(keep.departments_auto) } }
    );
    for (const person of moved) {
      const next = [...new Set((person.role_ids || []).map((r) => (ids.some((id) => String(id) === String(r)) ? String(keep._id) : String(r))))];
      await staff.updateOne({ _id: person._id }, { $set: { role_ids: next.map((id) => new mongoose.Types.ObjectId(id)) } });
    }
    await roles.updateMany({ _id: { $in: ids } }, { $set: { deleted_at: new Date() } });
  }
  console.log(apply ? 'Done.' : 'Preview only. Run again with --apply to merge.');
  await mongoose.disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
