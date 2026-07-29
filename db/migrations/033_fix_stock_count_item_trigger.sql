-- إصلاح Trigger أصناف الجرد:
-- في DELETE نستخدم OLD، وفي INSERT/UPDATE نستخدم NEW.
CREATE OR REPLACE FUNCTION
protect_inventory_stock_count_items()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_company_id UUID;
    target_stock_count_id UUID;
    header_status TEXT;
BEGIN
    -- DELETE لا يحتوي على NEW، لذلك نحدد المصدر حسب نوع العملية.
    IF TG_OP = 'DELETE' THEN
        target_company_id := OLD.company_id;
        target_stock_count_id := OLD.stock_count_id;
    ELSE
        target_company_id := NEW.company_id;
        target_stock_count_id := NEW.stock_count_id;
    END IF;

    -- لا نسمح بتعديل الأصناف إلا داخل مستند جرد مفتوح.
    SELECT status
    INTO header_status
    FROM inventory_stock_counts
    WHERE company_id = target_company_id
      AND id = target_stock_count_id;

    IF NOT FOUND OR header_status <> 'draft' THEN
        RAISE EXCEPTION
            'Stock count items require a draft document'
            USING ERRCODE = '23514';
    END IF;

    -- PostgreSQL يتوقع OLD في DELETE وNEW في باقي العمليات.
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;