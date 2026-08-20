import { useEffect, useState } from 'react'
import type { ProductCandidate } from '../../api/types'
import { categoryIconFor } from '../../lib/category'
import { Icon } from './Icon'

export function ProductPhoto({
  product,
  className,
  iconSize = 42,
}: {
  product: ProductCandidate
  className?: string
  iconSize?: number
}) {
  const src = product.image_url || null
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])
  if (!src || failed) {
    return (
      <span className="category-icon" aria-hidden="true">
        <Icon name={categoryIconFor(product.title)} size={iconSize} />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      className={className}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
