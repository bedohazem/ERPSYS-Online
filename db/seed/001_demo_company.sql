WITH demo_company AS (
    INSERT INTO companies (name, legal_name, tax_number)
    VALUES ('Demo Fashion Brand', 'Demo Fashion Brand LLC', 'DEMO-TAX-001')
    ON CONFLICT DO NOTHING
    RETURNING id
),
company_row AS (
    SELECT id FROM demo_company
    UNION
    SELECT id FROM companies WHERE name = 'Demo Fashion Brand'
    LIMIT 1
),
main_branch AS (
    INSERT INTO branches (company_id, code, name, address, phone)
    SELECT id, 'MAIN', 'Main Branch', 'Demo Address', '01000000000'
    FROM company_row
    ON CONFLICT (company_id, code) DO NOTHING
    RETURNING id, company_id
),
branch_row AS (
    SELECT id, company_id FROM main_branch
    UNION
    SELECT b.id, b.company_id
    FROM branches b
    JOIN company_row c ON c.id = b.company_id
    WHERE b.code = 'MAIN'
    LIMIT 1
),
admin_role AS (
    INSERT INTO roles (company_id, name, code, is_system)
    SELECT id, 'Admin', 'admin', TRUE
    FROM company_row
    ON CONFLICT (company_id, code) DO NOTHING
    RETURNING id, company_id
),
role_row AS (
    SELECT id, company_id FROM admin_role
    UNION
    SELECT r.id, r.company_id
    FROM roles r
    JOIN company_row c ON c.id = r.company_id
    WHERE r.code = 'admin'
    LIMIT 1
),
admin_user AS (
    INSERT INTO users (company_id, branch_id, full_name, username, email, password_hash)
    SELECT br.company_id, br.id, 'Demo Admin', 'admin', 'admin@demo.local', 'CHANGE_ME_HASH'
    FROM branch_row br
    ON CONFLICT (company_id, username) DO NOTHING
    RETURNING id, company_id
),
user_row AS (
    SELECT id, company_id FROM admin_user
    UNION
    SELECT u.id, u.company_id
    FROM users u
    JOIN company_row c ON c.id = u.company_id
    WHERE u.username = 'admin'
    LIMIT 1
)
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM user_row u
JOIN role_row r ON r.company_id = u.company_id
ON CONFLICT DO NOTHING;

WITH company_row AS (
    SELECT id FROM companies WHERE name = 'Demo Fashion Brand' LIMIT 1
),
branch_row AS (
    SELECT b.id, b.company_id
    FROM branches b
    JOIN company_row c ON c.id = b.company_id
    WHERE b.code = 'MAIN'
    LIMIT 1
)
INSERT INTO stock_locations (company_id, branch_id, code, name, location_type)
SELECT company_id, id, 'MAIN-WH', 'Main Warehouse', 'main_warehouse'
FROM branch_row
ON CONFLICT (company_id, code) DO NOTHING;

WITH company_row AS (
    SELECT id FROM companies WHERE name = 'Demo Fashion Brand' LIMIT 1
),
branch_row AS (
    SELECT b.id, b.company_id
    FROM branches b
    JOIN company_row c ON c.id = b.company_id
    WHERE b.code = 'MAIN'
    LIMIT 1
)
INSERT INTO stock_locations (company_id, branch_id, code, name, location_type)
SELECT company_id, id, 'MAIN-FLOOR', 'Main Sales Floor', 'sales_floor'
FROM branch_row
ON CONFLICT (company_id, code) DO NOTHING;

WITH company_row AS (
    SELECT id FROM companies WHERE name = 'Demo Fashion Brand' LIMIT 1
)
INSERT INTO fashion_sizes (company_id, name, code, sort_order)
SELECT id, size_name, size_code, sort_order
FROM company_row
CROSS JOIN (
    VALUES
        ('Small', 'S', 1),
        ('Medium', 'M', 2),
        ('Large', 'L', 3),
        ('X Large', 'XL', 4),
        ('XX Large', 'XXL', 5)
) AS sizes(size_name, size_code, sort_order)
ON CONFLICT (company_id, code) DO NOTHING;

WITH company_row AS (
    SELECT id FROM companies WHERE name = 'Demo Fashion Brand' LIMIT 1
)
INSERT INTO fashion_colors (company_id, name, code, hex_code)
SELECT id, color_name, color_code, hex_code
FROM company_row
CROSS JOIN (
    VALUES
        ('Black', 'BLACK', '#000000'),
        ('White', 'WHITE', '#FFFFFF'),
        ('Red', 'RED', '#FF0000'),
        ('Blue', 'BLUE', '#0000FF'),
        ('Beige', 'BEIGE', '#F5F5DC')
) AS colors(color_name, color_code, hex_code)
ON CONFLICT (company_id, code) DO NOTHING;

WITH company_row AS (
    SELECT id FROM companies WHERE name = 'Demo Fashion Brand' LIMIT 1
),
season_row AS (
    INSERT INTO fashion_seasons (company_id, name, code, year)
    SELECT id, 'Summer 2026', 'SUMMER-2026', 2026
    FROM company_row
    ON CONFLICT (company_id, code) DO NOTHING
    RETURNING id, company_id
),
season_final AS (
    SELECT id, company_id FROM season_row
    UNION
    SELECT s.id, s.company_id
    FROM fashion_seasons s
    JOIN company_row c ON c.id = s.company_id
    WHERE s.code = 'SUMMER-2026'
    LIMIT 1
)
INSERT INTO fashion_collections (company_id, season_id, name, code)
SELECT company_id, id, 'Basic Collection', 'BASIC'
FROM season_final
ON CONFLICT (company_id, code) DO NOTHING;
