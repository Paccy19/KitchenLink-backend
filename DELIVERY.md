# Delivery System & Driver Workflow

The delivery leg of every order: from "food ready at the vendor" to "successfully
delivered to the customer", driven by the **Driver Web App**.

## Flow example

```
Customer checks out   →  Order.status = placed
Kitchen accepts       →  confirmed
Kitchen preparing     →  preparing
Vendor taps "Ready"   →  ready
                         └─ Delivery is auto-created (status ready_for_pickup)
                            └─ Dispatch broadcasts to nearby online drivers
Driver accepts        →  delivery = assigned_to_driver (order.rider set)
Driver picks up       →  picked_up
Driver confirms pickup→  out_for_delivery (order.status = out_for_delivery)
Driver at customer    →  delivers, enters OTP from customer
Driver confirm-delivery → delivered → completed
                         └─ order.status = delivered
                            └─ driver earnings credited
```

## Models

- **Driver** — `/drivers`: phone (unique), location (GeoJSON Point), `is_online`,
  `status` (online/offline/busy), `active_deliveries_count`, rating, wallet totals.
  Auth mirrors the vendor: OTP sign-in (`purpose: 'driver'`), JWT role `driver`.
- **Delivery** — `/deliveries`: one per order (`order_id` unique). Stores the
  lifecycle statuses, pickup + delivery points, `route_distance_km` and
  `approved_distance_m` (the road distance charged at checkout),
  `route_monitoring` (see below), `delivery_fee_rwf`, `promised_earnings_rwf`
  (driver share), `dispatch.offers` (broadcast bookkeeping), `otp_code`
  (proof-of-delivery), `status_history`.
- **Order** — extended with `driver_id`, `delivery_id`, `picked_up_at`, `delivered_at`.

## Status machine

`pending → ready_for_pickup → assigned_to_driver → picked_up → out_for_delivery → delivered → completed`
Terminal: `cancelled`, `rejected`. Every transition is guarded by
`config.delivery.transitions` (also returned as `allowed_next_statuses`).

## REST API

### Driver auth (`/api/v1/driver/auth`)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/register` | `{ name, phone, vehicle_type, plate_number }` | create driver (approves immediately) |
| POST | `/send-otp` | `{ phone }` | returns `dev_otp` outside production |
| POST | `/verify-otp` | `{ phone, code }` | returns `token` + `driver` |
| GET | `/me` | — | driver profile (Bearer) |
| POST | `/change-password` | — | requires existing password |

### Driver delivery endpoints (`/api/v1/driver`, all Bearer)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/deliveries/available?lat&lng&radius` | nearby available offers (customer phone hidden) |
| POST | `/deliveries/:id/accept` | atomic claim — first accept wins |
| POST | `/deliveries/:id/reject` | adds driver to `rejected_by`, re-broadcasts |
| PATCH | `/deliveries/:id/status` | `{ status }` ∈ `picked_up / out_for_delivery / delivered` |
| POST | `/deliveries/:id/confirm-delivery` | `{ otp_code, proof_photo_base64? }` → completes + pays driver |
| GET | `/deliveries/active` | current delivery + route info |
| GET | `/deliveries/history` | completed/cancelled deliveries |
| GET | `/deliveries/earnings` | today/all-time earnings + breakdown |
| GET | `/stats` | dashboard counters |
| PATCH | `/location` | `{ latitude, longitude }` — live tracking |
| PATCH | `/availability` | `{ is_online }` — going offline re-assigns in-flight deliveries |

### Internal / system (`/api/v1/internal/deliveries`, header `x-agent-key`)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/:order_id/ready` | vendor marks order ready → create delivery + dispatch |
| POST | `/dispatch` | `{ order_id? | delivery_id? }` force dispatch; empty body re-dispatches all stale offers |

### Customer notifications (`/api/v1/notifications`, all Bearer)

The proof-of-delivery code is delivered to the customer twice:

- When the delivery is created (order marked ready) and again as a reminder
  when the rider sets the delivery **out_for_delivery**.
- Per delivery it is stored as an in-app notification (`type: delivery_code`,
  code in `data.otp_code`) and mirrored over SMS via `utils/sms.js`. With no
  SMS gateway configured the message is logged to the console
  (`sms_status: "skipped"`); set `SMS_*` env vars to enable a real gateway.
- The same code is exposed to the customer on `GET /orders/:id` and
  `GET /orders/:id/track` under `delivery.proof_of_delivery_code` — withheld
  once the delivery is completed/verified (customer sees a null).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | list notifications + `unread_count` |
| POST | `/:notification_id/read` | mark one read |
| POST | `/read-all` | mark all read |

## Dispatch & matching

Triggered automatically when a vendor marks an order **Ready**. Algorithm in
`deliveryService.dispatch`:

1. Load delivery (created on the fly if missing).
2. Find online, available drivers within the notification radius of the pickup
   point via `$geoNear` (set by admins in Settings → Delivery & pickup rules;
   `DELIVERY_RADIUS_KM` is only the starting value).
3. Rank: `distance → active_deliveries_count → rating`.
4. Open an offer window (`DELIVERY_OFFER_TIMEOUT_SECONDS`) on each candidate.
5. First driver to `accept` atomically locks the delivery (`findOneAndUpdate`
   with `driver_id: null` guards the race).

## Edge cases handled

- **Rejection / timeout** → driver added to `rejected_by` (never re-offered);
  `POST /internal/deliveries/dispatch` re-broadcasts stale offers.
- **Driver offline after accept** → `PATCH /driver/availability { is_online: false }`
  hands in-flight deliveries back to the pool and re-dispatches.
- **Customer unreachable** → driver escalates by cancelling via the guarded
  transition (payload-recorded in `status_history`).
- **Mid-transit cancellation** → only allowed by a guarding transition; terminal.

## Standard delivery fee (per meter)

The platform's own delivery fee is set by admins in **Settings → Delivery fee by
distance**, and applies to `fulfillment: 'delivery'` orders only. It does not
cover kitchen-delivered orders (nationwide travel fee), big-event delivery or
pickup. Pricing modes, in order of precedence (`deliveryPricingService`):

1. **Per meter** (when enabled): `fee = base_fee_rwf + road_meters × per_meter_rwf`,
   kept between `min_fee_rwf` (≥ 500 RWF) and `max_fee_rwf` (empty = none).
   Example: 300 + 2,000 m × 1 = 2,300 RWF.
2. Distance ranges, if the admin saved any.
3. The config formula (`DELIVERY_BASE_FEE_RWF + DELIVERY_PER_KM_FEE_RWF × km`).

**Road distance.** `routeDistanceService` measures the route from the kitchen's
saved location to the drop-off point in meters, using Google Routes
(`GOOGLE_MAPS_API_KEY`) and/or OSRM (`OSRM_URL`), as chosen by `ROUTING_PROVIDER`.
Per-meter pricing **never** uses a straight-line estimate. If no routing service
answers, the quote and the checkout return `503 ROUTE_UNAVAILABLE`: the customer
can try again or choose pickup. Real routes are cached for
`GOOGLE_MAPS_CACHE_TTL_SECONDS`, so the price shown at checkout is the price
charged a moment later.

**Server-side and fixed.** The fee is always recalculated on the server at
checkout. Any fee or price the client sends is ignored. The order stores the
approved route and the exact prices used in `Order.delivery_pricing`: mode,
`distance_m`, source, base fee, rate, min/max, fee, pickup and drop-off points,
and `priced_at`. Changing the prices later only affects new orders. The
delivery worker is paid from that stored fee.

**Route deviation monitoring.** While a delivery is `picked_up` or
`out_for_delivery`, each worker GPS update (`PATCH /driver/location`) adds the
distance moved to `Delivery.route_monitoring.tracked_distance_m`. These updates
are ignored:

- fixes with accuracy worse than 100 m
- steps under 15 m (jitter)
- jumps faster than ~150 km/h

A delivery is flagged (`route_monitoring.flagged_at`) when the tracked distance
exceeds the approved distance by the admin's route alert percentage (default
50%) **and** by at least 500 m. A flag is for review only: it never changes the
customer's fee or the worker's earnings.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/vendors/:id/delivery-quote?lat&lng` | quote: `distance_m`, `distance_source`, `delivery_fee_rwf`, `pricing`, `pickup` |
| GET / PUT | `/admin/settings/delivery-fees` | `{ ranges?, per_meter? }`: either part can be saved on its own |
| GET | `/admin/settings/delivery-fees/records?page&limit&flagged=true` | orders with distance, prices used, route monitoring, summary |

## Big-event delivery (platform pricing + special delivery negotiation)

Big-event orders the kitchen delivers (`fulfillment: 'vendor_delivery'` from
`POST /orders/event-checkout`) have their own pricing, separate from the
standard fee above. Kitchens never set it (their old `delivery_fee_ranges`
are ignored); they only choose **where** they deliver.

**Price** (`bigEventDeliveryService`, `utils/bigEventDeliveryPricing.js`):
`fee = starting_fee_rwf + road meters × per_meter_rwf`, at least
`min_fee_rwf`. Defaults: 3,000 RWF + 0.5 RWF/m, automatic ceiling 40,000 RWF.
Admins change them in **Delivery Management** (`/admin/settings/big-event-delivery`,
logged in the audit log). Road distance only — an estimate, or a route that
is implausible for the two points (shorter than the straight line, > 6× it,
> 1,500 km), is never billed.

**Coverage** (`config/deliveryCoverage.js`, vendor dashboard → Delivery
Coverage, `/vendor/delivery-coverage`): `big_event_enabled` plus areas — a
district (`config/rwandaDistricts.js`, nearest-reference-point
approximation) or "within N km" of the kitchen. Checked on the server.
Kitchens with old fee ranges were migrated at start-up to "within their
farthest range" + their district.

The event quote returns `delivery.status`:

| status | when | customer can |
| --- | --- | --- |
| `automatic` | in coverage and fee ≤ ceiling | book; fee is charged |
| `negotiation_required` | outside coverage, fee > ceiling (never cut to the ceiling), no road route, or automatic pricing off | request a special delivery |
| `unavailable` | kitchen doesn't deliver big events | pick up only |

Checkout refuses `negotiation_required` with `409 SPECIAL_DELIVERY_REQUIRED`.

**Special delivery requests** (`SpecialDeliveryRequest`, reference `SD-000124`,
one open request per customer–kitchen pair / per order). States and who may
move them are in `config/specialDelivery.js`; every change goes through
`specialDeliveryTransitions.js` (atomic, logged in `status_history` with
previous/new state, actor, time, reason). The kitchen accepts to negotiate,
asks for information, or declines (reason required). A dedicated chat
(`ChatConversation.special_delivery_request_id`, text / location / photo /
system notes, read receipts) opens on acceptance; it is never listed in the
general chats.

**Quotations** (`DeliveryQuotation`): fee, destination, proposed delivery time,
arrangement (own / rented / third-party / multiple trips / other),
conditions, validity. Never edited: a revision is a new version and the open
one becomes `superseded`; at most one is `submitted`. Expired ones are swept
every 5 minutes. The customer accepts (fee locked in `agreed_fee_rwf`), asks
for another price, or rejects.

**Booking**: `POST /orders/event-checkout` with `special_delivery_request_id`
claims the agreement atomically, uses its venue and locked fee (anything the
client sends is ignored), and records `Order.big_event_delivery` (`mode:
negotiated`, quotation reference) separately from the food. Payment is the
normal deposit/balance flow. Paid → `delivery_confirmed`; order delivered →
`completed`; order cancelled → `customer_cancelled` (history and quotations
kept). Disputes go to admins, who resolve them in Delivery Management.

**Refunds** (`refundService`, same refund queue, payout service and ledger as
cancellations; `Refund.kind` tells them apart, one of each kind per order):

- *While a dispute is open* the kitchen is not paid: `releaseOrder` keeps a
  disputed order's money held, even if the food was handed over.
- *Resolve → cancel the arrangement*: the order is cancelled through the
  normal admin cancellation, so everything paid is refunded (`order_cancelled`).
  Not allowed once the food was delivered.
- *Resolve → completed / delivery still on, with `fee_reduction_rwf`*: the
  order's `delivery_fee_rwf`, `total_rwf` and the kitchen's payout drop by
  that amount (`big_event_delivery.fee_rwf` keeps the agreed price; the change
  is in `big_event_delivery.adjustments`). It comes off an unpaid balance
  first (a balance brought to 0 counts as paid and sends the handover code);
  only what the customer already overpaid is refunded (`delivery_fee_adjustment`,
  at most once per order). Only for a paid order whose money is still held.
  Then the frozen payout is released.
- *A later cancellation* refunds what was paid less what was already refunded,
  so nothing is refunded twice and the platform books stay balanced.

| Method | Path | Notes |
| --- | --- | --- |
| GET/PUT | `/vendor/delivery-coverage` | coverage; sending any price field → 403 |
| GET | `/vendor/delivery-coverage/check?lat&lng` | inside / outside, district |
| POST | `/special-deliveries` | customer request (409 if automatic price applies) |
| GET | `/special-deliveries`, `/special-deliveries/:id` | customer list / detail |
| POST | `/special-deliveries/:id/{cancel,information,dispute}` | customer actions |
| POST | `/special-deliveries/:id/quotations/:qid/{accept,request-revision,reject}` | customer decision |
| GET/POST | `/special-deliveries/:id/messages`, POST `/attachments`, `/read` | chat (both sides, also under `/vendor/…`) |
| POST | `/vendor/special-deliveries/:id/{accept-negotiation,request-information,decline}` | kitchen review |
| POST | `/vendor/special-deliveries/:id/quotations`, `…/quotations/:qid/withdraw` | submit / revise / withdraw |
| GET/PUT | `/admin/settings/big-event-delivery` | pricing (`deliveries:read` / `write`) |
| GET | `/admin/special-deliveries[/:id]` | all negotiations, quotations, chat |
| POST | `/admin/special-deliveries/:id/resolve-dispute` | `{ outcome, resolution, fee_reduction_rwf? }` |

## Env vars (see `.env.example`)

The radius, workers per broadcast, location age, re-offer interval, deliveries
per worker and wrong pickup codes allowed are starting values only: once an
admin saves Settings → Delivery & pickup rules, the saved values are used.

`DELIVERY_OFFER_TIMEOUT_SECONDS`, `DELIVERY_RADIUS_KM`, `DELIVERY_MAX_ACTIVE`,
`DELIVERY_ROAD_FACTOR`, `DELIVERY_BASE_FEE_RWF`, `DELIVERY_PER_KM_FEE_RWF`,
`DELIVERY_MIN_FEE_RWF`, `DELIVERY_DRIVER_SHARE_PERCENT`.

## Try it

```bash
npm run seed:drivers   # creates demo drivers (0788 100 001 … 004)
npm run dev
# Driver app: /driver-login → 0788100001 → OTP is shown as dev_otp in the API response
```