-- ============================================================
-- Migration 035: Supplier Invoices And Payments
--
-- دورة مالية مبسطة للموردين:
-- 1. إنشاء فاتورة من إذن استلام.
-- 2. تسجيل دفعات جزئية أو كاملة.
-- 3. متابعة المدفوع والمتبقي.
-- ============================================================


CREATE TABLE IF NOT EXISTS supplier_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL,
    branch_id UUID,

    supplier_id UUID NOT NULL,
    purchase_receipt_id UUID NOT NULL,

    invoice_number VARCHAR(100) NOT NULL,
    supplier_invoice_number VARCHAR(100),

    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,

    status VARCHAR(30) NOT NULL DEFAULT 'open',

    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,

    paid_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    balance NUMERIC(14,2) NOT NULL DEFAULT 0,

    note TEXT,

    created_by UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_supplier_invoices_company_number
        UNIQUE (company_id, invoice_number),

    CONSTRAINT uq_supplier_invoices_receipt
        UNIQUE (company_id, purchase_receipt_id),

    CONSTRAINT fk_supplier_invoices_supplier
        FOREIGN KEY (company_id, supplier_id)
        REFERENCES suppliers (company_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_invoices_receipt
        FOREIGN KEY (company_id, purchase_receipt_id)
        REFERENCES purchase_receipts (company_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_invoices_created_by
        FOREIGN KEY (company_id, created_by)
        REFERENCES users (company_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT ck_supplier_invoices_status
        CHECK (
            status IN (
                'open',
                'partially_paid',
                'paid',
                'cancelled'
            )
        ),

    CONSTRAINT ck_supplier_invoices_amounts
        CHECK (
            subtotal >= 0
            AND discount_total >= 0
            AND tax_total >= 0
            AND total >= 0
            AND paid_total >= 0
            AND balance >= 0
            AND paid_total <= total
            AND balance = total - paid_total
        ),

    CONSTRAINT ck_supplier_invoices_due_date
        CHECK (
            due_date IS NULL
            OR due_date >= invoice_date
        )
);


CREATE TABLE IF NOT EXISTS supplier_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL,
    branch_id UUID,

    supplier_invoice_id UUID NOT NULL,
    supplier_id UUID NOT NULL,

    payment_number VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(150) NOT NULL,

    amount NUMERIC(14,2) NOT NULL,

    payment_method VARCHAR(30) NOT NULL,

    reference_number VARCHAR(150),
    note TEXT,

    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_supplier_payments_company_number
        UNIQUE (company_id, payment_number),

    CONSTRAINT uq_supplier_payments_idempotency
        UNIQUE (company_id, idempotency_key),

    CONSTRAINT fk_supplier_payments_invoice
        FOREIGN KEY (
            company_id,
            supplier_invoice_id
        )
        REFERENCES supplier_invoices (
            company_id,
            id
        )
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_payments_supplier
        FOREIGN KEY (company_id, supplier_id)
        REFERENCES suppliers (company_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_supplier_payments_created_by
        FOREIGN KEY (company_id, created_by)
        REFERENCES users (company_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT ck_supplier_payments_amount
        CHECK (amount > 0),

    CONSTRAINT ck_supplier_payments_method
        CHECK (
            payment_method IN (
                'cash',
                'bank_transfer',
                'card',
                'cheque',
                'other'
            )
        )
);


CREATE INDEX IF NOT EXISTS
idx_supplier_invoices_company_status
ON supplier_invoices (
    company_id,
    status,
    invoice_date DESC
);


CREATE INDEX IF NOT EXISTS
idx_supplier_invoices_supplier
ON supplier_invoices (
    company_id,
    supplier_id,
    invoice_date DESC
);


CREATE INDEX IF NOT EXISTS
idx_supplier_invoices_due
ON supplier_invoices (
    company_id,
    due_date
)
WHERE balance > 0;


CREATE INDEX IF NOT EXISTS
idx_supplier_payments_invoice
ON supplier_payments (
    company_id,
    supplier_invoice_id,
    paid_at DESC
);