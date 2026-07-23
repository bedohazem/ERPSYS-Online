-- ======================================================
-- POS Conflict Resolution
--
-- إضافة سجل واضح لطريقة حل التعارض،
-- وإضافة cashier_grant_invalid لأن Backend يستخدمه.
-- ======================================================

ALTER TABLE pos_pending_conflicts
ADD COLUMN IF NOT EXISTS
    resolution_action TEXT;

ALTER TABLE pos_pending_conflicts
ADD COLUMN IF NOT EXISTS
    resolution_note TEXT;

ALTER TABLE pos_pending_conflicts
ADD COLUMN IF NOT EXISTS
    resolved_at TIMESTAMPTZ;

ALTER TABLE pos_pending_conflicts
ADD COLUMN IF NOT EXISTS
    resolved_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL;


ALTER TABLE pos_pending_conflicts
DROP CONSTRAINT IF EXISTS
pos_pending_conflicts_conflict_type_check;

ALTER TABLE pos_pending_conflicts
ADD CONSTRAINT
pos_pending_conflicts_conflict_type_check
CHECK (
    conflict_type IN (
        'negative_stock',
        'price_changed',
        'variant_not_found',
        'cashier_not_found',
        'cashier_grant_invalid',
        'stock_location_not_found',
        'customer_not_found',
        'shift_not_found',
        'payment_mismatch',
        'invalid_payload',
        'duplicate_suspected',
        'unknown'
    )
);


CREATE INDEX IF NOT EXISTS
idx_pos_conflicts_resolved_at
ON pos_pending_conflicts (
    company_id,
    resolved_at DESC
);