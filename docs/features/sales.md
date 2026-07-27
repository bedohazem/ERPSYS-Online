# Sales Management

## Feature Status

- **Implementation:** Completed
- **Final integrated testing:** Pending
- **Production smoke test:** Pending
- **Last implementation commit:** `e9b979bb`

---

## Purpose

The Sales Management feature provides secure and auditable sales processing for:

- Web Admin sales.
- Online POS sales.
- Offline POS pending-sale synchronization.
- Inventory deduction.
- Customer payment recording.
- Cashier shift association.
- Return and exchange eligibility.
- Safe sale voiding.

PostgreSQL remains the only inventory source of truth.

The local Desktop POS database may store offline pending sales, but it does not maintain or deduct authoritative inventory balances.

---

## Supported Workflow

An authorized user can:

1. Select a trusted branch and stock location.
2. Search products by SKU or barcode.
3. Add product variants to the sale.
4. Select an optional customer.
5. Record one or more payment methods.
6. Submit the sale using an idempotency key.
7. Deduct inventory atomically in PostgreSQL.
8. Review sale history.
9. Review sale items and payments.
10. Review original stock movements.
11. Create returns or exchanges from completed sales.
12. Safely void a completed sale when allowed.
13. Review financial and inventory reversal records.

---

## Permissions

| Permission       | Description                                |
| ---------------- | ------------------------------------------ |
| `sales.view`     | View sales and sale details                |
| `sales.create`   | Create new sales                           |
| `sales.discount` | Reserved for controlled discount workflows |
| `sales.void`     | Safely void completed sales                |

The reserved `admin` role bypasses normal permission checks.

Sale records can also be read by users who need the original sale for:

- `returns.create`
- `exchanges.create`

---

## Main Files

### Backend

- `services/api/src/modules/sales/sales.routes.ts`
- `services/api/src/modules/pos-sync/pos-sync.routes.ts`
- `services/api/src/modules/auth/auth.middleware.ts`
- `services/api/src/app.ts`

### Web Admin

- `apps/web-admin/src/pages/NewSalePage.tsx`
- `apps/web-admin/src/pages/SalesPage.tsx`
- `apps/web-admin/src/App.tsx`

### Desktop POS

- `apps/desktop-pos/electron/main.ts`
- Desktop POS renderer and preload files.
- Offline pending-sale SQLite storage.

### Database

- `db/migrations/005_sales_payments.sql`
- `db/migrations/009_multi_tenant_integrity.sql`
- `db/migrations/011_permissions_seed.sql`
- `db/migrations/026_sale_void_reversal.sql`

---

## Database Tables

### `sales`

Stores the sale header:

- Company.
- Branch.
- Stock location.
- Cashier.
- Cashier shift.
- Customer.
- Sale number.
- Source.
- Local POS sale ID.
- Idempotency key.
- Subtotal.
- Discount total.
- Tax total.
- Final total.
- Paid total.
- Change total.
- Status.
- Sale occurrence timestamp.
- Creation timestamp.
- Synchronization timestamp.
- Void reason.
- Void user.
- Void timestamp.

Supported sources:

- `online_pos`
- `offline_pos`
- `web_admin`

Supported statuses:

- `draft`
- `completed`
- `voided`
- `refunded`
- `pending_review`

---

### `sale_items`

Stores every item sold.

Each row contains:

- Sale ID.
- Product variant ID.
- SKU snapshot.
- Barcode snapshot.
- Product name snapshot.
- Size snapshot.
- Color snapshot.
- Quantity.
- Trusted unit price.
- Discount amount.
- Tax amount.
- Final line total.
- Creation timestamp.

Product snapshots preserve the original invoice display even when product information changes later.

---

### `payments`

Stores original sale collections and void reversal refunds.

Supported methods:

- `cash`
- `card`
- `wallet`
- `bank_transfer`
- `mixed`
- `other`

Supported payment roles:

- `sale_collection`
- `void_reversal`

Supported payment directions:

- `received_from_customer`
- `refunded_to_customer`

Original sale payment:

```text
payment_role = sale_collection
payment_direction = received_from_customer
```

Void reversal:

```text
payment_role = void_reversal
payment_direction = refunded_to_customer
```

A reversal references the original payment through:

```text
reverses_payment_id
```

A unique partial index prevents reversing the same payment more than once.

---

### `stock_balances`

Contains the current PostgreSQL inventory quantity for every:

```text
company + stock location + product variant
```

Sales deduct inventory only through the Backend transaction.

The frontend and local Desktop POS database cannot directly update authoritative inventory.

---

### `stock_movements`

Stores:

- Original negative sale movements.
- Positive sale-void reversal movements.

Original sale example:

```text
Quantity before: 10
Sale movement: -2
Quantity after: 8
```

Void reversal example:

```text
Quantity before: 8
Void reversal: +2
Quantity after: 10
```

A reversal references the original movement through:

```text
reversal_of_movement_id
```

The same original movement cannot be reversed more than once.

---

## API Endpoints

### List Sales

```http
GET /api/sales
```

Supported filters:

- Authenticated company.
- Authenticated or selected branch.
- Result limit.

Returns:

- Sale number.
- Branch.
- Stock location.
- Customer.
- Source.
- Shift status.
- Financial totals.
- Sale status.
- Sold quantity.
- Returned or exchanged quantity.
- Remaining returnable quantity.
- Void metadata.

Branch-restricted users only see sales belonging to their branch.

---

### Load Sale Details

```http
GET /api/sales/:saleId
```

Returns:

- Sale header.
- Cashier and shift information.
- Sale items.
- Original payments.
- Payment reversals.
- Original stock movements.
- Stock reversal movements.
- Returnable quantities.
- Void metadata.

The sale ID must be a valid UUID.

The sale must belong to:

- The authenticated company.
- The authenticated branch when the user is branch-restricted.

---

### Create Sale

```http
POST /api/sales
```

Required data:

- Branch.
- Stock location.
- Sale number.
- Idempotency key.
- At least one item.
- At least one payment.

Optional data:

- Customer.
- Shift.
- Local POS sale ID.
- Payment reference.
- Source.

The authenticated tenant middleware replaces untrusted company and branch values.

The authenticated user is used as the cashier for normal authenticated sale creation.

---

### Void Sale

```http
POST /api/sales/:saleId/void
```

Required data:

- Void reason.

Optional data:

- Refund reference.

The operation safely reverses:

- Inventory deduction.
- Customer payment collection.
- Sale status.

The original sale records are never deleted.

---

## Trusted Sale Context

Before creating a sale, the Backend validates:

- Company exists and is active.
- Branch belongs to the company and is active.
- Stock location belongs to the company.
- Branch stock location belongs to the selected branch.
- Customer belongs to the company and is active.
- Cashier belongs to the company and branch.
- Cashier shift is open.
- Cashier shift belongs to the correct cashier.
- Product variants belong to the company and are active.

The Backend does not trust ownership values submitted by the frontend.

---

## Identifier Validation

The Backend validates and normalizes:

- Sale number.
- Idempotency key.
- Product variant IDs.
- Customer ID.
- Cashier ID.
- Shift ID.
- Branch ID.
- Company ID.
- Stock location ID.
- Sale ID used for voiding.

Product variant UUIDs are:

- Trimmed.
- Converted to lowercase.
- Validated before PostgreSQL queries.

The sale number is limited to 120 characters.

The idempotency key is limited to 200 characters.

---

## Duplicate Variant Protection

The same product variant cannot appear more than once inside one sale request.

Rejected example:

```text
Variant A — quantity 1
Variant A — quantity 2
```

The caller must submit:

```text
Variant A — quantity 3
```

This prevents:

- Duplicate sale-item rows.
- Incorrect inventory locking.
- Repeated stock movements.
- Ambiguous line totals.

---

## Deterministic Processing Order

Sale items are sorted by normalized product variant ID before processing.

This provides a stable inventory-lock order and reduces the risk of PostgreSQL deadlocks when concurrent sales contain multiple variants.

---

## Trusted Pricing

Product prices are loaded from PostgreSQL.

The Backend does not trust:

- Client unit price.
- Client line total.
- Client subtotal.
- Client discount total.
- Client tax total.
- Client final total.

Current implementation uses:

```text
Trusted unit price = current product variant selling price
```

Then:

```text
Line total = trusted unit price × quantity
```

Current controlled-sale configuration keeps:

```text
discount total = 0
tax total = 0
```

until the dedicated pricing, taxation and discount authorization workflow is implemented.

---

## Payment Validation

Every submitted payment is validated before saving.

The Backend verifies:

- Payment method is supported.
- Payment amount is finite.
- Rounded payment amount is greater than zero.
- Total payments cover the full sale value.

Credit or underpaid sales are not currently supported.

The sale is rejected when:

```text
paid total < sale total
```

The change value is calculated as:

```text
change total =
paid total - sale total
```

with a minimum of zero.

---

## Sale Creation Inventory Flow

For every sale item:

1. Load the trusted product and price.
2. Lock the relevant inventory balance.
3. Read the current PostgreSQL quantity.
4. Reject insufficient stock.
5. Deduct the sold quantity.
6. Create a negative sale stock movement.
7. Link the movement to the sale.
8. Record the authenticated cashier.

Example:

```text
Current inventory: 7
Sold quantity: 2
Final inventory: 5
Stock movement: -2
```

The following are saved atomically:

- Sale header.
- Sale items.
- Payments.
- Inventory balances.
- Stock movements.

If any step fails, the entire transaction is rolled back.

---

## Insufficient Stock Protection

A sale is rejected when:

```text
available quantity < requested quantity
```

PostgreSQL inventory rows are locked while the sale is processed.

Concurrent sales cannot safely deduct the same final available quantity twice.

The local POS cache is never treated as the final inventory authority.

---

## Idempotency

Every sale contains an idempotency key.

The Backend:

- Trims the key.
- Rejects an empty key.
- Rejects keys longer than 200 characters.
- Searches for an existing sale before creating a new one.
- Restricts duplicate-response retrieval to the same branch.
- Handles concurrent unique-constraint conflicts.
- Returns the previously created sale when the request is a valid duplicate.
- Returns a conflict when the key or sale number belongs to another incompatible request.

Submitting the same valid sale repeatedly must not:

- Create another invoice.
- Deduct inventory again.
- Create duplicate payments.
- Create duplicate stock movements.

The database currently enforces sale number and idempotency uniqueness at company level.

---

## Offline POS Sale Flow

The Desktop POS can continue preparing sales when connectivity is unavailable.

Offline behavior:

1. The cashier opens an authorized shift while online.
2. The POS caches the permitted catalog.
3. The cashier creates a local pending sale.
4. SQLite stores the pending sale document.
5. SQLite does not deduct authoritative inventory.
6. The pending sale keeps its local ID and idempotency identity.
7. When connectivity returns, the sale is synchronized to the Backend.
8. PostgreSQL validates the sale and inventory.
9. PostgreSQL becomes the final saved sale source.
10. The local pending record is marked synchronized or requires review.

Offline sale authorization is tied to:

- Company.
- Branch.
- POS device.
- Cashier.
- Authenticated session.
- Cashier grant.
- Cashier shift.

---

## Cashier Shift Integration

A POS sale may reference an open cashier shift.

The Backend verifies that:

- The shift exists.
- The shift is open.
- The shift belongs to the same company.
- The shift belongs to the same branch.
- The shift belongs to the authenticated cashier.

A sale from a closed cashier shift cannot be voided.

After shift closure, corrections must use the return workflow rather than voiding the original sale.

---

## Shift Cash Calculation

Expected shift cash uses net cash received.

For each active sale:

```text
Net sale cash =
original cash collections
-
change already given to the customer
```

Expected cash also accounts for:

- Cash returns.
- Cash exchange differences.
- Opening cash.

Voided sales are excluded from the active-sale cash calculation.

This prevents customer change from being counted as cash remaining inside the drawer.

---

## Remaining Returnable Quantity

The remaining quantity is calculated using:

```text
sold quantity
-
completed or pending-review return quantities
-
completed or pending-review exchange-return quantities
```

Voided returns and exchanges do not consume returnable quantities.

A voided sale cannot be used to create:

- A new return.
- A new exchange.

---

## Safe Sale Void Conditions

A sale can be voided only when:

- The user owns `sales.void`.
- The sale ID is valid.
- The sale belongs to the authenticated tenant.
- The sale belongs to the authenticated branch when restricted.
- The sale status is `completed`.
- No completed or pending-review return is linked.
- No completed or pending-review exchange is linked.
- The original stock movement history is complete.
- The original payment history is complete.
- No stock reversal already exists.
- No payment reversal already exists.
- A linked POS cashier shift is still open.

---

## Safe Void Inventory Flow

The Backend:

1. Locks the sale header.
2. Loads original sale stock movements.
3. Confirms one movement exists for every sale item.
4. Confirms original movement quantities are negative.
5. Confirms no previous reversals exist.
6. Locks affected stock balances.
7. Creates positive reversal movements.
8. Updates inventory balances.
9. Links every reversal to its original movement.

Example:

```text
Original sale movement: -3
Void reversal movement: +3
```

No original movement is deleted.

---

## Safe Void Financial Flow

The Backend validates:

```text
original payments total = paid total
```

and:

```text
paid total - change total = sale total
```

Only cash payments may absorb customer change.

Example:

```text
Sale total: 90
Customer cash payment: 100
Change already returned: 10
Void refund: 90
```

The void process does not refund the change a second time.

For mixed payments:

- Non-cash payments are reversed at their original collected amount.
- Customer change is deducted only from cash payment records.
- Total void refunds must equal the sale total.

Each reversal:

- Uses the original payment method.
- References the original payment.
- Is stored as a separate payment record.
- May include a refund reference.

---

## Repeated Void Protection

When the sale is already voided:

- Stock is not increased again.
- Payment refunds are not repeated.
- Original records remain unchanged.
- The API returns `alreadyVoided`.

Database unique indexes provide an additional duplicate-reversal safeguard.

---

## Sale Void Audit Log

A successful void writes an audit record with:

```text
action = sale.void
entity_type = sale
```

The record includes:

- Company.
- Branch.
- User.
- Sale ID.
- Previous status.
- Sale total.
- Paid total.
- Change total.
- New status.
- Void reason.
- Refunded total.
- Stock reversal IDs.
- Payment reversal IDs.
- IP address.
- User agent.

---

## Web Admin — New Sale

The New Sale screen supports:

- Branch stock-location selection.
- Product lookup by SKU or barcode.
- Product availability display.
- Quantity entry.
- Duplicate cart-item merging.
- Customer lookup.
- Payment-method selection.
- Paid-amount entry.
- Change calculation.
- Stable draft idempotency key.
- Automatic sale number.
- Submission locking against double clicks.
- Starting a new sale after success.

The stock location cannot be changed after items are added to the cart.

---

## Web Admin — Sale History

The Sale History screen supports:

- Sale list.
- Customer display.
- Branch display.
- Sale totals.
- Change display.
- Sold quantity.
- Returned or exchanged quantity.
- Remaining returnable quantity.
- Sale status.
- Return creation.
- Exchange creation.
- Sale details.
- Financial movement history.
- Inventory movement history.
- Safe void controls.

---

## Web Admin — Safe Void Controls

The void action:

1. Requires `sales.void`.
2. Confirms the sale is completed.
3. Detects linked return or exchange quantities.
4. Detects a closed POS shift.
5. Requests a void reason.
6. Allows an optional refund reference.
7. Displays the amount to refund.
8. Warns that all items will return to inventory.
9. Requires final confirmation.
10. Refreshes the sale list and details after success.
11. Displays original and reversal movements separately.
12. Hides the action after the sale is voided.

---

## Security Controls

- Authentication required.
- Tenant context from authenticated session.
- Company isolation.
- Branch isolation.
- Trusted cashier identity.
- UUID validation.
- Identifier normalization.
- Sale-number length limit.
- Idempotency-key length limit.
- Duplicate variant rejection.
- Deterministic item ordering.
- Trusted PostgreSQL pricing.
- Active product validation.
- Active stock-location validation.
- Active customer validation.
- Payment-method validation.
- Positive rounded-payment validation.
- Full-payment requirement.
- Inventory row locking.
- Insufficient-stock protection.
- Transactional sale creation.
- Idempotent creation.
- Company-level unique invoice numbers.
- Company-level unique idempotency keys.
- Completed-sale-only voiding.
- Return and exchange dependency protection.
- Shift-safe POS voiding.
- Complete stock-history verification.
- Complete payment-history verification.
- Unique stock reversal links.
- Unique payment reversal links.
- Transactional voiding.
- Audit logging.
- No direct frontend database access.
- No authoritative SQLite inventory.

---

## Implementation Checklist

- [x] Sale database model
- [x] Sale permissions
- [x] Web Admin sale creation
- [x] POS sale creation
- [x] Offline pending-sale synchronization
- [x] Tenant and branch validation
- [x] Trusted cashier identity
- [x] Trusted product pricing
- [x] Product variant snapshots
- [x] Duplicate variant protection
- [x] Identifier validation
- [x] Identifier normalization
- [x] Stable item lock ordering
- [x] Payment validation
- [x] Full-payment protection
- [x] Customer change calculation
- [x] PostgreSQL inventory deduction
- [x] Stock movement creation
- [x] Insufficient-stock protection
- [x] Transactional creation
- [x] Idempotent creation
- [x] Concurrent duplicate handling
- [x] Sale history
- [x] Sale details
- [x] Returnable quantity calculation
- [x] Returns integration
- [x] Exchanges integration
- [x] Cashier shift association
- [x] Net cash shift calculation
- [x] Safe void Backend
- [x] Closed-shift void protection
- [x] Stock reversal
- [x] Payment reversal
- [x] Change-safe refund calculation
- [x] Repeated void protection
- [x] Void audit log
- [x] Web Admin void controls
- [x] Financial reversal display
- [x] Inventory reversal display
- [x] Feature documentation
- [ ] Final integrated acceptance test
- [ ] Production smoke test

---

## Final Acceptance Scenarios

### Standard Web Admin Sale

- Create a sale with one item.
- Confirm trusted price is used.
- Confirm inventory decreases.
- Confirm one stock movement is created.
- Confirm payment is recorded.

### Multiple Items

- Create a sale containing several variants.
- Confirm all items are saved.
- Confirm each inventory balance decreases correctly.
- Confirm line totals and invoice total match.

### Duplicate Variant

- Submit the same variant twice.
- Confirm the request is rejected.
- Confirm no partial sale is created.

### Insufficient Stock

- Request more than the available inventory.
- Confirm rejection.
- Confirm no invoice, payment or stock movement is committed.

### Duplicate Submission

- Submit the same idempotency key twice.
- Confirm only one sale exists.
- Confirm inventory is deducted once.

### Concurrent Inventory

- Submit two sales for the same final available quantity.
- Confirm only one request can consume the quantity.

### Cash Payment With Change

- Create a sale with a total below the cash amount received.
- Confirm `change_total` is correct.
- Confirm expected shift cash excludes customer change.

### Mixed Payment Void

- Create a sale using cash and a non-cash payment.
- Void the sale.
- Confirm customer change is deducted from cash only.
- Confirm refund reversals total the sale value.

### Return Dependency

- Create a return from a completed sale.
- Attempt to void the sale.
- Confirm voiding is rejected.
- Void the return.
- Confirm the sale can then be evaluated for voiding.

### Exchange Dependency

- Create an exchange from a completed sale.
- Attempt to void the sale.
- Confirm voiding is rejected.
- Void the exchange.
- Confirm the sale can then be evaluated for voiding.

### Standard Safe Void

- Record inventory before the sale.
- Create the sale.
- Void the sale.
- Confirm inventory returns to its original quantity.
- Confirm the customer refund equals the sale total.
- Confirm original and reversal records remain visible.

### Repeated Void

- Void a completed sale.
- Submit the void request again.
- Confirm no stock or payment reversal is duplicated.

### Open POS Shift Void

- Create a POS sale inside an open shift.
- Void it before closing the shift.
- Confirm it is excluded from shift sale cash.

### Closed POS Shift Void

- Close the cashier shift.
- Attempt to void one of its sales.
- Confirm the API rejects the operation.
- Confirm the return workflow remains available.

### Branch Isolation

- Log in as a branch-restricted user.
- Attempt to open or void another branch’s sale.
- Confirm access is denied or the sale is not found.

### Offline Duplicate Sync

- Synchronize the same pending sale more than once.
- Confirm PostgreSQL creates only one sale.
- Confirm inventory is deducted once.

---

## Completion Definition

Current feature state:

```text
IMPLEMENTATION COMPLETE
```

Remaining work:

- Final integrated acceptance test.
- Production smoke test.
