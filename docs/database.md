# Database Design

## Source of Truth

PostgreSQL is the only source of truth.

## Multi-Tenant Ready

The database must be ready for multiple companies later.

Each company or brand must have isolated data.

Important business tables should include company_id when needed.

## Core Entities

- companies
- branches
- users
- roles
- permissions
- products
- product_categories
- stock_locations
- stock_balances
- stock_movements
- transfers
- sales
- sale_items
- payments
- returns
- exchanges
- purchases
- customers
- suppliers
- audit_logs

## Fashion Entities

- product_variants
- sizes
- colors
- seasons
- collections
- style_codes
- variant_barcodes

## Product Model

Core product contains general information:

- product_id
- company_id
- name
- category
- brand
- base_price
- tax
- status

Fashion extension contains fashion-specific data:

- style_code
- color
- size
- season
- collection
- variant_barcode

## Stock Locations

The system must support multiple stock locations, not one warehouse only.

Examples:

- main warehouse
- branch warehouse
- branch sales floor
- returns warehouse
- damaged stock
- under inspection

## Stock Movement Rule

Every stock change must create a stock_movement.

Examples:

- purchase
- sale
- return
- exchange
- transfer
- adjustment
- damage
- stock count

stock_balances stores the current quantity.

stock_movements stores the historical truth.
