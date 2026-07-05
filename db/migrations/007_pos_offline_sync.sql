CREATE TABLE pos_devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

    device_code TEXT NOT NULL,
    device_name TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'inactive', 'blocked')
    ),

    last_seen_at TIMESTAMPTZ,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(company_id, branch_id, device_code)
);

CREATE TABLE pos_offline_sync_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES pos_devices(id) ON DELETE RESTRICT,

    batch_key TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'processing', 'completed', 'completed_with_errors', 'failed')
    ),

    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,

    request_payload JSONB,
    response_payload JSONB,

    UNIQUE(company_id, device_id, batch_key)
);

CREATE TABLE pos_offline_sync_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES pos_offline_sync_batches(id) ON DELETE CASCADE,

    local_entity_type TEXT NOT NULL CHECK (
        local_entity_type IN ('sale', 'return', 'exchange')
    ),

    local_entity_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processed', 'failed', 'needs_review', 'duplicate')
    ),

    server_entity_type TEXT CHECK (
        server_entity_type IN ('sale', 'return', 'exchange')
    ),

    server_entity_id UUID,

    error_code TEXT,
    error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,

    UNIQUE(company_id, idempotency_key)
);

CREATE TABLE pos_pending_conflicts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    device_id UUID REFERENCES pos_devices(id) ON DELETE SET NULL,

    sync_item_id UUID REFERENCES pos_offline_sync_items(id) ON DELETE SET NULL,

    conflict_type TEXT NOT NULL CHECK (
        conflict_type IN (
            'negative_stock',
            'price_changed',
            'variant_not_found',
            'cashier_not_found',
            'stock_location_not_found',
            'duplicate_suspected',
            'unknown'
        )
    ),

    severity TEXT NOT NULL DEFAULT 'warning' CHECK (
        severity IN ('info', 'warning', 'critical')
    ),

    status TEXT NOT NULL DEFAULT 'open' CHECK (
        status IN ('open', 'reviewed', 'resolved', 'ignored')
    ),

    details JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_pos_devices_company_branch ON pos_devices(company_id, branch_id);
CREATE INDEX idx_pos_devices_status ON pos_devices(status);

CREATE INDEX idx_pos_sync_batches_company_branch ON pos_offline_sync_batches(company_id, branch_id);
CREATE INDEX idx_pos_sync_batches_device_id ON pos_offline_sync_batches(device_id);
CREATE INDEX idx_pos_sync_batches_status ON pos_offline_sync_batches(status);
CREATE INDEX idx_pos_sync_batches_received_at ON pos_offline_sync_batches(received_at);

CREATE INDEX idx_pos_sync_items_batch_id ON pos_offline_sync_items(batch_id);
CREATE INDEX idx_pos_sync_items_status ON pos_offline_sync_items(status);
CREATE INDEX idx_pos_sync_items_idempotency_key ON pos_offline_sync_items(idempotency_key);

CREATE INDEX idx_pos_conflicts_company_branch ON pos_pending_conflicts(company_id, branch_id);
CREATE INDEX idx_pos_conflicts_status ON pos_pending_conflicts(status);
CREATE INDEX idx_pos_conflicts_type ON pos_pending_conflicts(conflict_type);
