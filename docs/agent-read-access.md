# Read-only agent access

Claude (and other agents) can read admin data without a browser sign-in by sending
`Authorization: Bearer <AGENT_READ_TOKEN>`.

- The token lives in the Vercel env var `AGENT_READ_TOKEN` (Production, sensitive) and
  locally at `~/.config/zenfulcove/agent-read-token` (chmod 600, outside every repo).
  Never print it or paste it into chat.
- It only works on routes that opt in with `requireAdminRequest(request, { agentRead: true })`:
  - `GET /api/logs` — automation log (code sends, waiver reminders, errors)
  - `GET /api/config` — live automation settings
  - `GET /api/access-codes/jervis-properties` — unit to Jervis property mapping
  - `GET /api/cron/access-code-diagnose` — sent code vs. what Jervis holds now
  - `POST /api/access-code-release-test` with `dryRun` not `false` — simulation only
- It can't save settings, send messages, or create Jervis codes. A live (`dryRun: false`)
  test still needs the admin sign-in.
- To revoke: delete or rotate `AGENT_READ_TOKEN` in Vercel and redeploy.
