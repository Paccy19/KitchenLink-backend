# Data retention policy (draft)

**Status: draft, not yet in force.** Nothing below is deleted automatically
yet, except where marked *automatic today*. Confirm the periods with your
accountant (financial records) and a lawyer (personal data) before turning any
cleanup on. Rwanda's data protection law (Law No. 058/2021) expects personal
data to be kept no longer than needed for its purpose.

## What is stored, and for how long

| Data | Where (MongoDB collection) | Today | Proposed |
| --- | --- | --- | --- |
| Sign-in codes | `otpcodes` | *Automatic today:* deleted when expired (5 min) | Keep as is |
| Signed-out sessions, admin idle tracking | `revokedtokens`, `sessionactivities` | *Automatic today:* deleted when the session would have expired | Keep as is |
| Lockouts and daily code counts | `otpguards` | Kept (one small record per phone/email) | Delete records untouched for 30 days |
| Orders, payments, refunds, withdrawals, ledger | `orders`, `payments`, `refunds`, `withdrawals`, `platformwithdrawals`, `transactions` | Kept forever | **Keep 10 years** (accounting and tax evidence; confirm the period with your accountant) |
| Admin audit log | `adminactionlogs` | Kept forever | Keep 10 years (shows who moved money and changed settings) |
| Complaints and support conversations | `complaints` | Kept forever | 3 years after closing |
| Customer–kitchen chats | `chatconversations`, `chatmessages` | Kept forever | 2 years |
| Notifications (in-app) | `notifications` | Kept forever | Read ones: 6 months; unread: 1 year |
| Customer's last GPS position | `customers.last_location` | Kept until replaced | Clear after 30 days without activity |
| Delivery workers' position | `drivers.location` | Kept until replaced | Clear after 30 days offline |
| Menu items and options deleted by kitchens | `menuitems`, `menuitemoptions` (`deleted_at` set) | Kept, hidden | Remove for good after 1 year. Orders keep their own copy of each dish's name and price, so history stays intact |
| Deleted kitchen, driver and admin accounts | `vendors`, `drivers`, `admins` (`deleted_at` set) | Kept, hidden, with personal details | After 2 years, erase personal details (name, phone, email, payout account, photos) but keep the record, so old orders and money records still link to it |
| Kitchens' verification documents | `private-uploads/` + `vendors.verification_documents` | Kept forever | Delete 1 year after the kitchen is deleted or rejected |
| Delivery proof photos | `private-uploads/` + `deliveries.proof_photo_url` | Kept forever | 1 year after delivery (long enough for disputes and refunds) |
| Public photos (menus, kitchens, profiles) | `uploads/` | Removed when replaced or when a dish's image is deleted | Also remove with the item when it is removed for good |

## Open points to decide

1. **Customer data erasure: done.** When a customer asks, an admin uses
   Customers → **Erase data** (typing ERASE to confirm; `POST
   /admin/users/:id/erase`, `customerErasureService`). It removes their name,
   phone, email, photo and location; deletes their chats, notifications, cart
   and wishlist; keeps orders, payments and refunds for the accounts without
   address or payer details (coordinates kept to ~1 km); keeps complaints with
   their name and own messages removed; and is recorded in the audit log
   without personal data. It is refused while an order is in progress or a
   refund is still owed, and cannot be undone. The PostgreSQL mirror is only
   refreshed by `npm run migrate:pg`: run it after erasures so the mirror
   doesn't keep a copy. A self-service "Delete my account" could come later.
2. **Periods.** Confirm the "Proposed" column, especially the 10 years for
   financial records.
3. **Backups.** Deleted data stays in backups until they rotate. Decide how
   long backups are kept (e.g. 35 days) so erasure takes effect within that time.

## When the periods are decided

The cleanup would be one daily job, run by the server like the existing
schedulers (`platformSweepService`, `vendorOfferService`), with each period
adjustable in `.env` and every run summarised in the server log. Financial
records and the audit log are never touched by it. Removing records always
goes with removing their files in `uploads/` and `private-uploads/`.
