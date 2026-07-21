-- ============================================================
-- POS offline sales synchronization
-- ============================================================

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS pos_device_id UUID
REFERENCES pos_devices(id)
ON DELETE SET NULL;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;

UPDATE sales
SET occurred_at = created_at
WHERE occurred_at IS NULL;

ALTER TABLE sales
ALTER COLUMN occurred_at
SET DEFAULT NOW();

ALTER TABLE sales
ALTER COLUMN occurred_at
SET NOT NULL;


CREATE UNIQUE INDEX IF NOT EXISTS
uq_sales_offline_device_local_sale
ON sales (
    company_id,
    pos_device_id,
    local_sale_id
)
WHERE source = 'offline_pos'
  AND pos_device_id IS NOT NULL
  AND local_sale_id IS NOT NULL;


CREATE INDEX IF NOT EXISTS
idx_sales_pos_device
ON sales (
    company_id,
    pos_device_id,
    occurred_at DESC
);


ALTER TABLE pos_offline_sync_batches
ADD COLUMN IF NOT EXISTS total_items INTEGER
NOT NULL
DEFAULT 0;

ALTER TABLE pos_offline_sync_batches
ADD COLUMN IF NOT EXISTS processed_items INTEGER
NOT NULL
DEFAULT 0;

ALTER TABLE pos_offline_sync_batches
ADD COLUMN IF NOT EXISTS review_items INTEGER
NOT NULL
DEFAULT 0;

ALTER TABLE pos_offline_sync_batches
ADD COLUMN IF NOT EXISTS failed_items INTEGER
NOT NULL
DEFAULT 0;


ALTER TABLE pos_offline_sync_items
ADD COLUMN IF NOT EXISTS item_payload JSONB;

ALTER TABLE pos_offline_sync_items
ADD COLUMN IF NOT EXISTS result_payload JSONB;

ALTER TABLE pos_offline_sync_items
ADD COLUMN IF NOT EXISTS attempt_count INTEGER
NOT NULL
DEFAULT 0;

ALTER TABLE pos_offline_sync_items
ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;


-- توسيع أنواع التعارضات التي يمكن تسجيلها.
ALTER TABLE pos_pending_conflicts
DROP CONSTRAINT IF EXISTS
pos_pending_conflicts_conflict_type_check;

ALTER TABLE pos_pending_conflicts
ADD CONSTRAINT pos_pending_conflicts_conflict_type_check
CHECK (
    conflict_type IN (
        'negative_stock',
        'price_changed',
        'variant_not_found',
        'cashier_not_found',
        'stock_location_not_found',
        'customer_not_found',
        'shift_not_found',
        'payment_mismatch',
        'invalid_payload',
        'duplicate_suspected',
        'unknown'
    )
);


INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'pos.sync.manage',
        'Review and manage POS synchronization conflicts'
    )
ON CONFLICT (code)
DO UPDATE SET
    description = EXCLUDED.description;


INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    roles.id,
    permissions.id
FROM roles
CROSS JOIN permissions
WHERE roles.code = 'admin'
  AND permissions.code IN (
      'pos.sync.view',
      'pos.sync.manage'
  )
ON CONFLICT DO NOTHING;