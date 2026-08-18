import { NavLink, useNavigate } from 'react-router-dom'
import { Icon } from '../../components/ui/Icon'
import type { Currency } from '../../lib/currency'

export function Header({
  title,
  currency,
  onCurrency,
  onSwitch,
}: {
  title?: string
  currency: Currency
  onCurrency: () => void
  onSwitch: () => void
}) {
  const navigate = useNavigate()
  return (
    <header className="topbar">
      <button className="brand-lockup" onClick={() => navigate('/')}>
        <span className="brand-mark">ir</span>
        <span>
          <strong>跨境选物台</strong>
          <small>跨平台商品价比较</small>
        </span>
      </button>
      <nav className="main-nav">
        <NavLink to="/" className={({ isActive }) => (isActive ? 'is-active' : '')} end>
          <Icon name="plus" size={15} />
          新建选购
        </NavLink>
        <NavLink to="/missions" className={({ isActive }) => (isActive ? 'is-active' : '')}>
          <Icon name="spark" size={15} />
          我的选购
        </NavLink>
        {title ? (
          <>
            <span className="nav-divider" aria-hidden="true" />
            <button className="topbar-task-chip" onClick={onSwitch}>
              <span>当前选购</span>
              <strong>{title}</strong>
              <Icon name="chevron" size={14} />
            </button>
          </>
        ) : null}
      </nav>
      <div className="topbar-actions">
        <button className="currency-link" onClick={onCurrency} aria-label="比较货币">
          <b>{currency}</b>
          <Icon name="chevron" size={12} />
        </button>
      </div>
    </header>
  )
}
