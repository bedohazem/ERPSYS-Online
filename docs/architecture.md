# ERPSYS Online Architecture

## Main Rule

PostgreSQL is the only source of truth.

## Applications

- API: backend service that owns all business logic.
- Web Admin: management, inventory, reports, users.
- Desktop POS: cashier application.
- Shared Package: shared types and validation contracts.

## Data Ownership

The API is the only layer allowed to write to PostgreSQL.

Desktop POS must not write directly to PostgreSQL.

Desktop POS must not keep a local ERP database.

## Offline Rule

When the server is unavailable, the POS stores pending sales only.

Offline POS must never deduct local stock.
