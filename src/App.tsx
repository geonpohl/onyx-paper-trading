import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import './App.css'

type Side = 'YES' | 'NO'
type View = 'markets' | 'portfolio' | 'activity'

interface User {
  id: string
  email: string
  balanceCents: number
  createdAt: string
}

interface Market {
  id: string
  symbol: string
  sport: string
  name: string | null
  event_name: string | null
  status: string
  expiry_date: string | null
  yes_price: number | null
}

interface Price {
  yes: number | null
  no: number | null
  volume?: number | null
  unavailable?: boolean
}

interface Position {
  marketSymbol: string
  marketName: string
  sport: string
  side: Side
  shares: number
  costCents: number
  averagePrice: number
}

interface Order extends Position {
  id: string
  fillPrice: number
  createdAt: string
}

interface AccountSummary {
  user: User
  positions: Position[]
  orders: Order[]
}

const PAGE_SIZE = 12

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? 'Something went wrong')
  return payload
}

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

const probability = (value: number | null | undefined) =>
  value == null ? '—' : `${Math.round(value * 100)}¢`

const signedMoney = (cents: number | null) => {
  if (cents === null) return 'Waiting for quote'
  return `${cents >= 0 ? '+' : '−'}${money(Math.abs(cents))}`
}

function App() {
  const [markets, setMarkets] = useState<Market[]>([])
  const [marketError, setMarketError] = useState('')
  const [loadingMarkets, setLoadingMarkets] = useState(true)
  const [user, setUser] = useState<User | null>(null)
  const [summary, setSummary] = useState<AccountSummary | null>(null)
  const [prices, setPrices] = useState<Record<string, Price>>({})
  const [lastPriceAt, setLastPriceAt] = useState<Date | null>(null)
  const [view, setView] = useState<View>('markets')
  const [query, setQuery] = useState('')
  const [sport, setSport] = useState('ALL')
  const [page, setPage] = useState(1)
  const [authMode, setAuthMode] = useState<'login' | 'signup' | null>(null)
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [ticket, setTicket] = useState<{ market: Market; side: Side } | null>(null)
  const [orderError, setOrderError] = useState('')
  const [orderBusy, setOrderBusy] = useState(false)
  const [toast, setToast] = useState('')

  const loadAccount = useCallback(async () => {
    try {
      const account = await api<AccountSummary>('/api/account/summary')
      setSummary(account)
      setUser(account.user)
    } catch {
      setSummary(null)
    }
  }, [])

  useEffect(() => {
    void api<{ user: User | null }>('/api/auth/me').then(({ user: activeUser }) => {
      setUser(activeUser)
      if (activeUser) void loadAccount()
    })
    let cancelled = false
    const loadMarkets = async () => {
      let offset = 0
      try {
        while (offset < 10_000) {
          const page = await api<{ markets: Market[]; hasMore: boolean }>(
            `/api/markets?limit=1000&offset=${offset}`,
          )
          if (cancelled) return
          if (offset === 0) {
            setMarkets(page.markets)
            setLoadingMarkets(false)
          } else {
            setMarkets((current) => [...current, ...page.markets])
          }
          if (!page.hasMore) break
          offset += 1000
        }
      } catch (error) {
        if (!cancelled && offset === 0) setMarketError((error as Error).message)
      } finally {
        if (!cancelled) setLoadingMarkets(false)
      }
    }
    void loadMarkets()
    return () => {
      cancelled = true
    }
  }, [loadAccount])

  const sports = useMemo(
    () => ['ALL', ...Array.from(new Set(markets.map((market) => market.sport))).sort()],
    [markets],
  )

  const filteredMarkets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return markets.filter((market) => {
      const matchesSport = sport === 'ALL' || market.sport === sport
      const haystack = `${market.name ?? ''} ${market.event_name ?? ''} ${market.symbol}`.toLowerCase()
      return matchesSport && (!needle || haystack.includes(needle))
    })
  }, [markets, query, sport])

  const pageCount = Math.max(1, Math.ceil(filteredMarkets.length / PAGE_SIZE))
  const visibleMarkets = useMemo(
    () => filteredMarkets.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredMarkets, page],
  )

  useEffect(() => setPage(1), [query, sport])
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  const priceSymbolKey = useMemo(() => {
    const symbols = new Set(visibleMarkets.map((market) => market.symbol))
    summary?.positions.forEach((position) => symbols.add(position.marketSymbol))
    return Array.from(symbols).slice(0, 24).join(',')
  }, [visibleMarkets, summary?.positions])

  useEffect(() => {
    if (!priceSymbolKey) return
    let cancelled = false
    const refresh = async () => {
      try {
        const data = await api<{ prices: Record<string, Price> }>(
          `/api/prices?symbols=${encodeURIComponent(priceSymbolKey)}`,
        )
        if (!cancelled) {
          setPrices((current) => ({ ...current, ...data.prices }))
          setLastPriceAt(new Date())
        }
      } catch {
        // Keep the last successful quote visible while the next poll retries.
      }
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 8_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [priceSymbolKey])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 3_500)
    return () => window.clearTimeout(timeout)
  }, [toast])

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!authMode) return
    setAuthBusy(true)
    setAuthError('')
    const form = new FormData(event.currentTarget)
    try {
      const { user: activeUser } = await api<{ user: User }>(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      })
      setUser(activeUser)
      setAuthMode(null)
      setToast(authMode === 'signup' ? 'Account created with $1,000 in paper funds.' : 'Welcome back.')
      await loadAccount()
    } catch (error) {
      setAuthError((error as Error).message)
    } finally {
      setAuthBusy(false)
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' })
    setUser(null)
    setSummary(null)
    setView('markets')
  }

  function openTicket(market: Market, side: Side) {
    if (!user) {
      setAuthMode('signup')
      return
    }
    setOrderError('')
    setTicket({ market, side })
  }

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ticket) return
    const form = new FormData(event.currentTarget)
    const amountCents = Math.round(Number(form.get('amount')) * 100)
    setOrderBusy(true)
    setOrderError('')
    try {
      const result = await api<{ order: { shares: number; fillPrice: number } }>('/api/orders/market', {
        method: 'POST',
        body: JSON.stringify({ symbol: ticket.market.symbol, side: ticket.side, amountCents }),
      })
      setToast(
        `Filled ${result.order.shares.toFixed(2)} ${ticket.side} shares at ${probability(result.order.fillPrice)}.`,
      )
      setTicket(null)
      await loadAccount()
    } catch (error) {
      setOrderError((error as Error).message)
    } finally {
      setOrderBusy(false)
    }
  }

  const quoteForSide = (symbol: string, side: Side) => prices[symbol]?.[side.toLowerCase() as 'yes' | 'no'] ?? null

  const portfolioPnl = useMemo(
    () =>
      summary?.positions.reduce((total, position) => {
        const price = prices[position.marketSymbol]?.[position.side.toLowerCase() as 'yes' | 'no'] ?? null
        return price === null ? total : total + Math.round(position.shares * price * 100) - position.costCents
      }, 0) ?? 0,
    [prices, summary?.positions],
  )

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView('markets')} aria-label="Go to markets">
          <span className="brand-mark">O</span>
          <span>Onyx <strong>Paper</strong></span>
        </button>
        <div className="top-actions">
          <span className="live-pill"><i /> Live data</span>
          {user ? (
            <>
              <div className="balance-block"><small>Paper balance</small><strong>{money(user.balanceCents)}</strong></div>
              <button className="button ghost" onClick={() => void logout()}>Log out</button>
            </>
          ) : (
            <>
              <button className="button ghost" onClick={() => setAuthMode('login')}>Log in</button>
              <button className="button primary" onClick={() => setAuthMode('signup')}>Start trading</button>
            </>
          )}
        </div>
      </header>

      <main>
        <section className="hero-section">
          <div>
            <div className="eyebrow">PAPER TRADING · REAL PRICES</div>
            <h1>Trade the outcome.<br /><em>Risk nothing.</em></h1>
            <p>Explore every Onyx prediction market and test your conviction with $1,000 in simulated funds.</p>
          </div>
          <div className="market-stat-card">
            <small>Markets online</small>
            <strong>{loadingMarkets ? '···' : markets.length.toLocaleString()}</strong>
            <span>Across {Math.max(0, sports.length - 1)} leagues</span>
            <div className="sparkline" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          </div>
        </section>

        <nav className="view-tabs" aria-label="Dashboard views">
          <button className={view === 'markets' ? 'active' : ''} onClick={() => setView('markets')}>Markets</button>
          <button className={view === 'portfolio' ? 'active' : ''} onClick={() => user ? setView('portfolio') : setAuthMode('login')}>
            Portfolio {summary?.positions.length ? <span>{summary.positions.length}</span> : null}
          </button>
          <button className={view === 'activity' ? 'active' : ''} onClick={() => user ? setView('activity') : setAuthMode('login')}>Activity</button>
        </nav>

        {view === 'markets' && (
          <section className="content-section">
            <div className="section-heading">
              <div><h2>Open markets</h2><p>Quotes refresh every 8 seconds; fills re-price at submission.</p></div>
              <div className="quote-time">{lastPriceAt ? `Updated ${lastPriceAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Connecting to prices…'}</div>
            </div>
            <div className="filters">
              <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search teams, events, or symbols" /></label>
              <select value={sport} onChange={(event) => setSport(event.target.value)} aria-label="Filter by league">
                {sports.map((option) => <option key={option} value={option}>{option === 'ALL' ? 'All leagues' : option}</option>)}
              </select>
            </div>

            {loadingMarkets && <div className="state-card"><div className="spinner" />Loading every market from Onyx…</div>}
            {marketError && <div className="state-card error"><strong>Market feed unavailable</strong><span>{marketError}</span></div>}
            {!loadingMarkets && !marketError && visibleMarkets.length === 0 && <div className="state-card">No markets match those filters.</div>}

            <div className="market-grid">
              {visibleMarkets.map((market) => {
                const price = prices[market.symbol]
                const title = market.name ?? market.event_name ?? market.symbol
                return (
                  <article className="market-card" key={market.id}>
                    <div className="market-meta"><span>{market.sport}</span><span className={market.status === 'open' ? 'open' : ''}>{market.status}</span></div>
                    <h3>{title}</h3>
                    <p className="symbol" title={market.symbol}>{market.symbol}</p>
                    <div className="trade-buttons">
                      <button disabled={price?.yes == null} onClick={() => openTicket(market, 'YES')}><small>YES</small><strong>{probability(price?.yes)}</strong></button>
                      <button disabled={price?.no == null} onClick={() => openTicket(market, 'NO')}><small>NO</small><strong>{probability(price?.no)}</strong></button>
                    </div>
                    <div className="card-footer"><span>{price?.volume ? `${price.volume.toLocaleString()} vol` : 'Live quote'}</span><span>{market.expiry_date ? new Date(market.expiry_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Open-ended'}</span></div>
                  </article>
                )
              })}
            </div>
            {!loadingMarkets && filteredMarkets.length > 0 && (
              <div className="pagination">
                <span>{filteredMarkets.length.toLocaleString()} markets</span>
                <div><button disabled={page === 1} onClick={() => setPage((value) => value - 1)}>←</button><strong>{page} / {pageCount}</strong><button disabled={page === pageCount} onClick={() => setPage((value) => value + 1)}>→</button></div>
              </div>
            )}
          </section>
        )}

        {view === 'portfolio' && (
          <section className="content-section">
            <div className="section-heading"><div><h2>Your portfolio</h2><p>Positions are marked to the latest upstream quote.</p></div><div className={`pnl-total ${portfolioPnl >= 0 ? 'positive' : 'negative'}`}><small>Unrealized P&amp;L</small><strong>{signedMoney(portfolioPnl)}</strong></div></div>
            {!summary?.positions.length ? <Empty title="No positions yet" body="Pick a market and buy YES or NO to build your paper portfolio." action={() => setView('markets')} /> : (
              <div className="table-wrap"><table><thead><tr><th>Market</th><th>Side</th><th>Shares</th><th>Avg. fill</th><th>Live</th><th>Cost</th><th>P&amp;L</th></tr></thead><tbody>
                {summary.positions.map((position) => {
                  const price = quoteForSide(position.marketSymbol, position.side)
                  const pnl = price === null ? null : Math.round(position.shares * price * 100) - position.costCents
                  return <tr key={`${position.marketSymbol}-${position.side}`}><td><strong>{position.marketName}</strong><small>{position.sport}</small></td><td><span className={`side ${position.side.toLowerCase()}`}>{position.side}</span></td><td>{position.shares.toFixed(2)}</td><td>{probability(position.averagePrice)}</td><td>{probability(price)}</td><td>{money(position.costCents)}</td><td className={pnl !== null && pnl >= 0 ? 'positive' : 'negative'}>{signedMoney(pnl)}</td></tr>
                })}
              </tbody></table></div>
            )}
          </section>
        )}

        {view === 'activity' && (
          <section className="content-section">
            <div className="section-heading"><div><h2>Fill history</h2><p>Every simulated execution, newest first.</p></div></div>
            {!summary?.orders.length ? <Empty title="No fills yet" body="Your completed paper orders will appear here." action={() => setView('markets')} /> : (
              <div className="activity-list">{summary.orders.map((order) => <article key={order.id}><div className={`fill-icon ${order.side.toLowerCase()}`}>{order.side === 'YES' ? 'Y' : 'N'}</div><div><strong>Bought {order.side} · {order.marketName}</strong><span>{new Date(order.createdAt).toLocaleString()} · {order.sport}</span></div><div><strong>{money(order.costCents)}</strong><span>{order.shares.toFixed(2)} shares @ {probability(order.fillPrice)}</span></div></article>)}</div>
            )}
          </section>
        )}
      </main>

      <footer><span>Onyx Paper</span><p>Simulated trading only. No real orders are sent to any venue.</p><a href="https://predictions.dev-onyxodds.com/docs#/" target="_blank" rel="noreferrer">API docs ↗</a></footer>

      {authMode && <Modal onClose={() => setAuthMode(null)}><div className="modal-kicker">{authMode === 'signup' ? 'START WITH $1,000' : 'WELCOME BACK'}</div><h2>{authMode === 'signup' ? 'Create your paper account' : 'Log in to your account'}</h2><p>Your balance, positions, and fills stay private to your account.</p><form onSubmit={submitAuth}><label>Email<input type="email" name="email" autoComplete="email" required placeholder="you@example.com" /></label><label>Password<input type="password" name="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required placeholder="At least 8 characters" /></label>{authError && <div className="form-error">{authError}</div>}<button className="button primary wide" disabled={authBusy}>{authBusy ? 'Working…' : authMode === 'signup' ? 'Create account' : 'Log in'}</button></form><button className="mode-switch" onClick={() => { setAuthError(''); setAuthMode(authMode === 'signup' ? 'login' : 'signup') }}>{authMode === 'signup' ? 'Already have an account? Log in' : 'New here? Create an account'}</button></Modal>}

      {ticket && <Modal onClose={() => setTicket(null)}><div className="modal-kicker">MARKET ORDER</div><h2>Buy {ticket.side}</h2><p className="ticket-market">{ticket.market.name ?? ticket.market.event_name ?? ticket.market.symbol}</p><div className="quote-summary"><span>Indicative price<strong>{probability(quoteForSide(ticket.market.symbol, ticket.side))}</strong></span><span>Available cash<strong>{money(user?.balanceCents ?? 0)}</strong></span></div><form onSubmit={submitOrder}><label>Amount in USD<div className="money-input"><span>$</span><input type="number" name="amount" min="1" max={(user?.balanceCents ?? 0) / 100} step="0.01" defaultValue="25.00" required autoFocus /></div></label><small className="execution-note">The server will fetch a fresh Onyx quote before filling. Your final share count may change.</small>{orderError && <div className="form-error">{orderError}</div>}<button className={`button wide trade ${ticket.side.toLowerCase()}`} disabled={orderBusy}>{orderBusy ? 'Fetching live quote…' : `Place ${ticket.side} order`}</button></form></Modal>}

      {toast && <div className="toast">✓ {toast}</div>}
    </div>
  )
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={onClose} aria-label="Close">×</button>{children}</section></div>
}

function Empty({ title, body, action }: { title: string; body: string; action: () => void }) {
  return <div className="empty"><div>↗</div><h3>{title}</h3><p>{body}</p><button className="button primary" onClick={action}>Browse markets</button></div>
}

export default App
