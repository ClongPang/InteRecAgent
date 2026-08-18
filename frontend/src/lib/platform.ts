export function platformTone(merchant: string | null | undefined): string {
  const value = (merchant || '').toLowerCase()
  if (value.includes('amazon')) return 'amazon'
  if (value.includes('lazada')) return 'lazada'
  if (value.includes('best')) return 'bestbuy'
  return 'amazon'
}

export function platformName(merchant: string | null | undefined): string {
  const tone = platformTone(merchant)
  if (tone === 'lazada') return 'Lazada'
  if (tone === 'bestbuy') return 'Best Buy'
  if ((merchant || '').toLowerCase().includes('amazon')) return 'Amazon'
  return merchant || '商户'
}
