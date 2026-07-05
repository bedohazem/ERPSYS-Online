CREATE TABLE returns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    stock_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,

    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    original_sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,

    return_number TEXT NOT NULL,

    source TEXT NOT NULL DEFAULT 'online_pos' CHECK (
        source IN ('online_pos', 'offline_pos', 'web_admin')
    ),

    idempotency_key TEXT NOT NULL,

    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    refund_total NUMERIC(14,2) NOT NULL DEFAULT 0,

    status TEXT NOT NULL DEFAULT 'completed' CHECK (
        status IN ('draft', 'completed', 'voided', 'pending_review')
    ),

    reason TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at TIMESTAMPTZ,

    UNIQUE(company_id, return_number),
    UNIQUE(company_id, idempotency_key)
);

CREATE TABLE return_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    return_id UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,

    original_sale_item_id UUID REFERENCES sale_items(id) ON DELETE SET NULL,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,

    sku_snapshot TEXT NOT NULL,
    barcode_snapshot TEXT,
    product_name_snapshot TEXT NOT NULL,
    size_snapshot TEXT,
    color_snapshot TEXT,

    quantity NUMERIC(14,3) NOT NULL,
    unit_price NUMERIC(14,2) NOT NULL,
    refund_amount NUMERIC(14,2) NOT NULL,

    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (quantity > 0),
    CHECK (refund_amount >= 0)
);

CREATE TABLE return_refunds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    return_id UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,

    method TEXT NOT NULL CHECK (
        method IN ('cash', 'card', 'wallet', 'bank_transfer', 'other')
    ),

    amount NUMERIC(14,2) NOT NULL,
    reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (amount > 0)
);

CREATE TABLE exchanges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    stock_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,

    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    original_sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,

    exchange_number TEXT NOT NULL,

    source TEXT NOT NULL DEFAULT 'online_pos' CHECK (
        source IN ('online_pos', 'offline_pos', 'web_admin')
    ),

    idempotency_key TEXT NOT NULL,

    returned_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    issued_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    difference_total NUMERIC(14,2) NOT NULL DEFAULT 0,

    paid_difference_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    refunded_difference_total NUMERIC(14,2) NOT NULL DEFAULT 0,

    status TEXT NOT NULL DEFAULT 'completed' CHECK (
        status IN ('draft', 'completed', 'voided', 'pending_review')
    ),

    reason TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at TIMESTAMPTZ,

    UNIQUE(company_id, exchange_number),
    UNIQUE(company_id, idempotency_key)
);

CREATE TABLE exchange_return_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    exchange_id UUID NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,

    original_sale_item_id UUID REFERENCES sale_items(id) ON DELETE SET NULL,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,

    sku_snapshot TEXT NOT NULL,
    barcode_snapshot TEXT,
    product_name_snapshot TEXT NOT NULL,
    size_snapshot TEXT,
    color_snapshot TEXT,

    quantity NUMERIC(14,3) NOT NULL,
    unit_price NUMERIC(14,2) NOT NULL,
    line_total NUMERIC(14,2) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (quantity > 0)
);

CREATE TABLE exchange_issue_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    exchange_id UUID NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,

    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,

    sku_snapshot TEXT NOT NULL,
    barcode_snapshot TEXT,
    product_name_snapshot TEXT NOT NULL,
    size_snapshot TEXT,
    color_snapshot TEXT,

    quantity NUMERIC(14,3) NOT NULL,
    unit_price NUMERIC(14,2) NOT NULL,
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(14,2) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (quantity > 0)
);

CREATE TABLE exchange_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    exchange_id UUID NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,

    payment_direction TEXT NOT NULL CHECK (
        payment_direction IN ('paid_by_customer', 'refunded_to_customer')
    ),

    method TEXT NOT NULL CHECK (
        method IN ('cash', 'card', 'wallet', 'bank_transfer', 'other')
    ),

    amount NUMERIC(14,2) NOT NULL,
    reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (amount > 0)
);

CREATE INDEX idx_returns_company_id ON returns(company_id);
CREATE INDEX idx_returns_branch_id ON returns(branch_id);
CREATE INDEX idx_returns_original_sale_id ON returns(original_sale_id);
CREATE INDEX idx_returns_created_at ON returns(created_at);
CREATE INDEX idx_returns_status ON returns(status);

CREATE INDEX idx_return_items_return_id ON return_items(return_id);
CREATE INDEX idx_return_items_variant_id ON return_items(variant_id);

CREATE INDEX idx_return_refunds_return_id ON return_refunds(return_id);

CREATE INDEX idx_exchanges_company_id ON exchanges(company_id);
CREATE INDEX idx_exchanges_branch_id ON exchanges(branch_id);
CREATE INDEX idx_exchanges_original_sale_id ON exchanges(original_sale_id);
CREATE INDEX idx_exchanges_created_at ON exchanges(created_at);
CREATE INDEX idx_exchanges_status ON exchanges(status);

CREATE INDEX idx_exchange_return_items_exchange_id ON exchange_return_items(exchange_id);
CREATE INDEX idx_exchange_return_items_variant_id ON exchange_return_items(variant_id);

CREATE INDEX idx_exchange_issue_items_exchange_id ON exchange_issue_items(exchange_id);
CREATE INDEX idx_exchange_issue_items_variant_id ON exchange_issue_items(variant_id);

CREATE INDEX idx_exchange_payments_exchange_id ON exchange_payments(exchange_id);
