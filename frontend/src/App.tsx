import { useMemo, useState, type ReactNode } from 'react'

type View = 'home' | 'discover' | 'compare' | 'watchlist'
type Product = {
  id: string
  title: string
  brand: string
  model: string
  platform: string
  platformTone: string
  market: string
  nativePrice: string
  currency: string
  rmbPrice: number
  discount?: string
  rating: number
  reviews: number
  availability: string
  updated: string
  image: string
  gradient: string
  tag: string
  specs: string[]
  description: string
  delivery: string
  history: { month: string; value: number }[]
}

const products: Product[] = [
  {
    id: 'sony-xm5',
    title: 'Sony WH-1000XM5 无线降噪耳机',
    brand: 'Sony',
    model: 'WH-1000XM5',
    platform: 'Amazon',
    platformTone: 'amazon',
    market: '美国 · US',
    nativePrice: '$299.00',
    currency: 'USD',
    rmbPrice: 2149,
    discount: '低于 30 日均价 8%',
    rating: 4.8,
    reviews: 1240,
    availability: '现货 · 可配送至中国',
    updated: '3 分钟前',
    image: 'https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=900&q=80',
    gradient: 'linear-gradient(135deg, #dce5f9, #f4f0e7)',
    tag: '综合最优',
    specs: ['主动降噪', '续航 30 小时', 'Bluetooth 5.2'],
    description: '通勤场景的稳妥选择，降噪、佩戴和跨平台售后都比较均衡。',
    delivery: '预计 7–12 个工作日',
    history: [
      { month: '5月', value: 2399 },
      { month: '6月', value: 2259 },
      { month: '7月', value: 2219 },
      { month: '8月', value: 2149 },
    ],
  },
  {
    id: 'bose-qc-ultra',
    title: 'Bose QuietComfort Ultra 头戴式耳机',
    brand: 'Bose',
    model: 'QC Ultra',
    platform: 'Lazada',
    platformTone: 'lazada',
    market: '新加坡 · SG',
    nativePrice: 'S$399.00',
    currency: 'SGD',
    rmbPrice: 2118,
    discount: '券后价 · 需验证',
    rating: 4.7,
    reviews: 863,
    availability: '现货 · 配送范围待确认',
    updated: '8 分钟前',
    image: 'https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=900&q=80',
    gradient: 'linear-gradient(135deg, #e9dfd2, #f5f3ef)',
    tag: '降噪优先',
    specs: ['沉浸式音频', '续航 24 小时', 'Bluetooth 5.1'],
    description: '降噪体验更激进，适合长途飞行；价格优势依赖当前优惠券是否可用。',
    delivery: '预计 10–16 个工作日',
    history: [
      { month: '5月', value: 2360 },
      { month: '6月', value: 2280 },
      { month: '7月', value: 2199 },
      { month: '8月', value: 2118 },
    ],
  },
  {
    id: 'sennheiser-m4',
    title: 'Sennheiser Momentum 4 Wireless',
    brand: 'Sennheiser',
    model: 'Momentum 4',
    platform: 'Best Buy',
    platformTone: 'bestbuy',
    market: '美国 · US',
    nativePrice: '$329.95',
    currency: 'USD',
    rmbPrice: 2378,
    discount: '近 90 日低位',
    rating: 4.6,
    reviews: 516,
    availability: '现货 · 可配送至中国',
    updated: '12 分钟前',
    image: 'https://images.unsplash.com/photo-1484704849700-f032a568e944?auto=format&fit=crop&w=900&q=80',
    gradient: 'linear-gradient(135deg, #e5e0d4, #eef2f5)',
    tag: '续航最长',
    specs: ['自适应降噪', '续航 60 小时', 'Bluetooth 5.2'],
    description: '续航明显领先，音质口碑好；整体价格略高，适合重度使用者。',
    delivery: '预计 7–12 个工作日',
    history: [
      { month: '5月', value: 2589 },
      { month: '6月', value: 2499 },
      { month: '7月', value: 2419 },
      { month: '8月', value: 2378 },
    ],
  },
]

const watchItems = [
  { product: 'Sony WH-1000XM5', target: '¥2,000', current: '¥2,149', trend: '+7.5%', status: '等待降价', accent: 'blue' },
  { product: 'Apple MacBook Air M3 15″', target: '¥8,200', current: '¥8,699', trend: '近 30 日稳定', status: '价格稳定', accent: 'amber' },
]

const navItems: { id: View; label: string; icon: IconName }[] = [
  { id: 'discover', label: '任务', icon: 'spark' },
  { id: 'compare', label: '候选', icon: 'grid' },
  { id: 'watchlist', label: '价格监控', icon: 'bell' },
]

type IconName = 'arrow' | 'bell' | 'check' | 'chevron' | 'close' | 'external' | 'filter' | 'grid' | 'headphones' | 'heart' | 'info' | 'menu' | 'minus' | 'plus' | 'search' | 'spark' | 'sliders' | 'star' | 'target' | 'trend' | 'x'

function Icon({ name, size = 18, strokeWidth = 1.8 }: { name: IconName; size?: number; strokeWidth?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  const paths: Record<IconName, ReactNode> = {
    arrow: <><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
    external: <><path d="M14 5h5v5" /><path d="M10 14 19 5" /><path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" /></>,
    filter: <><path d="M4 6h16" /><path d="M7 12h10" /><path d="M10 18h4" /></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><path d="M4 14h3v5H5a1 1 0 0 1-1-1v-4Z" /><path d="M20 14h-3v5h2a1 1 0 0 0 1-1v-4Z" /></>,
    heart: <path d="M20.8 8.7c0 5.2-8.8 10.1-8.8 10.1S3.2 13.9 3.2 8.7A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
    menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
    minus: <path d="M5 12h14" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
    spark: <><path d="m12 3-1.5 5.5L5 10l5.5 1.5L12 17l1.5-5.5L19 10l-5.5-1.5L12 3Z" /><path d="m19 16-.7 2.3L16 19l2.3.7L19 22l.7-2.3L22 19l-2.3-.7L19 16Z" /></>,
    sliders: <><path d="M4 6h7" /><path d="M15 6h5" /><path d="M4 12h2" /><path d="M10 12h10" /><path d="M4 18h8" /><path d="M16 18h4" /><circle cx="13" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="14" cy="18" r="2" /></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
    target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>,
    trend: <><path d="M4 17 10 11l4 4 6-7" /><path d="M15 8h5v5" /></>,
    x: <><path d="M6 6 18 18" /><path d="m18 6-12 12" /></>,
  }
  return <svg {...common}>{paths[name]}</svg>
}

function PlatformMark({ product, small = false }: { product: Product; small?: boolean }) {
  return <span className={`platform-mark ${product.platformTone} ${small ? 'is-small' : ''}`}>{product.platform === 'Best Buy' ? 'BB' : product.platform.slice(0, 1)}</span>
}

function Button({ children, variant = 'secondary', icon, onClick, className = '', type = 'button', disabled = false }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'quiet'; icon?: IconName; onClick?: () => void; className?: string; type?: 'button' | 'submit'; disabled?: boolean }) {
  return <button className={`button button-${variant} ${className}`} type={type} onClick={onClick} disabled={disabled}>{children}{icon && <Icon name={icon} size={16} />}</button>
}

function Header({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  return (
    <header className="topbar">
      <button className="brand-lockup" onClick={() => onNavigate('discover')} aria-label="返回任务发现">
        <span className="brand-mark"><span>i</span><span>r</span></span>
        <span><strong>跨境选物台</strong><small>INTELLIGENCE DESK</small></span>
      </button>
      <nav className="main-nav" aria-label="主导航">
        {navItems.map((item) => <button key={item.id} className={view === item.id || (view === 'home' && item.id === 'discover') ? 'is-active' : ''} onClick={() => onNavigate(item.id)}><Icon name={item.icon} size={16} />{item.label}</button>)}
      </nav>
      <div className="topbar-actions">
        <button className="region-switch"><span className="flag-dot">¥</span> RMB <Icon name="chevron" size={13} /></button>
        <span className="topbar-divider" />
        <button className="avatar-button" aria-label="账户设置">L</button>
      </div>
    </header>
  )
}

function StageRail({ active = 1 }: { active?: number }) {
  const stages = ['购物简报', '候选池', '比较决策', '去购买']
  return <div className="stage-rail" aria-label="任务进度">
    {stages.map((stage, index) => <div className={`stage-item ${index === active ? 'is-active' : ''} ${index < active ? 'is-done' : ''}`} key={stage}>
      <span className="stage-number">{index < active ? <Icon name="check" size={13} strokeWidth={2.4} /> : `0${index + 1}`}</span>
      <span className="stage-label">{stage}</span>
      {index < stages.length - 1 && <span className="stage-line" />}
    </div>)}
  </div>
}

function HomeView({ query, setQuery, onSubmit }: { query: string; setQuery: (value: string) => void; onSubmit: () => void }) {
  const prompts = ['适合远程办公的 27 寸 4K 显示器', '送给爸爸的轻便徒步鞋', '2000 元以内的降噪耳机']
  return <main className="home-view">
    <div className="home-hero">
      <span className="eyebrow"><Icon name="spark" size={15} /> 跨平台购物情报台</span>
      <h1>告诉我你想买什么，<br /><em>我来把选择变简单。</em></h1>
      <p>从国际平台检索商品，统一换算成人民币，帮你看清价格、规格和到手路径。</p>
    </div>
    <form className="mission-composer" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
      <div className="composer-label"><span className="live-dot" /> 新建购物任务</div>
      <textarea aria-label="描述购物需求" value={query} onChange={(event) => setQuery(event.target.value)} rows={3} />
      <div className="composer-footer">
        <div className="composer-tools"><button type="button"><Icon name="plus" size={16} /> 添加图片</button><button type="button"><Icon name="target" size={16} /> 设定预算</button></div>
        <Button variant="primary" type="submit" icon="arrow">开始探索</Button>
      </div>
    </form>
    <div className="prompt-row"><span>试试这样说</span>{prompts.map((prompt) => <button key={prompt} onClick={() => setQuery(prompt)}>{prompt}<Icon name="arrow" size={13} /></button>)}</div>
    <div className="home-features">
      <div><span className="feature-icon blue"><Icon name="grid" size={18} /></span><strong>跨平台发现</strong><p>一条任务，聚合 Amazon、Lazada、Best Buy 等国际平台。</p></div>
      <div><span className="feature-icon amber"><Icon name="trend" size={18} /></span><strong>人民币比价</strong><p>保留原币种价格，同时按实时汇率统一比较。</p></div>
      <div><span className="feature-icon mint"><Icon name="bell" size={18} /></span><strong>价格跟踪</strong><p>错过好价也没关系，设置目标价后交给 Agent 盯住。</p></div>
    </div>
  </main>
}

function MissionHeader({ onReset }: { onReset: () => void }) {
  return <div className="mission-header">
    <div>
      <div className="breadcrumb"><span>任务</span><Icon name="chevron" size={13} /><span>通勤装备</span></div>
      <h1>帮我找一副适合通勤的降噪耳机</h1>
      <div className="mission-meta"><span><Icon name="target" size={14} /> 预算 ¥2,500 以内</span><span><Icon name="grid" size={14} /> 4 个平台</span><span><Icon name="bell" size={14} /> 送至中国大陆</span></div>
    </div>
    <Button variant="quiet" icon="plus" onClick={onReset}>新建任务</Button>
  </div>
}

function AgentInsight() {
  return <section className="agent-insight">
    <div className="insight-orb"><Icon name="spark" size={19} /></div>
    <div className="insight-copy"><span className="eyebrow">AGENT NOTE · 刚刚更新</span><p>我先按<strong>降噪、佩戴舒适度和到手价格</strong>做了第一轮筛选。当前最值得比较的是 Sony 与 Bose：两者都在预算内，但价格优势来自不同市场。</p></div>
    <div className="fx-signal"><span className="signal-label">汇率信号</span><strong>USD → RMB</strong><b>7.1882</b><small>实时参考</small></div>
  </section>
}

function FilterBar({ sort, setSort }: { sort: string; setSort: (value: string) => void }) {
  return <div className="filter-bar">
    <div className="result-count"><strong>12</strong> 个候选商品 <span>· 4 个平台</span></div>
    <div className="filter-actions"><button className="filter-button"><Icon name="filter" size={15} /> 筛选 <span className="filter-count">2</span></button><span className="filter-divider" /><label className="sort-select">排序 <select value={sort} onChange={(event) => setSort(event.target.value)}><option>综合推荐</option><option>人民币最低</option><option>评分最高</option><option>近期降价</option></select><Icon name="chevron" size={14} /></label></div>
  </div>
}

function ProductCard({ product, selected, onSelect, onDetail }: { product: Product; selected: boolean; onSelect: () => void; onDetail: () => void }) {
  return <article className={`product-card ${selected ? 'is-selected' : ''}`}>
    <button className="product-image-button" onClick={onDetail} aria-label={`查看 ${product.title} 详情`}>
      <div className="product-image" style={{ background: product.gradient }}><img src={product.image} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /><span className="image-tag">{product.tag}</span><span className="image-heart"><Icon name="heart" size={16} /></span></div>
    </button>
    <div className="product-card-body">
      <div className="product-source"><span><PlatformMark product={product} small /> {product.platform}</span><span>{product.market}</span></div>
      <button className="product-title" onClick={onDetail}>{product.title}</button>
      <div className="rating-line"><span className="stars"><Icon name="star" size={13} /> {product.rating}</span><span>{product.reviews.toLocaleString()} 条评价</span></div>
      <div className="price-line"><strong>¥{product.rmbPrice.toLocaleString()}</strong><span>{product.nativePrice}</span></div>
      <div className="deal-line"><span className="deal-dot" /> {product.discount}</div>
      <div className="card-bottom"><span className="stock"><Icon name="check" size={14} /> {product.availability.split(' · ')[0]}</span><Button variant={selected ? 'primary' : 'secondary'} icon={selected ? 'check' : 'plus'} onClick={onSelect}>{selected ? '已加入' : '加入候选'}</Button></div>
    </div>
  </article>
}

function CompareTray({ selected, onCompare, onRemove }: { selected: Product[]; onCompare: () => void; onRemove: (id: string) => void }) {
  return <div className="compare-tray">
    <div className="tray-copy"><span className="tray-count">{selected.length}</span><div><strong>已选候选</strong><small>最多选择 3 个进行横向比较</small></div></div>
    <div className="tray-items">{selected.map((product) => <div className="tray-item" key={product.id}><span className="tray-thumb" style={{ backgroundImage: `url(${product.image})` }} /><span>{product.brand} <small>¥{product.rmbPrice.toLocaleString()}</small></span><button onClick={() => onRemove(product.id)} aria-label={`移除 ${product.title}`}><Icon name="close" size={13} /></button></div>)}</div>
    <Button variant="primary" onClick={onCompare} disabled={selected.length < 2} icon="arrow">开始比较</Button>
  </div>
}

function DiscoverView({ onReset, selectedIds, onSelect, onDetail, onCompare }: { onReset: () => void; selectedIds: string[]; onSelect: (id: string) => void; onDetail: (id: string) => void; onCompare: () => void }) {
  const [sort, setSort] = useState('综合推荐')
  const selected = products.filter((product) => selectedIds.includes(product.id))
  return <main className="workspace-view">
    <StageRail active={1} />
    <MissionHeader onReset={onReset} />
    <AgentInsight />
    <FilterBar sort={sort} setSort={setSort} />
    <div className="results-layout">
      <aside className="context-rail">
        <div className="context-card"><span className="eyebrow">任务约束</span><div className="constraint"><Icon name="target" size={16} /><span>预算<strong>¥2,500</strong></span></div><div className="constraint"><Icon name="grid" size={16} /><span>偏好<strong>头戴式 · 黑色</strong></span></div><div className="constraint"><Icon name="bell" size={16} /><span>目的地<strong>中国大陆</strong></span></div><button className="edit-constraints"><Icon name="sliders" size={14} /> 调整条件</button></div>
        <div className="context-note"><span className="note-pin"><Icon name="info" size={14} /></span><p>人民币价格已包含当前汇率换算，<strong>不含关税与平台最终运费</strong>。</p></div>
        <div className="source-list"><span className="eyebrow">正在检索</span><div><PlatformMark product={products[0]} small /> Amazon US <Icon name="check" size={13} /></div><div><PlatformMark product={products[1]} small /> Lazada SG <Icon name="check" size={13} /></div><div><PlatformMark product={products[2]} small /> Best Buy US <Icon name="check" size={13} /></div><button>查看全部平台 <Icon name="arrow" size={13} /></button></div>
      </aside>
      <section className="product-results"><div className="products-grid">{products.map((product) => <ProductCard key={product.id} product={product} selected={selectedIds.includes(product.id)} onSelect={() => onSelect(product.id)} onDetail={() => onDetail(product.id)} />)}</div><button className="load-more"><Icon name="plus" size={15} /> 加载更多候选</button></section>
    </div>
    {selected.length > 0 && <CompareTray selected={selected} onCompare={onCompare} onRemove={onSelect} />}
  </main>
}

function MiniSparkline({ values }: { values: number[] }) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${90 - ((value - min) / Math.max(1, max - min)) * 70}`).join(' ')
  return <svg className="mini-sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="价格趋势图"><polyline points={points} /></svg>
}

function CompareView({ onBack, onDetail }: { onBack: () => void; onDetail: (id: string) => void }) {
  const compared = products.slice(0, 3)
  return <main className="workspace-view compare-view">
    <StageRail active={2} />
    <div className="compare-heading"><div><div className="breadcrumb"><button onClick={onBack}>候选池</button><Icon name="chevron" size={13} /><span>比较决策</span></div><h1>3 个候选，哪个最适合你？</h1><p>我已经把价格、规格、到手路径和近期趋势放在同一张桌面上。</p></div><Button variant="secondary" icon="plus" onClick={onBack}>添加候选</Button></div>
    <section className="decision-banner"><div className="decision-icon"><Icon name="spark" size={21} /></div><div><span className="eyebrow">AGENT DECISION · 综合判断</span><p><strong>Sony WH-1000XM5</strong> 目前是更稳妥的选择：人民币价格低于预算 ¥351，配送路径明确，降噪和佩戴评价都比较平衡。</p></div><div className="decision-score"><span>匹配度</span><strong>94</strong><small>/100</small></div></section>
    <section className="comparison-table-wrap"><div className="table-toolbar"><span className="eyebrow">横向比较 · 价格已统一为人民币</span><div><button><Icon name="sliders" size={15} /> 显示字段</button><button><Icon name="external" size={15} /> 分享结果</button></div></div><div className="comparison-table"><div className="comparison-label-column"><div className="table-spacer" /><div>平台与所在地</div><div>当前价格</div><div>近 30 日走势</div><div>核心规格</div><div>库存与配送</div><div>用户反馈</div><div>决策动作</div></div>{compared.map((product, index) => <div className={`comparison-product ${index === 0 ? 'is-recommended' : ''}`} key={product.id}>
      <div className="comparison-product-head"><div className="compare-image" style={{ background: product.gradient }}><img src={product.image} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /></div><span className="compare-tag">{index === 0 ? '推荐' : product.tag}</span><button onClick={() => onDetail(product.id)}>{product.title}<Icon name="external" size={13} /></button></div>
      <div className="compare-cell source-cell"><PlatformMark product={product} small /><span><strong>{product.platform}</strong><small>{product.market}</small></span></div>
      <div className="compare-cell price-cell"><strong>¥{product.rmbPrice.toLocaleString()}</strong><span>{product.nativePrice}</span>{index === 0 && <em>预算内 ¥351</em>}</div>
      <div className="compare-cell trend-cell"><MiniSparkline values={product.history.map((point) => point.value)} /><span className="trend-down"><Icon name="trend" size={13} /> -{index + 4}.2%</span></div>
      <div className="compare-cell specs-cell">{product.specs.map((spec) => <span key={spec}>{spec}</span>)}</div>
      <div className="compare-cell delivery-cell"><span className="stock"><Icon name="check" size={14} /> {product.availability.split(' · ')[0]}</span><small>{product.delivery}</small></div>
      <div className="compare-cell review-cell"><span className="stars"><Icon name="star" size={13} /> {product.rating}</span><small>{product.reviews.toLocaleString()} 条评价</small></div>
      <div className="compare-cell action-cell"><Button variant={index === 0 ? 'primary' : 'secondary'} onClick={() => onDetail(product.id)}>{index === 0 ? '查看购买路径' : '查看详情'}</Button></div>
    </div>)}</div></section>
    <div className="compare-footnote"><Icon name="info" size={14} /> 价格抓取时间：今天 14:32（北京时间） · 汇率仅作比较参考，最终以支付页为准。</div>
  </main>
}

function WatchlistView({ onDetail }: { onDetail: (id: string) => void }) {
  return <main className="workspace-view watchlist-view"><div className="watchlist-heading"><div><span className="eyebrow"><Icon name="bell" size={14} /> PRICE MONITOR</span><h1>价格监控</h1><p>把还没准备好下单的选择交给我，价格到位时再回来。</p></div><Button variant="primary" icon="plus">添加监控</Button></div><div className="monitor-summary"><div><span>监控中</span><strong>02</strong><small>个商品</small></div><div><span>本周降价</span><strong className="green">01</strong><small>个商品</small></div><div><span>已节省空间</span><strong>¥351</strong><small>若现在购买</small></div></div><div className="monitor-list">{watchItems.map((item, index) => <article className="monitor-card" key={item.product}><div className={`monitor-icon ${item.accent}`}><Icon name={index === 0 ? 'headphones' as IconName : 'grid'} size={21} /></div><div className="monitor-info"><span className="monitor-status"><i /> {item.status}</span><h2>{item.product}</h2><p>目标价 <strong>{item.target}</strong> · 当前人民币价 <strong>{item.current}</strong></p></div><div className="monitor-chart"><div><span>30 日价格走势</span><strong className={index === 0 ? 'red' : 'neutral'}>{item.trend}</strong></div><MiniSparkline values={index === 0 ? [2350, 2280, 2200, 2149, 2190, 2149] : [8700, 8699, 8720, 8699, 8699, 8699]} /></div><button className="monitor-more" onClick={() => index === 0 && onDetail('sony-xm5')} aria-label="查看监控商品"><Icon name="chevron" size={17} /></button></article>)}</div><div className="watchlist-tip"><span><Icon name="spark" size={16} /></span><p><strong>一个小建议</strong>：Sony WH-1000XM5 最近在 ¥2,100 附近波动，如果不急着用，可以把目标价设为 ¥2,000。</p><button>设置目标价 <Icon name="arrow" size={14} /></button></div></main>
}

function ProductDrawer({ product, onClose, onSelect, selected }: { product: Product; onClose: () => void; onSelect: () => void; selected: boolean }) {
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="product-drawer" aria-label="商品详情"><div className="drawer-top"><span className="eyebrow">商品详情</span><button className="icon-button" onClick={onClose} aria-label="关闭详情"><Icon name="close" size={18} /></button></div><div className="drawer-image" style={{ background: product.gradient }}><img src={product.image} alt={product.title} /></div><div className="drawer-body"><div className="product-source"><span><PlatformMark product={product} small /> {product.platform}</span><span>{product.market}</span></div><h2>{product.title}</h2><p className="drawer-description">{product.description}</p><div className="drawer-price"><div><span>当前人民币参考价</span><strong>¥{product.rmbPrice.toLocaleString()}</strong></div><div><span>原站价格</span><b>{product.nativePrice}</b></div></div><div className="drawer-callout"><Icon name="trend" size={16} /><span><strong>{product.discount}</strong><small>价格数据更新于 {product.updated}</small></span></div><div className="drawer-section"><div className="section-title">核心规格</div><div className="spec-pills">{product.specs.map((spec) => <span key={spec}>{spec}</span>)}</div></div><div className="drawer-section"><div className="section-title">价格走势 <small>近 4 个月 · RMB</small></div><div className="drawer-chart"><MiniSparkline values={product.history.map((point) => point.value)} /><div>{product.history.map((point) => <span key={point.month}><i style={{ height: `${(point.value / Math.max(...product.history.map((item) => item.value))) * 64}%` }} />{point.month}</span>)}</div></div></div><div className="drawer-section delivery-section"><div className="section-title">到手路径</div><div className="delivery-row"><span className="delivery-check"><Icon name="check" size={14} /></span><span><strong>{product.availability.split(' · ')[0]}</strong><small>{product.delivery}</small></span></div><p><Icon name="info" size={13} /> 运费、关税和最终可配送范围需在平台结算页确认。</p></div></div><div className="drawer-footer"><Button variant="secondary" onClick={onSelect} icon={selected ? 'check' : 'plus'}>{selected ? '已加入候选' : '加入候选'}</Button><Button variant="primary" icon="external">前往 {product.platform}</Button></div></aside></div>
}

export default function App() {
  const [view, setView] = useState<View>('discover')
  const [query, setQuery] = useState('帮我找一副适合通勤的降噪耳机，预算 2500 元以内')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
  const selectedProductIds = useMemo(() => new Set(selectedIds), [selectedIds])
  const detailProduct = products.find((product) => product.id === detailId)

  const toggleProduct = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length >= 3 ? current : [...current, id])
  const startTask = () => setView('discover')
  const resetTask = () => { setQuery(''); setSelectedIds([]); setView('home') }

  return <div className="app-shell"><Header view={view} onNavigate={setView} />{view === 'home' && <HomeView query={query} setQuery={setQuery} onSubmit={startTask} />}{view === 'discover' && <DiscoverView onReset={resetTask} selectedIds={selectedIds} onSelect={toggleProduct} onDetail={setDetailId} onCompare={() => setView('compare')} />}{view === 'compare' && <CompareView onBack={() => setView('discover')} onDetail={setDetailId} />}{view === 'watchlist' && <WatchlistView onDetail={setDetailId} />}{detailProduct && <ProductDrawer product={detailProduct} selected={selectedProductIds.has(detailProduct.id)} onClose={() => setDetailId(null)} onSelect={() => toggleProduct(detailProduct.id)} />}</div>
}
