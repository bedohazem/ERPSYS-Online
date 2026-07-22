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

export type CreatePendingSaleRecordInput = {
  id: string
  localSaleId: string
  idempotencyKey: string
  payload: Record<string, unknown>
}

export type PendingSaleSyncResult = {
  localSaleId: string

  status: 'processed' | 'duplicate' | 'needs_review' | 'failed'

  errorMessage: string | null
}

export type CatalogCacheItemInput = {
  variantId: string
  productId: string
  productName: string
  sku: string
  primaryBarcode: string | null
  sizeName: string | null
  colorName: string | null
  sellingPrice: string
  barcodes: string[]
}

export type CatalogCacheItemRecord = {
  variantId: string
  productId: string
  productName: string
  sku: string
  primaryBarcode: string | null
  sizeName: string | null
  colorName: string | null
  sellingPrice: string
}

export type CatalogCacheInfo = {
  itemCount: number
  refreshedAt: string | null
}

export type WorkspaceCacheInput = {
  serverTime: string

  device: {
    deviceId: string
    companyId: string
    branchId: string
    deviceCode: string
    deviceName: string
    branchCode: string
    branchName: string
  }

  stockLocations: Array<{
    id: string
    code: string
    name: string
    location_type: string
  }>
}

export type WorkspaceCacheRecord = WorkspaceCacheInput & {
  cachedAt: string
}

const CATALOG_REFRESHED_AT_KEY = 'pos.catalog.refreshed-at'

const WORKSPACE_CACHE_KEY = 'pos.workspace.cache'

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
    -- =====================================================
    -- كتالوج أصناف محلي للبحث Offline.
    --
    -- لا يحتوي على:
    -- stock quantity
    -- stock balance
    -- stock movement
    -- =====================================================
    CREATE TABLE IF NOT EXISTS catalog_items (
      variant_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,

      product_name TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE,

      primary_barcode TEXT,

      size_name TEXT,
      color_name TEXT,

      selling_price TEXT NOT NULL,

      refreshed_at TEXT NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS
    idx_catalog_items_primary_barcode
    ON catalog_items (
      primary_barcode
    )
    WHERE primary_barcode IS NOT NULL;

    CREATE INDEX IF NOT EXISTS
    idx_catalog_items_product_name
    ON catalog_items (
      product_name
    );

    CREATE TABLE IF NOT EXISTS catalog_barcodes (
      barcode TEXT PRIMARY KEY,

      variant_id TEXT NOT NULL
        REFERENCES catalog_items (
          variant_id
        )
        ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS
    idx_catalog_barcodes_variant
    ON catalog_barcodes (
      variant_id
    );

  `)

  // لو التطبيق اتقفل أثناء المزامنة،
  // نعيد العملية إلى Pending حتى يمكن المحاولة مرة أخرى.
  database
    .prepare(
      `
      UPDATE pending_sales
      SET
        status = 'pending',
        updated_at = ?
      WHERE status = 'syncing';
      `,
    )
    .run(new Date().toISOString())
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

function parseWorkspaceCache(value: string): WorkspaceCacheRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceCacheRecord>

    const device = parsed.device

    if (
      typeof parsed.serverTime !== 'string' ||
      typeof parsed.cachedAt !== 'string' ||
      !device ||
      typeof device.deviceId !== 'string' ||
      typeof device.companyId !== 'string' ||
      typeof device.branchId !== 'string' ||
      typeof device.deviceCode !== 'string' ||
      typeof device.deviceName !== 'string' ||
      typeof device.branchCode !== 'string' ||
      typeof device.branchName !== 'string' ||
      !Array.isArray(parsed.stockLocations)
    ) {
      return null
    }

    const locationsAreValid = parsed.stockLocations.every(
      (location) =>
        typeof location?.id === 'string' &&
        typeof location?.code === 'string' &&
        typeof location?.name === 'string' &&
        typeof location?.location_type === 'string',
    )

    if (!locationsAreValid) {
      return null
    }

    return parsed as WorkspaceCacheRecord
  } catch {
    return null
  }
}

export function getWorkspaceCache(): WorkspaceCacheRecord | null {
  const storedValue = getSetting(WORKSPACE_CACHE_KEY)

  if (!storedValue) {
    return null
  }

  const workspace = parseWorkspaceCache(storedValue)

  if (!workspace) {
    deleteSetting(WORKSPACE_CACHE_KEY)

    return null
  }

  return workspace
}

export function saveWorkspaceCache(
  input: WorkspaceCacheInput,
): WorkspaceCacheRecord {
  const workspace: WorkspaceCacheRecord = {
    ...input,
    cachedAt: new Date().toISOString(),
  }

  setSetting(WORKSPACE_CACHE_KEY, JSON.stringify(workspace))

  return workspace
}

export function clearWorkspaceCache() {
  deleteSetting(WORKSPACE_CACHE_KEY)
}

export function clearCatalogCache() {
  const currentDatabase = getDatabase()

  currentDatabase.exec('BEGIN IMMEDIATE;')

  try {
    currentDatabase.exec(`
      DELETE FROM catalog_barcodes;
      DELETE FROM catalog_items;
    `)

    currentDatabase
      .prepare(
        `
        DELETE FROM app_settings
        WHERE key = ?;
        `,
      )
      .run(CATALOG_REFRESHED_AT_KEY)

    currentDatabase.exec('COMMIT;')
  } catch (error) {
    currentDatabase.exec('ROLLBACK;')
    throw error
  }
}

export function getCatalogCacheInfo(): CatalogCacheInfo {
  const countRow = getDatabase()
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM catalog_items;
      `,
    )
    .get() as
    | {
        total: number
      }
    | undefined

  return {
    itemCount: Number(countRow?.total ?? 0),

    refreshedAt: getSetting(CATALOG_REFRESHED_AT_KEY),
  }
}

export function replaceCatalogCache(
  items: CatalogCacheItemInput[],
  refreshedAt: string,
): CatalogCacheInfo {
  const currentDatabase = getDatabase()

  const now = new Date().toISOString()

  currentDatabase.exec('BEGIN IMMEDIATE;')

  try {
    currentDatabase.exec(`
      DELETE FROM catalog_barcodes;
      DELETE FROM catalog_items;
    `)

    const insertItem = currentDatabase.prepare(
      `
        INSERT INTO catalog_items (
          variant_id,
          product_id,
          product_name,
          sku,
          primary_barcode,
          size_name,
          color_name,
          selling_price,
          refreshed_at
        )
        VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        );
        `,
    )

    const insertBarcode = currentDatabase.prepare(
      `
        INSERT INTO catalog_barcodes (
          barcode,
          variant_id
        )
        VALUES (?, ?);
        `,
    )

    for (const item of items) {
      insertItem.run(
        item.variantId,
        item.productId,
        item.productName,
        item.sku,
        item.primaryBarcode,
        item.sizeName,
        item.colorName,
        item.sellingPrice,
        refreshedAt,
      )

      const uniqueBarcodes = new Set(
        item.barcodes
          .map((barcode) => barcode.trim())
          .filter((barcode) => barcode && barcode !== item.primaryBarcode),
      )

      for (const barcode of uniqueBarcodes) {
        insertBarcode.run(barcode, item.variantId)
      }
    }

    currentDatabase
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
          updated_at =
            excluded.updated_at;
        `,
      )
      .run(CATALOG_REFRESHED_AT_KEY, refreshedAt, now)

    currentDatabase.exec('COMMIT;')
  } catch (error) {
    currentDatabase.exec('ROLLBACK;')
    throw error
  }

  return getCatalogCacheInfo()
}

function mapCatalogCacheRow(row: {
  variant_id: string
  product_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  selling_price: string
}): CatalogCacheItemRecord {
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,

    primaryBarcode: row.primary_barcode,

    sizeName: row.size_name,
    colorName: row.color_name,

    sellingPrice: row.selling_price,
  }
}

export function searchCatalogCache(
  query: string,
  limit = 20,
): CatalogCacheItemRecord[] {
  const normalizedQuery = query.trim()

  if (!normalizedQuery) {
    return []
  }

  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100)

  const searchText = `%${normalizedQuery}%`

  const rows = getDatabase()
    .prepare(
      `
      SELECT DISTINCT
        ci.variant_id,
        ci.product_id,
        ci.product_name,
        ci.sku,
        ci.primary_barcode,
        ci.size_name,
        ci.color_name,
        ci.selling_price

      FROM catalog_items ci

      LEFT JOIN catalog_barcodes cb
        ON cb.variant_id =
            ci.variant_id

      WHERE
        ci.product_name
          LIKE ? COLLATE NOCASE

        OR ci.sku
          LIKE ? COLLATE NOCASE

        OR ci.primary_barcode
          LIKE ? COLLATE NOCASE

        OR cb.barcode
          LIKE ? COLLATE NOCASE

      ORDER BY
        ci.product_name
          COLLATE NOCASE ASC,

        ci.sku
          COLLATE NOCASE ASC

      LIMIT ?;
      `,
    )
    .all(searchText, searchText, searchText, searchText, safeLimit) as Array<{
    variant_id: string
    product_id: string
    product_name: string
    sku: string
    primary_barcode: string | null
    size_name: string | null
    color_name: string | null
    selling_price: string
  }>

  return rows.map(mapCatalogCacheRow)
}

export function lookupCatalogCacheItem(
  code: string,
): CatalogCacheItemRecord | null {
  const normalizedCode = code.trim()

  if (!normalizedCode) {
    return null
  }

  const row = getDatabase()
    .prepare(
      `
      SELECT
        ci.variant_id,
        ci.product_id,
        ci.product_name,
        ci.sku,
        ci.primary_barcode,
        ci.size_name,
        ci.color_name,
        ci.selling_price

      FROM catalog_items ci

      WHERE
        ci.sku = ?
          COLLATE NOCASE

        OR ci.primary_barcode = ?
          COLLATE NOCASE

        OR EXISTS (
          SELECT 1
          FROM catalog_barcodes cb

          WHERE cb.variant_id =
                ci.variant_id

            AND cb.barcode = ?
                COLLATE NOCASE
        )

      LIMIT 1;
      `,
    )
    .get(normalizedCode, normalizedCode, normalizedCode) as
    | {
        variant_id: string
        product_id: string
        product_name: string
        sku: string
        primary_barcode: string | null
        size_name: string | null
        color_name: string | null
        selling_price: string
      }
    | undefined

  return row ? mapCatalogCacheRow(row) : null
}

export function createPendingSaleRecord(
  input: CreatePendingSaleRecordInput,
): PendingSaleRecord {
  const now = new Date().toISOString()

  getDatabase()
    .prepare(
      `
      INSERT INTO pending_sales (
        id,
        local_sale_id,
        idempotency_key,
        payload_json,
        status,
        attempt_count,
        last_error,
        created_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?,
        'pending',
        0,
        NULL,
        ?, ?
      );
      `,
    )
    .run(
      input.id,
      input.localSaleId,
      input.idempotencyKey,
      JSON.stringify(input.payload),
      now,
      now,
    )

  return {
    id: input.id,
    localSaleId: input.localSaleId,
    idempotencyKey: input.idempotencyKey,
    status: 'pending',
    payload: input.payload,
    attemptCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
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
        'needs_review',
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

type PendingSaleDatabaseRow = {
  id: string
  local_sale_id: string
  idempotency_key: string
  payload_json: string

  status: PendingSaleRecord['status']

  attempt_count: number
  last_error: string | null
  created_at: string
  updated_at: string
}

function mapPendingSaleRow(row: PendingSaleDatabaseRow): PendingSaleRecord {
  return {
    id: row.id,

    localSaleId: row.local_sale_id,

    idempotencyKey: row.idempotency_key,

    status: row.status,

    payload: parsePayload(row.payload_json),

    attemptCount: Number(row.attempt_count),

    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// يأخذ مجموعة للمزامنة ويحوّلها إلى syncing داخل Transaction واحدة.
// failed تُعاد تلقائيًا حتى 5 محاولات، أو دائمًا عند Sync Now اليدوي.
export function takePendingSalesForSync(
  limit = 50,
  forceRetry = false,
): PendingSaleRecord[] {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100)

  const currentDatabase = getDatabase()

  currentDatabase.exec('BEGIN IMMEDIATE;')

  try {
    const rows = currentDatabase
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

        WHERE
          status = 'pending'

          OR (
            status = 'failed'
            AND (
              ? = 1
              OR attempt_count < 5
            )
          )

        ORDER BY created_at ASC

        LIMIT ?;
        `,
      )
      .all(forceRetry ? 1 : 0, safeLimit) as PendingSaleDatabaseRow[]

    const updatedAt = new Date().toISOString()

    const updateStatement = currentDatabase.prepare(
      `
        UPDATE pending_sales
        SET
          status = 'syncing',
          attempt_count =
            attempt_count + 1,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?;
        `,
    )

    for (const row of rows) {
      updateStatement.run(updatedAt, row.id)
    }

    currentDatabase.exec('COMMIT;')

    return rows.map((row) => ({
      ...mapPendingSaleRow(row),

      status: 'syncing',

      attemptCount: Number(row.attempt_count) + 1,

      lastError: null,
      updatedAt,
    }))
  } catch (error) {
    currentDatabase.exec('ROLLBACK;')
    throw error
  }
}

export function markPendingSalesFailed(
  localSaleIds: string[],
  errorMessage: string,
) {
  if (localSaleIds.length === 0) {
    return
  }

  const currentDatabase = getDatabase()

  const updatedAt = new Date().toISOString()

  currentDatabase.exec('BEGIN IMMEDIATE;')

  try {
    const statement = currentDatabase.prepare(
      `
        UPDATE pending_sales
        SET
          status = 'failed',
          last_error = ?,
          updated_at = ?
        WHERE local_sale_id = ?;
        `,
    )

    for (const localSaleId of localSaleIds) {
      statement.run(errorMessage, updatedAt, localSaleId)
    }

    currentDatabase.exec('COMMIT;')
  } catch (error) {
    currentDatabase.exec('ROLLBACK;')
    throw error
  }
}

// processed وduplicate فقط يتم حذفهما.
// needs_review تبقى محليًا للعرض، لكنها لا تعاد تلقائيًا للسيرفر.
export function applyPendingSaleSyncResults(
  selectedLocalSaleIds: string[],
  results: PendingSaleSyncResult[],
) {
  const currentDatabase = getDatabase()

  const updatedAt = new Date().toISOString()

  const respondedLocalSaleIds = new Set<string>()

  currentDatabase.exec('BEGIN IMMEDIATE;')

  try {
    const deleteStatement = currentDatabase.prepare(
      `
        DELETE FROM pending_sales
        WHERE local_sale_id = ?;
        `,
    )

    const updateStatement = currentDatabase.prepare(
      `
        UPDATE pending_sales
        SET
          status = ?,
          last_error = ?,
          updated_at = ?
        WHERE local_sale_id = ?;
        `,
    )

    for (const result of results) {
      respondedLocalSaleIds.add(result.localSaleId)

      if (result.status === 'processed' || result.status === 'duplicate') {
        deleteStatement.run(result.localSaleId)

        continue
      }

      updateStatement.run(
        result.status,

        result.errorMessage ||
          (result.status === 'needs_review'
            ? 'تمت المزامنة وتحتاج مراجعة في Web Admin.'
            : 'فشلت معالجة الفاتورة على السيرفر.'),

        updatedAt,
        result.localSaleId,
      )
    }

    for (const localSaleId of selectedLocalSaleIds) {
      if (respondedLocalSaleIds.has(localSaleId)) {
        continue
      }

      updateStatement.run(
        'failed',
        'لم يُرجع السيرفر نتيجة لهذه الفاتورة.',
        updatedAt,
        localSaleId,
      )
    }

    currentDatabase.exec('COMMIT;')
  } catch (error) {
    currentDatabase.exec('ROLLBACK;')
    throw error
  }
}
