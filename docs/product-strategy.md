# Product Strategy

## 1. Product Thesis

ERPSYS Online is a **Modular ERP/POS Platform** for small and medium retail businesses.

The product starts with a general **Core ERP/POS** and delivers **Fashion Retail** as its first vertical.

It must:

- solve the owner’s real store operations now;
- support expansion from one store to three branches;
- become sellable to small and medium fashion brands;
- remain ready for a future SaaS model without building unnecessary SaaS complexity too early.

## 2. Target Customer

### Primary Customer Now

The owner and staff of a fashion retail business operating one store and preparing to expand to three branches.

The system must support:

- the business owner;
- branch managers;
- cashiers;
- warehouse and inventory staff;
- administrative users.

### First Sellable Customer Later

Small and medium fashion brands that need:

- reliable multi-branch inventory;
- fast cashier workflows;
- products with size and color variants;
- transfers between branches and stock locations;
- returns and exchanges;
- purchasing and supplier management;
- clear operational and financial reports;
- simple setup, training, and daily operation.

## 3. Customer Problem

Retail information often becomes fragmented across branches, spreadsheets, paper records, and separate cashier workflows.

This causes:

- inaccurate stock quantities;
- difficulty knowing the available size and color in each branch;
- duplicate or untraceable stock changes;
- slow reconciliation between branches;
- poor purchasing and transfer decisions;
- weak visibility into sales and profitability;
- difficulty monitoring cashiers and branch performance;
- operational problems when internet connectivity is unavailable.

ERPSYS Online should become the operational source of truth for products, stock, sales, purchasing, and branch activity.

## 4. Product Positioning

ERPSYS Online is neither:

- a large generic ERP that attempts to support every industry from the first release; nor
- a fashion-only application whose architecture prevents expansion into other industries.

The correct position is:

> A practical retail operations platform with a reusable ERP/POS Core and focused industry verticals.

The initial formula is:

> General ERP/POS Core
>
> - Fashion Retail Vertical

Future verticals may include restaurants, pharmacies, electronics, auto parts, and supermarkets, but they are outside the current product scope.

## 5. Product Principles

1. **Operate the real business first.**  
   Features must solve a verified store or branch workflow.

2. **Core plus verticals.**  
   Generic business capabilities belong to Core. Fashion-specific behavior belongs to the Fashion module.

3. **Modular Monolith first.**  
   The system uses clear module boundaries without introducing early microservices complexity.

4. **PostgreSQL is the source of truth.**  
   All authoritative business information is stored in the central PostgreSQL database.

5. **API-only data access.**  
   Web Admin, Desktop POS, and future applications communicate only with the Backend API.

6. **Multi-Tenant Ready, not SaaS-heavy.**  
   Business data is scoped by company from the beginning. Subscription billing and automated tenant provisioning are deferred.

7. **Inventory integrity over convenience.**  
   Every accepted stock change must be recorded centrally as a stock movement.

8. **Auditable operations.**  
   Important actions record the company, branch, user, time, affected entity, and relevant before-and-after information.

9. **Constrained offline operation.**  
   The POS may store pending sales during an outage, but it never owns or deducts authoritative stock locally.

10. **Grow from evidence.**  
    Mobile applications, AI, new verticals, and advanced automation should follow proven operational demand and reliable data.

## 6. Product Boundaries

### Core ERP/POS

Core owns reusable business capabilities:

- authentication;
- companies and branches;
- users, roles, and permissions;
- settings;
- products, brands, and categories;
- customers and suppliers;
- stock locations;
- stock balances and movements;
- transfers;
- purchases and receiving;
- sales and payments;
- returns and exchanges;
- cashier shifts;
- POS synchronization;
- reports;
- audit logs.

### Fashion Retail Vertical

Fashion Retail extends Core with:

- sizes;
- colors;
- product variants;
- size-color matrices;
- style codes;
- seasons;
- collections;
- variant SKUs and barcodes;
- fashion-specific pricing when required;
- branch-level size and color availability;
- analysis by size, color, season, and collection.

### Dependency Rule

Generic Core entities must not depend on Fashion-specific entities.

The Fashion module may reference and extend stable Core contracts.

This rule allows future vertical modules to use the same Core without inheriting fashion concepts.

## 7. Minimum Viable Product

The first production milestone is complete when one real fashion store can run its daily operations safely and can later add two branches without redesigning the Core.

### Included in the MVP

- secure authentication;
- users and branch-aware permissions;
- company and branch configuration;
- stock-location configuration;
- general products and fashion variants;
- sizes, colors, SKUs, and barcodes;
- suppliers and essential purchasing workflows;
- receiving purchased stock;
- stock movements and current balances;
- inventory counts and adjustments;
- transfers between locations and branches;
- online sales and payments;
- returns and exchanges;
- cashier shifts;
- receipt workflow;
- Offline Pending Sales;
- idempotent synchronization with the Backend API;
- essential owner and branch reports;
- audit logging;
- backup and basic operational recovery procedures.

### Explicitly Deferred

The MVP does not include:

- microservices;
- subscription billing;
- self-service tenant registration;
- automatic tenant provisioning;
- mobile applications;
- AI assistants;
- demand forecasting;
- OCR for supplier invoices;
- advanced workflow automation;
- restaurant, pharmacy, electronics, auto-parts, or supermarket verticals;
- broad accounting and payroll modules;
- offline inventory authority;
- multi-master database synchronization.

Deferring these items does not mean preventing them architecturally.

## 8. Offline POS Policy

Offline operation protects checkout continuity. It does not create a second inventory authority.

The required flow is:

1. The Desktop POS detects that the Backend API is unavailable.
2. The POS stores the sale as a pending operation.
3. Every pending sale receives a stable idempotency key.
4. The POS stores the minimum information required to submit the sale safely.
5. The POS does not deduct authoritative inventory locally.
6. When connectivity returns, the POS submits the pending sale to the Backend API.
7. The Backend validates:
   - company and branch scope;
   - cashier and shift;
   - products and variants;
   - trusted prices and discounts;
   - payments;
   - current stock;
   - duplicate requests.
8. The Backend either:
   - accepts the sale and creates its stock movements;
   - rejects it with a clear reason; or
   - sends it for manual review.
9. Retrying the same request must never create duplicate invoices, payments, or stock deductions.

## 9. Multi-Tenant Readiness

The initial deployment may serve one company, but tenant isolation is a permanent design requirement.

The following rules apply:

- company-owned business records include `company_id`;
- tenant-scoped uniqueness rules include `company_id`;
- the Backend derives company scope from the authenticated user;
- client-provided `company_id` values are not trusted for authorization;
- branch users can access only their authorized branches;
- cross-company reads, joins, and writes must be prevented;
- important queries and mutations must be tested for tenant isolation;
- adding another company must not require changing the primary database design;
- audit records must retain their company and branch context.

Multi-Tenant Ready does not currently mean implementing:

- subscription plans;
- billing;
- usage metering;
- self-service signup;
- automatic provisioning;
- automated tenant suspension.

These capabilities belong to a later SaaS stage.

## 10. Business Rollout

### Stage 1 — Prove the System in One Store

Operate real:

- products and variants;
- inventory;
- purchases;
- sales and payments;
- returns and exchanges;
- cashier shifts;
- daily reports.

The purpose is to discover workflow problems through actual use.

### Stage 2 — Expand to Three Branches

Prove:

- branch data isolation;
- transfers between branches;
- centralized inventory visibility;
- cashier and branch reporting;
- resilient POS synchronization;
- consistent permissions and audit logging.

### Stage 3 — Validate the Product Externally

Onboard a small number of fashion brands manually.

Use these customers to standardize:

- initial setup;
- data imports;
- training;
- support;
- configuration;
- repeated product requirements.

The product must avoid customer-specific forks whenever a reusable configuration or module can solve the problem.

### Stage 4 — Enable SaaS Operations

After the product works reliably for multiple businesses, add:

- tenant lifecycle management;
- subscription plans;
- billing;
- onboarding automation;
- backup policies;
- monitoring and observability;
- repeatable deployment;
- support processes.

### Stage 5 — Expand the Platform

Add validated capabilities such as:

- owner mobile application;
- warehouse scanning application;
- AI sales and stock assistant;
- shortage prediction;
- demand forecasting;
- supplier invoice OCR;
- transfer recommendations;
- additional industry verticals.

## 11. Success Measures

### Operational Success

- accepted workflows do not create unexplained negative stock;
- sales synchronization does not create duplicate invoices;
- every inventory change is traceable;
- branch users cannot access another company’s data;
- daily branch closing can be completed inside the system;
- management reports do not depend on external spreadsheets;
- a second and third branch can be added through configuration;
- staff can complete common workflows with limited training.

### Product Success

- the owner treats the system as the operational source of truth;
- the system reduces manual stock reconciliation;
- store employees use the POS during real operating hours;
- product, stock, and sales records remain consistent;
- external fashion brands can use the same product without custom forks;
- repeated customer requirements become reusable Core or Fashion capabilities.

### SaaS-Readiness Success

- tenant isolation tests cover critical reads and writes;
- a new company can be created without schema changes;
- APIs provide stable contracts for future applications;
- business data is structured enough for future analytics and AI;
- future subscriptions can be added without changing ownership of existing business records.

## 12. Feature Decision Filter

Before adding a feature, answer:

1. Does it solve a current store workflow or a validated near-term customer problem?
2. Is it a Core capability, a Fashion capability, or future scope?
3. Does it preserve tenant isolation?
4. Does it preserve auditability?
5. Does it preserve PostgreSQL as the source of truth?
6. Does it preserve the Backend API as the only authoritative data gateway?
7. Can it remain inside the Modular Monolith with a clear boundary?
8. What is the smallest production-safe version?
9. How will we verify that it works in the real store?
10. Does it introduce complexity that is only needed for a hypothetical future?

If these questions do not have clear answers, the feature remains outside the current milestone.

## 13. Immediate Product Priority

The repository already contains a significant implementation.

The immediate priority is therefore not to increase feature count.

The priority is to:

1. align the existing implementation with this product strategy;
2. identify production-critical gaps;
3. verify tenant and branch isolation;
4. complete integrated acceptance testing;
5. prove the complete one-store workflow;
6. resolve real operational problems discovered during store use;
7. expand to additional branches only after the first workflow is reliable.

Architecture, database, and implementation decisions should be evaluated against this strategy before expanding the scope.
