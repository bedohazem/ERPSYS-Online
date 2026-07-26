-- ======================================================
-- Safe Sale Void Reversal
--
-- إلغاء البيع لا يحذف الفاتورة.
-- يتم تسجيل:
-- 1. سبب الإلغاء والمستخدم والتوقيت.
-- 2. حركات مخزون عكسية.
-- 3. حركات مالية عكسية.
-- ======================================================


-- ======================================================
-- Sale void metadata
-- ======================================================

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS
    void_reason TEXT;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS
    voided_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS
    voided_at TIMESTAMPTZ;


CREATE INDEX IF NOT EXISTS
idx_sales_company_voided_at
ON sales (
    company_id,
    voided_at DESC
)
WHERE voided_at IS NOT NULL;


-- ======================================================
-- Sale payment classification
-- ======================================================

ALTER TABLE payments
ADD COLUMN IF NOT EXISTS
    payment_role TEXT NOT NULL
    DEFAULT 'sale_collection';

ALTER TABLE payments
ADD COLUMN IF NOT EXISTS
    payment_direction TEXT NOT NULL
    DEFAULT 'received_from_customer';

ALTER TABLE payments
ADD COLUMN IF NOT EXISTS
    reverses_payment_id UUID
    REFERENCES payments(id)
    ON DELETE SET NULL;


ALTER TABLE payments
DROP CONSTRAINT IF EXISTS
payments_payment_role_check;

ALTER TABLE payments
ADD CONSTRAINT
payments_payment_role_check
CHECK (
    payment_role IN (
        'sale_collection',
        'void_reversal'
    )
);


ALTER TABLE payments
DROP CONSTRAINT IF EXISTS
payments_payment_direction_check;

ALTER TABLE payments
ADD CONSTRAINT
payments_payment_direction_check
CHECK (
    payment_direction IN (
        'received_from_customer',
        'refunded_to_customer'
    )
);


ALTER TABLE payments
DROP CONSTRAINT IF EXISTS
payments_reversal_link_check;

ALTER TABLE payments
ADD CONSTRAINT
payments_reversal_link_check
CHECK (
    (
        payment_role =
            'sale_collection'
        AND payment_direction =
            'received_from_customer'
        AND reverses_payment_id
            IS NULL
    )
    OR
    (
        payment_role =
            'void_reversal'
        AND payment_direction =
            'refunded_to_customer'
        AND reverses_payment_id
            IS NOT NULL
    )
);


CREATE UNIQUE INDEX IF NOT EXISTS
idx_payments_single_void_reversal
ON payments (
    reverses_payment_id
)
WHERE reverses_payment_id IS NOT NULL;


CREATE INDEX IF NOT EXISTS
idx_payments_sale_role
ON payments (
    company_id,
    sale_id,
    payment_role,
    created_at
);