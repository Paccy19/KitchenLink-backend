# Kitchen operations

How a kitchen runs in house: departments, staff and permissions, department
tickets, table QR ordering, the server board, invoices, stock and reports.
The kitchen (`Vendor`) stays the parent of everything; none of this is
required, and a kitchen that sets nothing up works exactly as before.

Code: `src/services/kitchen/`, `src/routes/kitchenRoutes.js`,
`src/routes/tableRoutes.js`, `src/config/kitchenAccess.js`. Endpoints:
`../KitchenLink-frontend/API_CONTRACT.md` ("Kitchen operations" and "/tables").
Tests: `test/api/kitchenOperations.test.js`, `test/unit/kitchenReports.test.js`.

## Who is signed in

- **The kitchen account** (the owner who registered it) can do everything.
- **Employees** (`KitchenStaff`) belong to one kitchen. The kitchen
  administrator creates the account and hands over a username and password
  (typed, or made by the server and shown once; only a bcrypt hash is kept).
  Employees sign in with `POST /vendor/auth/staff-login` (username, phone or
  email + password; failures count towards a lockout), or, if they have a
  phone or email, with the normal kitchen code (`/vendor/auth/*`,
  `/auth/login/*`). New credentials sign the employee out everywhere; they
  can change their own password. Their token is a kitchen token with `staff_id`.
- `requireVendorAuth` loads the employee on every request (removed or
  deactivated → 401 at once) and builds `req.kitchenAccess`
  (`services/kitchen/accessService.js`). Employee sessions are revoked on the
  employee's own record, so "sign out everywhere" never signs the owner out.
- A phone or email signs in to one kitchen only (unique index over current
  staff, checked against kitchen accounts and delivery workers too).

## Permissions

- The catalogue is `config/kitchenAccess.js` (groups, labels, default roles).
- A role (`KitchenRole`) is a named set of permissions, optionally limited to
  departments. An employee holds the union of their roles.
- **Department scope.** Permissions marked `scoped` (queues, menu, stock,
  department reports, department settings) cover the role's departments, or
  else the employee's own departments, or else the whole kitchen. A
  department's managers also get `DEPARTMENT_MANAGER_PERMISSIONS` there.
- **Kitchen administrators**: the kitchen account and staff with `is_admin`.
  Only they get `account.wallet` and `account.settings`, which no role can
  hold. Nobody changes their own roles or administrator flag, and nobody
  grants permissions they don't hold. The kitchen account can't be removed,
  so a kitchen always keeps an administrator.
- **Enforcement** is on the server, twice: `requireKitchenPermission(...)` on
  every route (including the old `/vendor/*` routes: wallet, notifications,
  messages, settings, menu, orders), then `kitchen.assert(permission,
  departmentId)` in the service once the ticket, dish or stock item is known.
  Role changes apply on the next request (access is built per request).

## Departments and tickets

- `Department` belongs to a kitchen: category (suggested list or custom),
  ticket prefix, stations, operating hours, managers, and a workflow: whether
  it uses the `accepted` and `preparing` stages, and its own names for them
  ("Baking", "Ready for collection"). Stages keep fixed meanings
  (`pending → accepted → preparing → ready`) so an order's status can be
  worked out from its tickets.
- `MenuItem.department_id` says who prepares a dish (null = the kitchen).
  Dishes of a switched-off department leave the public menu.
- **Every order is split at creation** (`ticketService.buildTickets`): one
  ticket per department in `Order.tickets`, and each line gets
  `department_id`, `ticket_id` and a `service_status`. Dishes without a
  department, and big-event plates, go to the kitchen's own ticket. Older
  orders get their ticket the first time it is needed.
- **Why tickets live inside the Order.** MongoDB here runs standalone (no
  transactions). Inside one document, creating an order with its tickets,
  and every ticket change, is a single atomic write: no half-made orders and
  no tickets without a parent.
- **Parent status.** Moving a ticket (`advance`) uses a compare-and-set on
  the ticket's current stage, then `syncParent` moves the order forward one
  step at a time through `vendorOrderService.applyStatus` (so the existing
  notifications, pickup codes and delivery dispatch run unchanged): any
  accepted → confirmed, any preparing → preparing, all ready → ready.
  `applyStatus` itself only changes an order from the status it read, so two
  departments finishing together move it once; `syncParent` re-reads and
  retries. The owner moving the whole order in Orders still works: tickets
  that are behind catch up (`cascadeFromOrder`), and cancelling cancels them.
- **Preparation and service are separate.** Ticket stages track preparation;
  `items[].service_status` tracks what happens after
  (`waiting_collection → collected → served / handed_over`).

## Ordering

- **Dine-in (table QR).** `DiningTable` has a random 128-bit `token`; its QR
  code (`/vendor/tables/:id/qr`, made with `qrcode`) opens
  `FRONTEND_URL/menu/<token>`. The token identifies the kitchen and table;
  a deactivated, removed or replaced table stops working. Guests order
  without an account (`fulfillment: 'dine_in'`, `payment_method:
  'in_person'`, `source: 'table_qr'`); the server prices every line. A
  random guest key (only its hash is stored) lets the browser follow the
  order; it travels in the `X-Guest-Key` header, never the URL.
- **Takeaway and delivery** are the existing app checkout (`pickup`,
  `delivery`), now split into tickets too. Delivery orders leave the counter
  only when every department is done; others follow
  `operations.allow_partial_service`.
- **Servers** use `/vendor/service/board`: every order on the floor with its
  destination (table, takeaway, delivery address), each department's
  progress and what waits at the counter. Serving everything of a dine-in
  order completes it (no platform settlement: the money is the kitchen's).

## Invoices and payments

- `Invoice` is created automatically: a table's dine-in orders join its open
  bill (one consolidated invoice across departments; a unique index allows
  one open bill per table); an app order gets its own when paid, already
  paid online. Lines keep their department for reporting.
- Cashiers record full or partial payments (`cash`, `mobile_money`, `card`,
  `other`), atomically never above the balance; totals and status are
  recomputed in one pipeline update. Paid in full → the table's dine-in
  orders become paid and the bill closes. Refunds are for money taken in
  person; app orders are refunded through the existing order cancellation.
- **When dine-in guests pay** (`operations.payment_timing`) maps to one gate,
  fixed on each order when it is placed (`payment_gate`): `preparation`
  (tickets can't start), `collection` (items can't leave the counter) or
  `none` (settled at the end).
- Dine-in sales carry no platform commission and never touch the ledger.

## Menu photos

Besides dishes added one by one (which customers order), a kitchen can add
up to 12 photos of its own printed menu (`Vendor.menu_photos`,
`/vendor/menu/photos`). Customers see them on the kitchen page and at the
table; they're for reading, not ordering.

## Stock

`InventoryItem` (kitchen-wide or per department), `StockMovement` (every
change, never edited), `Supplier`. With `operations.inventory_auto_deduct`
on, marking a ticket ready deducts each dish's `MenuItem.recipe` once per
ticket (`stock_deducted_at`). Crossing the low-stock level notifies the
kitchen once until restocked.

## Reports

`reportService.build` covers one period in Rwanda time: sales (by
fulfilment, source, hour, over time), departments (sales, items, prep time),
products, tables, payments, refunds, outstanding bills, staff, stock and
cancellations, compared with the previous period, with plain-language
`highlights`. Department managers get their departments only, without the
kitchen-wide money sections. A scheduler (`reportService.start`, every 30
minutes) saves the report of each day, week, month and year that ended
(`KitchenReport`) and notifies the kitchen for weekly and longer ones. CSV
export neutralises cells that start like spreadsheet formulas.

## Activity log

`KitchenActivity` records who (owner, employee, guest, system) did what:
departments, roles, staff and access changes, tables and QR codes, tickets,
collection and serving, invoices, payments and refunds, stock.

## The full permission list

`config/kitchenAccess.js` holds 242 permissions in 20 groups (Overview,
Settings, Staff, Roles, Departments, Menu, Orders, Preparation, Tables,
Service, Cashier, Finance, Inventory, Delivery, Customers, Reservations,
Promotions, Notifications, Reports, Audit). Every one is enforced. Handing
out access — creating or editing roles, choosing a role's permissions,
giving roles to employees, choosing department managers and administrators —
and the wallet are kitchen-administrator only (`A` flag): they show in the
list but can't be put in a role.

## More kitchen tools

- **Orders** (`orderOpsService`): priority, who looks after it, adding and
  removing items and changing quantities (bills paid in person, before
  payment: app orders were charged online), moving items between
  departments, moving orders between tables (the bill lines follow),
  reopening, the full history, claiming collection tasks, and the kitchen's
  own couriers for orders it delivers itself.
- **Tickets**: pause/resume, cancel one department's part (in-person bills),
  give a ticket to an employee. Queues put urgent orders first.
- **Bills**: merge tables, split a bill, cancel an unpaid bill, discount
  codes, a customer on the bill (standing discount, loyalty points), points
  spent as a discount.
- **Guests at the table** ask for the waiter or the bill
  (`ServiceRequest`) and rate their order (`Feedback`; public ones are
  reviews on the kitchen page, the kitchen can reply).
- **Cashier tills** (`CashierSession`): opening float, then counted cash
  against float + cash taken − cash refunded; cashier reports.
- **Finance**: expenses (`Expense`, also recorded when a purchase order is
  received), profit and loss, every money movement.
- **Stock**: categories and kinds, transfers between departments, purchase
  orders (`PurchaseOrder`) received into stock.
- **Customers** (`KitchenCustomer`), loyalty settings, messages to app
  customers (3 a day).
- **Reservations** (`Reservation`): no double booking, free-table search,
  seating, longer stays, active dining sessions.
- **Promotions** (`Promotion`): codes the cashier applies and automatic
  campaigns, on the whole bill, some products or some departments, on table
  bills (app prices stay as they are).
- **Team inbox** (`StaffNotification`): messages to everyone, roles,
  departments or people, and automatic alerts (new and urgent orders, ready
  items, low stock, guest requests, reservations, failed sign-ins, late
  clock-ins), switchable per kitchen and mutable per person.
- **Team**: invitations by SMS/email, shift schedules (`StaffShift`),
  clocking in and out (`StaffAttendance`), signing an employee out
  everywhere, sign-in history and security events in the activity log.
- **Menu categories** a kitchen created can be renamed or deleted by it,
  while no other kitchen uses them.

## Known limits

- The Flutter app (`KitchenLink-Mobile`) does not have these screens yet.
- There are no sockets: dashboards poll (`/vendor/workspace` carries the
  badge counts), as everywhere else in KitchenLink.
- One username, phone or email signs in to one kitchen only.
- Staff can't yet enter orders for walk-in customers from scratch (a POS screen); they can add to and edit table orders.
- Department operating hours are stored but don't yet stop ordering.
