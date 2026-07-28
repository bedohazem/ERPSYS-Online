-- ============================================================
-- Supplier variant sourcing
--
-- يحدد الموردين المتاحين لكل Product Variant.
--
-- يمكن إنشاء إعداد:
-- 1. عام على مستوى الشركة: branch_id IS NULL
-- 2. خاص بفرع معين: branch_id IS NOT NULL
--
-- عند إنشاء أمر شراء لفرع:
-- - نستخدم المورد المفضل الخاص بالفرع أولًا.
-- - ثم نرجع للمورد المفضل العام للشركة.
-- ============================================================


-- مطلوب لإنشاء Foreign Key مركب يمنع خلط الشركات.
CREATE UNIQUE INDEX IF NOT EXISTS
uq_suppliers_company_id_id
ON suppliers (
    company_id,
    id
);


CREATE TABLE supplier_variant_sources (
    id UUID PRIMARY KEY
        DEFAULT uuid_generate_v4(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    -- NULL يعني أن الإعداد عام على مستوى الشركة.
    branch_id UUID,

    supplier_id UUID NOT NULL,
    variant_id UUID NOT NULL,

    -- كود الصنف لدى المورد، إن كان مختلفًا عن SKU الداخلي.
    supplier_sku TEXT,

    -- التكلفة الافتراضية المقترحة عند إنشاء أمر الشراء.
    default_unit_cost NUMERIC(14,2),

    -- أقل كمية يقبل المورد طلبها.
    minimum_order_quantity
        NUMERIC(14,3)
        NOT NULL
        DEFAULT 1,

    -- مضاعفات الطلب:
    -- مثال 6 يعني أن الكمية تكون 6 أو 12 أو 18...
    order_multiple
        NUMERIC(14,3)
        NOT NULL
        DEFAULT 1,

    -- مدة التوريد المتوقعة بالأيام.
    lead_time_days
        INTEGER
        NOT NULL
        DEFAULT 0,

    is_preferred BOOLEAN
        NOT NULL
        DEFAULT FALSE,

    is_active BOOLEAN
        NOT NULL
        DEFAULT TRUE,

    created_by UUID,
    updated_by UUID,

    created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

    CONSTRAINT ck_supplier_source_sku_not_empty
        CHECK (
            supplier_sku IS NULL
            OR BTRIM(supplier_sku) <> ''
        ),

    CONSTRAINT ck_supplier_source_cost_nonnegative
        CHECK (
            default_unit_cost IS NULL
            OR default_unit_cost >= 0
        ),

    CONSTRAINT ck_supplier_source_minimum_positive
        CHECK (
            minimum_order_quantity > 0
        ),

    CONSTRAINT ck_supplier_source_multiple_positive
        CHECK (
            order_multiple > 0
        ),

    CONSTRAINT ck_supplier_source_lead_time_nonnegative
        CHECK (
            lead_time_days >= 0
        ),

    -- القاعدة المعطلة لا يجوز أن تظل موردًا مفضلًا.
    CONSTRAINT ck_supplier_source_preferred_active
        CHECK (
            is_active = TRUE
            OR is_preferred = FALSE
        ),

    CONSTRAINT fk_supplier_sources_tenant_branch
        FOREIGN KEY (
            company_id,
            branch_id
        )
        REFERENCES branches (
            company_id,
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_supplier_sources_tenant_supplier
        FOREIGN KEY (
            company_id,
            supplier_id
        )
        REFERENCES suppliers (
            company_id,
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_supplier_sources_tenant_variant
        FOREIGN KEY (
            company_id,
            variant_id
        )
        REFERENCES product_variants (
            company_id,
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_supplier_sources_created_by
        FOREIGN KEY (
            company_id,
            created_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_sources_updated_by
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


-- ============================================================
-- منع تكرار نفس المورد والصنف داخل النطاق العام.
-- ============================================================

CREATE UNIQUE INDEX
uq_supplier_variant_sources_company_scope
ON supplier_variant_sources (
    company_id,
    supplier_id,
    variant_id
)
WHERE branch_id IS NULL;


-- ============================================================
-- منع التكرار داخل الفرع.
-- ============================================================

CREATE UNIQUE INDEX
uq_supplier_variant_sources_branch_scope
ON supplier_variant_sources (
    company_id,
    branch_id,
    supplier_id,
    variant_id
)
WHERE branch_id IS NOT NULL;


-- ============================================================
-- مورد مفضل واحد فقط للصنف على مستوى الشركة.
-- ============================================================

CREATE UNIQUE INDEX
uq_supplier_variant_preferred_company
ON supplier_variant_sources (
    company_id,
    variant_id
)
WHERE branch_id IS NULL
  AND is_preferred = TRUE
  AND is_active = TRUE;


-- ============================================================
-- مورد مفضل واحد فقط للصنف داخل كل فرع.
-- ============================================================

CREATE UNIQUE INDEX
uq_supplier_variant_preferred_branch
ON supplier_variant_sources (
    company_id,
    branch_id,
    variant_id
)
WHERE branch_id IS NOT NULL
  AND is_preferred = TRUE
  AND is_active = TRUE;


CREATE INDEX
idx_supplier_variant_sources_supplier
ON supplier_variant_sources (
    company_id,
    supplier_id,
    is_active
);


CREATE INDEX
idx_supplier_variant_sources_variant
ON supplier_variant_sources (
    company_id,
    variant_id,
    is_active
);


CREATE INDEX
idx_supplier_variant_sources_branch
ON supplier_variant_sources (
    company_id,
    branch_id,
    is_active
);