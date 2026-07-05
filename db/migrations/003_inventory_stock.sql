CREATE TABLE stock_locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    code TEXT NOT NULL,

    location_type TEXT NOT NULL CHECK (
        location_type IN (
            'main_warehouse',
            'branch_warehouse',
            'sales_floor',
            'returns',
            'damaged',
            'inspection'
        )
    ),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, code)
);

CREATE TABLE stock_balances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    stock_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,

    quantity NUMERIC(14,3) NOT NULL DEFAULT 0,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, stock_location_id, variant_id)
);

CREATE TABLE stock_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    stock_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,

    movement_type TEXT NOT NULL CHECK (
        movement_type IN (
            'purchase',
            'sale',
            'return',
            'exchange',
            'transfer_in',
            'transfer_out',
            'adjustment',
            'damage',
            'stock_count'
        )
    ),

    quantity NUMERIC(14,3) NOT NULL,
    quantity_before NUMERIC(14,3),
    quantity_after NUMERIC(14,3),

    reference_type TEXT,
    reference_id UUID,

    note TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stock_locations_company_id ON stock_locations(company_id);
CREATE INDEX idx_stock_locations_branch_id ON stock_locations(branch_id);

CREATE INDEX idx_stock_balances_company_location ON stock_balances(company_id, stock_location_id);
CREATE INDEX idx_stock_balances_variant_id ON stock_balances(variant_id);

CREATE INDEX idx_stock_movements_company_id ON stock_movements(company_id);
CREATE INDEX idx_stock_movements_variant_id ON stock_movements(variant_id);
CREATE INDEX idx_stock_movements_location_id ON stock_movements(stock_location_id);
CREATE INDEX idx_stock_movements_created_at ON stock_movements(created_at);
CREATE INDEX idx_stock_movements_reference ON stock_movements(reference_type, reference_id);
