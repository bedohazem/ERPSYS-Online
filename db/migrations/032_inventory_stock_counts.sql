-- ============================================================
-- Migration 032: Inventory Stock Counts
--
-- الجرد يحفظ الرصيد وقت فتح الجلسة، ثم الكمية الفعلية،
-- وعند الاعتماد ينشئ حركات stock_count للفروق فقط.
-- ============================================================


-- رأس مستند الجرد.
CREATE TABLE inventory_stock_counts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    branch_id UUID,

    stock_location_id UUID NOT NULL,

    count_number TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (
            status IN (
                'draft',
                'completed',
                'cancelled'
            )
        ),

    notes TEXT,

    -- يمنع تكرار إنشاء الجرد عند إعادة إرسال الطلب.
    idempotency_key UUID NOT NULL,

    created_by UUID NOT NULL,
    completed_by UUID,
    cancelled_by UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_inventory_stock_counts_company_id_id
        UNIQUE (
            company_id,
            id
        ),

    CONSTRAINT uq_inventory_stock_counts_number
        UNIQUE (
            company_id,
            count_number
        ),

    CONSTRAINT uq_inventory_stock_counts_idempotency
        UNIQUE (
            company_id,
            idempotency_key
        ),

    CONSTRAINT ck_inventory_stock_counts_number
        CHECK (
            CHAR_LENGTH(BTRIM(count_number))
            BETWEEN 3 AND 60
        ),

    CONSTRAINT ck_inventory_stock_counts_notes
        CHECK (
            notes IS NULL
            OR CHAR_LENGTH(BTRIM(notes))
               BETWEEN 1 AND 500
        ),

    -- بيانات الإكمال تظهر فقط في الجرد المكتمل.
    CONSTRAINT ck_inventory_stock_counts_completion
        CHECK (
            (
                status = 'completed'
                AND completed_by IS NOT NULL
                AND completed_at IS NOT NULL
            )
            OR (
                status <> 'completed'
                AND completed_by IS NULL
                AND completed_at IS NULL
            )
        ),

    -- بيانات الإلغاء تظهر فقط في الجرد الملغي.
    CONSTRAINT ck_inventory_stock_counts_cancellation
        CHECK (
            (
                status = 'cancelled'
                AND cancelled_by IS NOT NULL
                AND cancelled_at IS NOT NULL
            )
            OR (
                status <> 'cancelled'
                AND cancelled_by IS NULL
                AND cancelled_at IS NULL
            )
        ),

    CONSTRAINT fk_inventory_stock_counts_tenant_branch
        FOREIGN KEY (
            company_id,
            branch_id
        )
        REFERENCES branches (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_inventory_stock_counts_tenant_location
        FOREIGN KEY (
            company_id,
            stock_location_id
        )
        REFERENCES stock_locations (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_inventory_stock_counts_created_by
        FOREIGN KEY (
            company_id,
            created_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_inventory_stock_counts_completed_by
        FOREIGN KEY (
            company_id,
            completed_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_inventory_stock_counts_cancelled_by
        FOREIGN KEY (
            company_id,
            cancelled_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT
);


-- أصناف الجرد.
-- expected_quantity هي الكمية وقت فتح الجرد.
CREATE TABLE inventory_stock_count_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    stock_count_id UUID NOT NULL,
    variant_id UUID NOT NULL,

    expected_quantity NUMERIC(14,3) NOT NULL,

    -- تظل NULL حتى يعد الموظف الصنف.
    counted_quantity NUMERIC(14,3),

    difference_quantity NUMERIC(14,3),

    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_inventory_stock_count_items_variant
        UNIQUE (
            company_id,
            stock_count_id,
            variant_id
        ),

    CONSTRAINT ck_inventory_stock_count_expected
        CHECK (
            expected_quantity >= 0
        ),

    CONSTRAINT ck_inventory_stock_count_counted
        CHECK (
            counted_quantity IS NULL
            OR counted_quantity >= 0
        ),

    -- الفرق لا يُحفظ إلا بعد إدخال الكمية الفعلية.
    CONSTRAINT ck_inventory_stock_count_difference
        CHECK (
            (
                counted_quantity IS NULL
                AND difference_quantity IS NULL
            )
            OR (
                counted_quantity IS NOT NULL
                AND difference_quantity =
                    counted_quantity -
                    expected_quantity
            )
        ),

    CONSTRAINT fk_inventory_stock_count_items_header
        FOREIGN KEY (
            company_id,
            stock_count_id
        )
        REFERENCES inventory_stock_counts (
            company_id,
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_inventory_stock_count_items_variant
        FOREIGN KEY (
            company_id,
            variant_id
        )
        REFERENCES product_variants (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_inventory_stock_count_items_updated_by
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


-- لا نسمح بأكثر من جرد مفتوح لنفس مكان التخزين.
CREATE UNIQUE INDEX
uq_inventory_stock_counts_open_location
ON inventory_stock_counts (
    company_id,
    stock_location_id
)
WHERE status = 'draft';


CREATE INDEX
idx_inventory_stock_counts_status_created
ON inventory_stock_counts (
    company_id,
    status,
    created_at DESC
);


CREATE INDEX
idx_inventory_stock_count_items_header
ON inventory_stock_count_items (
    company_id,
    stock_count_id
);


-- ============================================================
-- حماية تطابق فرع الجرد مع فرع مكان التخزين.
-- ============================================================
CREATE OR REPLACE FUNCTION
enforce_inventory_stock_count_location_branch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    trusted_branch_id UUID;
BEGIN
    SELECT branch_id
    INTO trusted_branch_id
    FROM stock_locations
    WHERE company_id = NEW.company_id
      AND id = NEW.stock_location_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Stock count location does not belong to company'
            USING ERRCODE = '23503';
    END IF;

    IF trusted_branch_id
       IS DISTINCT FROM NEW.branch_id THEN
        RAISE EXCEPTION
            'Stock count branch does not match location branch'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;


CREATE TRIGGER
trg_inventory_stock_counts_location_branch
BEFORE INSERT OR UPDATE
ON inventory_stock_counts
FOR EACH ROW
EXECUTE FUNCTION
enforce_inventory_stock_count_location_branch();


-- ============================================================
-- المستند المكتمل أو الملغي يصبح غير قابل للتعديل أو الحذف.
-- ============================================================
CREATE OR REPLACE FUNCTION
protect_closed_inventory_stock_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION
            'Closed stock count documents cannot be changed'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Stock count documents cannot be deleted'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;


CREATE TRIGGER
trg_protect_closed_inventory_stock_count
BEFORE UPDATE OR DELETE
ON inventory_stock_counts
FOR EACH ROW
EXECUTE FUNCTION
protect_closed_inventory_stock_count();


-- أصناف الجرد تتعدل فقط طالما المستند Draft.
CREATE OR REPLACE FUNCTION
protect_inventory_stock_count_items()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_company_id UUID;
    target_stock_count_id UUID;
    header_status TEXT;
BEGIN
    target_company_id :=
        COALESCE(NEW.company_id, OLD.company_id);

    target_stock_count_id :=
        COALESCE(NEW.stock_count_id, OLD.stock_count_id);

    SELECT status
    INTO header_status
    FROM inventory_stock_counts
    WHERE company_id = target_company_id
      AND id = target_stock_count_id;

    IF NOT FOUND OR header_status <> 'draft' THEN
        RAISE EXCEPTION
            'Stock count items require a draft document'
            USING ERRCODE = '23514';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


CREATE TRIGGER
trg_protect_inventory_stock_count_items
BEFORE INSERT OR UPDATE OR DELETE
ON inventory_stock_count_items
FOR EACH ROW
EXECUTE FUNCTION
protect_inventory_stock_count_items();