-- ============================================================
-- POS device security and management permissions
-- ============================================================

ALTER TABLE pos_devices
ADD COLUMN IF NOT EXISTS device_secret_hash TEXT;

ALTER TABLE pos_devices
ADD COLUMN IF NOT EXISTS secret_rotated_at TIMESTAMPTZ;

ALTER TABLE pos_devices
ADD COLUMN IF NOT EXISTS created_by UUID
REFERENCES users(id)
ON DELETE SET NULL;

ALTER TABLE pos_devices
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
NOT NULL
DEFAULT NOW();


-- لا نخزن المفتاح السري الخام.
-- نخزن SHA-256 فقط، ويظهر المفتاح الخام مرة واحدة عند إنشائه.
CREATE UNIQUE INDEX IF NOT EXISTS
uq_pos_devices_secret_hash
ON pos_devices (
    device_secret_hash
)
WHERE device_secret_hash IS NOT NULL;


CREATE INDEX IF NOT EXISTS
idx_pos_devices_company_status
ON pos_devices (
    company_id,
    status
);


INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'pos.devices.view',
        'View registered POS devices'
    ),
    (
        'pos.devices.manage',
        'Register, block and rotate POS devices'
    ),
    (
        'pos.sync.view',
        'View POS offline synchronization activity'
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
      'pos.devices.view',
      'pos.devices.manage',
      'pos.sync.view'
  )
ON CONFLICT DO NOTHING;