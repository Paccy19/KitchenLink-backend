# Online Food Kitchen — Backend

Node/Express + MongoDB API for the Online Food Kitchen multi-vendor food
marketplace. This service powers the public discovery API, OTP customer
accounts, cart/checkout/orders, **and the Vendor Dashboard & management API**
(authentication, overview metrics, menu management, order lifecycle).

All prices are in Rwandan francs (RWF) and "today" is computed on Rwanda time
(CAT / UTC+2).

## Requirements

- Node.js 18+
- MongoDB 6+ running locally or a connection string

## Setup

```bash
cd backend
npm install
cp .env.example .env      # then edit as needed
npm run dev               # nodemon, http://localhost:4000/api/v1
# or
npm start
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` disables dev-only OTP echoes. |
| `PORT` | `4000` | HTTP port. |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/online_food_kitchen` | MongoDB connection string. |
| `JWT_SECRET` | `dev-secret-change-me` | **Set a strong secret in production.** |
| `JWT_EXPIRES_IN` | `30d` | Vendor/customer token lifetime. |
| `PUBLIC_BASE_URL` | `http://localhost:4000` | Absolute prefix used for uploaded image URLs. |
| `UPLOAD_DIR` | `uploads` | Local directory for uploaded images. |
| `UPLOAD_MAX_MB` | `5` | Max image upload size. |
| `PLATFORM_COMMISSION_PERCENT` | `0` | Percent withheld from each completed order payout. |
| `TZ_OFFSET_HOURS` | `2` | Offset used for "today" dashboard metrics (Rwanda = 2). |

## Migrations

MongoDB is schemaless, so schema changes apply automatically through Mongoose.
For vendors created before login existed, backfill credentials and wallet
fields:

```bash
npm run migrate:vendors
```

Existing credentials are never overwritten. Vendors without a password are
issued the temporary password `ChangeMe123!` and should rotate it after first
login via `POST /api/v1/vendor/auth/change-password`.

## Vendor API

Base path: `/api/v1/vendor`. All endpoints except `POST /vendor/auth/login`
require a vendor bearer token:

```
Authorization: Bearer <token>
```

### Authentication

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/vendor/auth/register` | Register a vendor (multipart with verification documents). |
| `POST` | `/vendor/auth/login` | Log in with **business/vendor name + phone** (email + password still accepted). |
| `GET` | `/vendor/auth/me` | Current vendor profile. |
| `POST` | `/vendor/auth/change-password` | Rotate password (email-based accounts). |

#### Register

Required fields: business/vendor name, vendor type, owner name, phone,
location, description, food categories, operating hours, payment information
and at least one verification document. New accounts are created with
`verification_status: "pending"` and `is_active: false` so they stay hidden from
customer discovery until an admin approves them; they can still log in and set
up their dashboard.

`multipart/form-data` fields:

| Field | Notes |
| --- | --- |
| `name`, `owner_name`, `vendor_type`, `phone`, `description` | Text. `vendor_type` is one of the supported vendor types. |
| `location` | JSON `{ "latitude": -1.94, "longitude": 30.06, "address": "...", "neighborhood": "..." }` (or flat `latitude`/`longitude`/`address`/`neighborhood`). |
| `food_categories` | JSON array of category ids or names, e.g. `["Main Dishes"]`. |
| `operating_hours` | JSON array `[{ "day":"monday","open_time":"08:00","close_time":"21:00" }]` or object keyed by day. |
| `payment_information` | JSON `{ "payout_method":"mobile_money","account_name":"...","mobile_money_number":"..." }`. |
| `documents` | One or more verification files (images or PDF). |
| `banner_image` | Optional image. |
| `verification_documents` | Optional JSON `[{ "label":"...","url":"..." }]` for pre-hosted docs. |

```bash
curl -X POST http://localhost:4000/api/v1/vendor/auth/register \
  -F "name=Keza Kitchen" -F "owner_name=Keza Mukamana" -F "vendor_type=Home Cook" \
  -F "phone=0788111222" -F "description=Home-style Rwandan meals made fresh daily." \
  -F 'location={"latitude":-1.9441,"longitude":30.0619,"address":"KG 11 Ave","neighborhood":"Kimironko"}' \
  -F 'food_categories=["Main Dishes"]' \
  -F 'operating_hours=[{"day":"monday","open_time":"08:00","close_time":"21:00"}]' \
  -F 'payment_information={"payout_method":"mobile_money","account_name":"Keza","mobile_money_number":"0788111222"}' \
  -F "documents=@/path/to/national-id.pdf"
```

#### Login

```bash
# Business name + phone (primary flow)
curl -X POST http://localhost:4000/api/v1/vendor/auth/login \
  -H "Content-Type: application/json" \
  -d '{"name":"YOUR_VENDOR_NAME","phone":"YOUR_VENDOR_PHONE"}'

# Email + password (accounts created before)
curl -X POST http://localhost:4000/api/v1/vendor/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"YOUR_VENDOR_EMAIL","password":"YOUR_VENDOR_PASSWORD"}'
```

### Dashboard

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/vendor/dashboard` | Today's orders, pending, completed, today's sales, total sales, available balance. |

```bash
curl http://localhost:4000/api/v1/vendor/dashboard -H "Authorization: Bearer $TOKEN"
```

```json
{
  "today_orders": 12,
  "pending_orders": 3,
  "completed_orders": 9,
  "today_sales_rwf": 145000,
  "total_sales_rwf": 2345000,
  "available_balance_rwf": 1870000
}
```

### Menu management

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/vendor/menu` | List items with options. Supports `category_id`, `is_available`, `q`, `sort`, `page`, `limit`. |
| `POST` | `/vendor/menu` | Create an item. `multipart/form-data` (with `image` file) or JSON. |
| `PUT` | `/vendor/menu/{item_id}` | Edit an item. Providing `options` replaces all options. |
| `DELETE` | `/vendor/menu/{item_id}` | Soft delete (`?hard=true` for permanent). |
| `PATCH` | `/vendor/menu/{item_id}/availability` | Toggle/set `is_available`. |
| `POST` | `/vendor/menu/upload-image` | Upload an image, returns `{ "image_url": "..." }`. |
| `GET` | `/vendor/menu/categories` | Categories for the item form picker. |

Create with JSON (options as an array):

```bash
curl -X POST http://localhost:4000/api/v1/vendor/menu \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Isombe with Beef",
    "price_rwf": 6500,
    "preparation_time_minutes": 25,
    "is_available": true,
    "options": [
      { "group_name": "Size", "name": "Large", "additional_price_rwf": 1500 }
    ]
  }'
```

Create with an image (`multipart/form-data`; `options` is a JSON string):

```bash
curl -X POST http://localhost:4000/api/v1/vendor/menu \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=Brochettes" -F "price_rwf=5000" -F "preparation_time_minutes=18" \
  -F 'options=[{"name":"Hot","additional_price_rwf":300}]' \
  -F "image=@/path/to/brochettes.jpg"
```

Images can also be sent inline as a base64 data URI in the `image_base64`
field, or as an external `image_url`. Allowed types: `image/jpeg`, `image/png`,
`image/webp`, `image/gif`.

### Order management

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/vendor/orders?status={status}` | List orders (`new`, `accepted`, `preparing`, `ready`, `completed`, `cancelled`). Supports `sort`, `page`, `limit`. |
| `GET` | `/vendor/orders/{order_id}` | Order detail with items, options and customer. |
| `PATCH` | `/vendor/orders/{order_id}/status` | Advance the order status (validated). |

```bash
curl -X PATCH http://localhost:4000/api/v1/vendor/orders/$ORDER_ID/status \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"accepted","note":"Kitchen accepted"}'
```

#### Status transitions

| From | Allowed next |
| --- | --- |
| `new` | `accepted`, `cancelled` |
| `accepted` | `preparing`, `cancelled` |
| `preparing` | `ready`, `cancelled` |
| `ready` | `completed`, `cancelled` |
| `completed` | — (terminal) |
| `cancelled` | — (terminal) |

Any other transition returns `409 INVALID_STATUS_TRANSITION`. Each response
includes `allowed_next_statuses` so the UI can render only valid actions.

When an order moves to `completed`, the backend sets `completed_at`, settles
cash-on-delivery payments, increments each item's `orders_count`, and credits
the vendor's `total_sales` (and `available_balance`, net of
`PLATFORM_COMMISSION_PERCENT`). Completion is idempotent because `completed`
is a terminal state.

> The vendor lifecycle is a translation layer over the shared customer order
> statuses (`new→placed`, `accepted→confirmed`, `completed→delivered`), so a
> vendor order is the same record the customer tracks — no data duplication.

## Conventions

- **Response shape:** plain JSON objects on success; errors use
  `{ "error": { "code": "...", "message": "...", "details": {...} } }`.
- **Pagination:** list endpoints return `{ items|orders, meta: { limit, page, offset, total, ... } }`.
- **Validation:** invalid input returns `400 VALIDATION_ERROR` with field-level
  `details`.
- **Soft delete:** menu items and vendors use a `deleted_at` marker; deleted
  records are excluded from all reads.

## Data model

- **Vendor** — name, `vendor_type` (Home Cook, Restaurant, Café, Bakery,
  Caterer, Food Truck, Chef, Meal-prep business, Juice/Drinks vendor, Other
  food business), email/phone/`password_hash`, GeoJSON `location`,
  rating, `estimated_prep_time`, `is_active`, `banner_image_url`,
  `delivery_available`, `available_balance`, `total_sales`, `deleted_at`.
- **MenuItem** — `vendor_id`, optional `category_id`, name, description,
  `price_rwf`, `preparation_time_minutes`, `is_available`, `image_url`,
  `deleted_at`.
- **MenuItemOption** — `menu_item_id`, `group_name`, name,
  `additional_price_rwf`, `is_available`, `sort_order` (e.g. size/extras).
- **Order** — `vendor_id`, `customer_id`, mapped `status`, `total_rwf`,
  `items[]` (each with selected `options[]`, quantity and price at order time),
  `completed_at`, `cancelled_at`, `status_history`.
- **Customer** — OTP-authenticated customer account.

## Testing

There is no automated suite yet. The fastest verification path:

1. Ensure MongoDB is running and start the backend:

   ```bash
   npm run dev
   ```

2. Register a vendor through the frontend or vendor registration API, then log
   in using that account and capture a token:

   ```bash
   TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/vendor/auth/login \
     -H "Content-Type: application/json" \
     -d '{"name":"YOUR_VENDOR_NAME","phone":"YOUR_VENDOR_PHONE"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")
   ```

3. Exercise the API:

   ```bash
   curl -s http://localhost:4000/api/v1/vendor/dashboard -H "Authorization: Bearer $TOKEN"
   curl -s http://localhost:4000/api/v1/vendor/menu -H "Authorization: Bearer $TOKEN"
   curl -s "http://localhost:4000/api/v1/vendor/orders?status=new" -H "Authorization: Bearer $TOKEN"
   ```

4. Check boundaries: a request without a token returns `401`, a customer token
   returns `403`, and `new → completed` returns `409`.
