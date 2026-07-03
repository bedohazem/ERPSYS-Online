# ERPSYS Online

Professional online ERP system.

## Core Architecture

- PostgreSQL is the only source of truth.
- Backend API is the only gateway for data changes.
- Web Admin is used for management, inventory, and reports.
- Desktop POS is used by cashiers.
- Desktop POS can work when internet or server is down.
- Offline POS stores pending sales only.
- Offline POS must never deduct local stock.
- Pending sales are synced to PostgreSQL through the API when server is available.

## Project Structure

- apps/api
- apps/web-admin
- apps/desktop-pos
- packages/shared
- db/migrations
- db/seed
- docs
- infra

## First Goal

Start with architecture and database before screens.
