-- ======================================================
-- Exchange Permissions
-- ======================================================

INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'exchanges.view',
        'View exchanges'
    ),
    (
        'exchanges.create',
        'Create exchanges'
    ),
    (
        'exchanges.void',
        'Void completed exchanges'
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
      'exchanges.view',
      'exchanges.create',
      'exchanges.void'
  )
ON CONFLICT DO NOTHING;