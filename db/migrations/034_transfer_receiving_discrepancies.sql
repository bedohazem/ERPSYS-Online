-- ============================================================
-- Migration 034: Transfer Receiving Discrepancies
--
-- تحفظ نتيجة الاستلام الفعلي للتحويل، وهل توجد فروق
-- بين الكميات المشحونة والكميات التي وصلت للوجهة.
-- ============================================================


ALTER TABLE transfers
ADD COLUMN IF NOT EXISTS
has_receiving_discrepancy BOOLEAN NOT NULL DEFAULT FALSE;


ALTER TABLE transfers
ADD COLUMN IF NOT EXISTS
receiving_note TEXT;


-- ملاحظة الاستلام اختيارية في الاستلام الكامل،
-- لكنها يجب أن تكون واضحة عند إرسالها.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_transfers_receiving_note'
    ) THEN
        ALTER TABLE transfers
        ADD CONSTRAINT ck_transfers_receiving_note
        CHECK (
            receiving_note IS NULL
            OR CHAR_LENGTH(BTRIM(receiving_note))
               BETWEEN 3 AND 500
        );
    END IF;
END;
$$;


-- وجود فرق استلام يتطلب تسجيل سبب أو ملاحظة.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'ck_transfers_receiving_discrepancy_note'
    ) THEN
        ALTER TABLE transfers
        ADD CONSTRAINT
            ck_transfers_receiving_discrepancy_note
        CHECK (
            has_receiving_discrepancy = FALSE
            OR receiving_note IS NOT NULL
        );
    END IF;
END;
$$;


CREATE INDEX IF NOT EXISTS
idx_transfers_receiving_discrepancy
ON transfers (
    company_id,
    received_at DESC
)
WHERE
    status = 'received'
    AND has_receiving_discrepancy = TRUE;