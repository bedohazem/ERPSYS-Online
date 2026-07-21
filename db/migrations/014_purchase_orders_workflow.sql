-- ============================================================
-- Purchase orders workflow
-- ============================================================

ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS idempotency_key TEXT;


CREATE UNIQUE INDEX IF NOT EXISTS
uq_purchase_orders_company_idempotency
ON purchase_orders (
    company_id,
    idempotency_key
)
WHERE idempotency_key IS NOT NULL;


-- تسريع استرجاع الأوامر المرتبطة بالفرع والمورد.
CREATE INDEX IF NOT EXISTS
idx_purchase_orders_company_branch
ON purchase_orders (
    company_id,
    branch_id,
    order_date DESC
);


-- منع تكرار نفس الصنف داخل أمر الشراء الواحد.
CREATE UNIQUE INDEX IF NOT EXISTS
uq_purchase_order_items_order_variant
ON purchase_order_items (
    company_id,
    purchase_order_id,
    variant_id
);