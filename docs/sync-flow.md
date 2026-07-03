# Sync Flow

## Online Sale

POS -> API -> PostgreSQL

The API validates the sale, saves it, creates stock movements, and returns the final sale number.

## Offline Sale

POS -> Local Pending Queue

When the API is back:

POS -> API Sync Endpoint -> PostgreSQL

## Idempotency

Every sale must have an idempotency_key.

The API must reject duplicate processing of the same idempotency_key.

This prevents duplicated invoices when POS retries sync.
