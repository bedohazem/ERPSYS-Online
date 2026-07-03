# Offline POS Rules

## Allowed Local Storage

The Desktop POS can store only:

- pending_sales
- sync_logs
- device_state

## Forbidden Local Storage

The Desktop POS must not store full ERP tables such as:

- products
- stock
- stock_movements
- warehouses
- accounting records

## Offline Sale Flow

1. Cashier creates a sale.
2. POS detects that API is unavailable.
3. POS saves sale as pending.
4. POS prints a local pending receipt.
5. POS retries sync when API is available.
6. API processes the sale in PostgreSQL.
7. POS marks the local pending sale as synced.

## Stock Rule

No local stock deduction is allowed.
All stock deductions happen only inside the backend API.
