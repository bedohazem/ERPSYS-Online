-- ============================================================
-- الصلاحيات الأساسية للنظام
-- ثم منحها تلقائيًا لكل Role اسمه admin.
-- ============================================================

INSERT INTO permissions (code, description)
VALUES
    ('dashboard.view', 'View dashboard'),

    ('products.view', 'View products'),
    ('products.manage', 'Create and update products'),

    ('customers.view', 'View customers'),
    ('customers.manage', 'Create and update customers'),

    ('inventory.view', 'View inventory'),
    ('inventory.adjust', 'Adjust inventory quantities'),

    ('sales.view', 'View sales'),
    ('sales.create', 'Create sales'),
    ('sales.discount', 'Apply sale discounts'),
    ('sales.void', 'Void completed sales'),

    ('returns.view', 'View returns'),
    ('returns.create', 'Create returns'),
    ('returns.void', 'Void completed returns'),

    ('reports.view', 'View reports'),

    ('users.manage', 'Manage users'),
    ('roles.manage', 'Manage roles and permissions')
ON CONFLICT (code)
DO UPDATE SET
    description = EXCLUDED.description;


-- منح كل الصلاحيات السابقة لدور Admin في كل شركة.
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
      'dashboard.view',
      'products.view',
      'products.manage',
      'customers.view',
      'customers.manage',
      'inventory.view',
      'inventory.adjust',
      'sales.view',
      'sales.create',
      'sales.discount',
      'sales.void',
      'returns.view',
      'returns.create',
      'returns.void',
      'reports.view',
      'users.manage',
      'roles.manage'
  )
ON CONFLICT DO NOTHING;