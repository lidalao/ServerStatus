# Repository notes

## Goal and architecture

The primary deployment target is Cloudflare Workers + D1. `cloudflare/worker.js` handles node configuration, HTTPS agent reports, the `/json/stats.json` dashboard API, and scheduled online/offline notifications. `service/web/` is served as Workers static assets. D1 migrations live under `cloudflare/migrations/`; The deployment helper generates production Wrangler bindings from `.env`; `wrangler.toml` is a reference template and `wrangler.local.toml` configures local testing.

This is a Cloudflare-only branch. Do not add Docker, a self-hosted backend, Go server, separate notification bot, or legacy TCP Agent compatibility.

`sss.sh` uses a single adjacent `.env` (or `SSS_ENV_FILE`), parsed as data without source/eval. `init` ensures curl/jq and Node 22+/npm, then generates private settings (retaining existing files); `deploy [--plan]` and `update [--plan]` handle deployment outside the default node-only menu; `scripts/deploy-cloudflare.mjs` generates Wrangler config, provisions/reuses D1, migrates, publishes Secrets and verifies the API. Deployment uses CF Account ID/API Token and Node 22+, while node management requires only `SSS_WORKER_URL` and `SSS_MANAGEMENT_TOKEN`. Legacy remote.env is a fallback only. It runs on machines with Bash, curl, and jq, edits a temporary local draft, and sends changes only on explicit submission. Supported management platforms are macOS and Ubuntu/Debian. Node management uses Bash, curl and jq without Node; deployment alone requires Node 22+. Keep a single Bash management implementation.

`agent/client-linux.py` runs on Linux with Python 3, posts metrics over HTTPS to `/api/agent/report`, and rejects legacy TCP arguments. Installation and updates use a user systemd service and need no root. Management and Agent installs are distributed via GitHub, not Workers Assets.

## Important contracts

- Dashboard JSON shape is consumed by `service/web/js/app.js`; preserve fields such as `online4/online6`, `network_rx/network_tx`, cumulative `network_in/network_out`, `last_network_in/last_network_out`, memory, disk, load, and ping/time metrics.
- Node credentials (`username`, `password`) are the agent identity. Worker management uses a separate Bearer app token.
- `hidden: true` only removes a node from the dashboard UI. It must not disable the probe or suppress offline notifications; leave hidden nodes in status data and filter them in the frontend.
- The admin CLI sends the entire config with a revision number. Keep the compare-and-swap revision check to prevent silently overwriting another manager's edits.
- Agent HTTP reports should remain infrequent (currently 15 seconds) because every report writes to D1; sampling on the VPS may remain more frequent.
- Never commit `.env`, `config.json`, or `json/` runtime data.

## Validation

Run `npm run test:local` for the local Worker/D1 integration suite. It needs Node/npm and local loopback access but no Cloudflare account. `npm run dev:local` and `npm run db:migrate:local` provide an interactive local development environment.

Deployment tests must inject Cloudflare API/command substitutes. No automatic CF deployment or GitHub push during development. Keep generated Token/DB IDs for retries; never regenerate the Token on update or silently recreate a missing configured database.


## Merging and release sources

When merging this branch into the primary branch, include a coordinated update of all default GitHub source references to that actual destination branch. Confirm the destination branch name; do not assume `main` or `master`. Keep the feature-branch defaults until a merge is requested.

- Update the default `GITHUB_RAW_URL` in `sss.sh`, its `init` template, `agent/sss-agent.sh`, and `.env.sample` together.
- Update corresponding download/archive URL expectations in tests and branch-specific instructions or examples in documentation. Both raw.githubusercontent.com downloads and codeload.github.com source archives must resolve to the same release source.
- Preserve explicit user-selected branches/tags and the installer’s saved-source behavior. Existing management `.env` files and Agent source settings retain the old source; document how operators switch their `GITHUB_RAW_URL` or explicitly override it when updating the Agent. Never change their credentials or database IDs for a source switch.
- Search for stale feature-branch references, run the complete local regression suite, and after the merge verify that the destination branch serves the CLI, Agent installer, Python Agent and service template. Do not remove the feature branch while supported existing installations still depend on it without providing a migration path.
- Merging or deploying CF alone does not update downloaded CLI/Agent copies; describe their separate update steps. Git push and CF deployment still require user authorization.
