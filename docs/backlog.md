# ERPSYS Online — Master Backlog

This file is the official execution backlog for ERPSYS Online.

The backlog must reflect the actual state of the `main` branch, not plans or old documents.

## Current Reference

- Repository: `bedohazem/ERPSYS-Online`
- Branch: `main`
- Reference commit: `9cf7f1de67f54ee3baf60e3e86d9ad57f8b8ca39`
- Reference date: `2026-08-05`
- Current product scope: Fashion Retail ERP/POS V1

## Status Values

| Status    | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| `DONE`    | Implemented and merged into `main`                               |
| `UAT`     | Implemented, but integrated acceptance testing is still required |
| `NEXT`    | Next executable backlog item                                     |
| `TODO`    | Required for V1 but not completed                                |
| `PARTIAL` | Partially implemented                                            |
| `LATER`   | Explicitly postponed until after V1                              |

## Definition of Done

A feature can only become `DONE` when:

1. Required migrations are safe and work on a clean database.
2. Backend APIs use authenticated session context.
3. Company, branch, and user identifiers are not trusted from frontend input.
4. Permissions and tenant isolation are enforced.
5. Business writes use PostgreSQL transactions.
6. Idempotency is implemented where retry or duplicate submission is possible.
7. Inventory changes generate traceable stock movements.
8. Financial changes generate traceable records.
9. Important actions generate audit logs.
10. Web Admin or Desktop POS UI is completed where required.
11. `npm run check` succeeds.
12. The commit is pushed to `main`.
13. The backlog and related documentation are updated.

---

# A. Foundation and Architecture

| ID    | Feature                                                     | Status | Reference           |
| ----- | ----------------------------------------------------------- | ------ | ------------------- |
| F-001 | Monorepo and Modular Monolith foundation                    | DONE   | Existing foundation |
| F-002 | PostgreSQL as the only source of truth                      | DONE   | Architecture rule   |
| F-003 | Backend API as the only database gateway                    | DONE   | Architecture rule   |
| F-004 | Multi-tenant database foundation                            | DONE   | Core migrations     |
| F-005 | Migration runner and database tooling                       | DONE   | `packages/database` |
| F-006 | Shared project verification command                         | DONE   | `npm run check`     |
| F-007 | Keep AI, Mobile, SaaS billing, and microservices outside V1 | DONE   | Product decision    |

---

# B. Authentication, Users, and Security Context

| ID    | Feature                                         | Status | Reference                                      |
| ----- | ----------------------------------------------- | ------ | ---------------------------------------------- |
| A-001 | Secure user authentication and sessions         | DONE   | Auth module                                    |
| A-002 | Users, roles, and permissions                   | DONE   | Auth and Web Admin                             |
| A-003 | Companies and branches                          | DONE   | Core modules                                   |
| A-004 | Session-based company, branch, and user context | UAT    | Applied across major business modules          |
| A-005 | Default-deny business permission policies       | UAT    | Auth middleware                                |
| A-006 | POS device authentication and device secrets    | UAT    | POS device workflow                            |
| A-007 | Production security hardening                   | TODO   | HTTPS, headers, rate limits, secret management |
| A-008 | Automated tenant-isolation regression tests     | TODO   | Required before V1                             |

---

# C. Catalog and Fashion Retail

| ID    | Feature                                            | Status | Reference                     |
| ----- | -------------------------------------------------- | ------ | ----------------------------- |
| C-001 | Core product database model                        | DONE   | Product migrations            |
| C-002 | Fashion sizes and colors                           | DONE   | Fashion module                |
| C-003 | Product variants and SKU support                   | DONE   | Product variants              |
| C-004 | Primary and alternate barcode foundation           | DONE   | Variant barcode model         |
| C-005 | Collections, seasons, and style codes foundation   | DONE   | Fashion module                |
| C-006 | Audited variant price editing                      | DONE   | Existing catalog feature      |
| C-007 | Variant price history and restoration              | DONE   | Existing catalog feature      |
| C-008 | Category and brand management CRUD                 | TODO   | Required for V1               |
| C-009 | Complete product CRUD                              | TODO   | Required for V1               |
| C-010 | Complete variant and barcode CRUD                  | TODO   | Required for V1               |
| C-011 | Bulk catalog import with preview and validation    | TODO   | Required for store onboarding |
| C-012 | Catalog export                                     | TODO   | Required for operations       |
| C-013 | Barcode label generation and printing              | TODO   | Required for store operations |
| C-014 | POS catalog snapshot refresh after catalog changes | UAT    | Existing POS cache workflow   |

---

# D. Inventory

| ID    | Feature                                    | Status | Reference                    |
| ----- | ------------------------------------------ | ------ | ---------------------------- |
| I-001 | Stock locations                            | DONE   | Inventory foundation         |
| I-002 | Stock balances                             | DONE   | Inventory foundation         |
| I-003 | Stock movement ledger                      | DONE   | Inventory foundation         |
| I-004 | Opening balance workflow                   | DONE   | Inventory workflow           |
| I-005 | Stock transfer creation and shipping       | DONE   | Transfers module             |
| I-006 | Transfer quantity approval                 | DONE   | `a66b31b`                    |
| I-007 | Transfer cancellation                      | DONE   | `6367f13`                    |
| I-008 | Transfer receiving discrepancies           | DONE   | `ca99088`                    |
| I-009 | Stock count opening and snapshot           | DONE   | Stock count workflow         |
| I-010 | Stock count entry and variance calculation | DONE   | Stock count workflow         |
| I-011 | Stock count approval and movements         | DONE   | Stock count workflow         |
| I-012 | Stock count cancellation and audit         | DONE   | Stock count workflow         |
| I-013 | Damaged inventory workflow                 | DONE   | Inventory exception workflow |
| I-014 | Inspection inventory workflow              | DONE   | Inventory exception workflow |
| I-015 | Return-location inventory workflow         | DONE   | Inventory exception workflow |
| I-016 | Reorder rules and shortage alerts          | UAT    | Existing reporting feature   |
| I-017 | General approved stock adjustments         | TODO   | Separate from stock count    |
| I-018 | Stock valuation                            | TODO   | Depends on costing           |
| I-019 | Inventory movement report                  | TODO   | Required for V1              |
| I-020 | Inventory acceptance test suite            | NEXT   | Included in baseline UAT     |

---

# E. Procurement and Supplier Finance

| ID    | Feature                               | Status  | Reference                                         |
| ----- | ------------------------------------- | ------- | ------------------------------------------------- |
| P-001 | Supplier management                   | DONE    | Suppliers module                                  |
| P-002 | Direct purchase receipts              | DONE    | Purchases module                                  |
| P-003 | Purchase orders                       | DONE    | Purchase order module                             |
| P-004 | Partial purchase receiving            | DONE    | Purchase order workflow                           |
| P-005 | Procurement session context isolation | DONE    | `4aa6a6b`                                         |
| P-006 | Supplier invoices                     | DONE    | `3125d53`                                         |
| P-007 | Partial and full supplier payments    | DONE    | `3125d53`                                         |
| P-008 | Supplier payment idempotency          | DONE    | `e7d8726`                                         |
| P-009 | Supplier returns                      | DONE    | `15f6052`                                         |
| P-010 | Supplier credit notes                 | DONE    | `15f6052`                                         |
| P-011 | Supplier balance updates              | DONE    | Supplier finance workflow                         |
| P-012 | Purchase order approval lifecycle     | TODO    | Draft, approval, cancellation, closure            |
| P-013 | Landed costs                          | TODO    | Freight, customs, and additional expenses         |
| P-014 | Weighted-average inventory costing    | PARTIAL | Foundation complete; purchase receipts integrated |
| P-015 | Cost snapshot on sale items           | DONE    | Online and offline sale snapshots integrated      |
| P-016 | Procurement acceptance tests          | NEXT    | Included in baseline UAT                          |

---

# F. Sales, Returns, Exchanges, and Receivables

| ID    | Feature                                       | Status | Reference                               |
| ----- | --------------------------------------------- | ------ | --------------------------------------- |
| S-001 | Core sale creation                            | DONE   | Sales workflow                          |
| S-002 | Trusted server-side inventory deduction       | DONE   | Sales workflow                          |
| S-003 | Online sale idempotency                       | DONE   | Sales workflow                          |
| S-004 | Sale history and details                      | DONE   | Web Admin                               |
| S-005 | Safe sale void and reversal                   | UAT    | Sales workflow                          |
| S-006 | Core customer returns                         | DONE   | Returns workflow                        |
| S-007 | Return quantity protection                    | DONE   | Returns workflow                        |
| S-008 | Return payment and inventory reversal         | UAT    | Returns workflow                        |
| S-009 | Exchange workflow                             | DONE   | Exchanges module                        |
| S-010 | Exchange payment difference                   | UAT    | Exchanges module                        |
| S-011 | Sales, returns, and exchanges session context | DONE   | `975f0a9`                               |
| S-012 | Customer credit policy                        | DONE   | `dab76b8`                               |
| S-013 | Credit and partially paid sales               | DONE   | `dab76b8`                               |
| S-014 | Customer credit-limit enforcement             | DONE   | `dab76b8`                               |
| S-015 | Customer collections                          | DONE   | `dab76b8`                               |
| S-016 | Customer account statement                    | DONE   | `dab76b8`                               |
| S-017 | Collection retry and reversal handling        | DONE   | `9cf7f1d`                               |
| S-018 | Pricing engine                                | TODO   | Price lists and branch/customer pricing |
| S-019 | Line and invoice discounts                    | TODO   | Server-calculated                       |
| S-020 | Discount limits and manager approval          | TODO   | Required for POS                        |
| S-021 | Tax engine                                    | TODO   | Inclusive/exclusive and exempt products |
| S-022 | Promotion engine                              | TODO   | Quantity, product, and customer rules   |
| S-023 | Hold and resume sales                         | TODO   | Online and offline policy               |
| S-024 | Mixed payments                                | TODO   | Cash, card, wallet, bank                |
| S-025 | Refund-to-original-method policy              | TODO   | Permission controlled                   |
| S-026 | Customer duplicate detection and merge        | TODO   | Advanced customer management            |
| S-027 | Customer loyalty                              | LATER  | Not required for initial V1             |
| S-028 | Commercial acceptance tests                   | NEXT   | Included in baseline UAT                |

---

# G. Desktop POS and POS Sync

| ID    | Feature                              | Status | Reference                             |
| ----- | ------------------------------------ | ------ | ------------------------------------- |
| D-001 | Electron Desktop POS foundation      | DONE   | Existing application                  |
| D-002 | Secure device setup                  | DONE   | Desktop POS                           |
| D-003 | Cashier login and workspace          | DONE   | Desktop POS                           |
| D-004 | Barcode and product search           | DONE   | Desktop POS                           |
| D-005 | Local catalog cache                  | DONE   | Desktop POS                           |
| D-006 | Offline workspace restoration        | DONE   | Desktop POS                           |
| D-007 | Offline pending-sales outbox         | DONE   | Desktop POS                           |
| D-008 | No local stock deduction             | DONE   | Core architecture rule                |
| D-009 | Automatic and manual synchronization | DONE   | Desktop POS                           |
| D-010 | Cashier offline grants               | DONE   | POS security                          |
| D-011 | Cashier shift opening                | DONE   | Cashier shifts                        |
| D-012 | Cashier shift closing and settlement | DONE   | Cashier shifts                        |
| D-013 | Pending-sale closure protection      | DONE   | Cashier shifts                        |
| D-014 | Price-conflict resolution            | UAT    | POS sync conflict workflow            |
| D-015 | Stock-conflict resolution            | UAT    | POS sync conflict workflow            |
| D-016 | Admin sync monitoring                | DONE   | Web Admin                             |
| D-017 | Receipt printing                     | TODO   | Required for V1                       |
| D-018 | Reprinting with audit                | TODO   | Required for V1                       |
| D-019 | Cash drawer movements                | TODO   | Cash in, cash out, expenses           |
| D-020 | Windows installer                    | TODO   | Required before branch deployment     |
| D-021 | Update strategy                      | TODO   | Required before commercial deployment |
| D-022 | Desktop POS full offline/online UAT  | NEXT   | Immediate execution priority          |

---

# H. Reports

| ID    | Feature                                   | Status | Reference                         |
| ----- | ----------------------------------------- | ------ | --------------------------------- |
| R-001 | Basic dashboard                           | DONE   | Web Admin                         |
| R-002 | Sales performance analytics               | UAT    | Existing report                   |
| R-003 | Product performance analytics             | UAT    | Existing report                   |
| R-004 | Reorder and shortage report               | UAT    | Existing report                   |
| R-005 | Customer receivables report               | DONE   | Receivables workspace             |
| R-006 | Supplier outstanding balances             | DONE   | Supplier finance workspace        |
| R-007 | Profitability reporting                   | UAT    | Backend endpoint integrated       |
| R-008 | Stock valuation report                    | TODO   | Depends on costing                |
| R-009 | Inventory movement ledger report          | TODO   | Required for V1                   |
| R-010 | Purchase and supplier reports             | TODO   | Required for V1                   |
| R-011 | Transfer and stock-count reports          | TODO   | Required for V1                   |
| R-012 | Damaged and inspection stock reports      | TODO   | Required for V1                   |
| R-013 | Cashier shift and cash-difference reports | TODO   | Required for V1                   |
| R-014 | Fashion size/color/season analysis        | TODO   | Required for Fashion V1           |
| R-015 | CSV and Excel export                      | TODO   | Required for V1                   |
| R-016 | PDF report export                         | TODO   | Can follow core report completion |

---

# I. Settings, Audit, and Operations

| ID    | Feature                                   | Status  | Reference                           |
| ----- | ----------------------------------------- | ------- | ----------------------------------- |
| O-001 | Core audit-log table and business logging | PARTIAL | Used by major workflows             |
| O-002 | Central audit search UI                   | TODO    | Required for governance             |
| O-003 | Company settings                          | TODO    | Currency, logo, tax, timezone       |
| O-004 | Branch settings                           | TODO    | POS and numbering configuration     |
| O-005 | Document numbering sequences              | TODO    | Replace timestamp-generated numbers |
| O-006 | Backup policy                             | TODO    | Required before production          |
| O-007 | Tested database restore procedure         | TODO    | Required before production          |
| O-008 | Structured logs and correlation IDs       | TODO    | Required before production          |
| O-009 | Health and readiness endpoints            | TODO    | Required before deployment          |
| O-010 | Error monitoring and alerts               | TODO    | Required before production          |
| O-011 | Environment separation                    | TODO    | Development, staging, production    |
| O-012 | Deployment pipeline                       | TODO    | Required before V1 release          |
| O-013 | Production security review                | TODO    | Required before V1 release          |

---

# J. Testing and Release

| ID    | Feature                               | Status | Reference                    |
| ----- | ------------------------------------- | ------ | ---------------------------- |
| T-001 | Integrated current-baseline UAT       | NEXT   | Immediate priority           |
| T-002 | Record and classify UAT findings      | TODO   | After T-001                  |
| T-003 | Fix blockers and critical regressions | TODO   | After T-002                  |
| T-004 | Freeze internal baseline              | TODO   | After blocker closure        |
| T-005 | Automated API integration tests       | TODO   | Required for V1              |
| T-006 | Idempotency and concurrency tests     | TODO   | Required for V1              |
| T-007 | Tenant isolation tests                | TODO   | Required for V1              |
| T-008 | Desktop POS integration tests         | TODO   | Required for V1              |
| T-009 | Clean-database migration test         | TODO   | Required for every release   |
| T-010 | Branch pilot UAT                      | TODO   | Final pre-release validation |
| T-011 | User operating guide                  | TODO   | Required for store rollout   |
| T-012 | ERPSYS Online V1 release              | TODO   | Final V1 milestone           |

---

# K. Explicitly Postponed

| ID    | Feature                                   | Status |
| ----- | ----------------------------------------- | ------ |
| L-001 | SaaS subscriptions and billing            | LATER  |
| L-002 | Self-service tenant onboarding            | LATER  |
| L-003 | Mobile applications                       | LATER  |
| L-004 | AI forecasting and recommendations        | LATER  |
| L-005 | OCR supplier invoices                     | LATER  |
| L-006 | Separate reporting microservice           | LATER  |
| L-007 | Restaurant, pharmacy, and other verticals | LATER  |

---

# Immediate Execution Order

The following order is fixed unless a blocker is discovered:

1. `T-001` Integrated current-baseline UAT.
2. `T-002` Record and classify findings.
3. `T-003` Fix blockers and critical regressions.
4. `T-004` Freeze internal baseline.
5. `C-008` Category and brand management.
6. `C-009` Complete product management.
7. `C-010` Complete variant and barcode management.
8. `I-017` Approved stock adjustments.
9. `P-012` Purchase order approval lifecycle.
10. `P-014` Complete purchase, transfer, and return costing integration.
11. `P-015` Complete sale cost and gross-profit snapshots.
12. `S-018` Pricing engine.
13. `S-019` Discounts.
14. `S-021` Taxes.
15. `S-022` Promotions.
16. `S-023` Hold and resume sales.
17. `S-024` Mixed payments.
18. `D-017` Receipt printing.
19. `D-019` Cash drawer movements.
20. Complete operational reports.
21. Complete automated tests.
22. Packaging, backup, security, deployment, and branch pilot.

## Backlog Update Rule

After every completed feature:

1. Change its status in this file.
2. Add the actual commit SHA.
3. Update `docs/roadmap.md`.
4. Update relevant files under `docs/features`.
5. Run `npm run check`.
6. Commit documentation with the feature whenever possible.
7. Do not begin the next backlog item before documentation reflects the current state.
