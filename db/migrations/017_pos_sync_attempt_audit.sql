-- ============================================================
-- Preserve every POS synchronization attempt
-- ============================================================

-- كان القيد يمنع تسجيل نفس Idempotency Key
-- في أكثر من Batch داخل الشركة.
--
-- منع إنشاء الفاتورة مرتين موجود بالفعل داخل sales،
-- لذلك جدول المزامنة يجب أن يحتفظ بكل محاولة Upload.
ALTER TABLE pos_offline_sync_items
DROP CONSTRAINT IF EXISTS
pos_offline_sync_items_company_id_idempotency_key_key;


-- Index غير Unique لتسريع البحث في تاريخ المحاولات.
CREATE INDEX IF NOT EXISTS
idx_pos_sync_items_company_idempotency_attempts
ON pos_offline_sync_items (
    company_id,
    idempotency_key,
    created_at DESC
);


-- تسريع عرض عناصر كل Batch بترتيب وصولها.
CREATE INDEX IF NOT EXISTS
idx_pos_sync_items_batch_created
ON pos_offline_sync_items (
    company_id,
    batch_id,
    created_at ASC
);