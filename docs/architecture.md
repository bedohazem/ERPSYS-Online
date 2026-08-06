# ERPSYS Online Architecture

## Current Reference

- Architecture style: Modular Monolith
- Database: PostgreSQL
- Primary branch: `main`
- Current scope: Fashion Retail ERP/POS V1
- Detailed execution backlog: [backlog.md](./backlog.md)

## Product Shape

ERPSYS Online is built as:

**General ERP/POS Core**

plus

**Fashion Retail as the first vertical module**

The system serves the owner's stores first while remaining ready for future commercial use.

SaaS subscriptions, AI services, mobile applications, extra verticals, and premature microservices are explicitly postponed until after V1.

## Main Architecture Rules

1. PostgreSQL is the only source of truth.
2. All business interfaces communicate with the Backend API.
3. Web Admin and Desktop POS never connect directly to PostgreSQL.
4. The Backend never trusts company, branch, or user identifiers sent by a frontend.
5. Company, branch, and user context comes from the authenticated session.
6. Important writes execute inside PostgreSQL transactions.
7. Retryable business operations use idempotency keys.
8. Inventory changes create stock movements.
9. Financial changes create traceable financial records.
10. Important business actions create audit logs.
11. V1 remains a Modular Monolith.

## Repository Structure

```text
apps/
  web-admin/
  desktop-pos/

services/
  api/

packages/
  database/
  shared/
  ui/
  validation/

docs/
  architecture.md
  backlog.md
  database.md
  roadmap.md
  sync-policy.md
  uat-baseline.md
  product-strategy.md
  features/
```
