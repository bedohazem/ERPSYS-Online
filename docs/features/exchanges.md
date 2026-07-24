# Exchange Management

## Feature Status

- **Implementation:** Completed
- **Final integrated testing:** Pending
- **Production smoke test:** Pending
- **Last implementation commit:** `f02e1c38`

---

## Purpose

The Exchange Management feature supports exchanging products from a completed sale while preserving:

- Inventory accuracy.
- Original sale history.
- Financial settlement history.
- Tenant and branch isolation.
- Complete auditability.
- Safe reversal when an exchange is voided.

PostgreSQL remains the only inventory source of truth.

---

## Supported Workflow

An authorized user can:

1. Select a completed sale.
2. View quantities still available for return or exchange.
3. Select items returned by the customer.
4. Search for replacement variants.
5. Select replacement quantities.
6. Calculate returned and issued totals.
7. Collect or refund the difference.
8. Save the exchange in one PostgreSQL transaction.
9. Review the exchange later.
10. Void the exchange safely when permitted.

---

## Permissions

| Permission         | Description                     |
| ------------------ | ------------------------------- |
| `exchanges.view`   | View exchange list and details  |
| `exchanges.create` | Create exchange operations      |
| `exchanges.void`   | Void completed exchanges safely |

The reserved `admin` role bypasses normal permission checks.

Users with `exchanges.create` may read the sales and catalog data required to prepare an exchange.

Users with `exchanges.void` may read exchange records before voiding them.

---

## Main Files

### Backend

- `services/api/src/modules/exchanges/exchanges.routes.ts`
- `services/api/src/modules/auth/auth.middleware.ts`
- `services/api/src/app.ts`

### Web Admin

- `apps/web-admin/src/pages/NewExchangePage.tsx`
- `apps/web-admin/src/pages/ExchangesPage.tsx`
- `apps/web-admin/src/pages/SalesPage.tsx`
- `apps/web-admin/src/App.tsx`

### Database

- `db/migrations/023_exchange_permissions.sql`
- `db/migrations/024_exchange_void_reversal.sql`

---

## Main Database Tables

### `exchanges`

Stores:

- Company and branch.
- Stock location.
- Customer.
- Original sale.
- Exchange number.
- Returned total.
- Issued total.
- Difference total.
- Amount paid by customer.
- Amount refunded to customer.
- Status.
- Creation user.
- Void reason.
- Void user.
- Void timestamp.

### `exchange_return_items`

Stores products returned by the customer and links each row to its original sale item.

### `exchange_issue_items`

Stores replacement products issued to the customer.

Product details are saved as snapshots:

- Product name.
- SKU.
- Barcode.
- Size.
- Color.
- Quantity.
- Unit price.
- Line total.

### `exchange_payments`

Stores exchange difference settlements.

Supported directions:

- `paid_by_customer`
- `refunded_to_customer`

Supported roles:

- `settlement`
- `void_reversal`

A reversal payment references the original payment through `reverses_payment_id`.

### `stock_movements`

Stores original exchange inventory movements and their reversal movements.

A reversal movement references its original movement through `reversal_of_movement_id`.

---

## API Endpoints

### Load Original Sale

`GET /api/exchanges/original-sale/:saleId`

Returns:

- Completed sale information.
- Original sale items.
- Previously returned or exchanged quantities.
- Remaining exchangeable quantities.

The API rejects:

- Invalid sale IDs.
- Non-completed sales.
- Sales belonging to another restricted branch.

---

### Search Replacement Products

`GET /api/exchanges/lookup-item?query=VALUE`

Searches by:

- SKU.
- Barcode.
- Product name.

Only active products and active variants are returned.

---

### List Exchanges

`GET /api/exchanges`

Supported filters:

- Branch.
- Status.
- Result limit.

Supported statuses:

- `draft`
- `completed`
- `pending_review`
- `voided`

---

### Load Exchange Details

`GET /api/exchanges/:exchangeId`

Returns:

- Exchange header.
- Returned items.
- Issued items.
- Settlement payments.
- Payment reversals.
- Original stock movements.
- Stock reversal movements.
- Void metadata.

---

### Create Exchange

`POST /api/exchanges`

Required data:

- Original sale ID.
- Idempotency key.
- Returned items.
- Issued items.
- Difference payment when required.

Optional data:

- Exchange reason.
- Payment reference.

The Backend recalculates all prices and totals from PostgreSQL.

Client-supplied product prices are never trusted.

The difference is calculated as:

`issued total - returned total`

When the result is positive, the customer pays.

When the result is negative, the customer receives a refund.

When the result is zero, no exchange payment is created.

---

### Void Exchange

`POST /api/exchanges/:exchangeId/void`

Required data:

- Void reason.

Optional data:

- Reversal payment reference.

Only completed exchanges can be voided.

The operation is performed inside one PostgreSQL transaction.

---

## Exchange Creation Inventory Flow

For a returned customer item:

- Inventory quantity increases.
- Stock movement quantity is positive.

For a replacement item issued to the customer:

- Inventory quantity decreases.
- Stock movement quantity is negative.

Before saving, the Backend:

1. Locks affected stock balances.
2. Includes returned quantities in available stock.
3. Calculates final inventory for every variant.
4. Rejects the operation if any final balance is negative.
5. Saves the exchange, payments and inventory movements atomically.

---

## Remaining Quantity Protection

The original sold quantity is considered consumed when used in:

- A completed return.
- A pending-review return.
- A completed exchange.
- A pending-review exchange.

Voided returns and voided exchanges do not consume the original sale quantity.

This prevents returning or exchanging the same sold quantity more than once.

---

## Idempotency

Every exchange creation request contains an idempotency key.

Submitting the same key again:

- Does not create another exchange.
- Does not repeat stock movements.
- Returns the previously created exchange.

Concurrent duplicate requests are also protected by PostgreSQL constraints.

---

## Safe Void Flow

Voiding does not delete or overwrite the original exchange records.

The Backend:

1. Locks the exchange.
2. Confirms its status is `completed`.
3. Loads all original stock movements.
4. Verifies the movement history is complete.
5. Verifies no reversal already exists.
6. Locks affected stock balances.
7. Calculates final balances before modifying inventory.
8. Rejects the operation if reversal would produce negative stock.
9. Returns issued replacement products to stock first.
10. Removes products originally returned by the customer.
11. Creates one linked reversal movement for every original movement.
12. Creates linked financial reversal records.
13. Changes the exchange status to `voided`.
14. Saves void reason, user and timestamp.
15. Writes an audit log.

### Inventory Example

Original returned-item movement:

`+1`

Void reversal:

`-1`

Original replacement-item movement:

`-1`

Void reversal:

`+1`

---

## Financial Reversal Flow

When the original settlement was:

`paid_by_customer`

The void reversal becomes:

`refunded_to_customer`

When the original settlement was:

`refunded_to_customer`

The void reversal becomes:

`paid_by_customer`

The original payment is never deleted or modified.

The reversal is stored as a separate linked record.

---

## Web Admin — New Exchange

The New Exchange screen supports:

- Completed sale selection.
- Search by sale number.
- Search by customer.
- Remaining quantity display.
- Returned quantity entry.
- Replacement product search.
- Replacement product cart.
- Automatic total calculation.
- Automatic difference calculation.
- Payment method selection.
- Optional payment reference.
- Exchange reason.
- Confirmation before save.
- Idempotent request submission.

---

## Web Admin — Exchange History

The Exchange History screen supports:

- Exchange list.
- Text search.
- Status filter.
- Returned and issued totals.
- Difference direction.
- Opening the original sale.
- Returned item details.
- Replacement item details.
- Settlement payment details.
- Original stock movements.
- Reversal stock movements.
- Void reason and void user.
- Original/reversal badges.
- Safe void action.

---

## Security Controls

- Authentication required.
- Tenant context taken from authenticated session.
- Company ownership enforced.
- Branch restrictions enforced.
- UUID validation.
- Backend price validation.
- Backend quantity validation.
- Duplicate sale item rejection.
- Duplicate replacement variant rejection.
- Unsupported payment method rejection.
- Difference payment validation.
- Negative stock prevention.
- PostgreSQL transaction protection.
- Idempotent creation.
- Unique stock reversal links.
- Unique payment reversal links.
- Void audit logging.
- No direct frontend database access.

---

## Implementation Checklist

- [x] Exchange database model
- [x] Exchange permissions
- [x] Original sale lookup
- [x] Replacement product lookup
- [x] Remaining quantity protection
- [x] Returned item stock increase
- [x] Replacement item stock deduction
- [x] Difference calculation
- [x] Customer payment
- [x] Customer refund
- [x] Idempotent creation
- [x] New Exchange screen
- [x] Exchange History screen
- [x] Exchange details
- [x] Payment details
- [x] Inventory movement details
- [x] Safe exchange void
- [x] Inventory reversal
- [x] Payment reversal
- [x] Void audit log
- [x] Web Admin void controls
- [x] Original and reversal record badges
- [x] Feature documentation
- [ ] Final integrated acceptance test
- [ ] Production smoke test

---

## Final Acceptance Scenarios

### Equal-Value Exchange

- Return an item.
- Issue another item with the same value.
- Confirm no settlement payment is created.
- Confirm inventory movements are correct.

### Customer Pays Difference

- Issue a higher-value replacement.
- Confirm the difference is collected.
- Confirm direction is `paid_by_customer`.

### Customer Receives Refund

- Issue a lower-value replacement.
- Confirm the difference is refunded.
- Confirm direction is `refunded_to_customer`.

### Insufficient Inventory

- Request more replacement quantity than available.
- Confirm the operation is rejected.
- Confirm no partial update occurs.

### Duplicate Submission

- Submit the same idempotency key twice.
- Confirm only one exchange exists.

### Safe Void

- Record balances before the exchange.
- Create the exchange.
- Void it.
- Confirm balances return to their original values.
- Confirm original and reversal records remain visible.

### Repeated Void

- Submit the void request twice.
- Confirm no reversal is duplicated.

### Void Stock Shortage

- Create an exchange.
- Consume stock that must be removed during void.
- Attempt to void.
- Confirm rejection without partial changes.

---

## Completion Definition

Current feature state:

**IMPLEMENTATION COMPLETE**

Remaining work:

- Final integrated acceptance test.
- Production smoke test.
