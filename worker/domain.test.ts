import { describe, expect, it } from 'vitest'
import { fillPrice, positionMetrics, sidePrices } from './domain'

describe('sidePrices', () => {
  it('uses the ask for a YES buy and one minus bid for a NO buy', () => {
    expect(sidePrices({ ask_price: 0.63, bid_price: 0.59 })).toEqual({ yes: 0.63, no: 0.41 })
  })

  it('falls back to the latest traded price', () => {
    expect(fillPrice({ last_price: 0.72 }, 'YES')).toBe(0.72)
    expect(fillPrice({ last_price: 0.72 }, 'NO')).toBeCloseTo(0.28)
  })

  it('rejects missing and invalid quotes', () => {
    expect(sidePrices({ ask_price: 1, bid_price: 0 })).toEqual({ yes: null, no: null })
  })
})

describe('positionMetrics', () => {
  it('calculates average entry, market value, and unrealized pnl', () => {
    expect(positionMetrics(20, 800, 0.5)).toEqual({
      averagePrice: 0.4,
      marketValueCents: 1000,
      pnlCents: 200,
    })
  })
})
