-- ============================================================
-- Migration 038: Weighted Average Costing Foundation
--
-- تضيف الأساس التخزيني لـ:
-- 1. متوسط التكلفة الحالي لكل رصيد مخزون.
-- 2. تاريخ التكلفة وقيمة المخزون داخل الحركات.
-- 3. Cost Snapshot داخل بنود المبيعات.
-- 4. تكلفة المخزون المعتمدة داخل بنود الاستلام.
--
-- هذه Migration تأسيسية فقط.
-- ربط الحسابات بدورات الشراء والبيع يأتي في الخطوات التالية.
-- ============================================================


-- ============================================================
-- 1. Current moving-average cost
-- ============================================================

ALTER TABLE stock_balances
ADD COLUMN IF NOT EXISTS
    average_cost NUMERIC(14,4)
    NOT NULL
    DEFAULT 0;


ALTER TABLE stock_balances
DROP CONSTRAINT IF EXISTS
    ck_stock_balances_average_cost;


ALTER TABLE stock_balances
ADD CONSTRAINT
    ck_stock_balances_average_cost
CHECK (
    average_cost >= 0
);


-- قيمة المخزون الحالية لا يتم تخزينها كعمود منفصل،
-- لأنها يمكن اشتقاقها دائمًا من:
-- quantity × average_cost.
CREATE INDEX IF NOT EXISTS
idx_stock_balances_company_variant_cost
ON stock_balances (
    company_id,
    variant_id,
    average_cost
);


-- ============================================================
-- 2. Cost history on inventory movements
-- ============================================================

ALTER TABLE stock_movements
ADD COLUMN IF NOT EXISTS
    unit_cost NUMERIC(14,4);


ALTER TABLE stock_movements
ADD COLUMN IF NOT EXISTS
    average_cost_before NUMERIC(14,4);


ALTER TABLE stock_movements
ADD COLUMN IF NOT EXISTS
    average_cost_after NUMERIC(14,4);


ALTER TABLE stock_movements
ADD COLUMN IF NOT EXISTS
    inventory_value_before NUMERIC(18,4);


ALTER TABLE stock_movements
ADD COLUMN IF NOT EXISTS
    inventory_value_after NUMERIC(18,4);


ALTER TABLE stock_movements
DROP CONSTRAINT IF EXISTS
    ck_stock_movements_cost_values;


ALTER TABLE stock_movements
ADD CONSTRAINT
    ck_stock_movements_cost_values
CHECK (
    (
        unit_cost IS NULL
        OR unit_cost >= 0
    )

    AND (
        average_cost_before IS NULL
        OR average_cost_before >= 0
    )

    AND (
        average_cost_after IS NULL
        OR average_cost_after >= 0
    )

    AND (
        inventory_value_before IS NULL
        OR inventory_value_before >= 0
    )

    AND (
        inventory_value_after IS NULL
        OR inventory_value_after >= 0
    )
);


CREATE INDEX IF NOT EXISTS
idx_stock_movements_cost_analysis
ON stock_movements (
    company_id,
    stock_location_id,
    variant_id,
    created_at
)
INCLUDE (
    quantity,
    unit_cost,
    average_cost_before,
    average_cost_after,
    inventory_value_before,
    inventory_value_after
);


-- ============================================================
-- 3. Approved inventory unit cost on purchase receipt items
-- ============================================================

ALTER TABLE purchase_receipt_items
ADD COLUMN IF NOT EXISTS
    inventory_unit_cost NUMERIC(14,4);


ALTER TABLE purchase_receipt_items
DROP CONSTRAINT IF EXISTS
    ck_purchase_receipt_items_inventory_cost;


ALTER TABLE purchase_receipt_items
ADD CONSTRAINT
    ck_purchase_receipt_items_inventory_cost
CHECK (
    inventory_unit_cost IS NULL
    OR inventory_unit_cost >= 0
);


-- لا نقوم بعمل Backfill تلقائي من line_total،
-- لأن معاملة الضرائب والمصروفات الإضافية
-- لم يتم تثبيتها بعد لكل البيانات القديمة.
COMMENT ON COLUMN
purchase_receipt_items.inventory_unit_cost
IS
'Approved per-unit inventory cost used by the weighted-average costing engine.';


-- ============================================================
-- 4. Historical sale cost and gross-profit snapshots
-- ============================================================

ALTER TABLE sale_items
ADD COLUMN IF NOT EXISTS
    unit_cost_snapshot NUMERIC(14,4);


ALTER TABLE sale_items
ADD COLUMN IF NOT EXISTS
    cost_total_snapshot NUMERIC(14,2);


ALTER TABLE sale_items
ADD COLUMN IF NOT EXISTS
    gross_profit_snapshot NUMERIC(14,2);


ALTER TABLE sale_items
ADD COLUMN IF NOT EXISTS
    gross_margin_percent NUMERIC(9,4);


ALTER TABLE sale_items
DROP CONSTRAINT IF EXISTS
    ck_sale_items_cost_snapshots;


ALTER TABLE sale_items
ADD CONSTRAINT
    ck_sale_items_cost_snapshots
CHECK (
    (
        unit_cost_snapshot IS NULL
        AND cost_total_snapshot IS NULL
        AND gross_profit_snapshot IS NULL
        AND gross_margin_percent IS NULL
    )

    OR

    (
        unit_cost_snapshot IS NOT NULL
        AND unit_cost_snapshot >= 0

        AND cost_total_snapshot IS NOT NULL
        AND cost_total_snapshot >= 0

        AND gross_profit_snapshot IS NOT NULL

        AND gross_margin_percent IS NOT NULL
    )
);


CREATE INDEX IF NOT EXISTS
idx_sale_items_profit_analysis
ON sale_items (
    company_id,
    variant_id,
    created_at
)
INCLUDE (
    quantity,
    line_total,
    cost_total_snapshot,
    gross_profit_snapshot,
    gross_margin_percent
);


COMMENT ON COLUMN
sale_items.unit_cost_snapshot
IS
'Authoritative weighted-average unit cost captured when the sale is posted.';


COMMENT ON COLUMN
sale_items.cost_total_snapshot
IS
'Historical quantity multiplied by the captured unit cost.';


COMMENT ON COLUMN
sale_items.gross_profit_snapshot
IS
'Historical line total minus historical cost total.';


COMMENT ON COLUMN
sale_items.gross_margin_percent
IS
'Historical gross profit divided by line total, expressed as a percentage.';


-- ============================================================
-- 5. Protection against direct average-cost editing
--
-- الـBackend سيضع local setting داخل Transaction
-- قبل أي تعديل تكلفة معتمد.
--
-- Migration 038 تضيف الحماية من البداية حتى لا يحدث
-- UPDATE يدوي غير متتبع أثناء تطوير التكامل.
-- ============================================================

CREATE OR REPLACE FUNCTION
protect_stock_balance_average_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.average_cost
       IS DISTINCT FROM
       OLD.average_cost

       AND COALESCE(
           current_setting(
               'erpsys.allow_cost_update',
               TRUE
           ),
           'false'
       ) <> 'true'
    THEN
        RAISE EXCEPTION
            'Direct average_cost update is not allowed'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS
trg_protect_stock_balance_average_cost
ON stock_balances;


CREATE TRIGGER
trg_protect_stock_balance_average_cost
BEFORE UPDATE OF average_cost
ON stock_balances
FOR EACH ROW
EXECUTE FUNCTION
protect_stock_balance_average_cost();