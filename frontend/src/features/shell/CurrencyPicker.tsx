import { Icon } from '../../components/ui/Icon'
import { CURRENCY_NAME, CURRENCY_SYMBOL, type Currency } from '../../lib/currency'

export function CurrencyPicker({
  currency,
  onSelect,
  onClose,
}: {
  currency: Currency
  onSelect: (currency: Currency) => void
  onClose: () => void
}) {
  const options: Currency[] = ['RMB', 'USD', 'SGD']
  return (
    <div className="currency-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="currency-popover" role="dialog" aria-label="比较货币">
        <div className="switcher-heading">
          <div>
            <strong>比较货币</strong>
            <small>价格按所选货币换算显示</small>
          </div>
          <button onClick={onClose} aria-label="关闭"><Icon name="close" size={16} /></button>
        </div>
        <div className="currency-list">
          {options.map((item) => (
            <button className={item === currency ? 'is-current' : ''} key={item} onClick={() => { onSelect(item); onClose() }}>
              <b>{item}</b>
              <small>{CURRENCY_NAME[item]} · {CURRENCY_SYMBOL[item]}</small>
              {item === currency ? <em>当前</em> : null}
            </button>
          ))}
        </div>
        <p className="currency-note">商品价先统一换算为人民币，再按所选货币显示；运费与税费以商户结算页为准。</p>
      </section>
    </div>
  )
}
