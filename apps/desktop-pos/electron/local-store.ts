import { DatabaseSync } from 'node:sqlite'

export type PendingSaleRecord = {
  id: string
  localSaleId: string
  idempotencyKey: string
  status: 'pending' | 'syncing' | 'needs_review' | 'failed'
  payload: Record<string, unknown>
  attemptCount: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

let database: DatabaseSync | null = null

function getDatabase() {
  if (!database) {
    throw new Error('Desktop POS local database is not initialized')
  }

  return database
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {}
  }

  try {
    const parsed = JSON.parse(value)

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>
    }

    return {}
  } catch {
    return {}
  }
}

export function initializeLocalStore(databasePath: string) {
  database = new DatabaseSync(databasePath)

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    -- إعدادات التطبيق والجهاز.
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    -- =====================================================
    -- Outbox المبيعات المؤجلة فقط.
    --
    -- لا يوجد داخل SQLite:
    -- stock_balances
    -- stock_movements
    -- inventory quantities
    --
    -- PostgreSQL هو المسؤول الوحيد عن خصم المخزون.
    -- =====================================================
    CREATE TABLE IF NOT EXISTS pending_sales (
      id TEXT PRIMARY KEY,

      local_sale_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,

      payload_json TEXT NOT NULL,

      status TEXT NOT NULL CHECK (
        status IN (
          'pending',
          'syncing',
          'needs_review',
          'failed'
        )
      ),

      attempt_count INTEGER NOT NULL DEFAULT 0,

      last_error TEXT,

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS
    idx_pending_sales_status_created
    ON pending_sales (
      status,
      created_at ASC
    );
  `)
}

export function getSetting(key: string) {
  const row = getDatabase()
    .prepare(
      `
      SELECT value
      FROM app_settings
      WHERE key = ?
      LIMIT 1;
      `,
    )
    .get(key) as { value: string } | undefined

  return row?.value ?? null
}

export function setSetting(key: string, value: string) {
  const now = new Date().toISOString()

  getDatabase()
    .prepare(
      `
      INSERT INTO app_settings (
        key,
        value,
        updated_at
      )
      VALUES (?, ?, ?)

      ON CONFLICT (key)
      DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at;
      `,
    )
    .run(key, value, now)
}

export function deleteSetting(key: string) {
  getDatabase()
    .prepare(
      `
      DELETE FROM app_settings
      WHERE key = ?;
      `,
    )
    .run(key)
}

export function countPendingSales() {
  const row = getDatabase()
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM pending_sales
      WHERE status IN (
        'pending',
        'syncing',
        'failed'
      );
      `,
    )
    .get() as { total: number } | undefined

  return Number(row?.total ?? 0)
}

export function listPendingSales(limit = 100): PendingSaleRecord[] {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500)

  const rows = getDatabase()
    .prepare(
      `
      SELECT
        id,
        local_sale_id,
        idempotency_key,
        payload_json,
        status,
        attempt_count,
        last_error,
        created_at,
        updated_at

      FROM pending_sales

      ORDER BY created_at ASC

      LIMIT ?;
      `,
    )
    .all(safeLimit) as Array<{
    id: string
    local_sale_id: string
    idempotency_key: string
    payload_json: string
    status: PendingSaleRecord['status']
    attempt_count: number
    last_error: string | null
    created_at: string
    updated_at: string
  }>

  return rows.map((row) => ({
    id: row.id,
    localSaleId: row.local_sale_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    payload: parsePayload(row.payload_json),
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}
