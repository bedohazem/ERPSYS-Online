-- ======================================================
-- POS Cashier Shifts
--
-- ربط الوردية بجهاز POS وتصريح الكاشير.
-- يمنع فتح أكثر من وردية للكاشير أو الجهاز في نفس الوقت.
-- ======================================================

ALTER TABLE cashier_shifts
ADD COLUMN pos_device_id UUID
    REFERENCES pos_devices(id)
    ON DELETE SET NULL;

ALTER TABLE cashier_shifts
ADD COLUMN pos_cashier_grant_id UUID
    REFERENCES pos_cashier_grants(id)
    ON DELETE SET NULL;

CREATE INDEX
    idx_cashier_shifts_pos_device
ON cashier_shifts (
    company_id,
    pos_device_id,
    opened_at DESC
);

CREATE INDEX
    idx_cashier_shifts_pos_grant
ON cashier_shifts (
    company_id,
    pos_cashier_grant_id
);

CREATE UNIQUE INDEX
    uq_cashier_shifts_one_open_cashier
ON cashier_shifts (
    company_id,
    cashier_id
)
WHERE status = 'open';

CREATE UNIQUE INDEX
    uq_cashier_shifts_one_open_device
ON cashier_shifts (
    company_id,
    pos_device_id
)
WHERE
    status = 'open'
    AND pos_device_id IS NOT NULL;