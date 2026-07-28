# Product Performance Analytics

## Feature Status

- **Implementation:** Completed
- **Final integrated testing:** Pending
- **Production smoke testing:** Pending

Main implementation commits:

```text
b65c731b — feat(reports): add product performance analytics API
78156176 — fix(reports): correct product report query parameters
a8cd378a — feat(web-admin): add product performance report
1dd83388 — fix(web-admin): use authenticated branch scope in product report
```

---

## Purpose

The Product Performance Analytics feature provides two management reports:

- Top-selling product variants.
- Slow-moving product variants.

The reports combine sales history with the current PostgreSQL inventory balance.

SQLite inventory is not used.

---

## Main Files

### Database

```text
db/migrations/028_product_performance_report_indexes.sql
```

### Backend

```text
services/api/src/modules/reports/reports.routes.ts
services/api/src/modules/auth/auth.middleware.ts
```

### Web Admin

```text
apps/web-admin/src/pages/ProductPerformancePage.tsx
apps/web-admin/src/App.tsx
apps/web-admin/src/styles.css
```

---

## Required Permission

```text
reports.view
```

The reserved administrator role also receives access through the administrator permission bypass.

---

## Report API

```http
GET /api/reports/product-performance
```

### Required Query Parameters

```text
dateFrom
dateTo
```

Date format:

```text
YYYY-MM-DD
```

Example:

```http
GET /api/reports/product-performance?dateFrom=2026-07-01&dateTo=2026-07-31
```

### Optional Query Parameters

```text
branchId
limit
```

Branch example:

```http
GET /api/reports/product-performance?dateFrom=2026-07-01&dateTo=2026-07-31&branchId=BRANCH_UUID
```

Result-limit example:

```http
GET /api/reports/product-performance?dateFrom=2026-07-01&dateTo=2026-07-31&limit=50
```

---

## Validation

The Backend validates:

- Start date is present.
- End date is present.
- Dates use valid `YYYY-MM-DD` values.
- Start date is not after the end date.
- The report period does not exceed 366 days.
- Branch ID is a valid UUID.
- Requested branch belongs to the authenticated company.

The result limit:

- Defaults to `20`.
- Has a minimum of `1`.
- Has a maximum of `100`.

---

## Tenant and Branch Security

Company identity always comes from the authenticated session.

### Company-Level User

A company-level user can:

- View all company branches and warehouses.
- Select one company branch.
- Return to the full company scope.

### Branch-Restricted User

A branch-restricted user:

- Is restricted to the authenticated branch.
- Cannot override the branch through query parameters.
- Receives only the authenticated branch in `branchOptions`.
- Receives:

```text
branchSelectionLocked = true
```

The Web Admin locks the branch selector based on the authenticated scope returned by the API, not according to the number of available branches.

---

## Included Sale Statuses

The report includes sale items from sales with these statuses:

```text
completed
pending_review
refunded
```

Voided and draft sales are excluded.

The report measures gross sale-item movement before deducting returns.

---

## Top-Selling Products

Top-selling products are grouped by product variant.

A variant represents a specific combination such as:

- Product.
- Size.
- Color.
- SKU.
- Barcode.

The ordering is:

```text
soldQuantity DESC
grossRevenue DESC
productName ASC
sku ASC
```

The report includes:

- Product name.
- SKU.
- Barcode.
- Size.
- Color.
- Category.
- Brand.
- Product and variant status.
- Sale invoice count.
- Sold quantity.
- Gross revenue.
- Average revenue per sold unit.
- Current stock.
- Last sale timestamp.

Historical sales for inactive products or variants remain visible.

---

## Slow-Moving Products

Slow-moving results include only variants that:

- Belong to active products.
- Are active variants.
- Have current stock greater than zero.

The ordering is:

```text
soldQuantity ASC
lastSaleAt ASC NULLS FIRST
currentStock DESC
productName ASC
sku ASC
```

This means:

1. Products with no sales during the selected period appear first.
2. Products with the lowest sold quantity appear next.
3. Older last-sale dates appear before recent last-sale dates.
4. Larger current stock is prioritized when movement is otherwise equal.

---

## Movement Classes

### No Sales in Period

```text
no_sales_in_period
```

Used when:

```text
soldQuantity = 0
```

### Low Sales in Period

```text
low_sales_in_period
```

Used when the product has positive stock and some sales, but appears among the lowest-selling results.

---

## Current Stock Basis

Current stock is calculated from:

```text
stock_balances
```

The report sums stock balances by product variant.

For a branch report:

```text
stock_balances.branch_id = selected branch
```

For the company report:

- All company branch balances are included.
- Company-level warehouse balances with a null branch may also be included.

PostgreSQL remains the only trusted inventory source.

Desktop POS does not provide a local inventory balance to this report.

---

## Report Summary

The response summary includes:

```text
salesCount
soldVariantCount
soldQuantity
grossRevenue
inStockVariantCount
currentStockQuantity
noSaleStockVariantCount
```

### Sales Count

Number of distinct active sale invoices containing sale items during the selected period.

### Sold Variant Count

Number of distinct variants sold during the period.

### Sold Quantity

Total gross quantity recorded in included sale items.

### Gross Revenue

Total `sale_items.line_total` value for included sales.

### In-Stock Variant Count

Number of active variants with current stock greater than zero.

### Current Stock Quantity

Total positive current stock quantity.

Negative and zero balances are not included in this summary value.

### No-Sale Stock Variant Count

Number of active variants that:

- Have positive current stock.
- Have no included sales during the selected period.

---

## Response Structure

The API response contains:

```text
filters
definitions
branchOptions
summary
topProducts
slowMovingProducts
```

### Filters

Returns:

- Company ID.
- Effective branch ID.
- Branch-selection lock state.
- Start date.
- End date.
- Number of days.
- Result limit.

### Definitions

Returns:

- Included sale statuses.
- Top-product ordering definition.
- Slow-moving ordering definition.
- Inventory source definition.
- Sales measurement definition.

### Branch Options

Returns the branches available to the authenticated user.

Each option contains:

```text
id
code
name
isActive
```

---

## Web Admin Screen

The navigation page is:

```text
أداء الأصناف
```

The page provides:

- Start-date filter.
- End-date filter.
- Branch filter.
- Result-limit selection.
- Report refresh.
- Company-scope reset.
- Summary cards.
- Top-ten comparison chart.
- Top-selling products table.
- Slow-moving products table.
- Calculation explanation.

---

## Summary Cards

The page displays:

- Gross product revenue.
- Sold quantity.
- Sale invoice count.
- Number of sold variants.
- Number of variants with current stock.
- Current stock quantity.
- Number of stocked variants without sales.

---

## Top-Product Chart

The chart displays up to the first ten top-selling variants.

Bar width is based on sold quantity relative to the highest-selling variant in the current result.

Each bar displays:

- Product and variant description.
- Sold quantity.
- Gross revenue.

The chart uses local HTML and CSS and does not require an external chart library.

---

## Loading and Filter Behaviour

The report does not apply changed inputs until the user presses:

```text
تحديث التقرير
```

When loading:

- Previous report data is cleared.
- Stale figures are not displayed.
- Loading feedback is shown.

When a company-level user selects:

```text
عرض كل الفروع
```

the branch filter is cleared and the company-wide report reloads.

Branch-restricted users cannot clear their enforced branch.

---

## Database Indexes

Migration:

```text
028_product_performance_report_indexes.sql
```

adds report indexes for:

```text
sales
sale_items
stock_balances
```

The sales index is partial and includes only:

```text
completed
pending_review
refunded
```

---

## Current Limitations

- Sales quantities are gross quantities before returns.
- Returned quantities are not deducted from product ranking.
- Exchange-issued and exchange-returned quantities are not included.
- Gross revenue is not accounting profit.
- Cost and margin calculations are not included.
- Slow-moving classification currently depends on result ordering rather than a configurable movement threshold.
- Days without sales are not generated as separate rows.
- Excel and PDF export are not implemented.
- Category and brand filters are not implemented.
- Pagination is not implemented; the maximum result limit is 100.

---

## Implementation Checklist

- [x] Product-performance API
- [x] Top-selling variant aggregation
- [x] Slow-moving variant aggregation
- [x] Current PostgreSQL stock integration
- [x] Company isolation
- [x] Branch isolation
- [x] Company-level branch selection
- [x] Authenticated branch lock
- [x] Branch ownership validation
- [x] Date validation
- [x] Maximum 366-day period
- [x] Configurable result limit
- [x] Maximum 100 results
- [x] Product and variant metadata
- [x] Category and brand metadata
- [x] Size and color metadata
- [x] Last-sale timestamp
- [x] Days since last sale
- [x] Summary metrics
- [x] Report database indexes
- [x] Web Admin page
- [x] Summary cards
- [x] Top-product chart
- [x] Top-products table
- [x] Slow-moving-products table
- [x] Responsive layout
- [x] Stale-report protection
- [x] Feature documentation
- [ ] Final integrated acceptance test
- [ ] Production smoke test
- [ ] Net quantity after returns
- [ ] Exchange quantity integration
- [ ] Category and brand filtering
- [ ] Excel export
- [ ] PDF export
- [ ] Profit and margin analytics

---

## Final Acceptance Scenarios

### Company Scope

- Log in as a company-level manager.
- Load the report without a branch ID.
- Confirm all accessible company inventory is included.
- Confirm branch options include company branches.

### Single-Branch Company Manager

- Log in as a company-level manager whose company has one branch.
- Confirm the branch selector remains enabled.
- Confirm the user can switch between company scope and branch scope.

### Branch User

- Log in as a branch-restricted user.
- Confirm only the authenticated branch appears.
- Confirm the branch selector is locked.
- Attempt to send another branch ID manually.
- Confirm the authenticated branch is enforced.

### Top-Selling Ranking

- Create sales for multiple variants.
- Confirm the highest sold quantity appears first.
- Confirm revenue resolves equal-quantity ordering.

### Slow-Moving Ranking

- Ensure several active variants have positive stock.
- Leave one variant without sales.
- Confirm it appears before variants with sales.
- Confirm zero-stock variants do not appear.

### Voided Sale

- Void a sale.
- Confirm its items no longer appear in product totals.

### Pending Review Sale

- Synchronize an offline sale requiring review.
- Confirm its items follow the documented included-status rule.

### Inactive Historical Product

- Mark a previously sold product or variant inactive.
- Confirm it remains visible in historical top-selling results.
- Confirm it does not appear as an active slow-moving stocked variant.

### Date Validation

- Use an invalid date.
- Use a start date after the end date.
- Request more than 366 days.
- Confirm every invalid request is rejected.

### Limit Validation

- Omit the limit and confirm the default is 20.
- Request 10, 50 and 100 results.
- Request more than 100 and confirm the effective limit is 100.

### Empty Period

- Select a valid period without sales.
- Confirm top-selling results are empty.
- Confirm stocked products can still appear as slow-moving.

---

## Completion Definition

Current feature state:

```text
IMPLEMENTATION COMPLETE
```

Remaining work:

- Final integrated acceptance testing.
- Production smoke testing.
- Return and exchange quantity integration.
- Export features.
- Profit and margin analytics.
