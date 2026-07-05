CREATE TABLE transfers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    transfer_number TEXT NOT NULL,

    from_branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    to_branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,

    from_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
    to_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,

    status TEXT NOT NULL DEFAULT 'draft' CHECK (
        status IN (
            'draft',
            'pending',
            'approved',
            'in_transit',
            'received',
            'cancelled'
        )
    ),

    requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    received_by UUID REFERENCES users(id) ON DELETE SET NULL,

    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ,

    note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, transfer_number),

    CHECK (from_location_id <> to_location_id)
);

CREATE TABLE transfer_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    transfer_id UUID NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,

    requested_quantity NUMERIC(14,3) NOT NULL,
    approved_quantity NUMERIC(14,3),
    received_quantity NUMERIC(14,3),

    note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (requested_quantity > 0),
    CHECK (approved_quantity IS NULL OR approved_quantity >= 0),
    CHECK (received_quantity IS NULL OR received_quantity >= 0)
);

CREATE INDEX idx_transfers_company_id ON transfers(company_id);
CREATE INDEX idx_transfers_from_branch_id ON transfers(from_branch_id);
CREATE INDEX idx_transfers_to_branch_id ON transfers(to_branch_id);
CREATE INDEX idx_transfers_from_location_id ON transfers(from_location_id);
CREATE INDEX idx_transfers_to_location_id ON transfers(to_location_id);
CREATE INDEX idx_transfers_status ON transfers(status);
CREATE INDEX idx_transfer_items_transfer_id ON transfer_items(transfer_id);
CREATE INDEX idx_transfer_items_variant_id ON transfer_items(variant_id);
