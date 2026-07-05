# Architecture

## Architecture Type

Modular Monolith.

## Reason

A modular monolith is simpler than microservices at the beginning, but still allows the system to grow in a clean way.

## Main Rule

PostgreSQL is the only source of truth.

## Data Access Rule

Only the Backend API can write to PostgreSQL.

No frontend app can access the database directly.

## Applications

- Web Admin
- Desktop POS
- Mobile App later
- Landing Website later

## Services

- API now
- Worker later
- Reporting Service later
- AI Service later

## Core ERP Modules

- auth
- companies
- branches
- users
- roles
- permissions
- products
- inventory
- stock-locations
- stock-movements
- transfers
- sales
- returns
- exchanges
- purchases
- customers
- suppliers
- reports
- pos-sync
- audit-log
- settings

## Future Modules

- subscriptions
- notifications
- ai
- mobile
- restaurant
- pharmacy
- electronics
- auto-parts
- supermarket

## First Vertical Module

Fashion Retail.

## Fashion Module

- product variants
- sizes
- colors
- collections
- seasons
- style codes
- variant barcodes
- size-color matrix
- branch size-color stock
- fashion sales analysis

## Multi-Tenant Readiness

The system must be designed so each company can see only its own data.

Core business tables should include company_id or tenant_id where needed.

## Current Development Rule

Do not build UI before architecture and database are clear.
