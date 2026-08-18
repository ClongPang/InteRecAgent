import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function Button({
  children,
  onClick,
  icon,
  variant = 'secondary',
  disabled,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  icon?: IconName
  variant?: 'primary' | 'secondary' | 'quiet'
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button className={`button button-${variant}`} type={type} onClick={onClick} disabled={disabled}>
      {children}
      {icon ? <Icon name={icon} size={15} /> : null}
    </button>
  )
}
