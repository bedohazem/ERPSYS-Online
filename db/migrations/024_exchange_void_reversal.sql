-- ======================================================
-- Safe Exchange Void Reversal
--
-- الإلغاء لا يحذف الاستبدال.
-- يتم حفظ:
-- 1. سبب الإلغاء والمستخدم والتوقيت.
-- 2. حركات مخزون عكسية مرتبطة بالحركات الأصلية.
-- 3. حركات مالية عكسية مرتبطة بالمدفوعات الأصلية.
-- ======================================================


-- ======================================================
-- Exchange void metadata
-- ======================================================

ALTER TABLE exchanges
ADD COLUMN IF NOT EXISTS
    void_reason TEXT;

ALTER TABLE exchanges
ADD COLUMN IF NOT EXISTS
    voided_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL;

ALTER TABLE exchanges
ADD COLUMN IF NOT EXISTS
    voided_at TIMESTAMPTZ;


CREATE INDEX IF NOT EXISTS
idx_exchanges_company_voided_at
ON exchanges (
    company_id,
    voided_at DESC
)
WHERE voided_at IS NOT NULL;


-- ======================================================
-- Exchange payment classification
-- ======================================================

ALTER TABLE exchange_payments
ADD COLUMN IF NOT EXISTS
    payment_role TEXT NOT NULL
    DEFAULT 'settlement';

ALTER TABLE exchange_payments
ADD COLUMN IF NOT EXISTS
    reverses_payment_id UUID
    REFERENCES exchange_payments(id)
    ON DELETE SET NULL;


ALTER TABLE exchange_payments
DROP CONSTRAINT IF EXISTS
exchange_payments_payment_role_check;

ALTER TABLE exchange_payments
ADD CONSTRAINT
exchange_payments_payment_role_check
CHECK (
    payment_role IN (
        'settlement',
        'void_reversal'
    )
);


ALTER TABLE exchange_payments
DROP CONSTRAINT IF EXISTS
exchange_payments_reversal_link_check;

ALTER TABLE exchange_payments
ADD CONSTRAINT
exchange_payments_reversal_link_check
CHECK (
    (
        payment_role = 'settlement'
        AND reverses_payment_id IS NULL
    )
    OR
    (
        payment_role = 'void_reversal'
        AND reverses_payment_id IS NOT NULL
    )
);


CREATE UNIQUE INDEX IF NOT EXISTS
idx_exchange_payments_single_reversal
ON exchange_payments (
    reverses_payment_id
)
WHERE reverses_payment_id IS NOT NULL;


CREATE INDEX IF NOT EXISTS
idx_exchange_payments_role
ON exchange_payments (
    company_id,
    exchange_id,
    payment_role,
    created_at
);


-- ======================================================
-- Stock movement reversal link
-- ======================================================

ALTER TABLE stock_movements
ADD COLUMN IF NOT EXISTS
    reversal_of_movement_id UUID
    REFERENCES stock_movements(id)
    ON DELETE SET NULL;


CREATE UNIQUE INDEX IF NOT EXISTS
idx_stock_movements_single_reversal
ON stock_movements (
    reversal_of_movement_id
)
WHERE reversal_of_movement_id IS NOT NULL;