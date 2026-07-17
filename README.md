# Onyx Paper

Onyx Paper is a full-stack paper-trading app for the live prediction markets exposed by the [Onyx Predictions API](https://predictions.dev-onyxodds.com/docs#/). Users receive $1,000 in simulated funds, can buy YES or NO at an executable upstream quote, and can follow their fills, positions, and unrealized P&L. No order is ever sent to a trading venue.

> **Live app:** deployment URL added after the production Worker is published.

## Product surface

- Email/password signup and login with isolated user accounts
- A browseable inventory of every market returned by the Onyx `/markets` endpoint
- Progressive background loading, full-text search, and league filtering across the loaded inventory
- Live visible-market quotes refreshed every eight seconds
- Server-side re-pricing immediately before every simulated fill
- YES buys filled at the upstream ask (falling back to last); NO buys filled at `1 − bid` (falling back to `1 − last`)
- Atomic paper-balance debits, fill history, aggregated positions, and live unrealized P&L
- Responsive desktop/mobile UI with explicit paper-trading disclosures

## Stack

- **UI:** React 19, TypeScript, Vite
- **API:** Hono on Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite)
- **Auth:** first-party session cookies; passwords use salted PBKDF2-SHA-256 (120,000 iterations)
- **Market data:** Onyx Predictions REST API, proxied through the Worker

This began from a clean `create-vite` React/TypeScript initialization. Authentication, persistence, and deployment were added directly rather than using a pre-wired full-stack starter.

## Run locally

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run db:local
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). `npm run dev` builds the client and serves both the Worker API and static app through Wrangler, using a local D1 database under `.wrangler/`.

The market endpoints in the current Onyx OpenAPI schema are publicly readable. The Worker also supports a provisioned bearer key without exposing it to the browser:

```bash
printf 'ONYX_API_KEY="your-key"\n' > .dev.vars
```

`.dev.vars` is gitignored. In production, store the same value with `wrangler secret put ONYX_API_KEY` if Onyx provisions a key.

## Useful commands

```bash
npm run build       # type-check frontend + Worker and build assets
npm test            # pricing and P&L unit tests
npm run lint        # oxlint
npm run db:local    # apply migrations to local D1
npm run db:remote   # apply migrations to production D1
npm run deploy      # build and deploy the Worker + assets
```

## Design decisions

### Quotes and fills

The browser polls only the visible cards and open positions, keeping the live path bounded even though the inventory contains thousands of contracts. Every order is re-quoted inside the Worker, so the price shown in the ticket is informative and the persisted fill is authoritative. Missing or invalid quotes disable trading rather than inventing a price.

The upstream instrument is treated as the YES contract. A market buy for YES takes the ask. A market buy for NO pays the complement of the YES bid, which represents crossing the opposite side of the spread. Last price is the documented fallback when the relevant top-of-book field is absent.

### Money and positions

Cash and order cost are stored as integer cents. Share quantities and probability prices use SQLite `REAL`, which is sufficient for this paper-trading exercise; a production ledger would use fixed-precision decimals throughout. Positions are derived from immutable fills with a grouped query, avoiding a second source of truth.

A database trigger validates funds and debits the user in the same SQLite statement that inserts the fill. That makes the balance invariant atomic even if two orders arrive together.

### Authentication

Passwords never leave the Worker except in the original TLS request and are stored only as salted PBKDF2 hashes. Session tokens are random 256-bit values; only their SHA-256 hashes are stored in D1. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Account queries are always scoped by the authenticated user ID.

### Market loading

The Onyx inventory is larger than a single API page. The first 1,000 contracts render quickly; remaining pages load progressively in the background up to the upstream maximum currently observed. The UI sorts the current event date to the front so executable contracts appear first, while search and pagination make the entire loaded inventory browseable.

## Deploy

Authenticate Wrangler, create a D1 database named `onyx-paper`, copy its `database_id` into `wrangler.jsonc`, and run:

```bash
npm run db:remote
npm run deploy
```

Cloudflare serves the built React assets and `/api/*` routes from one Worker origin, so cookies remain first-party and no CORS allowance is required.

## Trade-offs and next steps

Given more time I would:

1. Replace polling with an Onyx stream or SSE fan-out if the upstream exposes one, while retaining a reconnecting polling fallback.
2. Add sell/close flows, realized P&L, market settlement, and a double-entry cash ledger.
3. Move inventory refresh into a scheduled Worker and cache normalized contracts in D1 or KV for instant cold starts.
4. Add rate limiting, email verification, password reset, CSRF tokens for defense in depth, and automated session cleanup.
5. Add browser-level tests against local D1 plus structured observability for quote failures and fill latency.
6. Improve contract grouping so game lines, props, and futures have purpose-built cards instead of a universal market card.

## API-access note

The assignment asks for API keys, but the supplied OpenAPI document currently declares no security requirement on `/markets`, `/markets/{symbol}`, or `/markets/{symbol}/prices`, and those endpoints respond without a credential. The implementation supports `ONYX_API_KEY` as an optional server-only bearer token so a key can be enabled without a code change if access policy changes.

## Paper-trading guarantee

Only GET requests are made to Onyx market-data endpoints. The app never invokes any Onyx member, account, order, or execution endpoint. Simulated orders exist exclusively in this app's D1 database.
