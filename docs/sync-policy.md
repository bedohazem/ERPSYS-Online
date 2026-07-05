# POS Sync Policy

## Main Rule

Desktop POS can work offline, but it must only store pending sales.

## Forbidden

The POS must not:

- deduct local stock
- store local stock as a source of truth
- write directly to PostgreSQL
- bypass the Backend API
- create final server invoices locally

## Offline Sale Flow

1. Cashier creates a sale.
2. POS detects that the API is unavailable.
3. POS saves the sale as pending locally.
4. POS prints a pending receipt if needed.
5. POS retries sync when the API is available.
6. Backend API validates and processes the sale.
7. Backend API deducts stock in PostgreSQL.
8. POS marks the local pending sale as synced.

## Idempotency

Each sale must have an idempotency key.

This prevents duplicate invoices if the POS retries the same pending sale more than once.

## Stock Conflict Policy

If an offline sale causes stock conflict, the Backend should record the sale and flag it for review instead of silently losing the transaction.

## Local Storage Allowed

- pending_sales
- sync_logs
- device_state

## Local Storage Forbidden

- products as a source of truth
- stock
- stock_movements
- accounting records
- full ERP database copy
