-- ============================================================
-- Migration 031: Inventory Adjustments
--
-- الهدف:
-- إنشاء مستند دائم لكل تسوية مخزون يدوية.
--
-- التسوية لا تعدّل stock_balances وحده.
-- الـBackend سينشئ:
-- 1. inventory_adjustment
-- 2. stock_movement
-- 3. تحديث stock_balance
-- 4. audit_log
--
-- وكل ذلك سيتم داخل Transaction واحدة.
-- ============================================================


-- ============================================================
-- جدول مستندات تسوية المخزون
--
-- quantity_before:
-- الرصيد الموثوق من PostgreSQL قبل التسوية.
--
-- counted_quantity:
-- الكمية الفعلية التي وجدها الموظف.
--
-- adjustment_quantity:
-- الفرق بين الكمية الفعلية والرصيد السابق.
--
-- مثال زيادة:
-- الرصيد السابق 10 والفعلي 12، الفرق +2.
--
-- مثال عجز:
-- الرصيد السابق 10 والفعلي 7، الفرق -3.
-- ============================================================
CREATE TABLE inventory_adjustments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- الشركة تؤخذ لاحقًا من Session المستخدم،
    -- ولا يتم الوثوق في companyId القادم من الواجهة.
    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    -- الفرع قد يكون NULL في حالة المخزن المركزي.
    -- الـTrigger الموجود أسفل الملف سيتأكد أن الفرع
    -- يطابق فرع مكان التخزين.
    branch_id UUID,

    -- مكان التخزين الذي سيتم تصحيح رصيده.
    stock_location_id UUID NOT NULL,

    -- الـVariant الفعلي: المقاس واللون المحددان.
    variant_id UUID NOT NULL,

    -- الرصيد الموجود في PostgreSQL قبل التسوية.
    quantity_before NUMERIC(14,3) NOT NULL,

    -- الكمية التي تم عدها فعليًا.
    counted_quantity NUMERIC(14,3) NOT NULL,

    -- الفرق:
    -- counted_quantity - quantity_before
    adjustment_quantity NUMERIC(14,3) NOT NULL,

    -- سبب التسوية إجباري حتى لا يحدث تعديل
    -- غير موثق للمخزون.
    reason TEXT NOT NULL,

    -- يمنع تكرار التسوية لو أعادت الواجهة
    -- إرسال نفس الطلب بسبب مشكلة اتصال.
    idempotency_key UUID NOT NULL,

    -- المستخدم الذي نفذ التسوية.
    created_by UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- نفس الطلب لا يُنفذ مرتين داخل الشركة.
    CONSTRAINT uq_inventory_adjustments_idempotency
        UNIQUE (
            company_id,
            idempotency_key
        ),

    -- لا نسمح برصيد سابق أو كمية فعلية سالبة.
    CONSTRAINT ck_inventory_adjustments_quantity_before
        CHECK (quantity_before >= 0),

    CONSTRAINT ck_inventory_adjustments_counted_quantity
        CHECK (counted_quantity >= 0),

    -- لا ننشئ مستند تسوية إذا لم يتغير الرصيد.
    CONSTRAINT ck_inventory_adjustments_nonzero_difference
        CHECK (adjustment_quantity <> 0),

    -- نتأكد داخل PostgreSQL أن الفرق المحفوظ صحيح.
    CONSTRAINT ck_inventory_adjustments_difference
        CHECK (
            adjustment_quantity =
            counted_quantity - quantity_before
        ),

    -- السبب يجب أن يكون واضحًا وغير فارغ،
    -- مع حد يمنع تخزين نصوص ضخمة.
    CONSTRAINT ck_inventory_adjustments_reason_length
        CHECK (
            CHAR_LENGTH(BTRIM(reason))
            BETWEEN 3 AND 500
        ),

    -- الفرع، إن وجد، يجب أن يتبع الشركة نفسها.
    CONSTRAINT fk_inventory_adjustments_tenant_branch
        FOREIGN KEY (
            company_id,
            branch_id
        )
        REFERENCES branches (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    -- مكان التخزين يجب أن يتبع الشركة نفسها.
    CONSTRAINT fk_inventory_adjustments_tenant_location
        FOREIGN KEY (
            company_id,
            stock_location_id
        )
        REFERENCES stock_locations (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    -- الصنف يجب أن يتبع الشركة نفسها.
    CONSTRAINT fk_inventory_adjustments_tenant_variant
        FOREIGN KEY (
            company_id,
            variant_id
        )
        REFERENCES product_variants (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    -- منفذ التسوية يجب أن يتبع الشركة نفسها.
    CONSTRAINT fk_inventory_adjustments_created_by
        FOREIGN KEY (
            company_id,
            created_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT
);


-- ============================================================
-- Trigger حماية الفرع ومكان التخزين
--
-- الـForeign Keys السابقة تضمن أن الشركة صحيحة،
-- لكنها لا تضمن وحدها أن branch_id هو نفس الفرع
-- الموجود داخل stock_location.
--
-- لذلك يعمل هذا الـTrigger قبل الحفظ ويتأكد من التطابق.
-- ============================================================
CREATE OR REPLACE FUNCTION
enforce_inventory_adjustment_location_branch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    trusted_location_branch_id UUID;
BEGIN
    -- نقرأ الفرع الحقيقي من مكان التخزين نفسه.
    SELECT branch_id
    INTO trusted_location_branch_id
    FROM stock_locations
    WHERE company_id = NEW.company_id
      AND id = NEW.stock_location_id;

    -- عدم العثور على المكان يعني أن السياق غير صالح.
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Inventory adjustment stock location does not belong to company'
            USING ERRCODE = '23503';
    END IF;

    -- IS DISTINCT FROM تتعامل بصورة صحيحة مع NULL.
    --
    -- المخزن المركزي:
    -- trusted branch = NULL
    -- adjustment branch = NULL
    --
    -- مخزن الفرع:
    -- يجب أن يتطابق الفرعان.
    IF trusted_location_branch_id
       IS DISTINCT FROM NEW.branch_id THEN
        RAISE EXCEPTION
            'Inventory adjustment branch does not match stock location branch'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;


-- تشغيل الحماية قبل إنشاء أو تعديل المستند.
CREATE TRIGGER
trg_inventory_adjustments_location_branch
BEFORE INSERT OR UPDATE
ON inventory_adjustments
FOR EACH ROW
EXECUTE FUNCTION
enforce_inventory_adjustment_location_branch();


-- ============================================================
-- Indexes
-- ============================================================

-- عرض تسويات مكان تخزين بترتيب زمني.
CREATE INDEX
idx_inventory_adjustments_location_created
ON inventory_adjustments (
    company_id,
    stock_location_id,
    created_at DESC
);


-- عرض تاريخ تسويات صنف معين.
CREATE INDEX
idx_inventory_adjustments_variant_created
ON inventory_adjustments (
    company_id,
    variant_id,
    created_at DESC
);


-- البحث في تسويات فرع معين.
CREATE INDEX
idx_inventory_adjustments_branch_created
ON inventory_adjustments (
    company_id,
    branch_id,
    created_at DESC
);