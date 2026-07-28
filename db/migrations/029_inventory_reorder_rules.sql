-- ============================================================
-- Inventory reorder rules
--
-- حد إعادة طلب مستقل لكل Variant داخل مكان تخزين.
-- PostgreSQL هو مصدر المخزون الوحيد.
-- ============================================================

CREATE TABLE inventory_reorder_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    stock_location_id UUID NOT NULL,
    variant_id UUID NOT NULL,

    -- عند وصول الرصيد إلى هذا الحد يبدأ تنبيه إعادة الطلب.
    reorder_point NUMERIC(14,3) NOT NULL,

    -- الحد الحرج الذي لا يُفضل النزول تحته.
    safety_stock NUMERIC(14,3) NOT NULL DEFAULT 0,

    -- كمية الشراء المقترحة الثابتة.
    -- القيمة صفر تعني الاعتماد على كمية العجز المحسوبة.
    reorder_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_by UUID,
    updated_by UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_inventory_reorder_rules_scope
        UNIQUE (
            company_id,
            stock_location_id,
            variant_id
        ),

    CONSTRAINT ck_inventory_reorder_point_nonnegative
        CHECK (reorder_point >= 0),

    CONSTRAINT ck_inventory_safety_stock_nonnegative
        CHECK (safety_stock >= 0),

    CONSTRAINT ck_inventory_reorder_quantity_nonnegative
        CHECK (reorder_quantity >= 0),

    CONSTRAINT ck_inventory_safety_below_reorder
        CHECK (safety_stock <= reorder_point),

    CONSTRAINT ck_inventory_active_rule_has_point
        CHECK (
            is_active = FALSE
            OR reorder_point > 0
        ),

    CONSTRAINT fk_inventory_reorder_rules_tenant_location
        FOREIGN KEY (
            company_id,
            stock_location_id
        )
        REFERENCES stock_locations (
            company_id,
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_inventory_reorder_rules_tenant_variant
        FOREIGN KEY (
            company_id,
            variant_id
        )
        REFERENCES product_variants (
            company_id,
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_inventory_reorder_rules_created_by
        FOREIGN KEY (
            company_id,
            created_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_inventory_reorder_rules_updated_by
        FOREIGN KEY (
            company_id,
            updated_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT
);

CREATE INDEX
idx_inventory_reorder_rules_active_location
ON inventory_reorder_rules (
    company_id,
    stock_location_id,
    is_active
);

CREATE INDEX
idx_inventory_reorder_rules_variant
ON inventory_reorder_rules (
    company_id,
    variant_id
);

CREATE INDEX
idx_inventory_reorder_rules_active
ON inventory_reorder_rules (
    company_id,
    stock_location_id,
    variant_id
)
WHERE is_active = TRUE;
