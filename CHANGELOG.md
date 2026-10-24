# Changelog

## 0.2.1 (2026-10-24)
- `harvest_report_uninvoiced` now returns only projects with uninvoiced time, amounts or expenses (`include_zero` restores the full list), adds totals and a `client_id` filter. The full report (654 projects) was too large for a chat context.

## 0.2.0 (2026-10-24) — Spotlight security and coverage release

### Security
- OAuth authorization server rebuilt:
  - PKCE (S256) is required and verified.
  - Redirect URIs must exactly match Claude's hosted callbacks or be loopback.
  - Authorization codes are single-use and expire in 60 seconds.
  - Access tokens (1 hour) are opaque and separate from refresh tokens. Refresh tokens rotate, with a 60-second retry grace window.
  - All tokens are stored only as SHA-256 hashes.
  - RFC 7009 `/revoke` endpoint.
- Harvest tokens are AES-GCM encrypted in KV (key derived from `SESSION_SECRET`, bound to the session ID).
- OAuth state is HMAC-signed and single-use.
- Sessions have a 90-day hard maximum and no longer slide or write to KV on every request.
- `ALLOWED_HARVEST_ACCOUNT_IDS` restricts which Harvest accounts may connect. It fails closed.
- Legacy `x-harvest-session` / `mcp-session-id` credentials removed; the internal session ID is never exposed.
- Auth codes and session IDs are no longer logged or displayed.
- The response cache is scoped per account and token, so users never share cached data.
- CORS no longer reflects arbitrary origins. `preview_urls` disabled (previews shared production KV).
- The Worker fails closed if `SESSION_SECRET` is missing.

### Reliability
- Pagination:
  - Follows `links.next`.
  - Results report `truncated` plus a warning instead of silently stopping. Analytics previously stopped at 1,000 entries.
  - Analytics now read 2,000 records per page, up to 50,000 records.
- Retries:
  - GET, DELETE and plain PATCH retry 5xx and network errors with backoff.
  - POST, and PATCH that appends invoice line items, are never replayed. They return a "may or may not have been applied" warning instead, which prevents duplicate time entries and line items.
  - Write 429s fail fast after 15 seconds of back-off.
- Separate rate limiter for the Reports API (100 requests per 15 minutes), plus a per-account limiter.
- Caching:
  - Time entries, invoices, expenses and reports are always read live.
  - Reference data is cached for 15 seconds.
  - The cache is invalidated after every write attempt.
- A transient Harvest token-refresh failure no longer logs the user out, and concurrent refreshes are reconciled.

### New tools (27 → 49)
- Reports API: `harvest_report_time`, `harvest_report_uninvoiced`, `harvest_report_project_budget`, `harvest_report_expenses`.
- Admin:
  - Clients and contacts: `harvest_create_client`, `harvest_update_client`, `harvest_create_contact`, `harvest_update_contact`.
  - Projects and tasks: `harvest_create_project`, `harvest_update_project`, `harvest_create_task`, `harvest_update_task`.
  - Task assignments: `harvest_list_project_task_assignments`, `harvest_assign_task_to_project`.
  - User assignments: `harvest_list_project_user_assignments`, `harvest_assign_user_to_project`.
- Expenses: `harvest_list_expense_categories`, `harvest_create_expense`, `harvest_update_expense`, `harvest_delete_expense`.
- Other: `harvest_get_invoice`, `harvest_restart_timer`.
- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
- `harvest_init` now lists tools automatically.

### Tooling
- vitest suite (85 tests): OAuth flow, crypto, pagination, retries, tool calls. Run with `npm test`.
- `npm run typecheck`.

### Upgrade notes
- Set `SESSION_SECRET` (32+ random characters) before deploying.
- Existing connections are invalidated. Reconnect the Harvest connector once in Claude settings.
