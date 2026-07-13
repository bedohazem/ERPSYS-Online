-- ============================================================
-- Migration 009: Multi-Tenant Data Integrity
--
-- الهدف:
-- 1. منع ربط بيانات شركة ببيانات شركة أخرى.
-- 2. التأكد أن الفروع والمخازن والعملاء والكاشير
--    تابعون لنفس الشركة الخاصة بالمستند.
-- 3. حماية المبيعات والمرتجعات والمخزون داخل PostgreSQL.
--
-- هذه الحماية تعمل حتى لو حدث خطأ برمجي في Backend API.
-- ============================================================


-- ============================================================
-- 1. فحص البيانات الحالية قبل إضافة القيود
--
-- لو توجد بيانات قديمة غير متوافقة، تتوقف الـ Migration
-- برسالة واضحة بدل إضافة القيود فوق بيانات خاطئة.
-- ============================================================

DO $$
BEGIN
    -- التأكد أن مخزن البيع تابع لنفس الشركة والفرع.
    IF EXISTS (
        SELECT 1
        FROM sales s
        JOIN stock_locations sl
          ON sl.id = s.stock_location_id
        WHERE sl.company_id IS DISTINCT FROM s.company_id
           OR (
                sl.branch_id IS NOT NULL
                AND sl.branch_id IS DISTINCT FROM s.branch_id
           )
    ) THEN
        RAISE EXCEPTION
            'Invalid existing sales: stock location company or branch mismatch';
    END IF;

    -- التأكد أن عميل الفاتورة تابع لنفس الشركة.
    IF EXISTS (
        SELECT 1
        FROM sales s
        JOIN customers c
          ON c.id = s.customer_id
        WHERE s.customer_id IS NOT NULL
          AND c.company_id IS DISTINCT FROM s.company_id
    ) THEN
        RAISE EXCEPTION
            'Invalid existing sales: customer company mismatch';
    END IF;

    -- التأكد أن الكاشير تابع لنفس الشركة والفرع.
    IF EXISTS (
        SELECT 1
        FROM sales s
        JOIN users u
          ON u.id = s.cashier_id
        WHERE s.cashier_id IS NOT NULL
          AND (
              u.company_id IS DISTINCT FROM s.company_id
              OR (
                  u.branch_id IS NOT NULL
                  AND u.branch_id IS DISTINCT FROM s.branch_id
              )
          )
    ) THEN
        RAISE EXCEPTION
            'Invalid existing sales: cashier company or branch mismatch';
    END IF;

    -- التأكد أن وردية الكاشير تابعة لنفس الشركة والفرع.
    IF EXISTS (
        SELECT 1
        FROM sales s
        JOIN cashier_shifts cs
          ON cs.id = s.shift_id
        WHERE s.shift_id IS NOT NULL
          AND (
              cs.company_id IS DISTINCT FROM s.company_id
              OR cs.branch_id IS DISTINCT FROM s.branch_id
              OR (
                  s.cashier_id IS NOT NULL
                  AND cs.cashier_id IS DISTINCT FROM s.cashier_id
              )
          )
    ) THEN
        RAISE EXCEPTION
            'Invalid existing sales: shift company, branch or cashier mismatch';
    END IF;

    -- التأكد أن مخزن المرتجع تابع لنفس الشركة والفرع.
    IF EXISTS (
        SELECT 1
        FROM returns r
        JOIN stock_locations sl
          ON sl.id = r.stock_location_id
        WHERE sl.company_id IS DISTINCT FROM r.company_id
           OR (
                sl.branch_id IS NOT NULL
                AND sl.branch_id IS DISTINCT FROM r.branch_id
           )
    ) THEN
        RAISE EXCEPTION
            'Invalid existing returns: stock location company or branch mismatch';
    END IF;

    -- التأكد أن عميل المرتجع تابع لنفس الشركة.
    IF EXISTS (
        SELECT 1
        FROM returns r
        JOIN customers c
          ON c.id = r.customer_id
        WHERE r.customer_id IS NOT NULL
          AND c.company_id IS DISTINCT FROM r.company_id
    ) THEN
        RAISE EXCEPTION
            'Invalid existing returns: customer company mismatch';
    END IF;

    -- التأكد أن الفاتورة الأصلية تابعة لنفس الشركة.
    IF EXISTS (
        SELECT 1
        FROM returns r
        JOIN sales s
          ON s.id = r.original_sale_id
        WHERE r.original_sale_id IS NOT NULL
          AND s.company_id IS DISTINCT FROM r.company_id
    ) THEN
        RAISE EXCEPTION
            'Invalid existing returns: original sale company mismatch';
    END IF;

    -- التأكد أن سطر المرتجع مرتبط بسطر الفاتورة الصحيحة.
    IF EXISTS (
        SELECT 1
        FROM return_items ri
        JOIN returns r
          ON r.id = ri.return_id
        JOIN sale_items si
          ON si.id = ri.original_sale_item_id
        WHERE ri.original_sale_item_id IS NOT NULL
          AND (
              si.company_id IS DISTINCT FROM ri.company_id
              OR si.variant_id IS DISTINCT FROM ri.variant_id
              OR r.original_sale_id IS NULL
              OR si.sale_id IS DISTINCT FROM r.original_sale_id
          )
    ) THEN
        RAISE EXCEPTION
            'Invalid existing return items: original sale item mismatch';
    END IF;
END;
$$;


-- ============================================================
-- 2. إضافة مفاتيح Unique مركبة
--
-- PostgreSQL يحتاج UNIQUE(company_id, id)
-- حتى نستطيع إنشاء Foreign Keys تمنع خلط الشركات.
-- ============================================================

ALTER TABLE branches
    ADD CONSTRAINT uq_branches_company_id_id
    UNIQUE (company_id, id);

ALTER TABLE users
    ADD CONSTRAINT uq_users_company_id_id
    UNIQUE (company_id, id);

ALTER TABLE customers
    ADD CONSTRAINT uq_customers_company_id_id
    UNIQUE (company_id, id);

ALTER TABLE stock_locations
    ADD CONSTRAINT uq_stock_locations_company_id_id
    UNIQUE (company_id, id);

ALTER TABLE product_variants
    ADD CONSTRAINT uq_product_variants_company_id_id
    UNIQUE (company_id, id);

ALTER TABLE cashier_shifts
    ADD CONSTRAINT uq_cashier_shifts_company_id_id
    UNIQUE (company_id, id);

ALTER TABLE sales
    ADD CONSTRAINT uq_sales_company_id_id
    UNIQUE (company_id, id);

ALTER TABLE sale_items
    ADD CONSTRAINT uq_sale_items_company_id_id
    UNIQUE (company_id, id);

ALTER TABLE returns
    ADD CONSTRAINT uq_returns_company_id_id
    UNIQUE (company_id, id);


-- ============================================================
-- 3. قيود المخزون
--
-- تمنع ربط رصيد أو حركة مخزون:
-- - بمخزن تابع لشركة أخرى.
-- - بصنف تابع لشركة أخرى.
-- ============================================================

ALTER TABLE stock_balances
    ADD CONSTRAINT fk_stock_balances_tenant_location
    FOREIGN KEY (company_id, stock_location_id)
    REFERENCES stock_locations (company_id, id)
    ON DELETE CASCADE;

ALTER TABLE stock_balances
    ADD CONSTRAINT fk_stock_balances_tenant_variant
    FOREIGN KEY (company_id, variant_id)
    REFERENCES product_variants (company_id, id)
    ON DELETE CASCADE;

ALTER TABLE stock_movements
    ADD CONSTRAINT fk_stock_movements_tenant_location
    FOREIGN KEY (company_id, stock_location_id)
    REFERENCES stock_locations (company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE stock_movements
    ADD CONSTRAINT fk_stock_movements_tenant_variant
    FOREIGN KEY (company_id, variant_id)
    REFERENCES product_variants (company_id, id)
    ON DELETE RESTRICT;


-- ============================================================
-- 4. قيود الورديات
--
-- تمنع إنشاء وردية بكاشير أو فرع من شركة مختلفة.
-- ============================================================

ALTER TABLE cashier_shifts
    ADD CONSTRAINT fk_cashier_shifts_tenant_branch
    FOREIGN KEY (company_id, branch_id)
    REFERENCES branches (company_id, id)
    ON DELETE CASCADE;

ALTER TABLE cashier_shifts
    ADD CONSTRAINT fk_cashier_shifts_tenant_cashier
    FOREIGN KEY (company_id, cashier_id)
    REFERENCES users (company_id, id)
    ON DELETE RESTRICT;


-- ============================================================
-- 5. قيود المبيعات
--
-- تمنع ربط الفاتورة بفرع أو مخزن من شركة أخرى.
-- وتمنع ربط أصناف الفاتورة ببيع أو Variant من شركة أخرى.
-- ============================================================

ALTER TABLE sales
    ADD CONSTRAINT fk_sales_tenant_branch
    FOREIGN KEY (company_id, branch_id)
    REFERENCES branches (company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE sales
    ADD CONSTRAINT fk_sales_tenant_location
    FOREIGN KEY (company_id, stock_location_id)
    REFERENCES stock_locations (company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE sale_items
    ADD CONSTRAINT fk_sale_items_tenant_sale
    FOREIGN KEY (company_id, sale_id)
    REFERENCES sales (company_id, id)
    ON DELETE CASCADE;

ALTER TABLE sale_items
    ADD CONSTRAINT fk_sale_items_tenant_variant
    FOREIGN KEY (company_id, variant_id)
    REFERENCES product_variants (company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE payments
    ADD CONSTRAINT fk_payments_tenant_sale
    FOREIGN KEY (company_id, sale_id)
    REFERENCES sales (company_id, id)
    ON DELETE CASCADE;


-- ============================================================
-- 6. قيود المرتجعات
--
-- تمنع ربط المرتجع أو أصنافه أو المدفوعات
-- بكيانات من شركة أخرى.
-- ============================================================

ALTER TABLE returns
    ADD CONSTRAINT fk_returns_tenant_branch
    FOREIGN KEY (company_id, branch_id)
    REFERENCES branches (company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE returns
    ADD CONSTRAINT fk_returns_tenant_location
    FOREIGN KEY (company_id, stock_location_id)
    REFERENCES stock_locations (company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE return_items
    ADD CONSTRAINT fk_return_items_tenant_return
    FOREIGN KEY (company_id, return_id)
    REFERENCES returns (company_id, id)
    ON DELETE CASCADE;

ALTER TABLE return_items
    ADD CONSTRAINT fk_return_items_tenant_variant
    FOREIGN KEY (company_id, variant_id)
    REFERENCES product_variants (company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE return_refunds
    ADD CONSTRAINT fk_return_refunds_tenant_return
    FOREIGN KEY (company_id, return_id)
    REFERENCES returns (company_id, id)
    ON DELETE CASCADE;


-- ============================================================
-- 7. Trigger حماية سياق فاتورة البيع
--
-- يستخدم للعلاقات الاختيارية التي لا نريد تغيير
-- ON DELETE SET NULL الخاص بها.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_sales_tenant_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    selected_location_branch_id UUID;
    selected_cashier_company_id UUID;
    selected_cashier_branch_id UUID;
    selected_shift_company_id UUID;
    selected_shift_branch_id UUID;
    selected_shift_cashier_id UUID;
BEGIN
    -- التأكد أن المخزن تابع لنفس الشركة.
    SELECT branch_id
    INTO selected_location_branch_id
    FROM stock_locations
    WHERE id = NEW.stock_location_id
      AND company_id = NEW.company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Sale stock location does not belong to sale company'
            USING ERRCODE = '23503';
    END IF;

    -- المخزن المركزي قد يكون branch_id = NULL.
    -- أما مخزن الفرع فلازم يطابق فرع الفاتورة.
    IF selected_location_branch_id IS NOT NULL
       AND selected_location_branch_id IS DISTINCT FROM NEW.branch_id THEN
        RAISE EXCEPTION
            'Sale stock location does not belong to sale branch'
            USING ERRCODE = '23514';
    END IF;

    -- العميل اختياري، لكن لو موجود لازم يتبع نفس الشركة.
    IF NEW.customer_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM customers c
           WHERE c.id = NEW.customer_id
             AND c.company_id = NEW.company_id
       ) THEN
        RAISE EXCEPTION
            'Sale customer does not belong to sale company'
            USING ERRCODE = '23503';
    END IF;

    -- الكاشير اختياري، لكن لازم يتبع نفس الشركة والفرع.
    IF NEW.cashier_id IS NOT NULL THEN
        SELECT company_id, branch_id
        INTO selected_cashier_company_id, selected_cashier_branch_id
        FROM users
        WHERE id = NEW.cashier_id;

        IF NOT FOUND
           OR selected_cashier_company_id IS DISTINCT FROM NEW.company_id THEN
            RAISE EXCEPTION
                'Sale cashier does not belong to sale company'
                USING ERRCODE = '23503';
        END IF;

        IF selected_cashier_branch_id IS NOT NULL
           AND selected_cashier_branch_id IS DISTINCT FROM NEW.branch_id THEN
            RAISE EXCEPTION
                'Sale cashier does not belong to sale branch'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- الوردية لو موجودة لازم تتبع نفس الشركة والفرع والكاشير.
    IF NEW.shift_id IS NOT NULL THEN
        SELECT company_id, branch_id, cashier_id
        INTO
            selected_shift_company_id,
            selected_shift_branch_id,
            selected_shift_cashier_id
        FROM cashier_shifts
        WHERE id = NEW.shift_id;

        IF NOT FOUND
           OR selected_shift_company_id IS DISTINCT FROM NEW.company_id THEN
            RAISE EXCEPTION
                'Sale shift does not belong to sale company'
                USING ERRCODE = '23503';
        END IF;

        IF selected_shift_branch_id IS DISTINCT FROM NEW.branch_id THEN
            RAISE EXCEPTION
                'Sale shift does not belong to sale branch'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.cashier_id IS NOT NULL
           AND selected_shift_cashier_id IS DISTINCT FROM NEW.cashier_id THEN
            RAISE EXCEPTION
                'Sale shift does not belong to selected cashier'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_tenant_context ON sales;

CREATE TRIGGER trg_sales_tenant_context
BEFORE INSERT OR UPDATE
ON sales
FOR EACH ROW
EXECUTE FUNCTION enforce_sales_tenant_context();


-- ============================================================
-- 8. Trigger حماية سياق المرتجع
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_returns_tenant_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    selected_location_branch_id UUID;
BEGIN
    -- المخزن لازم يكون تابع لنفس الشركة.
    SELECT branch_id
    INTO selected_location_branch_id
    FROM stock_locations
    WHERE id = NEW.stock_location_id
      AND company_id = NEW.company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Return stock location does not belong to return company'
            USING ERRCODE = '23503';
    END IF;

    -- مخزن الفرع لازم يطابق فرع المرتجع.
    IF selected_location_branch_id IS NOT NULL
       AND selected_location_branch_id IS DISTINCT FROM NEW.branch_id THEN
        RAISE EXCEPTION
            'Return stock location does not belong to return branch'
            USING ERRCODE = '23514';
    END IF;

    -- العميل لو موجود لازم يتبع نفس الشركة.
    IF NEW.customer_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM customers c
           WHERE c.id = NEW.customer_id
             AND c.company_id = NEW.company_id
       ) THEN
        RAISE EXCEPTION
            'Return customer does not belong to return company'
            USING ERRCODE = '23503';
    END IF;

    -- الفاتورة الأصلية لو موجودة لازم تتبع نفس الشركة.
    IF NEW.original_sale_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM sales s
           WHERE s.id = NEW.original_sale_id
             AND s.company_id = NEW.company_id
       ) THEN
        RAISE EXCEPTION
            'Original sale does not belong to return company'
            USING ERRCODE = '23503';
    END IF;

    -- المستخدم الذي أنشأ المرتجع لازم يتبع نفس الشركة.
    IF NEW.created_by IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM users u
           WHERE u.id = NEW.created_by
             AND u.company_id = NEW.company_id
       ) THEN
        RAISE EXCEPTION
            'Return creator does not belong to return company'
            USING ERRCODE = '23503';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_returns_tenant_context ON returns;

CREATE TRIGGER trg_returns_tenant_context
BEFORE INSERT OR UPDATE
ON returns
FOR EACH ROW
EXECUTE FUNCTION enforce_returns_tenant_context();


-- ============================================================
-- 9. Trigger حماية أصل سطر المرتجع
--
-- يمنع:
-- - ربط الصنف بسطر فاتورة من شركة أخرى.
-- - إرجاع Variant مختلف عن الموجود بالفاتورة.
-- - ربط السطر بفاتورة غير الفاتورة الأصلية للمرتجع.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_return_item_origin_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    header_original_sale_id UUID;
    original_item_company_id UUID;
    original_item_sale_id UUID;
    original_item_variant_id UUID;
BEGIN
    -- نجيب الفاتورة الأصلية من رأس المرتجع.
    SELECT original_sale_id
    INTO header_original_sale_id
    FROM returns
    WHERE id = NEW.return_id
      AND company_id = NEW.company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Return item header does not belong to item company'
            USING ERRCODE = '23503';
    END IF;

    -- المرتجع اليدوي قد لا يحتوي original_sale_item_id.
    IF NEW.original_sale_item_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT company_id, sale_id, variant_id
    INTO
        original_item_company_id,
        original_item_sale_id,
        original_item_variant_id
    FROM sale_items
    WHERE id = NEW.original_sale_item_id;

    IF NOT FOUND
       OR original_item_company_id IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION
            'Original sale item does not belong to return company'
            USING ERRCODE = '23503';
    END IF;

    IF original_item_variant_id IS DISTINCT FROM NEW.variant_id THEN
        RAISE EXCEPTION
            'Returned variant does not match original sale item'
            USING ERRCODE = '23514';
    END IF;

    IF header_original_sale_id IS NULL
       OR original_item_sale_id IS DISTINCT FROM header_original_sale_id THEN
        RAISE EXCEPTION
            'Original sale item does not belong to return original sale'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_return_items_origin_context
ON return_items;

CREATE TRIGGER trg_return_items_origin_context
BEFORE INSERT OR UPDATE
ON return_items
FOR EACH ROW
EXECUTE FUNCTION enforce_return_item_origin_context();


-- ============================================================
-- 10. Indexes مساعدة
--
-- تسرّع التحقق من الكميات المرتجعة
-- والبحث حسب الشركة والفاتورة الأصلية.
-- ============================================================

CREATE INDEX idx_return_items_company_original_sale_item
ON return_items (company_id, original_sale_item_id)
WHERE original_sale_item_id IS NOT NULL;

CREATE INDEX idx_sales_company_branch_location
ON sales (company_id, branch_id, stock_location_id);

CREATE INDEX idx_returns_company_branch_location
ON returns (company_id, branch_id, stock_location_id);