-- ============================================================
-- Migration 037: Customer Receivables
--
-- تضيف:
-- 1. السياسة الائتمانية للعميل.
-- 2. المبيعات الآجلة والمدفوعة جزئيًا.
-- 3. تحصيلات العملاء.
-- 4. صلاحيات الحسابات المدينة.
-- ============================================================


-- ============================================================
-- 1. السياسة الائتمانية للعميل
-- ============================================================

ALTER TABLE customers
ADD COLUMN IF NOT EXISTS
    allow_credit_sales BOOLEAN
    NOT NULL
    DEFAULT FALSE;


ALTER TABLE customers
ADD COLUMN IF NOT EXISTS
    credit_limit NUMERIC(14,2)
    NOT NULL
    DEFAULT 0;


ALTER TABLE customers
ADD COLUMN IF NOT EXISTS
    payment_terms_days INTEGER
    NOT NULL
    DEFAULT 0;


ALTER TABLE customers
DROP CONSTRAINT IF EXISTS
    ck_customers_credit_policy;


ALTER TABLE customers
ADD CONSTRAINT
    ck_customers_credit_policy
CHECK (
    credit_limit >= 0

    AND payment_terms_days
        BETWEEN 0 AND 3650
);


-- ============================================================
-- 2. الحالة المالية لفاتورة البيع
-- ============================================================

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS
    payment_status TEXT
    NOT NULL
    DEFAULT 'paid';


ALTER TABLE sales
ADD COLUMN IF NOT EXISTS
    outstanding_total NUMERIC(14,2)
    NOT NULL
    DEFAULT 0;


ALTER TABLE sales
ADD COLUMN IF NOT EXISTS
    due_date DATE;


ALTER TABLE sales
ADD COLUMN IF NOT EXISTS
    is_credit_sale BOOLEAN
    NOT NULL
    DEFAULT FALSE;


-- تسوية البيانات القديمة قبل إضافة القيود.
UPDATE sales
SET
    outstanding_total =
        GREATEST(
            ROUND(
                total -
                paid_total +
                change_total,
                2
            ),
            0
        ),

    payment_status =
        CASE
            WHEN status = 'voided'
                THEN 'voided'

            WHEN (
                total -
                paid_total +
                change_total
            ) <= 0
                THEN 'paid'

            WHEN (
                paid_total -
                change_total
            ) > 0
                THEN 'partially_paid'

            ELSE 'unpaid'
        END,

    is_credit_sale =
        (
            total -
            paid_total +
            change_total
        ) > 0;


ALTER TABLE sales
DROP CONSTRAINT IF EXISTS
    ck_sales_payment_status;


ALTER TABLE sales
ADD CONSTRAINT
    ck_sales_payment_status
CHECK (
    payment_status IN (
        'paid',
        'partially_paid',
        'unpaid',
        'voided'
    )
);


ALTER TABLE sales
DROP CONSTRAINT IF EXISTS
    ck_sales_outstanding_total;


ALTER TABLE sales
ADD CONSTRAINT
    ck_sales_outstanding_total
CHECK (
    outstanding_total >= 0
    AND outstanding_total <= total

    AND (
        (
            status = 'voided'

            AND payment_status = 'voided'
            AND outstanding_total = 0
        )

        OR

        (
            status <> 'voided'

            AND outstanding_total =
                GREATEST(
                    ROUND(
                        total -
                        paid_total +
                        change_total,
                        2
                    ),
                    0
                )
        )
    )

    AND (
        outstanding_total = 0

        OR (
            customer_id IS NOT NULL
            AND due_date IS NOT NULL
        )
    )
);


CREATE INDEX IF NOT EXISTS
idx_sales_company_outstanding
ON sales (
    company_id,
    due_date,
    outstanding_total
)
WHERE outstanding_total > 0
  AND status <> 'voided';


CREATE INDEX IF NOT EXISTS
idx_sales_customer_outstanding
ON sales (
    company_id,
    customer_id,
    due_date
)
WHERE outstanding_total > 0
  AND status <> 'voided';


-- ============================================================
-- 3. تحصيلات العملاء
-- ============================================================

CREATE TABLE customer_collections (
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL,
    branch_id UUID NOT NULL,

    customer_id UUID NOT NULL,
    sale_id UUID NOT NULL,

    collection_number VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(150) NOT NULL,

    amount NUMERIC(14,2) NOT NULL,

    payment_method VARCHAR(30) NOT NULL,

    reference_number VARCHAR(150),
    note TEXT,

    collected_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

    created_by UUID NOT NULL,

    created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

    CONSTRAINT
        uq_customer_collections_company_number
    UNIQUE (
        company_id,
        collection_number
    ),

    CONSTRAINT
        uq_customer_collections_idempotency
    UNIQUE (
        company_id,
        idempotency_key
    ),

    CONSTRAINT
        uq_customer_collections_company_scope
    UNIQUE (
        company_id,
        id
    ),

    CONSTRAINT
        fk_customer_collections_branch
    FOREIGN KEY (
        company_id,
        branch_id
    )
    REFERENCES branches (
        company_id,
        id
    )
    ON DELETE RESTRICT,

    CONSTRAINT
        fk_customer_collections_customer
    FOREIGN KEY (
        company_id,
        customer_id
    )
    REFERENCES customers (
        company_id,
        id
    )
    ON DELETE RESTRICT,

    CONSTRAINT
        fk_customer_collections_sale
    FOREIGN KEY (
        company_id,
        sale_id
    )
    REFERENCES sales (
        company_id,
        id
    )
    ON DELETE RESTRICT,

    CONSTRAINT
        fk_customer_collections_created_by
    FOREIGN KEY (
        company_id,
        created_by
    )
    REFERENCES users (
        company_id,
        id
    )
    ON DELETE RESTRICT,

    CONSTRAINT
        ck_customer_collections_amount
    CHECK (
        amount > 0
    ),

    CONSTRAINT
        ck_customer_collections_method
    CHECK (
        payment_method IN (
            'cash',
            'card',
            'wallet',
            'bank_transfer',
            'other'
        )
    )
);


-- كل تحصيل يتم تسجيله أيضًا داخل سجل مدفوعات البيع.
ALTER TABLE payments
ADD COLUMN IF NOT EXISTS
    customer_collection_id UUID;


ALTER TABLE payments
DROP CONSTRAINT IF EXISTS
    fk_payments_customer_collection;


ALTER TABLE payments
ADD CONSTRAINT
    fk_payments_customer_collection
FOREIGN KEY (
    company_id,
    customer_collection_id
)
REFERENCES customer_collections (
    company_id,
    id
)
ON DELETE RESTRICT;


CREATE UNIQUE INDEX IF NOT EXISTS
idx_payments_customer_collection
ON payments (
    company_id,
    customer_collection_id
)
WHERE customer_collection_id IS NOT NULL;


CREATE INDEX IF NOT EXISTS
idx_customer_collections_customer
ON customer_collections (
    company_id,
    customer_id,
    collected_at DESC
);


CREATE INDEX IF NOT EXISTS
idx_customer_collections_sale
ON customer_collections (
    company_id,
    sale_id,
    collected_at DESC
);


-- ============================================================
-- 4. حماية سياق التحصيل داخل PostgreSQL
-- ============================================================

CREATE OR REPLACE FUNCTION
enforce_customer_collection_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    selected_sale_branch_id UUID;
    selected_sale_customer_id UUID;
    selected_outstanding NUMERIC(14,2);
BEGIN
    SELECT
        branch_id,
        customer_id,
        outstanding_total

    INTO
        selected_sale_branch_id,
        selected_sale_customer_id,
        selected_outstanding

    FROM sales

    WHERE company_id = NEW.company_id
      AND id = NEW.sale_id
      AND status = 'completed';

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Customer collection sale is invalid'
            USING ERRCODE = '23503';
    END IF;

    IF selected_sale_customer_id
       IS DISTINCT FROM NEW.customer_id THEN
        RAISE EXCEPTION
            'Customer collection does not match sale customer'
            USING ERRCODE = '23514';
    END IF;

    IF selected_sale_branch_id
       IS DISTINCT FROM NEW.branch_id THEN
        RAISE EXCEPTION
            'Customer collection does not match sale branch'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.amount > selected_outstanding THEN
        RAISE EXCEPTION
            'Customer collection exceeds sale outstanding balance'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS
trg_customer_collection_context
ON customer_collections;


CREATE TRIGGER
trg_customer_collection_context
BEFORE INSERT OR UPDATE
ON customer_collections
FOR EACH ROW
EXECUTE FUNCTION
enforce_customer_collection_context();


-- ============================================================
-- 5. صلاحيات الحسابات المدينة
-- ============================================================

INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'receivables.view',
        'View customer receivables'
    ),
    (
        'receivables.collect',
        'Record customer collections'
    ),
    (
        'receivables.manage_credit',
        'Manage customer credit policy'
    )
ON CONFLICT (code)
DO UPDATE SET
    description = EXCLUDED.description;


INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    role_row.id,
    permission_row.id

FROM roles role_row

CROSS JOIN permissions permission_row

WHERE role_row.code = 'admin'

  AND permission_row.code IN (
      'receivables.view',
      'receivables.collect',
      'receivables.manage_credit'
  )

ON CONFLICT DO NOTHING;