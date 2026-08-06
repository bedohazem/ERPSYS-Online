# ERPSYS Online POS Sync Policy

## Purpose

This document defines the allowed Desktop POS offline behavior and the Backend synchronization contract.

PostgreSQL remains the only source of truth.

## Core Rule

Desktop POS may continue selling during a connection outage by storing pending sales locally.

Desktop POS must never finalize authoritative inventory or financial records locally.

## Allowed Local Data

Desktop POS may store:

- Device identity and setup state.
- Authenticated cashier session state.
- Offline grants.
- Catalog cache.
- Product and barcode search data.
- Draft sale workspace.
- Pending-sale outbox.
- Synchronization attempts.
- Conflict state.
- Shift continuity state.
- Local application settings.
- Receipt data required for temporary printing.

## Forbidden Local Authority

Desktop POS must not treat the following as authoritative:

- Stock balances.
- Stock movements.
- Final server invoices.
- Customer receivables.
- Supplier balances.
- Accounting records.
- Audit logs.
- Tenant configuration.
- User and permission administration.

## No Local Stock Deduction

Desktop POS never deducts stock locally.

When a sale is created offline:

- The POS may show the last cached stock information.
- Cached stock is advisory only.
- The local pending sale does not change cached stock truth.
- The Backend validates and changes stock during synchronization.

## Pending Sale Identity

Each pending sale must have stable identifiers created before the first sync attempt:

- Local sale ID.
- Idempotency key.
- Device ID.
- Company context associated with the device session.
- Branch context.
- Cashier identity.
- Shift identity when required.
- Original local creation time.

These identifiers must remain unchanged during retries.

## Offline Sale Flow

1. Cashier builds the sale.
2. POS calculates a local preview.
3. POS attempts to call the Backend.
4. If the API is unavailable, the POS saves a pending sale.
5. The pending record is added to the outbox.
6. The POS may print a clearly marked pending receipt.
7. The POS retries automatically or manually.
8. Backend authenticates the device and cashier context.
9. Backend validates the request.
10. Backend recalculates product prices and totals.
11. Backend validates stock and business policies.
12. Backend executes the final sale inside a transaction.
13. Backend returns the authoritative sale.
14. POS stores the server sale ID and marks the local item as synced.
15. The pending item must not be submitted again as a new transaction.

## Online Sale Flow

Online sales still use idempotency.

A temporary timeout after Backend success must not cause a duplicate invoice.

The same idempotency key must return the existing sale.

## Backend Authority

During synchronization, the Backend owns:

- Company scope.
- Branch scope.
- Cashier identity.
- Shift validation.
- Device authorization.
- Product activity.
- Variant and barcode validity.
- Current server price.
- Discount and tax policy.
- Customer credit policy.
- Available stock.
- Sale totals.
- Payment totals.
- Stock deduction.
- Sale number and server identifiers.
- Final document state.

## Price Conflict Policy

A price conflict occurs when the pending sale used a cached price that differs from the current approved server price.

The Backend must not silently rewrite a completed customer transaction without recording the difference.

Supported review behavior may include:

- Accepting the server price automatically under a defined policy.
- Sending the pending sale to review.
- Requiring an authorized user to approve or reject the difference.
- Recording cached and current prices.
- Recording the final resolution and resolving user.

Price-conflict behavior must be tested before V1.

## Stock Conflict Policy

A stock conflict occurs when current server stock is insufficient for an offline pending sale.

The system must not silently lose the sale.

The Backend should place the sale into an explicit review state or return a structured conflict result.

The conflict record should include:

- Pending sale.
- Variant.
- Requested quantity.
- Available quantity.
- Branch.
- Location.
- Device.
- Cashier.
- Creation time.
- Sync-attempt time.

Resolution may include:

- Accepting controlled negative stock if future policy allows.
- Rejecting specific items.
- Cancelling the pending sale.
- Transferring stock.
- Manager approval.
- Other explicit audited action.

No implicit local stock deduction is allowed.

## Customer Credit Sales Offline

Customer-credit sales require live validation of:

- Customer activity.
- Credit enablement.
- Credit limit.
- Current outstanding balance.
- Payment terms.

Therefore, fully offline customer-credit sales should remain disabled unless a dedicated secure offline-credit grant policy is implemented.

Normal offline pending sales should be paid sales within the allowed POS offline policy.

## Shift Policy

A pending sale must be associated with the correct cashier shift when shifts are enabled.

A shift must not close if unresolved pending sales belonging to it still exist, unless an explicit audited exception policy is introduced.

Offline-grant expiration and shift state must be validated during sync.

## Sync Queue States

Recommended local states:

- `pending`
- `syncing`
- `synced`
- `review_required`
- `failed_retryable`
- `failed_permanent`
- `cancelled`

A record must never move from `synced` back to `pending`.

## Retry Policy

Retryable failures include:

- API unavailable.
- Network timeout.
- Temporary server failure.
- Temporary authentication refresh requirement.

Permanent or review failures include:

- Invalid product.
- Invalid branch or location.
- Expired grant.
- Closed or invalid shift.
- Price conflict requiring approval.
- Stock conflict.
- Invalid customer.
- Invalid payment.
- Permission failure.

The POS must avoid rapid uncontrolled retries.

Use bounded retry delays and expose manual retry.

## Idempotency Response

For the same company and idempotency key:

- Same pending sale: return existing result.
- Different sale: reject with conflict.
- Already synced sale: return authoritative server sale.
- Concurrent retry: only one server transaction may succeed.

## Catalog Cache

The catalog cache may include:

- Product name.
- Variant.
- SKU.
- Barcodes.
- Size.
- Color.
- Approved selling price.
- Activity status.
- Last refresh metadata.

The cache must record its refresh time or version.

The UI should make stale-cache conditions visible when useful.

## Device Security

Each Desktop POS installation must have:

- Registered device identity.
- Revocable credentials.
- Company and branch assignment.
- Device status.
- Last-seen information.
- Audit trail for setup and revocation.

Device credentials must not be committed to Git.

## Monitoring

Web Admin should allow authorized users to view:

- Pending and failed sync records.
- Review-required sales.
- Device.
- Branch.
- Cashier.
- Shift.
- Conflict reason.
- Retry count.
- Last attempt.
- Server sale ID when synced.
- Resolution state.

## Audit Requirements

Audit records are required for:

- Device registration.
- Device revocation.
- Offline-grant creation.
- Manual retry.
- Conflict approval.
- Conflict rejection.
- Pending-sale cancellation.
- Manual sync resolution.
- Price override.
- Stock override if such a policy is later introduced.

## UAT Requirements

Desktop POS UAT must include:

1. Online sale.
2. Network loss before submission.
3. Network timeout after server success.
4. Multiple retry attempts.
5. Duplicate local submission.
6. App restart with pending sales.
7. Device restart.
8. Cashier re-login.
9. Shift with pending sales.
10. Price change before sync.
11. Stock shortage before sync.
12. Invalid or deactivated product.
13. Revoked device.
14. Expired offline grant.
15. Wrong branch attempt.
16. Manual retry.
17. Conflict resolution.
18. Final sale visibility in Web Admin.
19. Final stock movement verification.
20. No duplicate invoice verification.

## Future Policy

The following require separate approved designs:

- Offline customer-credit sales.
- Offline returns.
- Offline exchanges.
- Offline loyalty.
- Offline promotions requiring server state.
- Controlled negative stock.
- Multi-device local peer synchronization.

They are not implied by the current pending-sale model.
