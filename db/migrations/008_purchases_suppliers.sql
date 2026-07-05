CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    code TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    tax_number TEXT,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, code)
);

CREATE TABLE purchase_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,

    purchase_number TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'draft' CHECK (
        status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')
    ),

    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,

    order_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expected_date TIMESTAMPTZ,
    received_at TIMESTAMPTZ,

    note TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, purchase_number)
);

CREATE TABLE purchase_order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,

    quantity NUMERIC(14,3) NOT NULL,
    received_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,

    unit_cost NUMERIC(14,2) NOT NULL,
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(14,2) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (quantity > 0),
    CHECK (received_quantity >= 0)
);

CREATE TABLE purchase_receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    stock_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,

    receipt_number TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('draft', 'received', 'cancelled')
    ),

    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,

    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, receipt_number)
);

CREATE TABLE purchase_receipt_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    purchase_receipt_id UUID NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
    purchase_order_item_id UUID REFERENCES purchase_order_items(id) ON DELETE SET NULL,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,

    quantity NUMERIC(14,3) NOT NULL,
    unit_cost NUMERIC(14,2) NOT NULL,
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(14,2) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (quantity > 0)
);

CREATE INDEX idx_suppliers_company_id ON suppliers(company_id);
CREATE INDEX idx_suppliers_code ON suppliers(code);

CREATE INDEX idx_purchase_orders_company_id ON purchase_orders(company_id);
CREATE INDEX idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_orders_order_date ON purchase_orders(order_date);

CREATE INDEX idx_purchase_order_items_order_id ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_purchase_order_items_variant_id ON purchase_order_items(variant_id);

CREATE INDEX idx_purchase_receipts_company_id ON purchase_receipts(company_id);
CREATE INDEX idx_purchase_receipts_supplier_id ON purchase_receipts(supplier_id);
CREATE INDEX idx_purchase_receipts_location_id ON purchase_receipts(stock_location_id);
CREATE INDEX idx_purchase_receipts_received_at ON purchase_receipts(received_at);

CREATE INDEX idx_purchase_receipt_items_receipt_id ON purchase_receipt_items(purchase_receipt_id);
CREATE INDEX idx_purchase_receipt_items_variant_id ON purchase_receipt_items(variant_id);
