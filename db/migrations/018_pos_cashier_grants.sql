-- ======================================================
-- Offline POS Cashier Grants
--
-- تمنح جلسة الكاشير إثباتًا قصير المدى مرتبطًا بـ:
-- الشركة + الفرع + جهاز POS + الكاشير.
--
-- المفتاح الخام لا يُخزن داخل PostgreSQL.
-- ======================================================

CREATE TABLE pos_cashier_grants (
    id UUID PRIMARY KEY
        DEFAULT uuid_generate_v4(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    branch_id UUID NOT NULL
        REFERENCES branches(id)
        ON DELETE CASCADE,

    device_id UUID NOT NULL
        REFERENCES pos_devices(id)
        ON DELETE CASCADE,

    cashier_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    auth_session_id UUID NOT NULL
        REFERENCES auth_sessions(id)
        ON DELETE RESTRICT,

    token_hash TEXT NOT NULL UNIQUE,

    issued_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    expires_at TIMESTAMPTZ NOT NULL,

    revoked_at TIMESTAMPTZ,

    last_used_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CONSTRAINT pos_cashier_grants_expiry_check
        CHECK (expires_at > issued_at)
);

CREATE INDEX
    idx_pos_cashier_grants_device_cashier
ON pos_cashier_grants (
    company_id,
    device_id,
    cashier_id,
    expires_at DESC
);

CREATE INDEX
    idx_pos_cashier_grants_active
ON pos_cashier_grants (
    company_id,
    branch_id,
    expires_at
)
WHERE revoked_at IS NULL;

ALTER TABLE sales
ADD COLUMN pos_cashier_grant_id UUID
    REFERENCES pos_cashier_grants(id)
    ON DELETE SET NULL;

CREATE INDEX
    idx_sales_pos_cashier_grant
ON sales (
    company_id,
    pos_cashier_grant_id
);