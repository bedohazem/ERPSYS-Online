# ERPSYS Online

Modular ERP/POS Platform starting with Fashion Retail.

## Product Direction

ERPSYS Online is not a huge generic ERP from day one, and it is not locked to fashion forever.

The correct direction is:

General ERP/POS Core

**+**

Fashion Retail Module first

## Current Goal

Build a real system for managing fashion retail branches, inventory, sales, returns, exchanges, and POS operations.

## Future Goal

Turn the system into a SaaS product for small and medium retail brands.

## Core Rules

- PostgreSQL is the only source of truth.
- Backend API is the only gateway for data changes.
- Web Admin is used for management, inventory, and reports.
- Desktop POS is used by cashiers and branches.
- POS can work when internet or server is down.
- Offline POS stores pending sales only.
- Offline POS must never deduct local stock.
- Pending sales are synced to the Backend API when the server is available.
- All stock deductions happen only inside the Backend API.
- No frontend app talks directly to the database.

## Main Apps

- apps/web-admin
- apps/desktop-pos
- apps/mobile-app later
- apps/landing-website later

## Main Services

- services/api
- services/worker later
- services/reporting-service later
- services/ai-service later

## Packages

- packages/database
- packages/shared
- packages/ui
- packages/validation

## First Vertical

Fashion Retail ERP/POS.

## Project Documentation

- [Architecture](./docs/architecture.md)
- [Database](./docs/database.md)
- [Roadmap](./docs/roadmap.md)
- [Sales Management](./docs/features/sales.md)
- [Cashier Shifts and Settlement](./docs/features/cashier-shifts.md)
- [Exchange Management](./docs/features/exchanges.md)
- [Return Management](./docs/features/returns.md)
- [Sales Performance Analytics](./docs/features/sales-performance.md)
- [Product Performance Analytics](./docs/features/product-performance.md)
