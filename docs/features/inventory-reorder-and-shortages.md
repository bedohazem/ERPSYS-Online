# Inventory Reorder Rules and Shortage Alerts

## Feature Status

- **Implementation:** Completed
- **Final integrated testing:** Pending
- **Production smoke testing:** Pending

Main implementation commits:

```text
b8a60460 — feat(inventory): add reorder rule management
636a27f8 — feat(reports): add inventory shortage analytics API
174843d2 — feat(web-admin): add inventory shortage report
0da53414 — fix(inventory): secure shortage report access and filters
0c96746d — feat(web-admin): add reorder rule management
dd1b8d45 — fix(inventory): secure reorder rule item lookup
368dcf36 — fix(web-admin): clear cancelled reorder rule lookups
```

---

## Purpose

This feature provides inventory replenishment controls for every product variant inside each PostgreSQL stock location.

It supports:

- Reorder-point configuration.
- Safety-stock configuration.
- Fixed reorder quantity.
- Critical-stock alerts.
- Low-stock alerts.
- Out-of-stock visibility.
- Suggested purchase quantities.
- Branch and stock-location filters.
- Secure item lookup.
- Rule creation and editing.
- Audit logging.
- Web Admin reporting and management.

PostgreSQL remains the only inventory source of truth.

Desktop POS does not maintain or deduct authoritative local inventory.

---

## Main Files

### Database

```text
db/migrations/029_inventory_reorder_rules.sql
```

### Backend

```text
services/api/src/modules/inventory/inventory.routes.ts
services/api/src/modules/reports/reports.routes.ts
services/api/src/modules/auth/auth.middleware.ts
```

### Web Admin

```text
apps/web-admin/src/pages/InventoryShortagesPage.tsx
apps/web-admin/src/components/InventoryReorderRulesPanel.tsx
apps/web-admin/src/App.tsx
apps/web-admin/src/styles.css
```

---

## Permissions

Viewing stock-shortage information requires the applicable inventory or reporting permission according to the protected route.

Rule management requires:

```text
inventory.adjust
```

Reserved administrators receive access through the administrator-role bypass.

Users without adjustment permission can view applicable reports but cannot create or edit reorder rules.

---

## Database Table

### `inventory_reorder_rules`

Each rule belongs to:

- One company.
- One stock location.
- One product variant.

The combination is unique:

```text
company_id
stock_location_id
variant_id
```

Main fields:

```text
reorder_point
safety_stock
reorder_quantity
is_active
created_by
updated_by
created_at
updated_at
```

---

## Rule Definitions

### Reorder Point

The quantity at which replenishment attention begins.

```text
currentQuantity <= reorderPoint
```

### Safety Stock

The critical minimum quantity.

```text
currentQuantity <= safetyStock
```

Safety stock cannot exceed the reorder point.

### Reorder Quantity

Optional fixed purchase quantity.

When it is zero, the suggested amount depends on the calculated shortage.

---

## Stock Statuses

### Critical

```text
currentQuantity <= safetyStock
```

### Low

```text
safetyStock < currentQuantity
currentQuantity <= reorderPoint
```

### Healthy

```text
currentQuantity > reorderPoint
```

### Inactive

The reorder rule is disabled.

Inactive rules do not appear as active shortage alerts.

---

## Shortage Calculation

```text
shortageQuantity =
max(
  reorderPoint - currentQuantity,
  0
)
```

---

## Suggested Purchase Quantity

```text
suggestedOrderQuantity =
max(
  reorderQuantity,
  shortageQuantity
)
```

This means the suggested quantity never falls below either:

- The configured fixed reorder quantity.
- The quantity required to restore stock to the reorder point.

---

## Rule Validation

The Backend validates:

- Stock-location UUID.
- Product-variant UUID.
- Company ownership.
- Branch access.
- Non-negative reorder point.
- Non-negative safety stock.
- Non-negative reorder quantity.
- Safety stock does not exceed reorder point.
- Active rules have a reorder point greater than zero.
- Active product.
- Active product variant.
- Active stock location.

Cross-company or inaccessible items and locations are rejected.

---

## Rule Management API

### Read Rules

```http
GET /api/inventory/reorder-rules
```

Optional filters:

```text
stockLocationId
variantId
limit
```

The response includes:

- Product metadata.
- Variant metadata.
- Branch and stock-location metadata.
- Current PostgreSQL quantity.
- Reorder point.
- Safety stock.
- Reorder quantity.
- Calculated shortage.
- Suggested order quantity.
- Current stock status.
- Rule status.

---

### Create or Update Rule

```http
PUT /api/inventory/reorder-rules
```

Example request:

```json
{
  "stockLocationId": "STOCK_LOCATION_UUID",
  "variantId": "VARIANT_UUID",
  "reorderPoint": 10,
  "safetyStock": 3,
  "reorderQuantity": 20,
  "isActive": true
}
```

The same endpoint creates or updates the unique company, stock-location and variant combination.

---

## Secure Item Lookup

Rule creation uses a trusted inventory lookup endpoint.

The lookup verifies:

- Authenticated company.
- Accessible branch.
- Accessible stock location.
- SKU or barcode.
- Product and variant ownership.

The Web Admin never trusts a manually supplied variant ID without server validation.

Concurrent or cancelled lookup responses are ignored using request identifiers.

Changing:

- The selected rule.
- The stock location.
- The form state.
- The preferred location.

cancels the previous lookup state and removes its loading indicator.

---

## Audit Logging

Creating a rule records:

```text
inventory.reorder_rule.created
```

Updating a rule records:

```text
inventory.reorder_rule.updated
```

Audit data includes:

- Company.
- Branch.
- User.
- Rule ID.
- Previous data.
- New data.
- IP address.
- User agent.

Rule persistence and audit logging occur inside the same PostgreSQL transaction.

---

## Inventory Shortage Report API

```http
GET /api/reports/inventory-shortages
```

Optional parameters:

```text
branchId
stockLocationId
status
search
page
pageSize
```

Supported status filters:

```text
alerts
critical
low
healthy
all
```

Default:

```text
alerts
```

The default displays:

```text
critical
low
```

---

## Search Fields

The report search supports:

- Product name.
- SKU.
- Primary barcode.
- Stock-location name.
- Stock-location code.
- Branch name.
- Category.
- Brand.

Search input is limited to 100 characters.

---

## Pagination

The report supports:

```text
page
pageSize
```

Page size is limited to a maximum of 100.

The response contains:

```text
page
pageSize
totalItems
totalPages
hasPreviousPage
hasNextPage
```

Summary totals are calculated independently from the current page.

---

## Report Summary

The shortage report returns:

```text
totalActiveRules
stockLocationCount
variantCount
criticalCount
lowCount
healthyCount
outOfStockCount
totalShortageQuantity
totalSuggestedOrderQuantity
```

---

## Branch Security

### Branch-Restricted User

A branch-restricted user:

- Is locked to the authenticated branch.
- Cannot request another branch.
- Can only use stock locations belonging to that branch.
- Cannot use a location from another branch by manually changing the query.

### Company-Level User

A company-level user may:

- View all accessible branches.
- Select one branch.
- Select one stock location.
- Include central stock locations when permitted by the report scope.

---

## Web Admin Shortage Screen

The page is:

```text
نواقص المخزون
```

It provides:

- Branch filter.
- Stock-location filter.
- Status filter.
- Search.
- Page-size selector.
- Summary cards.
- Shortage details.
- Suggested purchase quantities.
- Pagination.
- Critical, low and healthy status indicators.
- Explanation of calculations.

---

## Web Admin Rule Management

The rule panel provides:

- Existing-rule selection.
- Existing-rule search.
- Stock-location selection.
- SKU or barcode lookup.
- Product and variant preview.
- Current stock preview.
- Reorder-point input.
- Safety-stock input.
- Reorder-quantity input.
- Enable or disable control.
- Create and update action.
- Permission-aware controls.
- Loading and saving protection.
- Cancellation-safe asynchronous lookup.

---

## Security Controls

- Authenticated API access.
- Company isolation.
- Branch isolation.
- Stock-location validation.
- Product-variant validation.
- Composite tenant foreign keys.
- Unique rule per location and variant.
- Inventory-adjust permission for writes.
- Non-negative quantity validation.
- Active-entity checks.
- Transactional writes.
- Audit logging.
- Pagination limits.
- Search-length limit.
- Secure server-side lookup.
- Stale-request protection.
- Cancelled-lookup state cleanup.
- PostgreSQL inventory source.
- No authoritative SQLite inventory.

---

## Current Limitations

- Suggested quantities are rule-based and do not yet consider supplier lead time.
- Sales velocity is not included in reorder calculations.
- Seasonal demand is not included.
- Supplier minimum order quantities are not included.
- Existing purchase orders are not deducted from suggested quantities.
- Inter-branch transfer availability is not considered.
- Automatic purchase-order creation is not implemented.
- Excel and PDF export are not implemented.
- Email or notification delivery is not implemented.

---

## Implementation Checklist

- [x] Reorder-rule database table
- [x] Composite company and location protection
- [x] Composite company and variant protection
- [x] Reorder-point validation
- [x] Safety-stock validation
- [x] Reorder-quantity validation
- [x] Active-rule validation
- [x] Create rule API
- [x] Update rule API
- [x] Read rules API
- [x] Current PostgreSQL balance
- [x] Critical calculation
- [x] Low-stock calculation
- [x] Healthy calculation
- [x] Shortage calculation
- [x] Suggested-order calculation
- [x] Transactional audit logging
- [x] Branch isolation
- [x] Stock-location isolation
- [x] Secure product lookup
- [x] Shortage analytics API
- [x] Search filters
- [x] Status filters
- [x] Pagination
- [x] Summary totals
- [x] Web Admin shortage report
- [x] Web Admin rule management
- [x] Permission-aware write controls
- [x] Stale-request protection
- [x] Cancelled-lookup cleanup
- [x] Feature documentation
- [ ] Final integrated acceptance test
- [ ] Production smoke test
- [ ] Supplier integration
- [ ] Purchase-order generation
- [ ] Transfer recommendations
- [ ] Excel export
- [ ] PDF export
- [ ] Automated notifications

---

## Final Acceptance Scenarios

### Create Rule

- Choose an accessible stock location.
- Search using SKU or barcode.
- Enter reorder point, safety stock and reorder quantity.
- Save the rule.
- Confirm it appears in PostgreSQL and the rule list.

### Update Rule

- Select an existing rule.
- Change one or more thresholds.
- Save.
- Confirm the existing record is updated rather than duplicated.

### Duplicate Scope

- Attempt to create another rule for the same location and variant.
- Confirm the existing unique rule is updated.

### Critical Stock

- Set current stock equal to or below safety stock.
- Confirm the status is critical.

### Low Stock

- Set stock above safety stock but at or below the reorder point.
- Confirm the status is low.

### Healthy Stock

- Set stock above the reorder point.
- Confirm the status is healthy.

### Suggested Quantity

- Configure a fixed reorder quantity larger than the shortage.
- Confirm the fixed quantity is suggested.

- Configure a shortage larger than the fixed quantity.
- Confirm the shortage is suggested.

### Branch Isolation

- Log in as a branch user.
- Attempt to use another branch or stock location manually.
- Confirm the request is rejected or the authenticated branch is enforced.

### Permission Protection

- Log in without `inventory.adjust`.
- Confirm the report remains available when permitted.
- Confirm rule-saving controls are disabled.
- Confirm a manual write request is rejected.

### Cancelled Lookup

- Start an item lookup.
- Immediately change the stock location or select another rule.
- Confirm the previous lookup does not overwrite the new form state.
- Confirm the loading indicator does not remain stuck.

### Pagination

- Create enough rules for multiple pages.
- Confirm page totals and navigation.
- Confirm summary totals remain the same across pages.

### Audit

- Create and update a rule.
- Confirm both actions appear in the audit log with old and new data.

---

## Completion Definition

Current feature state:

```text
IMPLEMENTATION COMPLETE
```

Remaining work:

- Final integrated acceptance testing.
- Production smoke testing.
- Purchasing integration.
- Automated replenishment workflows.
