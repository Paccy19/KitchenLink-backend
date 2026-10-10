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
  lifecycle statuses, pickup + delivery points, `route_distance_km`
  (haversine × road factor), `delivery_fee_rwf`, `promised_earnings_rwf`
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
2. Find online, available drivers within `DELIVERY_RADIUS_KM` of the pickup
   point via `$geoNear`.
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

## Env vars (see `.env.example`)

`DELIVERY_OFFER_TIMEOUT_SECONDS`, `DELIVERY_RADIUS_KM`, `DELIVERY_MAX_ACTIVE`,
`DELIVERY_ROAD_FACTOR`, `DELIVERY_BASE_FEE_RWF`, `DELIVERY_PER_KM_FEE_RWF`,
`DELIVERY_MIN_FEE_RWF`, `DELIVERY_DRIVER_SHARE_PERCENT`.

## Try it

```bash
npm run seed:drivers   # creates demo drivers (0788 100 001 … 004)
npm run dev
# Driver app: /driver-login → 0788100001 → OTP is shown as dev_otp in the API response
```