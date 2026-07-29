-- ============================================================
-- Migration 033: Transfer Cancellation
--
-- تضيف بيانات إلغاء التحويل بدون حذف المستند أو أصنافه.
-- التحويل الملغي يظل ظاهرًا في السجل لأغراض المراجعة.
-- ============================================================


ALTER TABLE transfers
ADD COLUMN IF NOT EXISTS cancelled_by UUID;


ALTER TABLE transfers
ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;


ALTER TABLE transfers
ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;


-- ربط مستخدم الإلغاء بنفس شركة التحويل.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_transfers_cancelled_by'
    ) THEN
        ALTER TABLE transfers
        ADD CONSTRAINT fk_transfers_cancelled_by
        FOREIGN KEY (
            company_id,
            cancelled_by
        )
        REFERENCES users (
            company_id,
            id
        )
        ON DELETE RESTRICT;
    END IF;
END;
$$;


-- سبب الإلغاء، عند وجوده، يجب أن يكون واضحًا ومحدود الطول.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_transfers_cancellation_reason'
    ) THEN
        ALTER TABLE transfers
        ADD CONSTRAINT ck_transfers_cancellation_reason
        CHECK (
            cancellation_reason IS NULL
            OR CHAR_LENGTH(BTRIM(cancellation_reason))
               BETWEEN 3 AND 300
        );
    END IF;
END;
$$;


CREATE INDEX IF NOT EXISTS
idx_transfers_company_cancelled_at
ON transfers (
    company_id,
    cancelled_at DESC
)
WHERE status = 'cancelled';