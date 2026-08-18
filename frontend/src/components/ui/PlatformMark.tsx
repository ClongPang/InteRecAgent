import { useState } from 'react'
import amazonLogo from '../../platform-logos/amazon.png'
import bestbuyLogo from '../../platform-logos/bestbuy.png'
import lazadaLogo from '../../platform-logos/lazada.png'
import { platformName, platformTone } from '../../lib/platform'

const logos: Record<string, string> = {
  amazon: amazonLogo,
  bestbuy: bestbuyLogo,
  lazada: lazadaLogo,
}

export function PlatformMark({ merchant }: { merchant: string | null | undefined }) {
  const [failed, setFailed] = useState(false)
  const tone = platformTone(merchant)
  const name = platformName(merchant)
  const src = logos[tone]
  return (
    <span className={`platform-mark platform-mark--${tone}${failed || !src ? ' platform-mark--fallback' : ''}`} role="img" aria-label={name}>
      {failed || !src ? (
        <span className="platform-mark-fallback">{name}</span>
      ) : (
        <img src={src} alt="" onError={() => setFailed(true)} />
      )}
    </span>
  )
}
