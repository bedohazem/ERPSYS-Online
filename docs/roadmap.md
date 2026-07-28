# Roadmap

## Phase 1 - Foundation

- Product strategy
- Architecture docs
- Database design
- Initial repo structure
- Local PostgreSQL setup
- Migration runner

## Phase 2 - Backend Core

- API foundation
- Auth
- Users
- Roles
- Permissions
- Companies
- Branches

## Phase 3 - Products and Fashion

- Core products
- Sizes
- Colors
- Product variants
- Variant barcodes
- SKU rules

## Phase 4 - Inventory

- Stock locations
- Stock balances
- Stock movements
- Transfers between locations
- Transfers between branches

## Phase 5 - Sales

- ✅ Sales invoices and payments — implementation completed
  - Secure Web Admin and POS sale creation
  - PostgreSQL trusted pricing and inventory deduction
  - Payment and customer-change validation
  - Idempotent online and offline synchronization
  - Sale history and detailed financial records
  - Returns and exchanges integration
  - Safe void with stock and payment reversals
  - Cashier-shift-safe void accounting
  - Branch isolation and audit trail
  - 🧪 Final integrated acceptance test pending
- ✅ Returns — implementation completed
  - Secure return creation from completed sales
  - Original sale price and quantity validation
  - Returns and exchanges share remaining quantity protection
  - Customer refund records
  - Inventory increase and stock movements
  - Return history and detailed financial records
  - Safe void with stock and refund reversals
  - Branch isolation and audit trail
  - 🧪 Final integrated acceptance test pending
- ✅ Exchanges — implementation completed
  - Secure exchange creation
  - Returned and issued item inventory movements
  - Customer payment or refund difference
  - Exchange history and details
  - Safe void with inventory and payment reversals
  - Audit trail
  - 🧪 Final integrated acceptance test pending
- ✅ Cashier shifts and cash settlement — implementation completed
  - Secure online shift opening and closure
  - Encrypted active-shift cache for Offline POS continuity
  - Pending-sale and logout closure protections
  - PostgreSQL net cash calculation
  - Sales, returns and exchanges cash effects
  - Expected cash and shortage/overage calculation
  - Versioned permanent settlement snapshot
  - Optional Desktop POS closing note
  - Transactional audit trail
  - Web Admin shift history and settlement details
  - Branch isolation
  - 🧪 Final integrated acceptance test pending

## Phase 6 - Web Admin

- Dashboard
- Products
- Branches
- Inventory
- Transfers
- Sales
- Reports
- Users and permissions

## Phase 7 - Desktop POS

- Fast sales screen
- Barcode support
- Product search
- Fashion size/color support
- Receipt printing
- Offline pending sales
- Sync status

## Phase 8 - Reports

- ✅ Sales performance analytics — implementation completed
  - Flexible date range up to 366 days
  - Company, branch and cashier filters
  - Daily, branch and cashier aggregation
  - Gross sales and average invoice value
  - Returns and exchanges financial effects
  - Net revenue calculation
  - Voided and pending-review visibility
  - Tenant and branch isolation
  - Web Admin summary, chart and detailed tables
  - Consistent filter reset and stale-data protection
  - 🧪 Final integrated acceptance test pending
- ✅ Product performance analytics — implementation completed
  - Top-selling product variants
  - Slow-moving stocked variants
  - Date and branch filters
  - Current PostgreSQL stock integration
  - Gross quantity and revenue ranking
  - No-sale stock visibility
  - Size, color, category and brand details
  - Authenticated branch restriction
  - Web Admin summary, chart and detailed tables
  - 🧪 Final integrated acceptance test pending
- ✅ Inventory reorder rules and shortage alerts — implementation completed
  - Reorder point per product variant and stock location
  - Safety stock and fixed reorder quantity
  - Critical, low and healthy stock classification
  - Suggested purchase quantities
  - PostgreSQL current-stock integration
  - Company, branch and stock-location isolation
  - Secure SKU and barcode lookup
  - Transactional audit logging
  - Web Admin shortage report
  - Web Admin reorder-rule management
  - Search, filters and pagination
  - Cancellation-safe asynchronous lookup
  - 🧪 Final integrated acceptance test pending
- Profits
- Returns
- Transfers
- Product movement report

## Phase 9 - SaaS Readiness

- Tenant isolation
- Subscription plans later
- Billing later
- Tenant settings
- Security hardening

## Phase 10 - Future

- Mobile apps
- AI service
- Advanced analytics
- OCR supplier invoices
- Demand forecasting

## Feature Documentation

- [Cashier Shifts and Settlement](./features/cashier-shifts.md)
- [Sales Management](./features/sales.md)
- [Exchange Management](./features/exchanges.md)
- [Return Management](./features/returns.md)
- [Sales Performance Analytics](./features/sales-performance.md)
- [Product Performance Analytics](./features/product-performance.md)
- [Inventory Reorder Rules and Shortage Alerts](./features/inventory-reorder-and-shortages.md)
