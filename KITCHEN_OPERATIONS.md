# Kitchen operations

How a kitchen runs in house: departments, staff and permissions, department
tickets, table QR ordering, the server board, invoices, stock and reports.
The kitchen (`Vendor`) stays the parent of everything; none of this is
required, and a kitchen that sets nothing up works exactly as before.

Code: `src/services/kitchen/`, `src/routes/kitchenRoutes.js`,
`src/routes/tableRoutes.js`, `src/config/kitchenAccess.js`. Endpoints:
`../KitchenLink-frontend/API_CONTRACT.md` ("Kitchen operations" and "/tables").
Tests: `test/api/kitchenOperations.test.js`, `test/api/kitchenFeatures.test.js`,
`test/api/restaurantFlow.test.js` (the floor, packing, deliveries, reservations,
security), `test/unit/kitchenReports.test.js`.

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
- **Every permission works on its own.** `test/api/everyPermission.test.js`
  gives an employee one permission at a time and calls every route that
  accepts it, with real records: a 403 fails the test. It also checks that
  every permission is used somewhere, and that the default roles (stock
  manager, chef, cashier, order desk...) do their jobs end to end.
- **The website follows the routes.** `config/routeAccess.js` reads what each
  route accepts from its `requireKitchenPermission(...)` and serves it in
  `GET /vendor/permissions` (`routes`), so a button shows exactly when the
  server would allow it.
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

## Preparation time

Each dish has its own preparation time (`MenuItem.preparation_time_minutes`).
An order takes as long as its slowest dish (departments cook in parallel):
`Order.prep_minutes`, set when it is placed (`utils/prepTime.js`). The
kitchen's `estimated_prep_time` is only the default for dishes without one;
kitchen pages don't show a kitchen-wide time any more.

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

## The floor: table visits

- **`TableSession`** is one visit at a table, from seating to closing:
  guests, server, every order placed at the table, and the one bill
  (`Invoice.session_id`). A unique partial index allows one live visit per
  table (`is_live`), so two hosts can't seat the same table.
- A visit starts when the **host seats** guests (`POST /vendor/table-sessions`:
  a walk-in, someone from the **waiting list** `WaitlistEntry`, or a
  reservation), or with the **first QR order** when nobody seated them
  (`sessionService.liveForTable`, race-safe through the same index).
  Seating refuses a table in use, switched off, too small or booked within
  the hour unless the host confirms (`allow_over_capacity`,
  `ignore_reservation`).
- Status is worked out from what's in it: `open` (nothing ordered),
  `active`, `awaiting_payment` (everything served, money due), `closed`.
- **Servers** (`service.order_for_guests`) take orders for the table through
  the same code as QR orders (`tableOrderService.createDineInOrder`): priced
  on the server, split into tickets, on the visit's bill. A server who only
  has `service.view_assigned` sees and orders for their own tables only.
- **Moving guests** (`tables.transfer_sessions`) moves the visit, its open
  orders and its bill to a free table; merging tables merges the visits.
- **Closing** follows `operations.session_close` (orders finished, bill paid,
  packing handed over, optionally no open guest requests). What blocks it is
  returned as `blockers`. A manager with `tables.session_override` can close
  anyway with a reason, kept in `close_exceptions` and the activity log; an
  unpaid bill then stays outstanding, never marked paid.

## Packing, takeaway and leftovers

`PackingTask` (`packingService`) keeps three things apart:

- **Leftovers** of a dine-in order: the guest's own food, already on the bill.
  Packing them never adds a charge.
- **Takeaway from a dine-in order**: items the guest takes instead of eating
  in (`POST /vendor/orders/:id/takeaway`: same items, same bill), or new items
  ordered "to take away" (`takeaway: true` on a line: a normal, billed item).
  Servers can't "serve" them; the packing station hands them over
  (`service_status: handed_over`), which completes the order with the rest.
- **Delivery and pickup orders**, when `operations.require_packing` is on:
  marking the order ready creates the task instead of dispatching; packing it
  dispatches the KitchenLink delivery, and a kitchen courier can only collect
  a packed order.

## Problems on a ticket

A department flags its ticket (`kitchen.flag_issues`): running late, an item
it can't make (the item is marked `unavailable`, stays on the bill until the
server changes the order with the guests), or it needs help. The table's
server and the floor are alerted; anyone serving can mark it sorted out.

## The kitchen's own deliveries

For orders the kitchen delivers itself (`vendor_delivery`), a coordinator
gives each to a courier (`/vendor/deliveries` is their board: what is
packed, who is out, failed attempts). A **kitchen driver** (`delivery.drive`)
sees only their own deliveries, with the address and items but no money, and
moves them along: `assigned → acknowledged → collected → in_transit`, with
`failed` / `customer_unavailable` (a note is required; each is an attempt)
and `returned`. Only the customer's code completes a delivery, which the
courier may enter for their own order; nothing marks it paid on the way.
Customers see the courier's name and progress on their tracking page.

## Reservations

`reservationService` runs a booking from start to end:
`pending` (asked online) → `confirmed` → `arrived` → `seated` → `completed`,
or `rejected`, `cancelled`, `no_show`. Every step changes the booking only
from the status it was read in, and each booking says what can come next
(`allowed_next_statuses`).

- **No double booking**: a table is held by bookings that overlap, with the
  kitchen's buffer before and after (`operations.reservations.buffer_minutes`).
- **Online booking** (`/bookings`, public): the kitchen's opening hours, real
  free tables, the largest party it takes online; held as `pending` when the
  kitchen confirms bookings itself. The guest gets a private token (only its
  hash is kept) to view or cancel, sent in a header.
- **Deposits**: recorded when taken (`reservations.deposits`), counted on the
  visit's bill when the guests are seated, as payments arrive (payment method
  `deposit`, never more than is due, claimed on the booking first so it is
  used once). Cancelled within `refund_deposit_hours` of the time → kept
  (`forfeited`), earlier → to give back (`refunded`); a no-show follows
  `keep_deposit_on_no_show`. The money itself is handed over at the till.
- **Pre-orders** are dishes chosen with the booking. They are sent to the
  kitchen only when the guests are seated, as one order on their bill; a
  dish that went off the menu is reported to the server instead.
- **Reminders**: a scheduler (`reservationService.start`, every 5 minutes)
  tells the floor who is arriving soon and reminds signed-in guests, once.

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
`highlights`, and `operations`: table visits and how much each table was
used, reservations by status with attendance and deposits, how long ready
food waited to be served, packing, and the kitchen's own deliveries.
Department managers get their departments only, without the
kitchen-wide money sections. A scheduler (`reportService.start`, every 30
minutes) saves the report of each day, week, month and year that ended
(`KitchenReport`) and notifies the kitchen for weekly and longer ones. CSV
export neutralises cells that start like spreadsheet formulas.

## Activity log

`KitchenActivity` records who (owner, employee, guest, system) did what:
departments, roles, staff and access changes, tables and QR codes, tickets,
collection and serving, invoices, payments and refunds, stock.

## The full permission list

`config/kitchenAccess.js` holds 259 permissions in 21 groups (Overview,
Settings, Staff, Roles, Departments, Menu, Orders, Preparation, Tables,
Service, Packing, Cashier, Finance, Inventory, Delivery, Customers,
Reservations, Promotions, Notifications, Reports, Audit). Default roles
include Host / Receptionist, Server, Service supervisor, Packing staff,
Delivery coordinator and Kitchen driver. Every one is enforced. Handing
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
- Servers order for guests seated at a table; there is no separate counter
  POS for walk-in takeaway customers without a table.
- Deposits are recorded, not collected online: the kitchen takes and returns
  the money itself.
- Department operating hours are stored but don't yet stop ordering.
