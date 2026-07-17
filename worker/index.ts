import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { fillPrice, sidePrices, type RawQuote, type Side } from './domain'
import { INDEX_HTML } from './static.generated'

interface Env {
  DB: D1Database
  ASSETS: Fetcher
  ONYX_API_KEY?: string
}

interface UserRow {
  id: string
  email: string
  balance_cents: number
  created_at: string
}

interface Market {
  id: string
  symbol: string
  sport: string
  name: string | null
  event_name: string | null
  status: string
  expiry_date: string | null
  min_price: number
  max_price: number
  yes_price: number | null
}

interface Quote extends RawQuote {
  symbol: string
  volume?: number | null
}

type Variables = { user: UserRow }
type AppEnv = { Bindings: Env; Variables: Variables }

const app = new Hono<AppEnv>()
const ONYX_BASE = 'https://predictions.dev-onyxodds.com'
const SESSION_COOKIE = 'onyx_session'
const SESSION_DAYS = 14
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 100000 CHECK (balance_cents >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    market_symbol TEXT NOT NULL,
    market_name TEXT NOT NULL,
    sport TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
    shares REAL NOT NULL CHECK (shares > 0),
    fill_price REAL NOT NULL CHECK (fill_price > 0 AND fill_price < 1),
    cost_cents INTEGER NOT NULL CHECK (cost_cents > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  'CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS orders_user_position_idx ON orders(user_id, market_symbol, side)',
  `CREATE TRIGGER IF NOT EXISTS orders_require_balance
    BEFORE INSERT ON orders
    FOR EACH ROW
    WHEN (SELECT balance_cents FROM users WHERE id = NEW.user_id) < NEW.cost_cents
    BEGIN
      SELECT RAISE(ABORT, 'insufficient funds');
    END`,
  `CREATE TRIGGER IF NOT EXISTS orders_debit_balance
    AFTER INSERT ON orders
    FOR EACH ROW
    BEGIN
      UPDATE users
      SET balance_cents = balance_cents - NEW.cost_cents
      WHERE id = NEW.user_id;
    END`,
] as const
let schemaReady: Promise<void> | null = null

const jsonError = (message: string, status: 400 | 401 | 404 | 409 | 422 | 502 = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function onyxHeaders(env: Env) {
  const headers: Record<string, string> = {}
  if (env.ONYX_API_KEY) headers.Authorization = `Bearer ${env.ONYX_API_KEY}`
  return headers
}

function normalizedSport(market: Pick<Market, 'sport' | 'symbol'>) {
  return market.sport === 'OTHER'
    ? market.symbol.match(/OPT\.([A-Z0-9]+)/)?.[1] ?? market.sport
    : market.sport
}

async function onyxFetch<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`${ONYX_BASE}${path}`, { headers: onyxHeaders(env) })
  if (!response.ok) throw new Error(`Onyx API returned ${response.status}`)
  return response.json<T>()
}

async function marketPage(env: Env, limit: number, offset: number) {
  const page = await onyxFetch<Market[]>(env, `/markets?limit=${limit}&offset=${offset}`)
  const markets = page.map((market) => ({ ...market, sport: normalizedSport(market) }))
  markets.sort((a, b) => {
    const aDate = a.symbol.match(/-(\d{6})-M/)?.[1] ?? ''
    const bDate = b.symbol.match(/-(\d{6})-M/)?.[1] ?? ''
    return bDate.localeCompare(aDate) || Number(b.yes_price !== null) - Number(a.yes_price !== null)
  })
  return markets
}

async function quoteFor(env: Env, symbol: string) {
  return onyxFetch<Quote>(env, `/markets/${encodeURIComponent(symbol)}/prices`)
}

async function ensureSchema(env: Env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA_STATEMENTS.map((statement) => env.DB.prepare(statement)))
      .then(() => undefined)
      .catch((error) => {
        schemaReady = null
        throw error
      })
  }
  return schemaReady
}

const encoder = new TextEncoder()
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function sha256(value: string) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

async function hashPassword(password: string, saltBase64: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const salt = Uint8Array.from(atob(saltBase64), (char) => char.charCodeAt(0))
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 120_000, salt },
    key,
    256,
  )
  return bytesToBase64(new Uint8Array(bits))
}

async function createSession(env: Env, userId: string) {
  const token = randomToken()
  const tokenHash = await sha256(token)
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString()
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt)
    .run()
  return token
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    balanceCents: user.balance_cents,
    createdAt: user.created_at,
  }
}

async function sessionUser(c: Context<AppEnv>) {
  await ensureSchema(c.env)
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const tokenHash = await sha256(token)
  return c.env.DB.prepare(
    `SELECT users.id, users.email, users.balance_cents, users.created_at
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<UserRow>()
}

app.use('/api/account/*', async (c, next) => {
  const user = await sessionUser(c)
  if (!user) return c.json({ error: 'Authentication required' }, 401)
  c.set('user', user)
  await next()
})

app.use('/api/orders/*', async (c, next) => {
  const user = await sessionUser(c)
  if (!user) return c.json({ error: 'Authentication required' }, 401)
  c.set('user', user)
  await next()
})

app.get('/api/health', (c) => c.json({ ok: true, upstream: ONYX_BASE }))

app.get('/api/markets', async (c) => {
  try {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit')) || 1000))
    const offset = Math.max(0, Number(c.req.query('offset')) || 0)
    const markets = await marketPage(c.env, limit, offset)
    return c.json({
      markets,
      count: markets.length,
      hasMore: markets.length === limit,
      offset,
      refreshedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'Live markets are temporarily unavailable' }, 502)
  }
})

app.get('/api/prices', async (c) => {
  const symbols = (c.req.query('symbols') ?? '')
    .split(',')
    .map((symbol) => symbol.trim())
    .filter(Boolean)
    .slice(0, 24)
  if (!symbols.length) return c.json({ prices: {}, refreshedAt: new Date().toISOString() })

  const results = await Promise.allSettled(symbols.map((symbol) => quoteFor(c.env, symbol)))
  const prices = Object.fromEntries(
    results.map((result, index) => {
      const symbol = symbols[index]
      if (result.status === 'rejected') return [symbol, { yes: null, no: null, unavailable: true }]
      return [symbol, { ...sidePrices(result.value), volume: result.value.volume ?? null }]
    }),
  )
  return c.json({ prices, refreshedAt: new Date().toISOString() })
})

app.post('/api/auth/signup', async (c) => {
  await ensureSchema(c.env)
  const body = await c.req
    .json<{ email?: string; password?: string }>()
    .catch(() => ({} as { email?: string; password?: string }))
  const email = body.email?.trim().toLowerCase() ?? ''
  const password = body.password ?? ''
  if (!/^\S+@\S+\.\S+$/.test(email)) return c.json({ error: 'Enter a valid email address' }, 422)
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 422)

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) return c.json({ error: 'An account with this email already exists' }, 409)

  const id = crypto.randomUUID()
  const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)))
  const passwordHash = await hashPassword(password, salt)
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)',
  )
    .bind(id, email, passwordHash, salt)
    .run()
  const token = await createSession(c.env, id)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  })
  const user = await c.env.DB.prepare(
    'SELECT id, email, balance_cents, created_at FROM users WHERE id = ?',
  )
    .bind(id)
    .first<UserRow>()
  return c.json({ user: publicUser(user!) }, 201)
})

app.post('/api/auth/login', async (c) => {
  await ensureSchema(c.env)
  const body = await c.req
    .json<{ email?: string; password?: string }>()
    .catch(() => ({} as { email?: string; password?: string }))
  const email = body.email?.trim().toLowerCase() ?? ''
  const row = await c.env.DB.prepare(
    'SELECT id, email, balance_cents, created_at, password_hash, password_salt FROM users WHERE email = ?',
  )
    .bind(email)
    .first<UserRow & { password_hash: string; password_salt: string }>()
  if (!row || (await hashPassword(body.password ?? '', row.password_salt)) !== row.password_hash) {
    return c.json({ error: 'Invalid email or password' }, 401)
  }
  const token = await createSession(c.env, row.id)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  })
  return c.json({ user: publicUser(row) })
})

app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

app.get('/api/auth/me', async (c) => {
  const user = await sessionUser(c)
  return c.json({ user: user ? publicUser(user) : null })
})

app.get('/api/account/summary', async (c) => {
  const user = c.get('user')
  const [freshUser, orderRows, positionRows] = await Promise.all([
    c.env.DB.prepare('SELECT id, email, balance_cents, created_at FROM users WHERE id = ?')
      .bind(user.id)
      .first<UserRow>(),
    c.env.DB.prepare(
      `SELECT id, market_symbol AS marketSymbol, market_name AS marketName, sport, side,
              shares, fill_price AS fillPrice, cost_cents AS costCents, created_at AS createdAt
       FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(user.id)
      .all(),
    c.env.DB.prepare(
      `SELECT market_symbol AS marketSymbol, market_name AS marketName, sport, side,
              SUM(shares) AS shares, SUM(cost_cents) AS costCents,
              SUM(cost_cents) / 100.0 / SUM(shares) AS averagePrice
       FROM orders WHERE user_id = ?
       GROUP BY market_symbol, market_name, sport, side
       ORDER BY MAX(created_at) DESC`,
    )
      .bind(user.id)
      .all(),
  ])
  return c.json({
    user: publicUser(freshUser!),
    orders: orderRows.results,
    positions: positionRows.results,
  })
})

app.post('/api/orders/market', async (c) => {
  const user = c.get('user')
  const body = await c.req
    .json<{ symbol?: string; side?: Side; amountCents?: number }>()
    .catch(() => ({} as { symbol?: string; side?: Side; amountCents?: number }))
  const symbol = body.symbol?.trim() ?? ''
  const side = body.side
  const amountCents = Math.round(Number(body.amountCents))
  if (!symbol || (side !== 'YES' && side !== 'NO')) return c.json({ error: 'Invalid order' }, 422)
  if (!Number.isInteger(amountCents) || amountCents < 100) {
    return c.json({ error: 'Minimum order is $1.00' }, 422)
  }

  const freshUser = await c.env.DB.prepare('SELECT balance_cents FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ balance_cents: number }>()
  if (!freshUser || freshUser.balance_cents < amountCents) {
    return c.json({ error: 'Insufficient paper balance' }, 409)
  }

  try {
    const [market, quote] = await Promise.all([
      onyxFetch<Market>(c.env, `/markets/${encodeURIComponent(symbol)}`),
      quoteFor(c.env, symbol),
    ])
    if (market.status !== 'open') return c.json({ error: 'This market is not open' }, 409)
    const price = fillPrice({ ...quote, yes_price: market.yes_price }, side)
    if (price === null) return c.json({ error: 'No executable upstream quote is available' }, 409)
    const shares = amountCents / 100 / price
    const id = crypto.randomUUID()
    await c.env.DB.prepare(
      `INSERT INTO orders
       (id, user_id, market_symbol, market_name, sport, side, shares, fill_price, cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        user.id,
        market.symbol,
        market.name ?? market.event_name ?? market.symbol,
        normalizedSport(market),
        side,
        shares,
        price,
        amountCents,
      )
      .run()
    return c.json(
      {
        order: { id, symbol, side, shares, fillPrice: price, costCents: amountCents },
        balanceCents: freshUser.balance_cents - amountCents,
      },
      201,
    )
  } catch (error) {
    console.error(error)
    if (error instanceof Error && error.message.includes('insufficient funds')) {
      return c.json({ error: 'Insufficient paper balance' }, 409)
    }
    return c.json({ error: 'The order could not be filled against the live quote' }, 502)
  }
})

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return jsonError('Not found', 404)
  return new Response(INDEX_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    },
  })
})

export default app
