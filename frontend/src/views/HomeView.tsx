import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { PlatformMark } from '../components/ui/PlatformMark'
import { useMissionCommands } from '../features/missions/useMissionCommands'
import { ApiError } from '../api/errors'

const PROMPTS = [
  '适合远程办公的 27 寸 4K 显示器，3000 元以内',
  '送给爸爸的轻便徒步鞋，1000 元以内',
  '降噪耳机，2000 元以内，优先续航',
]

const PREVIEW = [
  { merchant: 'Amazon', tone: 'amazon', market: 'US', native: 'USD 299.00', rmb: '2,149' },
  { merchant: 'Lazada', tone: 'lazada', market: 'SG', native: 'SGD 399.00', rmb: '2,118' },
  { merchant: 'Best Buy', tone: 'bestbuy', market: 'US', native: 'USD 329.95', rmb: '2,378' },
]

export function HomeView() {
  const navigate = useNavigate()
  const { create } = useMissionCommands(undefined)
  const [query, setQuery] = useState('帮我找一副适合通勤的降噪耳机，预算 2500 元以内')
  const [error, setError] = useState<string | null>(null)
  const starting = useRef(false)
  const [locked, setLocked] = useState(false)
  const busy = locked || create.isPending

  const start = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || starting.current) return
    starting.current = true
    setLocked(true)
    setError(null)
    try {
      const result = await create.mutateAsync(trimmed)
      navigate(`/missions/${result.mission.id}`)
    } catch (err) {
      starting.current = false
      setLocked(false)
      setError(err instanceof ApiError ? err.message : '创建选购失败，请确认后端已启动。')
    }
  }

  return (
    <main className="home-view">
      <div className="home-hero">
        <h1>想买什么？</h1>
        <p>告诉我用途、预算和偏好，我会跨平台检索商品价与证据。无需登录即可开始；任务会绑定本机匿名身份。</p>
      </div>
      <form
        className="mission-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void start(query)
        }}
      >
        <div className="composer-label">描述你的需求</div>
        <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} aria-label="描述购物需求" />
        <div className="composer-footer">
          <span>商品价换算为 RMB；运费与税费以商户结算页为准</span>
          <Button variant="primary" type="submit" icon="arrow" disabled={!query.trim() || busy}>
            {busy ? '正在创建…' : '开始选购'}
          </Button>
        </div>
      </form>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      <div className="prompt-row">
        <span>试试这样说</span>
        {PROMPTS.map((prompt) => (
          <button key={prompt} type="button" onClick={() => setQuery(prompt)}>{prompt}</button>
        ))}
      </div>
      <section className="home-preview" aria-label="比价示意">
        <div className="preview-heading">
          <span>比价示意</span>
          <strong>通勤降噪耳机 · ¥2,500 内</strong>
          <small>示意数据，不是当前检索结果</small>
        </div>
        <div className="preview-fx">
          <span>汇率基准</span>
          <span className="preview-rate"><b>USD</b> 7.1882</span>
          <span className="preview-rate"><b>SGD</b> 5.3083</span>
          <em>示意汇率</em>
        </div>
        <div className="preview-rows" aria-label="示例比较结果">
          {PREVIEW.map((row) => (
            <div className="preview-row" key={row.merchant}>
              <PlatformMark merchant={row.merchant} />
              <b>{row.merchant} {row.market}</b>
              <strong>{row.native}</strong>
              <em>约 ¥{row.rmb}</em>
            </div>
          ))}
        </div>
        <div className="preview-foot">
          <span>已统一商品价口径，可继续比较规格与评价</span>
          <span>运费与税费以商户结算页为准</span>
        </div>
      </section>
    </main>
  )
}
