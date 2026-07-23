-- ======================================================
-- Product Variant Price History
--
-- كل تعديل على سعر بيع الصنف يُسجل مع:
-- السعر القديم والجديد والمستخدم ووقت التعديل.
-- ======================================================

CREATE TABLE product_variant_price_history (
    id UUID PRIMARY KEY
        DEFAULT uuid_generate_v4(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    variant_id UUID NOT NULL
        REFERENCES product_variants(id)
        ON DELETE CASCADE,

    old_selling_price NUMERIC(14,2) NOT NULL,

    new_selling_price NUMERIC(14,2) NOT NULL,

    changed_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    change_note TEXT,

    changed_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CHECK (
        old_selling_price >= 0
    ),

    CHECK (
        new_selling_price >= 0
    )
);

CREATE INDEX
    idx_variant_price_history_variant
ON product_variant_price_history (
    company_id,
    variant_id,
    changed_at DESC
);

CREATE INDEX
    idx_variant_price_history_changed_by
ON product_variant_price_history (
    company_id,
    changed_by,
    changed_at DESC
);