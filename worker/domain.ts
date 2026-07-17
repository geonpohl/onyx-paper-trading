export type Side = 'YES' | 'NO'

export interface RawQuote {
  ask_price?: number | null
  bid_price?: number | null
  last_price?: number | null
  yes_price?: number | null
}

export interface SidePrices {
  yes: number | null
  no: number | null
}

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1

export function sidePrices(quote: RawQuote): SidePrices {
  const yes = [quote.ask_price, quote.last_price, quote.yes_price].find(isProbability) ?? null
  const noSource = [quote.bid_price, quote.last_price, quote.yes_price].find(isProbability)
  const no = noSource === undefined ? null : Math.round((1 - noSource) * 1_000_000) / 1_000_000
  return { yes, no: no !== null && isProbability(no) ? no : null }
}

export function fillPrice(quote: RawQuote, side: Side): number | null {
  const prices = sidePrices(quote)
  return side === 'YES' ? prices.yes : prices.no
}

export function positionMetrics(shares: number, costCents: number, currentPrice: number | null) {
  const averagePrice = shares > 0 ? costCents / 100 / shares : 0
  const marketValueCents = currentPrice === null ? null : Math.round(shares * currentPrice * 100)
  const pnlCents = marketValueCents === null ? null : marketValueCents - costCents
  return { averagePrice, marketValueCents, pnlCents }
}
