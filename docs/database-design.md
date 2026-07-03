# Database Design

## Source of Truth

PostgreSQL is the only source of truth.

## Core Tables

- companies
- branches
- users
- devices
- products
- warehouses
- stock_balances
- stock_movements
- sales
- sale_items
- payments
- offline_sync_batches
- offline_sync_items
- audit_logs

## Stock Principle

Every stock change must create a stock_movement.

stock_balances is the current quantity summary.

stock_movements is the historical source for tracking.
