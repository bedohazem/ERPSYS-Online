# ERPSYS Online Roadmap

This roadmap summarizes the current release direction.

The detailed and authoritative execution list is:

- [Master Backlog](./backlog.md)

## Current Reference

- Branch: `main`
- Reference commit: `9cf7f1de67f54ee3baf60e3e86d9ad57f8b8ca39`
- Reference date: `2026-08-05`
- Target release: Fashion Retail ERP/POS V1

## Product Direction

ERPSYS Online is built as:

**General ERP/POS Core**

plus

**Fashion Retail as the first vertical module**

The current priority is a stable V1 for real store and branch operation.

SaaS billing, AI, mobile applications, and additional verticals are postponed.

## Non-Negotiable Architecture Rules

- PostgreSQL is the only source of truth.
- Backend API is the only business-data gateway.
- Frontend applications never access PostgreSQL directly.
- Desktop POS stores offline pending sales only.
- Desktop POS never deducts local stock.
- All inventory changes happen in Backend transactions.
- Business APIs take company, branch, and user context from authenticated sessions.
- Retryable business operations require idempotency.
- Important business actions require audit records.
- The project remains a Modular Monolith for V1.

## Current Implementation Summary

### Foundation and Security

Implemented:

- Monorepo and Modular Monolith structure.
- PostgreSQL migrations and database tooling.
- Authentication and secure sessions.
- Companies and branches.
- Users, roles, and permissions.
- Multi-tenant and branch-aware business context.
- POS device authentication.
- Shared project verification with `npm run check`.

### Catalog and Fashion

Implemented:

- Core products.
- Fashion variants.
- Sizes and colors.
- Collections, seasons, and style-code foundation.
- SKU and barcode foundation.
- Audited variant price changes.
- Price history and restoration.

Still required:

- Category and brand CRUD.
- Complete product CRUD.
- Complete variant and barcode CRUD.
- Bulk import/export.
- Barcode-label printing.

### Inventory

Implemented:

- Stock locations.
- Stock balances.
- Stock movement ledger.
- Opening balances.
- Stock transfers.
- Transfer approval.
- Transfer cancellation.
- Partial receiving and receiving discrepancies.
- Stock count workflow.
- Damaged inventory.
- Inspection inventory.
- Return inventory locations.
- Reorder rules and shortage alerts.

Still required:

- General approved stock adjustments.
- Stock valuation.
- Complete inventory reports.
- Integrated acceptance testing.

### Procurement and Supplier Finance

Implemented:

- Suppliers.
- Direct purchase receipts.
- Purchase orders.
- Partial receiving.
- Supplier invoices.
- Supplier payments.
- Supplier returns.
- Supplier credit notes.
- Supplier balances and payment retry protection.

Still required:

- Purchase-order approval and closure lifecycle.
- Landed costs.
- Weighted-average costing.
- Historical sale cost snapshots.
- Integrated acceptance testing.

### Sales and Customer Finance

Implemented:

- Online sale creation.
- Inventory deduction.
- Payments.
- Sale history.
- Sale void and reversal.
- Returns.
- Exchanges.
- Customer credit policy.
- Credit and partially paid sales.
- Credit-limit enforcement.
- Customer collections.
- Customer account statement.
- Collection retry and reversal handling.

Still required:

- Pricing engine.
- Discounts and manager approval.
- Tax engine.
- Promotions.
- Hold and resume.
- Mixed payments.
- Complete refund policy.
- Integrated acceptance testing.

### Desktop POS

Implemented:

- Electron Desktop POS application.
- Cashier workspace.
- Barcode and catalog search.
- Secure device registration.
- Local catalog cache.
- Offline workspace restoration.
- Pending-sale outbox.
- Manual and automatic synchronization.
- Cashier grants.
- Cashier shifts and settlement.
- Admin sync monitoring.
- Price and stock conflict-resolution foundation.

Still required:

- Full Offline/Online acceptance test.
- Receipt printing.
- Reprint audit.
- Cash-in, cash-out, and expense movements.
- Windows packaging and update strategy.

### Reports

Implemented or partially implemented:

- Basic dashboard.
- Sales-performance analytics.
- Product-performance analytics.
- Reorder and shortage analytics.
- Customer receivables.
- Supplier balances.

Still required:

- Profitability.
- Stock valuation and movement ledger.
- Procurement reports.
- Stock-count, transfer, damage, and inspection reports.
- Shift and cash reports.
- Fashion size/color/season reports.
- Export formats.

## Current Phase

The project is currently in:

**Baseline Stabilization and Integrated UAT**

No new large business feature should begin before the current implementation is tested as one connected system.

## Immediate Milestones

### Milestone 1 — Integrated Baseline UAT

Test together:

- Authentication and permissions.
- Products and variants.
- Opening balances.
- Transfers.
- Stock counts.
- Damage and inspection.
- Purchase orders and receiving.
- Supplier invoices, payments, and returns.
- Online sales.
- Credit sales and collections.
- Returns and exchanges.
- Desktop POS Online and Offline.
- Cashier shifts.
- POS conflict resolution.
- Existing reports.

### Milestone 2 — Baseline Stabilization

- Record all findings.
- Classify Blocker, Critical, Normal, and UI issues.
- Fix data, financial, inventory, and security issues first.
- Add regression tests for important defects.
- Freeze an internal baseline.

### Milestone 3 — Catalog Completion

- Categories.
- Brands.
- Products.
- Variants.
- Barcodes.
- Import/export.
- Labels.

### Milestone 4 — Costing and Procurement Completion

- Purchase approvals.
- Landed costs.
- Weighted-average costing.
- Sale cost snapshots.

### Milestone 5 — Commercial Sales Engine

- Pricing.
- Discounts.
- Taxes.
- Promotions.
- Hold and resume.
- Mixed payments.
- Refund policies.

### Milestone 6 — POS Completion

- Receipt printing.
- Reprint audit.
- Cash movements.
- Windows packaging.
- Update strategy.

### Milestone 7 — Reports and Operational Control

- Sales and profitability reports.
- Inventory reports.
- Procurement reports.
- Fashion analytics.
- Shift reports.
- Audit workspace.
- Settings and numbering.

### Milestone 8 — Production Readiness

- Automated tests.
- Backup and tested restore.
- Monitoring and health checks.
- Security review.
- Staging and production deployment.
- Branch pilot.
- V1 release.

## Postponed Until After V1

- SaaS subscriptions and billing.
- Self-service company onboarding.
- AI services.
- Mobile applications.
- OCR.
- Additional vertical modules.
- Premature microservices.

## Documentation Rule

The repository documentation is the official project reference.

After every completed feature:

1. Update `docs/backlog.md`.
2. Update this roadmap when a milestone changes.
3. Update the relevant feature document.
4. Add the actual commit SHA.
5. Keep the PDF only as an approved historical snapshot.
