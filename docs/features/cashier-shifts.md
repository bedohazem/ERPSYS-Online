# Cashier Shifts and Settlement

## Feature Status

- **Implementation:** Completed
- **Final integrated testing:** Pending
- **Production smoke test:** Pending
- **Last implementation commit:** `a4086ff5`

---

## Purpose

The Cashier Shifts feature provides a controlled and auditable cash-drawer lifecycle for Desktop POS operations.

It supports:

- Opening a cashier shift.
- Keeping the shift available during offline sales.
- Associating POS sales with the active shift.
- Preventing logout while a shift is open.
- Preventing shift closure while pending sales remain unsynchronized.
- Calculating expected cash from PostgreSQL records.
- Recording actual closing cash.
- Calculating cash shortage or overage.
- Saving a permanent settlement snapshot.
- Recording an optional cashier closing note.
- Reviewing shift settlements from Web Admin.

PostgreSQL remains the only source of truth for financial and inventory records.

---

## Main Files

### Backend

- `services/api/src/modules/pos-sync/pos-sync.routes.ts`
- `services/api/src/modules/reports/reports.routes.ts`
- `services/api/src/modules/auth/auth.middleware.ts`

### Desktop POS

- `apps/desktop-pos/electron/cashier-service.ts`
- `apps/desktop-pos/electron/main.ts`
- `apps/desktop-pos/electron/preload.ts`
- `apps/desktop-pos/src/CashierWorkspace.tsx`
- `apps/desktop-pos/src/vite-env.d.ts`
- `apps/desktop-pos/src/styles.css`

### Web Admin

- `apps/web-admin/src/pages/CashierShiftsPage.tsx`
- `apps/web-admin/src/App.tsx`

### Database

- `db/migrations/020_cashier_shifts.sql`
- `db/migrations/027_cashier_shift_settlement.sql`

---

## Database Table

### `cashier_shifts`

Stores the complete lifecycle of a cashier shift.

Main identity fields:

- Company ID.
- Branch ID.
- Cashier ID.
- POS device ID.
- Cashier grant ID.
- Shift number.
- Status.

Opening fields:

- Opening cash.
- Opened timestamp.

Closing fields:

- Closing cash.
- Expected cash.
- Cash difference.
- Closed timestamp.
- User who closed the shift.
- Optional closing note.

Financial settlement fields:

- Net sales cash.
- Cash returns.
- Net exchange cash.

Document counters:

- Active sales count.
- Voided sales count.
- Return count.
- Exchange count.

Permanent settlement data:

- Versioned JSON settlement snapshot.

Supported statuses:

```text
open
closed
```

---

## Opening a Shift

A cashier opens a shift from Desktop POS while connected to the server.

Required input:

```text
openingCash
```

The Backend validates:

- Authenticated cashier session.
- Registered POS device.
- Device secret.
- Company ownership.
- Branch ownership.
- Cashier ownership.
- Cashier and device branch consistency.
- Opening cash is finite and non-negative.
- No incompatible active shift exists.

The opened shift is returned to Desktop POS and stored inside the encrypted cashier session.

---

## Active Shift Identity

An active shift is tied to:

- Company.
- Branch.
- Cashier.
- POS device.
- Cashier grant.
- Authenticated server session.

A sale cannot use a shift belonging to:

- Another company.
- Another branch.
- Another cashier.
- Another POS device.
- A closed shift.

---

## Encrypted Local Shift Cache

Desktop POS stores the cashier session and active shift using Electron `safeStorage`.

The local cached shift allows the cashier to continue preparing offline pending sales when the server is temporarily unavailable.

The encrypted session stores:

- Cashier identity.
- Company and branch identity.
- Cashier grant ID.
- Cashier grant expiry.
- Current shift identity.
- Shift number.
- Opening cash.
- Shift opening time.
- Shift status.

The local cache is not an accounting source of truth.

---

## Offline Sales During a Shift

When connectivity is unavailable:

1. The cashier must already be logged in.
2. A valid cashier grant must already exist.
3. An open shift must already be cached.
4. The cashier may create local pending sales.
5. Each pending sale stores the shift ID.
6. SQLite stores the pending-sale document.
7. SQLite does not deduct authoritative inventory.
8. The pending sale is synchronized when connectivity returns.
9. PostgreSQL validates the shift and inventory.
10. PostgreSQL becomes the final sale source.

Opening or closing a shift is not available while operating only from the local cache.

---

## Logout Protection

Desktop POS blocks cashier logout while an open shift exists.

The cashier must:

1. Synchronize pending sales.
2. Close the shift online.
3. Then log out.

This prevents abandoning an active cash drawer without settlement.

---

## Pending-Sale Closure Protection

Desktop POS checks the local pending-sale database before closing a shift.

Closure is rejected when the shift contains:

- Pending sales.
- Sales currently synchronizing.
- Sales requiring review when they still block settlement.
- Failed sales that have not been safely resolved.

The cashier must synchronize or resolve these records before the final cash calculation.

---

## Closing a Shift

Required input:

```text
shiftId
closingCash
```

Optional input:

```text
closingNote
```

The closing note:

- Is optional.
- Is trimmed.
- Converts whitespace-only input to `null`.
- Must be a string.
- Must not exceed 500 characters.

Example:

```text
Small difference caused by cash change shortage.
```

---

## Settlement Calculation

The Backend calculates the shift using PostgreSQL financial records.

The general formula is:

```text
Expected cash =
Opening cash
+ Net sales cash
- Cash returns
+ Net exchange cash
```

The cash difference is:

```text
Difference =
Actual closing cash
- Expected cash
```

Interpretation:

```text
Difference = 0
Balanced shift

Difference > 0
Cash overage

Difference < 0
Cash shortage
```

---

## Net Sales Cash

Net sales cash is calculated from original cash collections.

Customer change is excluded:

```text
Net sales cash =
Cash received
- Customer change
```

Voided sales do not remain part of active shift sales cash.

Sale payment reversal records preserve the financial audit history without counting the original sale as active revenue.

---

## Cash Returns

Cash returns represent money refunded to customers through completed or pending-review return documents.

Return void reversals recollect the original refunded cash and prevent the voided return from remaining as an active cash expense.

---

## Net Exchange Cash

Exchange settlement may produce:

- Cash paid by the customer.
- Cash refunded to the customer.
- No cash difference.

The net exchange cash is calculated as:

```text
Cash collected from customer
- Cash refunded to customer
```

A positive result increases expected drawer cash.

A negative result decreases expected drawer cash.

---

## Settlement Document Counts

At closure, the Backend stores:

- Active sales count.
- Voided sales count.
- Active returns count.
- Active exchanges count.

Active sales include applicable statuses such as:

```text
completed
pending_review
refunded
```

Active returns and exchanges include:

```text
completed
pending_review
```

Voided returns and exchanges are excluded from active settlement counts.

---

## Permanent Settlement Snapshot

When the shift closes, the Backend stores a versioned JSON snapshot.

Current version:

```text
version = 1
```

The snapshot contains:

### Shift identity

- Shift ID.
- Shift number.
- Company ID.
- Branch ID.
- Cashier ID.
- POS device ID.
- Opening timestamp.

### Financial values

- Opening cash.
- Net sales cash.
- Cash returns.
- Net exchange cash.
- Expected cash.
- Closing cash.
- Difference.

### Document counts

- Sales count.
- Voided sales count.
- Returns count.
- Exchanges count.

### Calculation metadata

- Snapshot version.
- Computation timestamp.

The snapshot protects historical reports from being silently recalculated using later data changes.

---

## Atomic Shift Closure

The following operations occur inside one PostgreSQL transaction:

1. Lock and validate the open shift.
2. Calculate financial totals.
3. Calculate document counts.
4. Build the settlement snapshot.
5. Update the shift as closed.
6. Save closing metadata.
7. Save the optional closing note.
8. Write the audit log.
9. Commit the transaction.

If any required step fails, the transaction is rolled back.

---

## Closing Audit Log

A successful closure writes:

```text
action = cashier_shift.close
entity_type = cashier_shift
```

The audit record contains:

- Company.
- Branch.
- Closing user.
- Shift ID.
- Previous shift status.
- Opening cash.
- Opening timestamp.
- New closed status.
- Closing note.
- Complete settlement snapshot.
- IP address.
- User agent.

---

## Current Shift API

```http
GET /api/pos-sync/shifts/current
```

Returns the authenticated cashier’s current open shift or `null`.

Desktop POS uses this endpoint to reconcile the encrypted local session with the server when connectivity is available.

---

## Open Shift API

```http
POST /api/pos-sync/shifts/open
```

Request example:

```json
{
  "openingCash": 500
}
```

Returns the newly opened shift.

---

## Close Shift API

```http
POST /api/pos-sync/shifts/:shiftId/close
```

Request example:

```json
{
  "closingCash": 3750,
  "closingNote": "Drawer counted and handed to management."
}
```

Returns:

- Closed shift.
- Opening cash.
- Net sales cash.
- Cash returns.
- Net exchange cash.
- Document counts.
- Expected cash.
- Actual closing cash.
- Difference.
- Closing note.
- Settlement version.

---

## Shift Settlement Report API

### List Shifts

```http
GET /api/reports/cashier-shifts
```

Supported filters:

- Cashier ID.
- Shift status.
- Start date.
- End date.
- Result limit.

Returns:

- Matching shift records.
- Open-shift count.
- Closed-shift count.
- Total expected cash.
- Total actual closing cash.
- Total differences.

Tenant and branch restrictions come from the authenticated session.

---

### Shift Details

```http
GET /api/reports/cashier-shifts/:shiftId
```

Returns:

- Shift identity.
- Cashier information.
- Branch information.
- POS device information.
- Opening and closing data.
- Permanent settlement snapshot.
- Sales belonging to the shift.
- Returns created by the cashier during the shift period.
- Exchanges created by the cashier during the shift period.
- Cash effects for every document.

---

## Web Admin Settlement Screen

The Web Admin page is:

```text
تسوية الورديات
```

Required permission:

```text
reports.view
```

The screen provides:

- Date filters.
- Open or closed status filter.
- Local search by shift, cashier, branch or device.
- Total shift count.
- Open-shift count.
- Closed-shift count.
- Total expected cash.
- Total closing cash.
- Net shortage or overage.
- Detailed shift settlement.
- Sales table.
- Returns table.
- Exchanges table.
- Closing note.
- Warning for open non-final shifts.
- Warning for historical shifts without a final snapshot.

Branch-restricted users cannot view another branch’s shifts.

---

## Desktop POS Closing Screen

When a shift is open, Desktop POS displays:

- Shift number.
- Opening timestamp.
- Opening cash.
- Actual closing cash input.
- Optional closing-note input.
- Character counter.
- Final closure confirmation.

The confirmation dialog includes the closing note before submitting the operation.

The closing controls are disabled while Desktop POS is operating only from the cached workspace.

---

## Security Controls

- Authenticated cashier session.
- POS device ID validation.
- POS device secret validation.
- Company isolation.
- Branch isolation.
- Cashier ownership validation.
- Device ownership validation.
- Shift UUID validation.
- Open-shift-only operations.
- Non-negative opening cash.
- Non-negative closing cash.
- Closing-note type validation.
- Closing-note length limit.
- Encrypted local cashier session.
- Offline cashier grant validation.
- Pending-sale closure protection.
- Logout protection while shift is open.
- PostgreSQL financial calculations.
- Permanent versioned settlement snapshot.
- Transactional shift closure.
- Audit logging.
- Report permission enforcement.
- No authoritative financial totals in SQLite.
- No authoritative inventory in SQLite.

---

## Implementation Checklist

- [x] Cashier shift database model
- [x] Open-shift API
- [x] Current-shift API
- [x] Close-shift API
- [x] Company validation
- [x] Branch validation
- [x] Cashier validation
- [x] POS device validation
- [x] Cashier grant association
- [x] Encrypted local shift cache
- [x] Offline sales require an open shift
- [x] Shift ID stored on pending sales
- [x] Logout blocked during open shift
- [x] Closure blocked by unsynchronized sales
- [x] Net cash sales calculation
- [x] Customer-change exclusion
- [x] Cash return calculation
- [x] Exchange cash calculation
- [x] Expected cash calculation
- [x] Actual closing cash
- [x] Shortage and overage calculation
- [x] Settlement document counts
- [x] Versioned settlement snapshot
- [x] Closing user metadata
- [x] Optional closing note
- [x] Closing-note Desktop POS interface
- [x] Transactional audit log
- [x] Shift history API
- [x] Shift details API
- [x] Web Admin settlement report
- [x] Branch-isolated reports
- [x] Feature documentation
- [ ] Final integrated acceptance test
- [ ] Production smoke test

---

## Final Acceptance Scenarios

### Open Shift

- Log in from a registered POS device.
- Enter a valid opening balance.
- Open the shift.
- Confirm the shift is saved in PostgreSQL.
- Confirm the shift is cached encrypted locally.

### Duplicate Open Shift

- Attempt to open another incompatible shift.
- Confirm the operation is rejected.

### Offline Sale

- Open the shift while online.
- Disconnect the server.
- Create an offline pending sale.
- Confirm the pending sale contains the shift ID.
- Confirm no local authoritative stock is deducted.

### Logout Protection

- Attempt to log out while the shift is open.
- Confirm logout is rejected.

### Pending-Sale Closure Protection

- Create an offline pending sale.
- Reconnect without synchronizing it.
- Attempt to close the shift.
- Confirm closure is rejected.

### Balanced Shift

- Open with known cash.
- Complete cash sales.
- Enter the exact expected closing balance.
- Confirm the difference is zero.

### Cash Shortage

- Enter closing cash below expected cash.
- Confirm the difference is negative.
- Confirm Web Admin displays a shortage.

### Cash Overage

- Enter closing cash above expected cash.
- Confirm the difference is positive.
- Confirm Web Admin displays an overage.

### Customer Change

- Complete a cash sale with customer change.
- Confirm only net retained cash is included in expected cash.

### Cash Return

- Complete a cash return during the shift.
- Confirm expected cash decreases by the refund.

### Exchange Customer Payment

- Complete an exchange where the customer pays a cash difference.
- Confirm expected cash increases.

### Exchange Customer Refund

- Complete an exchange where the customer receives cash.
- Confirm expected cash decreases.

### Closing Note

- Close a shift with a note.
- Confirm the note is stored.
- Confirm the note appears in Web Admin.
- Confirm the note appears in the audit record.

### Empty Closing Note

- Enter spaces only.
- Close the shift.
- Confirm the note is stored as `null`.

### Closing Note Limit

- Attempt to submit more than 500 characters.
- Confirm Desktop POS or the Backend rejects it.

### Settlement Snapshot

- Close a shift.
- Confirm snapshot version 1 exists.
- Confirm snapshot totals equal the close response.

### Branch Isolation

- Log in as a branch-restricted manager.
- Attempt to load another branch’s shift.
- Confirm it is not returned.

### Atomic Closure

- Force audit-log insertion to fail in a controlled test.
- Confirm the shift update is rolled back.

---

## Completion Definition

Current feature state:

```text
IMPLEMENTATION COMPLETE
```

Remaining work:

- Final integrated acceptance test.
- Production smoke test.
