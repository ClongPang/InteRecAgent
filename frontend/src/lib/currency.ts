import type { ProductCandidate } from '../api/types'

export type Currency = 'RMB' | 'USD' | 'SGD'

export const CURRENCY_SYMBOL: Record<Currency, string> = { RMB: '¥', USD: '$', SGD: 'S$' }
export const CURRENCY_NAME: Record<Currency, string> = { RMB: '人民币', USD: '美元', SGD: '新加坡元' }

export type SnapshotRates = Partial<Record<'USD' | 'SGD', number>>

export function rmbAmount(product: ProductCandidate): number | null {
  return product.estimated_cny?.amount ?? null
}

export function ratesFromCandidates(products: ProductCandidate[]): SnapshotRates {
  const rates: SnapshotRates = {}
  for (const product of products) {
    const code = product.native_price.currency
    const rate = product.estimated_cny?.rate
    if ((code === 'USD' || code === 'SGD') && rate && !rates[code]) {
      rates[code] = rate
    }
  }
  return rates
}

export function displayAmount(
  rmb: number | null,
  currency: Currency,
  rates?: SnapshotRates,
): string | null {
  if (rmb == null) return null
  if (currency === 'RMB') return rmb.toLocaleString()
  const rate = rates?.[currency]
  if (!rate) return null
  return Math.round(rmb / rate).toLocaleString()
}

export function nativePriceText(product: ProductCandidate): string {
  const { amount, currency } = product.native_price
  return `${currency} ${amount.toFixed(2)}`
}

export function fxText(product: ProductCandidate): string | null {
  const fx = product.estimated_cny
  if (!fx) return product.fx_failed ? '人民币估算暂不可用' : null
  return `1 ${product.native_price.currency} = ${fx.rate} CNY · 汇率日期 ${fx.rate_date}`
}
