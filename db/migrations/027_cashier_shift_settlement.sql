-- ======================================================
-- Cashier Shift Settlement Snapshot
--
-- حفظ ملخص ثابت عند إغلاق الوردية حتى لا تتغير
-- نتائج التقارير التاريخية عند حدوث تعديلات لاحقة.
-- ======================================================


-- ======================================================
-- Closing metadata
-- ======================================================

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    closed_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL;

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    closing_note TEXT;


-- ======================================================
-- Settlement financial snapshot
-- ======================================================

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    net_sales_cash NUMERIC(14,2);

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    cash_returns NUMERIC(14,2);

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    net_exchange_cash NUMERIC(14,2);


-- ======================================================
-- Settlement document counts
-- ======================================================

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    sales_count INTEGER;

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    voided_sales_count INTEGER;

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    returns_count INTEGER;

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    exchanges_count INTEGER;


-- ======================================================
-- Versioned settlement payload
-- ======================================================

ALTER TABLE cashier_shifts
ADD COLUMN IF NOT EXISTS
    settlement_snapshot JSONB;


-- ======================================================
-- Constraints
-- ======================================================

ALTER TABLE cashier_shifts
DROP CONSTRAINT IF EXISTS
cashier_shifts_settlement_counts_check;

ALTER TABLE cashier_shifts
ADD CONSTRAINT
cashier_shifts_settlement_counts_check
CHECK (
    (
        sales_count IS NULL
        OR sales_count >= 0
    )
    AND
    (
        voided_sales_count IS NULL
        OR voided_sales_count >= 0
    )
    AND
    (
        returns_count IS NULL
        OR returns_count >= 0
    )
    AND
    (
        exchanges_count IS NULL
        OR exchanges_count >= 0
    )
);


ALTER TABLE cashier_shifts
DROP CONSTRAINT IF EXISTS
cashier_shifts_settlement_snapshot_check;

ALTER TABLE cashier_shifts
ADD CONSTRAINT
cashier_shifts_settlement_snapshot_check
CHECK (
    settlement_snapshot IS NULL
    OR jsonb_typeof(
        settlement_snapshot
    ) = 'object'
);


-- ======================================================
-- Reporting indexes
-- ======================================================

CREATE INDEX IF NOT EXISTS
idx_cashier_shifts_company_closed_at
ON cashier_shifts (
    company_id,
    closed_at DESC
)
WHERE closed_at IS NOT NULL;


CREATE INDEX IF NOT EXISTS
idx_cashier_shifts_company_cashier_opened
ON cashier_shifts (
    company_id,
    cashier_id,
    opened_at DESC
);