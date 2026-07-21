-- ============================================================
-- Purchases workflow permissions and idempotency
-- ============================================================

ALTER TABLE purchase_receipts
ADD COLUMN IF NOT EXISTS idempotency_key TEXT;


CREATE UNIQUE INDEX IF NOT EXISTS
uq_purchase_receipts_company_idempotency
ON purchase_receipts (
    company_id,
    idempotency_key
)
WHERE idempotency_key IS NOT NULL;


INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'suppliers.view',
        'View suppliers'
    ),
    (
        'suppliers.manage',
        'Create and update suppliers'
    ),
    (
        'purchases.view',
        'View purchase receipts'
    ),
    (
        'purchases.create',
        'Create and receive purchases'
    )
ON CONFLICT (code)
DO UPDATE SET
    description = EXCLUDED.description;


-- منح الصلاحيات الجديدة تلقائيًا لدور admin.
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
      'suppliers.view',
      'suppliers.manage',
      'purchases.view',
      'purchases.create'
  )
ON CONFLICT DO NOTHING;