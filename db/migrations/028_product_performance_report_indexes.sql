-- ============================================================
-- Product performance report indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS
idx_sales_product_performance
ON sales (
    company_id,
    branch_id,
    occurred_at DESC,
    id
)
WHERE status IN (
    'completed',
    'pending_review',
    'refunded'
);

CREATE INDEX IF NOT EXISTS
idx_sale_items_product_performance
ON sale_items (
    company_id,
    sale_id,
    variant_id
);

CREATE INDEX IF NOT EXISTS
idx_stock_balances_product_performance
ON stock_balances (
    company_id,
    branch_id,
    variant_id
);

