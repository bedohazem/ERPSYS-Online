-- ============================================================
-- Transfer workflow idempotency and permissions
-- ============================================================

ALTER TABLE transfers
ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
uq_transfers_company_idempotency
ON transfers (
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
        'inventory.transfer.view',
        'View inventory transfers'
    ),
    (
        'inventory.transfer.create',
        'Create inventory transfers'
    ),
    (
        'inventory.transfer.approve',
        'Ship and approve inventory transfers'
    ),
    (
        'inventory.transfer.receive',
        'Receive inventory transfers'
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
      'inventory.transfer.view',
      'inventory.transfer.create',
      'inventory.transfer.approve',
      'inventory.transfer.receive'
  )
ON CONFLICT DO NOTHING;