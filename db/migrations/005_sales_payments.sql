CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, phone)
);

CREATE TABLE cashier_shifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    shift_number TEXT NOT NULL,

    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,

    opening_cash NUMERIC(14,2) NOT NULL DEFAULT 0,
    closing_cash NUMERIC(14,2),
    expected_cash NUMERIC(14,2),
    difference NUMERIC(14,2),

    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, branch_id, shift_number)
);

CREATE TABLE sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    stock_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,

    cashier_id UUID REFERENCES users(id) ON DELETE SET NULL,
    shift_id UUID REFERENCES cashier_shifts(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

    sale_number TEXT NOT NULL,

    source TEXT NOT NULL DEFAULT 'online_pos' CHECK (
        source IN ('online_pos', 'offline_pos', 'web_admin')
    ),

    local_sale_id TEXT,
    idempotency_key TEXT NOT NULL,

    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,
    paid_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    change_total NUMERIC(14,2) NOT NULL DEFAULT 0,

    status TEXT NOT NULL DEFAULT 'completed' CHECK (
        status IN ('draft', 'completed', 'voided', 'refunded', 'pending_review')
    ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at TIMESTAMPTZ,

    UNIQUE(company_id, sale_number),
    UNIQUE(company_id, idempotency_key)
);

CREATE TABLE sale_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,

    sku_snapshot TEXT NOT NULL,
    barcode_snapshot TEXT,
    product_name_snapshot TEXT NOT NULL,
    size_snapshot TEXT,
    color_snapshot TEXT,

    quantity NUMERIC(14,3) NOT NULL,
    unit_price NUMERIC(14,2) NOT NULL,
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(14,2) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (quantity > 0)
);

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,

    method TEXT NOT NULL CHECK (
        method IN ('cash', 'card', 'wallet', 'bank_transfer', 'mixed', 'other')
    ),

    amount NUMERIC(14,2) NOT NULL,
    reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (amount > 0)
);

CREATE INDEX idx_customers_company_id ON customers(company_id);
CREATE INDEX idx_customers_phone ON customers(phone);

CREATE INDEX idx_cashier_shifts_company_branch ON cashier_shifts(company_id, branch_id);
CREATE INDEX idx_cashier_shifts_cashier_id ON cashier_shifts(cashier_id);
CREATE INDEX idx_cashier_shifts_status ON cashier_shifts(status);

CREATE INDEX idx_sales_company_id ON sales(company_id);
CREATE INDEX idx_sales_branch_id ON sales(branch_id);
CREATE INDEX idx_sales_cashier_id ON sales(cashier_id);
CREATE INDEX idx_sales_customer_id ON sales(customer_id);
CREATE INDEX idx_sales_created_at ON sales(created_at);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_idempotency_key ON sales(idempotency_key);

CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX idx_sale_items_variant_id ON sale_items(variant_id);

CREATE INDEX idx_payments_sale_id ON payments(sale_id);
CREATE INDEX idx_payments_method ON payments(method);
