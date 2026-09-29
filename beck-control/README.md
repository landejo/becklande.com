# Beck Control

A one-screen phone app for evening screen-time extensions. One tap changes the right Firewalla rules and **changes them back automatically** when the time is up.

- **Extend 15/30/60 min**: pauses the "limit" rules (the 8:30pm bedtime block and the 2.5 h internet time limit).
- **Homework 30/60/90 min**: same, plus switches **on** the block rules (games, Discord, video, YouTube).
- **Block fun 30 min / 1 h / 2 h / until 7 am**: switches the block rules on and leaves the limits alone. Use it any time, e.g. homework in the afternoon. Runs up to 24 h, then switches off by itself.
- **+15 / +30 / End now** while a session is running.
- Shows the time-limit usage, each rule's live status and an activity log.
- Apple Screen Time is **not** controlled (Apple has no API for it). The page reminds you to approve Beck's *Ask For More Time* request for the same length; Apple's approvals expire on their own.

It runs as a Cloudflare Worker (free plan). Your Firewalla token stays in Cloudflare and never reaches the browser.

## How it works

- `src/index.js`: the Worker. It serves the page and the JSON API, and handles passcode login (signed cookie, 90 days) and optional Bearer-token access for iPhone Shortcuts.
- `src/controller.js`: a Durable Object, a single stateful instance with its own storage and timer. It holds the setup, the active session and the log. Its **alarm** ends the session on time. If Firewalla is unreachable at that moment, it retries every 2 minutes until the limits are back on. A cron job every 30 minutes re-arms the alarm if it ever goes missing.
- `src/logic.js`: pure planning logic, unit tested. A session records only the changes it actually made. Ending it restores exactly what was there before, and it never touches a rule you had already paused by hand.
- `src/firewalla.js`: a minimal MSP API v2 client (`GET /v2/rules`, `POST /v2/rules`, `POST /v2/rules/{id}/pause|resume`).

### Firewalla API notes

- **Pausing through the API has no expiry.** The official docs list no duration parameter. A third-party client ([amittell/firewalla-mcp-server](https://github.com/amittell/firewalla-mcp-server/blob/main/docs/firewalla-api-reference.md), measured 2026-09-25) found that a `duration` is accepted and ignored: the rule stays paused until `/resume` is called. That's why this app owns the timer.
- The API can only **create** `block`/`allow` rules. Time-limit rules must already exist; you create them in the Firewalla app.
- Rate limits reported by a third-party integration: 100 requests per 5 min, 3,000 per day. A session uses roughly 5–10.

## Setup (about 20 minutes)

### 1. Firewalla MSP token

In the MSP portal: **Account Settings → Create New Token**. It needs write access, not a read-only token. Note your MSP domain, e.g. `yourname.firewalla.net`.

### 2. Cloudflare

1. Create a free account at <https://dash.cloudflare.com>.
2. On a computer with Node 20+:

   ```sh
   cd beck-control
   npm install
   npx wrangler login
   ```

3. Put your MSP domain in `wrangler.toml` → `MSP_DOMAIN = "yourname.firewalla.net"`.
4. Set the secrets. Each command prompts for the value:

   ```sh
   npx wrangler secret put MSP_TOKEN        # Firewalla token
   npx wrangler secret put APP_PASSCODE     # the passcode you'll type on your phone; make it one Beck can't guess
   npx wrangler secret put SESSION_SECRET   # paste output of: openssl rand -base64 32
   npx wrangler secret put API_TOKEN        # optional, for Shortcuts/Siri; openssl rand -base64 32
   ```

5. Deploy:

   ```sh
   npm run deploy
   ```

   Wrangler prints the URL, e.g. `https://beck-control.<you>.workers.dev`.

**Optional custom domain** (`control.becklande.com`): this needs becklande.com's DNS to be on Cloudflare. Then go to Workers → beck-control → Settings → Domains & Routes → Add custom domain. If the DNS stays elsewhere, the workers.dev URL works fine.

**Signing everyone out**: run `npx wrangler secret put SESSION_SECRET` with a new value. This invalidates every login cookie.

**Optional extra lock**: Cloudflare Zero Trust → Access → add an application for the Worker's hostname, with a policy that allows only your and Tracey's email addresses (one-time email code). The passcode still applies behind it.

### 3. First run

1. Open the URL on your iPhone, sign in, then tap **Share → Add to Home Screen**.
2. Open **Setup**:
   - Tick **Limit** on the 8:30pm bedtime rule and on the 2.5 h time-limit rule.
   - Under **Create block rules**, pick the bedtime rule as the device source, leave Games/YouTube/Discord/Video ticked, and tap **Create**. This makes paused block rules aimed at the same devices and ticks them as **Block**.
     If you already have such rules, tick **Block** on them instead. They should be paused in Firewalla when not in use.
   - Tap **Save setup**.
3. Test with a 15-minute extension. Check that the rules show **paused** in the Firewalla app, then tap **End now** and check that they show **active** again.

### Cellular gap for blocks

Firewalla only sees traffic on the home network. If Beck turns off Wi-Fi, his iPhone reaches YouTube, Discord and games over cellular. To close that gap, turn off cellular data for those apps in iPhone Settings → Cellular, then lock it with Screen Time → Content & Privacy Restrictions → **Cellular Data Changes: Don't Allow**. This is permanent, not per-session.

### Apple Screen Time side (manual, one step)

Beck's iPhone has cellular, so Apple's limits still matter when he's off Wi-Fi. For an extension:

- Have Beck tap **Ask For More Time** on the blocked screen (this works during Downtime and on App Limits).
- Approve **15 minutes** or **1 hour** to match. These approvals expire on their own, so don't turn Downtime or App Limits off.

## iPhone Shortcuts / Siri (optional)

This requires `API_TOKEN`. Create a shortcut with **Get Contents of URL**:

- URL: `https://<your-worker>/api/start`
- Method: POST
- Headers: `Authorization: Bearer <API_TOKEN>`, `Content-Type: application/json`
- Request body (JSON): `kind` = `extend`, `homework` or `block`; `minutes` = `30`

Useful ones:

| Shortcut name (Siri phrase) | Body |
|---|---|
| Give Beck thirty minutes | `{"kind":"extend","minutes":30}` |
| Beck homework hour | `{"kind":"homework","minutes":60}` |
| Block Beck's games | `{"kind":"block","minutes":120}` |

A Shortcut can also be a Home Screen icon, an Apple Watch action or a Personal Automation, e.g. a weekday 3:30pm automation that starts `block` for 90 minutes. Other endpoints: `POST /api/add {"minutes":15}`, `POST /api/end {}` ("Unblock Beck" / "End Beck's extension"), `GET /api/status`.

## Local development

```sh
node scripts/mock-msp.js &          # fake Firewalla on :8799
cat > .dev.vars <<'EOF'
MSP_DOMAIN=http://localhost:8799
MSP_TOKEN=test-token
APP_PASSCODE=letmein
SESSION_SECRET=dev-secret
API_TOKEN=shortcut-token
EOF
npm run dev                         # http://localhost:8787
npm test                            # unit tests for the planning logic
```
