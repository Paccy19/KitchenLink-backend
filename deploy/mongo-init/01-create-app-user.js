// Runs ONCE, automatically, when the mongo container starts with an EMPTY
// data volume (official image behaviour). It never runs again and never
// touches existing data.
//
// Creates the application's own user with access to the KitchenLink database
// only (the root user stays for backups/administration). Values come from
// deploy/.env via docker-compose.prod.yml.
const dbName = process.env.MONGO_APP_DB || 'online_food_kitchen';
const user = process.env.MONGO_APP_USER || 'kitchenlink';
const pwd = process.env.MONGO_APP_PASSWORD;

if (!pwd) {
  throw new Error('MONGO_APP_PASSWORD is not set: cannot create the application user');
}

const appDb = db.getSiblingDB(dbName);
if (appDb.getUser(user)) {
  print(`[init] MongoDB user "${user}" already exists on ${dbName}`);
} else {
  appDb.createUser({ user, pwd, roles: [{ role: 'readWrite', db: dbName }] });
  print(`[init] Created MongoDB user "${user}" (readWrite on ${dbName})`);
}
