-- ======================================================
-- Variant Price History Restore
--
-- تمييز التعديل اليدوي عن استرجاع سعر سابق،
-- مع ربط عملية الاسترجاع بالسجل الأصلي.
-- ======================================================

ALTER TABLE product_variant_price_history
ADD COLUMN IF NOT EXISTS
    change_type TEXT NOT NULL
    DEFAULT 'manual';

ALTER TABLE product_variant_price_history
DROP CONSTRAINT IF EXISTS
product_variant_price_history_change_type_check;

ALTER TABLE product_variant_price_history
ADD CONSTRAINT
product_variant_price_history_change_type_check
CHECK (
    change_type IN (
        'manual',
        'restore'
    )
);

ALTER TABLE product_variant_price_history
ADD COLUMN IF NOT EXISTS
    source_history_id UUID
    REFERENCES product_variant_price_history(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS
idx_variant_price_history_source
ON product_variant_price_history (
    company_id,
    source_history_id
);