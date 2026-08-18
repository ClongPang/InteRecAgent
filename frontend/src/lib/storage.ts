import type { Currency } from './currency'

const CURRENCY_KEY = 'interecagent.currency'

export function loadCurrency(): Currency {
  const saved = localStorage.getItem(CURRENCY_KEY)
  return saved === 'USD' || saved === 'SGD' ? saved : 'RMB'
}

export function saveCurrency(currency: Currency): void {
  localStorage.setItem(CURRENCY_KEY, currency)
}

export function demoAuthEnabled(): boolean {
  return String(import.meta.env.VITE_ENABLE_DEMO_AUTH || '').toLowerCase() === 'true'
}
