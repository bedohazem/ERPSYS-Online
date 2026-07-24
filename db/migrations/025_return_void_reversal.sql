-- ======================================================
-- Safe Return Void Reversal
--
-- الإلغاء لا يحذف المرتجع أو حركاته الأصلية.
-- يتم إنشاء حركات مخزون ومالية عكسية مرتبطة بالأصل.
-- ======================================================


-- ======================================================
-- Return void metadata
-- ======================================================

ALTER TABLE returns
ADD COLUMN IF NOT EXISTS
    void_reason TEXT;

ALTER TABLE returns
ADD COLUMN IF NOT EXISTS
    voided_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL;

ALTER TABLE returns
ADD COLUMN IF NOT EXISTS
    voided_at TIMESTAMPTZ;


CREATE INDEX IF NOT EXISTS
idx_returns_company_voided_at
ON returns (
    company_id,
    voided_at DESC
)
WHERE voided_at IS NOT NULL;


-- ======================================================
-- Return refund classification
-- ======================================================

ALTER TABLE return_refunds
ADD COLUMN IF NOT EXISTS
    refund_role TEXT NOT NULL
    DEFAULT 'refund';

ALTER TABLE return_refunds
ADD COLUMN IF NOT EXISTS
    payment_direction TEXT NOT NULL
    DEFAULT 'refunded_to_customer';

ALTER TABLE return_refunds
ADD COLUMN IF NOT EXISTS
    reverses_refund_id UUID
    REFERENCES return_refunds(id)
    ON DELETE SET NULL;


ALTER TABLE return_refunds
DROP CONSTRAINT IF EXISTS
return_refunds_refund_role_check;

ALTER TABLE return_refunds
ADD CONSTRAINT
return_refunds_refund_role_check
CHECK (
    refund_role IN (
        'refund',
        'void_reversal'
    )
);


ALTER TABLE return_refunds
DROP CONSTRAINT IF EXISTS
return_refunds_payment_direction_check;

ALTER TABLE return_refunds
ADD CONSTRAINT
return_refunds_payment_direction_check
CHECK (
    payment_direction IN (
        'refunded_to_customer',
        'collected_from_customer'
    )
);


ALTER TABLE return_refunds
DROP CONSTRAINT IF EXISTS
return_refunds_reversal_link_check;

ALTER TABLE return_refunds
ADD CONSTRAINT
return_refunds_reversal_link_check
CHECK (
    (
        refund_role = 'refund'
        AND payment_direction =
            'refunded_to_customer'
        AND reverses_refund_id IS NULL
    )
    OR
    (
        refund_role = 'void_reversal'
        AND payment_direction =
            'collected_from_customer'
        AND reverses_refund_id IS NOT NULL
    )
);


CREATE UNIQUE INDEX IF NOT EXISTS
idx_return_refunds_single_reversal
ON return_refunds (
    reverses_refund_id
)
WHERE reverses_refund_id IS NOT NULL;


CREATE INDEX IF NOT EXISTS
idx_return_refunds_role
ON return_refunds (
    company_id,
    return_id,
    refund_role,
    created_at
);