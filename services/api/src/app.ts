import express from 'express'
import cors from 'cors'
import helmet from 'helmet'

import { healthRouter } from './routes/health.route'
import { demoRouter } from './routes/demo.route'

import { authRouter } from './modules/auth/auth.routes'
import {
  applyAuthenticatedTenant,
  requireAuth,
  requireBusinessPermission,
} from './modules/auth/auth.middleware'

import { companiesRouter } from './modules/companies/companies.routes'
import { branchesRouter } from './modules/branches/branches.routes'
import { catalogRouter } from './modules/catalog/catalog.routes'
import { inventoryRouter } from './modules/inventory/inventory.routes'
import { suppliersRouter } from './modules/suppliers/suppliers.routes'
import { purchasesRouter } from './modules/purchases/purchases.routes'
import { purchaseOrdersRouter } from './modules/purchase-orders/purchase-orders.routes'
import { supplierFinanceRouter } from './modules/supplier-finance/supplier-finance.routes'
import { transfersRouter } from './modules/transfers/transfers.routes'
import { salesRouter } from './modules/sales/sales.routes'
import { posRouter } from './modules/pos/pos.routes'
import { posDevicesRouter } from './modules/pos-devices/pos-devices.routes'
import {
  posDeviceSyncRouter,
  posSyncAdminRouter,
} from './modules/pos-sync/pos-sync.routes'
import { customersRouter } from './modules/customers/customers.routes'
import { returnsRouter } from './modules/returns/returns.routes'
import { exchangesRouter } from './modules/exchanges/exchanges.routes'
import { reportsRouter } from './modules/reports/reports.routes'
import { inventoryAdjustmentsRouter } from './modules/inventory/inventory-adjustments.routes'
import { inventoryStockCountsRouter } from './modules/inventory/inventory-stock-counts.routes'
// إدارة المستخدمين والأدوار والصلاحيات.
import { accessRouter } from './modules/access/access.routes'

export const app = express()

// ======================================================
// General Security Middleware
// ======================================================

app.use(helmet())
app.use(cors())
app.use(express.json({ limit: '2mb' }))

// ======================================================
// Public Routes
//
// Health وLogin فقط لا يحتاجان Session.
// authRouter يحتوي أيضًا على /me و/logout، وهما محميان
// داخليًا باستخدام requireAuth.
// ======================================================

app.use(healthRouter)
app.use(authRouter)
// Device-authenticated POS routes.
//
// هذه المسارات لا تستخدم User Bearer Session.
// كل Route بداخلها يستخدم requirePosDevice.
app.use(posDeviceSyncRouter)

// ======================================================
// Protected API Layer
//
// أي Route يبدأ بـ /api بعد هذه النقطة:
// 1. يجب أن يحمل Bearer Token صالحًا.
// 2. يأخذ الشركة والفرع من Session الموثقة.
// ======================================================

// كل Business API تحتاج Login وصلاحية مناسبة.
app.use(
  '/api',
  requireAuth,
  applyAuthenticatedTenant,
  requireBusinessPermission,
)

// ======================================================
// Protected Business Routes
// ======================================================

app.use(demoRouter)
app.use(companiesRouter)
app.use(branchesRouter)
app.use(catalogRouter)
app.use(inventoryRouter)
app.use(inventoryAdjustmentsRouter)
app.use(inventoryStockCountsRouter)
app.use(suppliersRouter)
app.use(purchasesRouter)
app.use(purchaseOrdersRouter)
app.use(supplierFinanceRouter)
app.use(transfersRouter)
app.use(salesRouter)
app.use(posRouter)
app.use(posDevicesRouter)
app.use(posSyncAdminRouter)
app.use(customersRouter)
app.use(returnsRouter)
app.use(exchangesRouter)
app.use(reportsRouter)
app.use(accessRouter)
// ======================================================
// 404 Handler
// ======================================================

app.use((_req, res) => {
  res.status(404).json({
    error: 'Not Found',
  })
})

// ======================================================
// Global Error Handler
// ======================================================

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error)

    res.status(500).json({
      error: 'Internal Server Error',
    })
  },
)
