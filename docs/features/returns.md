# Return Management

## Feature Status

- **Implementation:** Completed
- **Final integrated testing:** Pending
- **Production smoke test:** Pending
- **Last implementation commit:** `95aa9614`

---

## Purpose

The Return Management feature allows authorized users to return items from a completed sale while preserving:

- Original sale history.
- Accurate returnable quantities.
- Inventory integrity.
- Customer refund history.
- Tenant and branch isolation.
- Complete auditability.
- Safe reversal when a return is voided.

PostgreSQL remains the only inventory source of truth.

---

## Supported Workflow

An authorized user can:

1. Select a completed original sale.
2. View the sold items.
3. View quantities already returned or exchanged.
4. Select the quantity to return.
5. Calculate the refund from the original sale value.
6. Select the refund method.
7. Create the return atomically.
8. Increase PostgreSQL inventory.
9. Review previous returns.
10. Review refund records.
11. Review inventory movements.
12. Safely void a completed return.
13. Preserve original and reversal records.

---

## Current Limitations

The current implementation intentionally does not support:

- Manual returns without an original sale.
- Returning more than the remaining sold quantity.
- Zero-value returns without a refund transaction.
- Deleting completed returns.
- Editing a completed return.
- Direct inventory changes from the frontend.

Manual returns may be added later under a separate permission and review workflow.

---

## Permissions

| Permission       | Description                         |
| ---------------- | ----------------------------------- |
| `returns.view`   | View return records and details     |
| `returns.create` | Create returns from completed sales |
| `returns.void`   | Safely void completed returns       |

The reserved `admin` role bypasses normal permission checks.

Users with any of the following permissions can read the return records required for their workflow:

- `returns.view`
- `returns.create`
- `returns.void`

A user with `returns.create` may read completed sales required to prepare a return.

---

## Main Files

### Backend

- `services/api/src/modules/returns/returns.routes.ts`
- `services/api/src/modules/auth/auth.middleware.ts`
- `services/api/src/app.ts`

### Web Admin

- `apps/web-admin/src/pages/NewReturnPage.tsx`
- `apps/web-admin/src/pages/ReturnsPage.tsx`
- `apps/web-admin/src/pages/SalesPage.tsx`
- `apps/web-admin/src/App.tsx`

### Database

- `db/migrations/006_returns_exchanges.sql`
- `db/migrations/009_multi_tenant_integrity.sql`
- `db/migrations/011_permissions_seed.sql`
- `db/migrations/025_return_void_reversal.sql`

---

## Database Tables

### `returns`

Stores the return header:

- Company.
- Branch.
- Stock location.
- Customer.
- Original sale.
- Return number.
- Source.
- Idempotency key.
- Subtotal.
- Refund total.
- Status.
- Return reason.
- Creation user.
- Creation timestamp.
- Sync timestamp.
- Void reason.
- Void user.
- Void timestamp.

Supported statuses:

- `draft`
- `completed`
- `pending_review`
- `voided`

Supported sources:

- `online_pos`
- `offline_pos`
- `web_admin`

---

### `return_items`

Stores every returned item.

Each row contains:

- Return ID.
- Original sale item ID.
- Product variant ID.
- SKU snapshot.
- Barcode snapshot.
- Product name snapshot.
- Size snapshot.
- Color snapshot.
- Quantity.
- Original unit price.
- Calculated refund amount.
- Item-specific reason.
- Creation timestamp.

The original sale item link protects against returning more than the sold quantity.

---

### `return_refunds`

Stores original refund records and refund reversal records.

Supported methods:

- `cash`
- `card`
- `wallet`
- `bank_transfer`
- `other`

Supported refund roles:

- `refund`
- `void_reversal`

Supported payment directions:

- `refunded_to_customer`
- `collected_from_customer`

Original refund:

```text
refund_role = refund
payment_direction = refunded_to_customer
```

Void reversal:

```text
refund_role = void_reversal
payment_direction = collected_from_customer
```

A reversal references the original refund through:

```text
reverses_refund_id
```

The unique partial index prevents reversing the same refund more than once.

---

### `stock_movements`

Stores:

- Original positive return inventory movements.
- Negative inventory reversal movements created during voiding.

A reversal movement references its original movement through:

```text
reversal_of_movement_id
```

The same original stock movement cannot be reversed more than once.

---

## API Endpoints

### List Returns

```http
GET /api/returns
```

Supported query values:

- Company context.
- Branch filter.
- Result limit.

The authenticated tenant middleware overrides untrusted company and branch values.

The list returns:

- Return number.
- Original sale number.
- Customer.
- Branch.
- Stock location.
- Subtotal.
- Refund total.
- Status.
- Item count.
- Void reason.
- Void user.
- Void timestamp.

Branch-restricted users only see returns belonging to their branch.

---

### Load Return Details

```http
GET /api/returns/:returnId
```

Returns:

- Return header.
- Returned items.
- Refund records.
- Refund reversal records.
- Original stock movements.
- Stock reversal movements.
- Creation user.
- Void metadata.

The return ID must be a valid UUID.

The requested return must belong to:

- The authenticated company.
- The authenticated branch when the user is branch-restricted.

---

### Create Return

```http
POST /api/returns
```

Required data:

- Original sale ID.
- Return number.
- Idempotency key.
- At least one returned item.
- At least one refund record.

Optional data:

- Return reason.
- Item-specific reason.
- Refund reference.
- Source.

The Backend does not trust:

- Client-submitted company ownership.
- Client-submitted branch ownership.
- Client-submitted creation user.
- Client-submitted product price.
- Client-submitted refund amount for an original sale item.

---

### Void Return

```http
POST /api/returns/:returnId/void
```

Required data:

- Void reason.

Optional data:

- Collection reference.

Only completed returns can be voided.

The operation runs inside one PostgreSQL transaction.

---

## Original Sale Validation

A return can only be created from a sale with status:

```text
completed
```

The Backend loads the original sale and obtains the trusted:

- Branch.
- Stock location.
- Customer.

The frontend cannot replace these values.

A branch-restricted user cannot return an invoice belonging to another branch.

---

## Identifier Validation

Before processing a return, the Backend validates and normalizes:

- Original sale ID.
- Original sale item IDs.
- Product variant IDs.
- Return ID.
- Idempotency key.

UUID values are:

- Trimmed.
- Converted to lowercase.
- Validated before being passed to PostgreSQL.

This prevents malformed UUID database errors and case-based duplicate bypasses.

---

## Duplicate Item Protection

The same original sale item cannot appear twice inside one return request.

The Backend maintains a normalized set of original sale item IDs while preparing the request.

Example rejected request:

```text
Sale Item A — quantity 1
Sale Item A — quantity 1
```

The caller must send:

```text
Sale Item A — quantity 2
```

when two units from the same sale line are being returned.

---

## Remaining Returnable Quantity

The remaining quantity is calculated as:

```text
sold quantity
-
completed or pending-review return quantities
-
completed or pending-review exchange quantities
```

The following records do not consume the original sold quantity:

- Voided returns.
- Voided exchanges.

This prevents the same sold quantity from being:

- Returned twice.
- Exchanged twice.
- Returned after being fully exchanged.
- Exchanged after being fully returned.

---

## Concurrency Protection

Original sale item rows are locked using PostgreSQL row locks.

When two return requests target the same sale item concurrently:

1. The first request locks the sale item.
2. The second request waits.
3. The first request completes.
4. The second request recalculates consumed quantity.
5. The second request is rejected if insufficient returnable quantity remains.

Items are sorted by normalized identifiers before row locking to reduce deadlock risk.

---

## Refund Calculation

The refund amount is calculated from the original sale item.

The Backend uses:

```text
refundable unit amount =
original sale line total / sold quantity
```

Then:

```text
item refund amount =
refundable unit amount × returned quantity
```

Example:

```text
Sold quantity: 2
Final original line total: 180
Refundable amount per unit: 90
Returned quantity: 1
Calculated refund: 90
```

The original line total already represents the final sale-line value after relevant discounts and taxes.

The frontend cannot override the calculated refund.

---

## Refund Validation

The Backend calculates the total value of all returned items.

It also calculates the total of all submitted refund methods.

The operation is rejected when:

```text
refund methods total != returned items total
```

A rounding tolerance of one minor currency unit is permitted.

Refund methods are validated before insertion.

Negative or zero refund amounts are rejected.

---

## Return Creation Inventory Flow

For every returned item:

```text
Stock balance increases.
Stock movement quantity is positive.
```

Example:

```text
Quantity before: 8
Return movement: +2
Quantity after: 10
```

The Backend:

1. Ensures the stock balance row exists.
2. Locks the stock balance.
3. Reads the current quantity.
4. Increases the inventory.
5. Creates a `return` stock movement.
6. Links the movement to the return document.

The return header, items, refunds and inventory changes are committed atomically.

If any step fails, the entire transaction is rolled back.

---

## Idempotency

Every return creation request includes an idempotency key.

The Backend:

- Trims the key.
- Rejects an empty key.
- Rejects keys longer than 200 characters.
- Searches for an existing return before creating a new one.
- Handles concurrent unique-constraint conflicts.
- Returns the previously created document for repeated requests.

Submitting the same request more than once must not:

- Create another return.
- Increase inventory again.
- Create another refund.
- Consume the original sale quantity again.

---

## Creation User Protection

The return creator is taken from:

```text
Authenticated session user
```

The frontend cannot select another user as:

- Return creator.
- Stock movement creator.

This information is stored for audit and reporting.

---

## Safe Void Flow

Voiding a return does not delete the original return.

The Backend:

1. Validates the return ID.
2. Starts a PostgreSQL transaction.
3. Locks the return header.
4. Confirms the return belongs to the trusted tenant and branch.
5. Confirms the return status is `completed`.
6. Loads the original return stock movements.
7. Verifies the movement history is complete.
8. Confirms no stock reversal already exists.
9. Loads the original refund records.
10. Confirms the refund history matches the return total.
11. Confirms no refund reversal already exists.
12. Locks all affected stock balances.
13. Calculates final inventory before modifying anything.
14. Rejects the operation if inventory would become negative.
15. Creates linked stock reversal movements.
16. Creates linked financial reversal records.
17. Changes the return status to `voided`.
18. Saves the void reason, user and timestamp.
19. Writes an audit log.
20. Commits the transaction.

---

## Safe Void Inventory Flow

Original return movement:

```text
+2
```

Void reversal:

```text
-2
```

Example:

```text
Current inventory: 10
Void reversal: -2
Final inventory: 8
```

Before changing inventory, the Backend verifies:

```text
current inventory - returned quantity >= 0
```

When the returned stock has already been consumed and the balance is insufficient, voiding is rejected.

No partial inventory reversal is allowed.

---

## Safe Void Financial Flow

The original return created:

```text
refunded_to_customer
```

Voiding creates:

```text
collected_from_customer
```

The original refund is not deleted or modified.

The reversal:

- Uses the same payment method.
- Uses the same amount.
- Can contain a collection reference.
- References the original refund.
- Is stored as a separate auditable record.

---

## Repeated Void Protection

When the return is already voided:

- No stock movement is repeated.
- No financial reversal is repeated.
- The API returns an `alreadyVoided` response.

Database unique indexes also prevent duplicate reversal links.

---

## Audit Log

A successful return void writes an audit log with:

```text
action = return.void
entity_type = return
```

The audit record includes:

- Company.
- Branch.
- User.
- Return ID.
- Previous status.
- Return subtotal.
- Original refund total.
- New status.
- Void reason.
- Stock reversal IDs.
- Refund reversal IDs.
- IP address.
- User agent.

---

## Web Admin — New Return

The New Return screen supports:

- Completed sale selection.
- Sale number search.
- Customer search.
- Remaining quantity display.
- Returned quantity entry.
- Original price display.
- Backend-calculated refund.
- Refund method selection.
- Optional refund reference.
- Return reason.
- Idempotent request submission.

---

## Web Admin — Return History

The Return History screen supports:

- Return list.
- Original sale display.
- Customer display.
- Branch display.
- Return totals.
- Status display.
- Item count.
- Return details.
- Returned item details.
- Original refund records.
- Refund reversal records.
- Original stock movements.
- Stock reversal movements.
- Void reason.
- Void user.
- Void timestamp.
- Safe void controls.

---

## Web Admin — Safe Void Controls

The void action:

1. Requires `returns.void`.
2. Requests a void reason.
3. Allows an optional collection reference.
4. Displays the financial effect.
5. Warns that returned items will be removed from inventory.
6. Requires final confirmation.
7. Displays stock shortage details when reversal is unsafe.
8. Refreshes the return list and details after success.
9. Hides the void button after completion.

The interface distinguishes:

- Original refund.
- Collection caused by void.
- Original stock movement.
- Reversal stock movement.

---

## Security Controls

- Authentication required.
- Tenant context from authenticated session.
- Company ownership enforced.
- Branch ownership enforced.
- UUID validation.
- Identifier normalization.
- Authenticated creator enforcement.
- Completed original sale required.
- Manual returns rejected.
- Duplicate sale items rejected.
- Excess quantities rejected.
- Returns and exchanges counted together.
- Client prices not trusted.
- Client refund amounts not trusted.
- Refund methods validated.
- Refund total must match item total.
- Inventory row locking.
- Original sale item row locking.
- Transactional creation.
- Idempotent creation.
- Negative stock prevention during void.
- Complete movement-history verification.
- Complete refund-history verification.
- Unique stock reversal links.
- Unique refund reversal links.
- Transactional void.
- Audit logging.
- No direct frontend database access.

---

## Implementation Checklist

- [x] Return database model
- [x] Return permissions
- [x] Original sale validation
- [x] Branch isolation
- [x] Original sale item validation
- [x] UUID normalization and validation
- [x] Duplicate item protection
- [x] Remaining quantity protection
- [x] Exchange quantity integration
- [x] Backend refund calculation
- [x] Refund total validation
- [x] Supported refund methods
- [x] Return stock increase
- [x] Return stock movement
- [x] Authenticated creation user
- [x] Idempotent creation
- [x] Concurrent quantity protection
- [x] New Return Web Admin screen
- [x] Return History Web Admin screen
- [x] Return details
- [x] Refund details
- [x] Inventory movement details
- [x] Safe void Backend
- [x] Stock reversal
- [x] Financial reversal
- [x] Void audit log
- [x] Repeated void protection
- [x] Web Admin void controls
- [x] Original and reversal badges
- [x] Feature documentation
- [ ] Final integrated acceptance test
- [ ] Production smoke test

---

## Final Acceptance Scenarios

### Standard Return

- Create a completed sale.
- Return part of one sale item.
- Confirm the refund uses the original line value.
- Confirm inventory increases.
- Confirm one original stock movement is created.

### Multiple Items

- Return items from multiple sale lines.
- Confirm all items are saved.
- Confirm totals match.
- Confirm inventory movements are correct.

### Partial Return

- Sell quantity 3.
- Return quantity 1.
- Confirm remaining returnable quantity is 2.

### Full Return

- Return the entire sold quantity.
- Confirm no remaining quantity is available.

### Duplicate Item Request

- Submit the same original sale item twice in one request.
- Confirm the API rejects the request.
- Confirm no partial return is created.

### Excess Quantity

- Request more than the remaining sold quantity.
- Confirm rejection.
- Confirm inventory is unchanged.

### Return After Exchange

- Exchange part of a sold quantity.
- Attempt to return more than the remaining quantity.
- Confirm rejection.

### Exchange After Return

- Return part of a sold quantity.
- Attempt to exchange more than the remaining quantity.
- Confirm rejection.

### Duplicate Submission

- Submit the same idempotency key twice.
- Confirm only one return exists.
- Confirm inventory increases once.

### Concurrent Submission

- Submit two requests for the same final available quantity.
- Confirm only one succeeds.

### Invalid Identifiers

- Submit malformed sale, sale-item and variant IDs.
- Confirm validation errors are returned.
- Confirm PostgreSQL errors are not exposed.

### Safe Void

- Record inventory before return creation.
- Create a return.
- Void the return.
- Confirm inventory returns to its original value.
- Confirm the original and reversal movements remain visible.
- Confirm the original refund and collection reversal remain visible.

### Repeated Void

- Void a return.
- Submit the void request again.
- Confirm no stock or financial reversal is duplicated.

### Void Stock Shortage

- Create a return.
- Consume the returned stock.
- Attempt to void the return.
- Confirm the operation is rejected.
- Confirm no partial reversal occurs.

### Branch Isolation

- Log in as a branch-restricted user.
- Attempt to open or void another branch’s return.
- Confirm access is denied or the document is not found.

---

## Completion Definition

Current feature state:

```text
IMPLEMENTATION COMPLETE
```

Remaining work:

- Final integrated acceptance test.
- Production smoke test.
