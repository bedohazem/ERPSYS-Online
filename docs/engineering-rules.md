# ERPSYS Online Engineering Rules

These rules apply to all active V1 development.

## Architecture

### ER-001 — Modular Monolith

V1 remains a Modular Monolith.

Do not introduce microservices without an approved ADR.

### ER-002 — PostgreSQL Source of Truth

PostgreSQL is the only authoritative business-data store.

### ER-003 — Backend API Boundary

Web Admin and Desktop POS access business data through the Backend API only.

### ER-004 — Session Context

Company, branch, and user context come from the authenticated server session.

The Backend must not trust these identifiers from frontend input.

## Inventory

### ER-005 — No Untracked Stock Update

Every approved stock change must update `stock_balances` and create a linked `stock_movement` inside one transaction.

### ER-006 — No Direct Average-Cost Editing

`stock_balances.average_cost` cannot be edited manually through ordinary CRUD.

### ER-007 — Costed Inventory Movement

Cost-affecting movements must record enough information to explain quantity and inventory-value changes.

### ER-008 — No Local POS Stock Deduction

Desktop POS never deducts stock locally.

### ER-009 — Row Locking

Stock and cost operations must lock affected balance rows before calculating new values.

### ER-010 — Predictable Lock Order

Operations affecting multiple variants must lock them in a stable deterministic order.

## Sales and Finance

### ER-011 — Backend Financial Calculation

The Backend calculates or verifies all authoritative totals.

Frontend calculations are previews only.

### ER-012 — Sale Cost Snapshot

Every new posted sale item must preserve its historical unit cost and total cost.

### ER-013 — No Financial Deletion

Posted financial records are corrected through reversal, cancellation, credit, or revaluation workflows.

### ER-014 — Idempotent Retry

Retryable business writes require a stable idempotency key.

### ER-015 — Atomic Business Write

A workflow changing several business records must run inside one PostgreSQL transaction.

## Security and Governance

### ER-016 — Default Deny

Business routes require an explicit permission policy.

### ER-017 — Tenant-Aware Relations

Tenant-owned relations must verify that both records belong to the same company.

### ER-018 — Audit Important Actions

Important inventory, financial, pricing, permission, and approval actions require audit logs.

### ER-019 — No Secrets in Git

Database credentials, device secrets, tokens, and private keys must not be committed.

## Quality

### ER-020 — Migration Required

Every schema change requires a numbered migration.

### ER-021 — Clean Database Compatibility

All migrations must run successfully on a clean database.

### ER-022 — Check Before Commit

`npm run check` must succeed before committing.

### ER-023 — Documentation Is Living State

Every completed feature updates the Master Backlog and relevant documentation.

### ER-024 — Feature Definition of Done

A feature is not complete until its database, Backend, permissions, validation, transactions, audit, interface, UAT, and documentation requirements are addressed where applicable.
