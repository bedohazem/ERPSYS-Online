# ERPSYS Online Database Design

## Current Reference

- Database engine: PostgreSQL
- Migration directory: `db/migrations`
- Migration runner: `packages/database/scripts/migrate.js`
- Current documented migration baseline: `038_weighted_average_costing_foundation.sql`

The migration files are the authoritative schema history.

This document explains the current domain model and database rules.

## Source of Truth

PostgreSQL is the only source of truth.

Frontend caches, Desktop POS local storage, reports, and exported files are not authoritative business stores.

## Migration Rules

1. Every schema change requires a numbered migration.
2. Applied migrations must never be edited after release to shared environments.
3. A failed migration must roll back completely.
4. Migrations must run on a clean database.
5. New foreign keys must match existing primary or unique constraints.
6. Constraint and index names must be unique.
7. Existing production data must be normalized before adding stricter constraints.
8. Destructive schema changes require an explicit migration and rollback plan.
9. Every release must include a clean-database migration test.
10. The current migration baseline must be updated in this document.

## Tenant Model

Tenant-owned records use `company_id`.

Branch-owned or branch-restricted records use `branch_id`.

The database protects tenant relationships through:

- Company-scoped queries.
- Composite unique constraints.
- Composite foreign keys where appropriate.
- Backend session-context checks.
- PostgreSQL checks and triggers for critical invariants.

## Identity Model

Most business entities use UUID primary keys.

Human-readable document identifiers are separate fields, such as:

- sale number
- return number
- exchange number
- transfer number
- purchase number
- receipt number
- supplier invoice number
- supplier payment number
- collection number

Timestamp-generated document numbers are temporary operational behavior and should later be replaced by configurable numbering sequences.

## Core Organization Entities

- `companies`
- `branches`
- `users`
- `roles`
- `permissions`
- `user_roles`
- `role_permissions`
- session and authentication tables
- POS device and grant tables

## Catalog Entities

- `products`
- product-category foundation
- brand foundation where implemented
- `product_variants`
- variant barcode tables
- fashion sizes
- fashion colors
- collections
- seasons
- style-code fields or related structures
- variant price-history tables

## Customer and Supplier Entities

- `customers`
- `suppliers`

Customer credit fields currently include:

- `allow_credit_sales`
- `credit_limit`
- `payment_terms_days`

## Inventory Entities

- `stock_locations`
- `stock_balances`
- `stock_movements`
- `transfers`
- `transfer_items`
- stock-count documents
- stock-count items
- inventory exception documents and items

Supported stock-location examples:

- Main warehouse.
- Branch warehouse.
- Sales floor.
- Returns location.
- Damaged location.
- Under-inspection location.

## Inventory Truth Rule

`stock_balances` stores current quantity.

`stock_movements` stores movement history.

A balance update without a matching approved movement is invalid business behavior.

Important movement types include:

- opening balance
- purchase
- purchase return
- sale
- customer return
- exchange
- transfer in
- transfer out
- adjustment
- damage
- inspection-related movement
- stock count

The exact allowed values are defined by current migrations and database constraints.

## Transfer Entities

Transfers support:

- Source and destination locations.
- Requested quantities.
- Approved quantities.
- Shipped quantities.
- Received quantities.
- Receiving discrepancies.
- Cancellation.
- Audit information.

The Backend owns the lifecycle and stock deduction.

## Stock Count Entities

Stock-count documents support:

- Opening.
- Snapshot quantities.
- Actual entered quantities.
- Variance calculation.
- Approval.
- Balance update.
- Stock movements.
- Cancellation.
- Audit logs.

Approval must verify that protected stock has not changed unexpectedly since the count was opened.

## Purchase Entities

- purchase orders
- purchase-order items
- purchase receipts
- purchase-receipt items
- direct purchase workflows where still supported

Purchase receipt approval increases stock and creates purchase stock movements.

## Supplier Finance Entities

- `supplier_invoices`
- `supplier_payments`
- `supplier_returns`
- `supplier_return_items`
- `supplier_credit_notes`

Supplier invoices track:

- total
- paid total
- credit total
- outstanding balance
- supplier credit balance
- payment state

Supplier returns:

1. Validate previously received quantity.
2. Validate available stock.
3. Deduct stock.
4. Create `purchase_return` movements.
5. Create a supplier credit note.
6. Update the supplier invoice balance.
7. Execute inside one transaction.

## Sales Entities

- `sales`
- `sale_items`
- `payments`

Sales track:

- subtotal
- discount total
- tax total
- total
- paid total
- change total
- payment status
- outstanding total
- due date
- credit-sale flag
- sale status
- source
- idempotency data
- cashier and shift information

The Backend recalculates and validates financial totals.

## Returns and Exchanges

Customer-return entities store:

- Original sale.
- Returned items.
- Approved return quantities.
- Refund records.
- Inventory restoration.
- Reason and audit context.

Exchange entities link:

- Original sale.
- Returned side.
- Replacement-sale side.
- Difference payment or refund.
- Final exchange status.

Returns and exchanges must not exceed the original returnable quantity.

Current policy prevents ordinary returns or exchanges against unpaid outstanding amounts until a dedicated financial allocation policy is implemented.

## Customer Receivables

- `customer_collections`

Sales currently include receivable fields:

- `payment_status`
- `outstanding_total`
- `due_date`
- `is_credit_sale`

Customer collections include:

- Company.
- Branch.
- Customer.
- Sale.
- Collection number.
- Idempotency key.
- Amount.
- Payment method.
- Reference.
- Note.
- Collecting user.
- Timestamp.

Each collection also creates a linked record in `payments`.

Sale cancellation creates payment-reversal records rather than deleting collection history.

## Cashier and POS Entities

The database includes or supports:

- POS devices.
- Device secrets or authentication records.
- Cashier grants.
- Cashier shifts.
- Shift settlements.
- Synced-sale identifiers.
- Offline conflict or review state.
- POS sync monitoring records.

The exact local Desktop POS database is not the ERP source of truth.

## Audit Entities

- `audit_logs`

Audit logs store important business actions with:

- company
- branch
- user
- action
- entity type
- entity ID
- old data
- new data
- IP address
- user agent
- timestamp

## Constraint Strategy

Use database constraints for rules that must never be bypassed:

- Positive quantities.
- Non-negative financial totals.
- Valid document statuses.
- Valid payment methods.
- Tenant-matching foreign keys.
- Unique document numbers.
- Unique idempotency keys.
- Balance consistency.
- Credit and outstanding consistency.
- Context matching through triggers where necessary.

Backend validation still remains required for readable errors and business authorization.

## Locking Strategy

Use row-level locks for operations that can race:

- Stock deduction.
- Stock receipt.
- Transfer shipment and receipt.
- Stock-count approval.
- Supplier payment.
- Supplier return.
- Customer credit-limit check.
- Customer collection.
- Sale cancellation.

Queries should lock rows in predictable order to reduce deadlock risk.

## Idempotency Strategy

Idempotency keys must be unique inside the company.

A repeated request must return the previously created document when:

- The key belongs to the same operation.
- The authenticated tenant and branch allow access.
- The document belongs to the expected entity.

The same key must be rejected if it belongs to another document.

## Costing Status

The database foundation for perpetual weighted-average costing is implemented.

Current costing fields include:

- `stock_balances.average_cost`
- Cost fields on `stock_movements`
- `purchase_receipt_items.inventory_unit_cost`
- Cost and gross-profit snapshots on `sale_items`

The costing method is defined by:

- [ADR-004: Weighted Average Cost](./adr/004-weighted-average-cost.md)

Remaining integration work:

- Purchase receipts must update moving-average cost.
- Transfers must carry source-location cost.
- Supplier returns must use authoritative historical cost.
- Sales must write cost and profit snapshots.
- Historical pre-costing data requires an initialization policy.
- Landed-cost allocation remains pending.
- Inventory valuation and profitability reports remain pending.

## Reporting Rule

Reports query authoritative PostgreSQL data.

Reports must respect:

- Company scope.
- Branch scope.
- Voided and cancelled states.
- Reversed payments.
- Returned quantities.
- Outstanding balances.
- Historical cost snapshots when implemented.

## Backup and Restore

Before production:

1. Define automated backups.
2. Define retention.
3. Encrypt backup storage.
4. Test restore into a separate environment.
5. Document recovery steps.
6. Record restore-test dates.

A backup that has not been restored successfully is not considered verified.

## Documentation Rule

When a new migration is added:

1. Update the migration baseline in this file.
2. Add new domain entities or fields.
3. Update `docs/backlog.md`.
4. Update any affected feature documents.
