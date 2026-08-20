export function platformTone(merchant: string | null | undefined): string {
  const value = (merchant || '').toLowerCase()
  if (value.includes('amazon')) return 'amazon'
  if (value.includes('lazada')) return 'lazada'
  if (value.includes('best')) return 'bestbuy'
  return 'amazon'
}

export function platformName(merchant: string | null | undefined): string {
  const value = (merchant || '').trim()
  const tone = platformTone(value)
  if (tone === 'lazada') return 'Lazada'
  if (tone === 'bestbuy') return 'Best Buy'
  if (value.toLowerCase().includes('amazon')) return 'Amazon'
  const shopify = value.match(/^shopify[_-](.+)$/i)
  if (shopify) {
    const host = shopify[1].replace(/_/g, '.').replace(/^www\./, '')
    if (host.includes('decathlon')) return 'Decathlon'
    return host
  }
  return value || '商户'
}
