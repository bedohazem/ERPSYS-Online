-- ============================================================
-- Migration 036: Supplier Returns And Credit Notes
--
-- تضيف:
-- 1. مرتجعات الموردين.
-- 2. إشعارات الخصم.
-- 3. خصم المخزون المرتجع.
-- 4. تحديث مديونية فاتورة المورد.
-- ============================================================


-- ============================================================
-- 1. السماح بحركة مرتجع مشتريات
-- ============================================================

DO $$
DECLARE
    constraint_row RECORD;
BEGIN
    FOR constraint_row IN
        SELECT constraint_data.conname

        FROM pg_constraint constraint_data

        WHERE constraint_data.conrelid =
              'stock_movements'::regclass

          AND constraint_data.contype = 'c'

          AND pg_get_constraintdef(
              constraint_data.oid
          ) ILIKE '%movement_type%'
    LOOP
        EXECUTE format(
            'ALTER TABLE stock_movements DROP CONSTRAINT %I',
            constraint_row.conname
        );
    END LOOP;
END;
$$;


ALTER TABLE stock_movements
ADD CONSTRAINT ck_stock_movements_movement_type
CHECK (
    movement_type IN (
        'purchase',
        'purchase_return',
        'sale',
        'return',
        'exchange',
        'transfer_in',
        'transfer_out',
        'adjustment',
        'damage',
        'stock_count'
    )
);


-- ============================================================
-- 2. تحديث الحساب المالي لفاتورة المورد
-- ============================================================

ALTER TABLE supplier_invoices
ADD COLUMN IF NOT EXISTS
credit_total NUMERIC(14,2) NOT NULL DEFAULT 0;


ALTER TABLE supplier_invoices
ADD COLUMN IF NOT EXISTS
supplier_credit_balance NUMERIC(14,2) NOT NULL DEFAULT 0;


ALTER TABLE supplier_invoices
DROP CONSTRAINT IF EXISTS ck_supplier_invoices_status;


ALTER TABLE supplier_invoices
DROP CONSTRAINT IF EXISTS ck_supplier_invoices_amounts;


ALTER TABLE supplier_invoices
ADD CONSTRAINT ck_supplier_invoices_status
CHECK (
    status IN (
        'open',
        'partially_paid',
        'paid',
        'credit_due',
        'cancelled'
    )
);


ALTER TABLE supplier_invoices
ADD CONSTRAINT ck_supplier_invoices_amounts
CHECK (
    subtotal >= 0
    AND discount_total >= 0
    AND tax_total >= 0
    AND total >= 0

    AND paid_total >= 0
    AND paid_total <= total

    AND credit_total >= 0
    AND credit_total <= total

    AND balance >= 0
    AND supplier_credit_balance >= 0

    AND balance =
        GREATEST(
            total - paid_total - credit_total,
            0
        )

    AND supplier_credit_balance =
        GREATEST(
            paid_total + credit_total - total,
            0
        )
);


-- ============================================================
-- 3. مفتاح مركب لبنود إذن الاستلام
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1

        FROM pg_constraint constraint_row

        WHERE constraint_row.conrelid =
              'purchase_receipt_items'::regclass

          AND constraint_row.contype IN ('p', 'u')

          AND constraint_row.conkey = ARRAY[
              (
                  SELECT attribute.attnum

                  FROM pg_attribute attribute

                  WHERE attribute.attrelid =
                        'purchase_receipt_items'::regclass

                    AND attribute.attname =
                        'company_id'
              ),
              (
                  SELECT attribute.attnum

                  FROM pg_attribute attribute

                  WHERE attribute.attrelid =
                        'purchase_receipt_items'::regclass

                    AND attribute.attname = 'id'
              )
          ]::smallint[]
    ) THEN
        ALTER TABLE purchase_receipt_items

        ADD CONSTRAINT
            uq_purchase_receipt_items_company_scope

        UNIQUE (
            company_id,
            id
        );
    END IF;
END;
$$;


-- ============================================================
-- 4. مستند مرتجع المورد
-- ============================================================

CREATE TABLE supplier_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL,
    branch_id UUID,

    supplier_invoice_id UUID NOT NULL,
    purchase_receipt_id UUID NOT NULL,
    supplier_id UUID NOT NULL,

    stock_location_id UUID NOT NULL,

    return_number VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(150) NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'posted',

    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,

    note TEXT,

    created_by UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_supplier_returns_company_number
        UNIQUE (
            company_id,
            return_number
        ),

    CONSTRAINT uq_supplier_returns_idempotency
        UNIQUE (
            company_id,
            idempotency_key
        ),

    CONSTRAINT uq_supplier_returns_company_scope
        UNIQUE (
            company_id,
            id
        ),

    CONSTRAINT fk_supplier_returns_branch
        FOREIGN KEY (
            company_id,
            branch_id
        )
        REFERENCES branches (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_returns_invoice
        FOREIGN KEY (
            company_id,
            supplier_invoice_id
        )
        REFERENCES supplier_invoices (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_returns_receipt
        FOREIGN KEY (
            company_id,
            purchase_receipt_id
        )
        REFERENCES purchase_receipts (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_returns_supplier
        FOREIGN KEY (
            company_id,
            supplier_id
        )
        REFERENCES suppliers (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_returns_location
        FOREIGN KEY (
            company_id,
            stock_location_id
        )
        REFERENCES stock_locations (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_returns_created_by
        FOREIGN KEY (
            company_id,
            created_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT ck_supplier_returns_status
        CHECK (
            status = 'posted'
        ),

    CONSTRAINT ck_supplier_returns_amounts
        CHECK (
            subtotal >= 0
            AND discount_total >= 0
            AND tax_total >= 0
            AND total > 0
        )
);


CREATE TABLE supplier_return_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL,

    supplier_return_id UUID NOT NULL,
    purchase_receipt_item_id UUID NOT NULL,

    variant_id UUID NOT NULL,

    quantity NUMERIC(14,3) NOT NULL,

    unit_cost NUMERIC(14,2) NOT NULL,

    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,

    line_total NUMERIC(14,2) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_supplier_return_receipt_item
        UNIQUE (
            supplier_return_id,
            purchase_receipt_item_id
        ),

    CONSTRAINT fk_supplier_return_items_return
        FOREIGN KEY (
            company_id,
            supplier_return_id
        )
        REFERENCES supplier_returns (
            company_id,
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_supplier_return_items_receipt_item
        FOREIGN KEY (
            company_id,
            purchase_receipt_item_id
        )
        REFERENCES purchase_receipt_items (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_return_items_variant
        FOREIGN KEY (
            company_id,
            variant_id
        )
        REFERENCES product_variants (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT ck_supplier_return_items_quantity
        CHECK (
            quantity > 0
        ),

    CONSTRAINT ck_supplier_return_items_amounts
        CHECK (
            unit_cost >= 0
            AND discount_amount >= 0
            AND tax_amount >= 0
            AND line_total >= 0
        )
);


-- ============================================================
-- 5. إشعار الخصم
-- ============================================================

CREATE TABLE supplier_credit_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL,
    branch_id UUID,

    supplier_invoice_id UUID NOT NULL,
    supplier_return_id UUID NOT NULL,
    supplier_id UUID NOT NULL,

    credit_note_number VARCHAR(100) NOT NULL,

    amount NUMERIC(14,2) NOT NULL,

    note TEXT,

    created_by UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_supplier_credit_notes_company_number
        UNIQUE (
            company_id,
            credit_note_number
        ),

    CONSTRAINT uq_supplier_credit_notes_return
        UNIQUE (
            company_id,
            supplier_return_id
        ),

    CONSTRAINT fk_supplier_credit_notes_invoice
        FOREIGN KEY (
            company_id,
            supplier_invoice_id
        )
        REFERENCES supplier_invoices (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_credit_notes_return
        FOREIGN KEY (
            company_id,
            supplier_return_id
        )
        REFERENCES supplier_returns (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_credit_notes_supplier
        FOREIGN KEY (
            company_id,
            supplier_id
        )
        REFERENCES suppliers (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_credit_notes_created_by
        FOREIGN KEY (
            company_id,
            created_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT ck_supplier_credit_notes_amount
        CHECK (
            amount > 0
        )
);


CREATE INDEX idx_supplier_returns_company_created
ON supplier_returns (
    company_id,
    created_at DESC
);


CREATE INDEX idx_supplier_returns_invoice
ON supplier_returns (
    company_id,
    supplier_invoice_id,
    created_at DESC
);


CREATE INDEX idx_supplier_return_items_return
ON supplier_return_items (
    company_id,
    supplier_return_id
);


CREATE INDEX idx_supplier_credit_notes_invoice
ON supplier_credit_notes (
    company_id,
    supplier_invoice_id,
    created_at DESC
);