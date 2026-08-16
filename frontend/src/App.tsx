import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import amazonLogo from './platform-logos/amazon.png'
import bestbuyLogo from './platform-logos/BBY.jpeg'
import lazadaLogo from './platform-logos/lazada.png'

type View = 'home' | 'tasks' | 'discover' | 'compare'
type Preference = 'balanced' | 'noise' | 'battery' | 'lowest'
type IconName = 'back' | 'arrow' | 'bell' | 'check' | 'chevron' | 'close' | 'download' | 'edit' | 'external' | 'eye' | 'eye-off' | 'filter' | 'grid' | 'headphones' | 'heart' | 'info' | 'logout' | 'monitor' | 'plus' | 'search' | 'settings' | 'shoe' | 'spark' | 'star' | 'target' | 'trash' | 'user'
type AuthProvider = 'phone'
type Currency = 'RMB' | 'USD' | 'SGD'
type AccountUser = { phone: string; name: string; provider: AuthProvider; memberSince: string; createdAt: number; expiresAt: number; remember: boolean }
type Mission = { id: number; intent: string; budget?: number; preference: Preference; onlyInStock: boolean; version: number }
type Product = { id: string; title: string; brand: string; model: string; platform: string; tone: string; market: string; nativePrice: string; rmbPrice: number; fx: string; fxAsOf: string; updated: string; rating: number; reviews: number; stock: '有货' | '库存有限' | '暂无库存信息'; specs: string[]; why: string; tradeoff: string; url: string }
type Message = { id: string; role: 'user' | 'agent'; text: string; actions?: string[] }
type ChangeRecord = { id: string; summary: string; before: Mission; selectedBefore: string[]; resultBefore: number; resultAfter: number }
type TaskPhase = 'collecting' | 'shortlisting' | 'comparing'
type ShoppingTask = { id: number; mission: Mission; selected: string[]; messages: Message[]; latestChange: ChangeRecord | null; phase: TaskPhase; lastSurface: 'discover' | 'compare'; createdAt: string; updatedAt: string; updatedAtMs: number }

const products: Product[] = [
  { id: 'sony-xm5', title: 'Sony WH-1000XM5 无线降噪耳机', brand: 'Sony', model: 'WH-1000XM5', platform: 'Amazon', tone: 'amazon', market: '美国 · US', nativePrice: 'USD 299.00', rmbPrice: 2149, fx: '1 USD = 7.1882 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '3 分钟前更新', rating: 4.8, reviews: 1240, stock: '有货', specs: ['主动降噪', '续航 30 小时', 'Bluetooth 5.2'], why: '降噪、续航与评分比较均衡。', tradeoff: '适合把降噪和续航放在同一优先级的人。', url: 'https://www.amazon.com/s?k=Sony+WH-1000XM5' },
  { id: 'bose-qc-ultra', title: 'Bose QuietComfort Ultra 头戴式耳机', brand: 'Bose', model: 'QC Ultra', platform: 'Lazada', tone: 'lazada', market: '新加坡 · SG', nativePrice: 'SGD 399.00', rmbPrice: 2118, fx: '1 SGD = 5.3083 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '8 分钟前更新', rating: 4.7, reviews: 863, stock: '有货', specs: ['沉浸式音频', '续航 24 小时', 'Bluetooth 5.1'], why: '降噪取向突出，商品价接近预算。', tradeoff: '适合优先考虑沉浸式降噪体验的人。', url: 'https://www.lazada.sg/catalog/?q=Bose%20QuietComfort%20Ultra' },
  { id: 'sennheiser-m4', title: 'Sennheiser Momentum 4 Wireless', brand: 'Sennheiser', model: 'Momentum 4', platform: 'Best Buy', tone: 'bestbuy', market: '美国 · US', nativePrice: 'USD 329.95', rmbPrice: 2378, fx: '1 USD = 7.1882 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '12 分钟前更新', rating: 4.6, reviews: 516, stock: '库存有限', specs: ['自适应降噪', '续航 60 小时', 'Bluetooth 5.2'], why: '60 小时续航明显领先。', tradeoff: '适合把长续航放在首位的人。', url: 'https://www.bestbuy.com/site/searchpage.jsp?st=Sennheiser+Momentum+4' },
  { id: 'soundcore-q45', title: 'Soundcore Space Q45 降噪耳机', brand: 'Soundcore', model: 'Space Q45', platform: 'Amazon', tone: 'amazon', market: '美国 · US', nativePrice: 'USD 149.99', rmbPrice: 1078, fx: '1 USD = 7.1882 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '18 分钟前更新', rating: 4.4, reviews: 3210, stock: '暂无库存信息', specs: ['主动降噪', '续航 50 小时', 'LDAC'], why: '商品参考价最低，续航较长。', tradeoff: '适合优先控制商品预算的人。', url: 'https://www.amazon.com/s?k=Soundcore+Space+Q45' },
  { id: 'dell-u2723qe', title: 'Dell UltraSharp U2723QE 27 英寸 4K 显示器', brand: 'Dell', model: 'U2723QE', platform: 'Amazon', tone: 'amazon', market: '美国 · US', nativePrice: 'USD 579.99', rmbPrice: 4170, fx: '1 USD = 7.1882 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '5 分钟前更新', rating: 4.7, reviews: 932, stock: '有货', specs: ['27 英寸 4K IPS', 'USB-C 90W', 'HDR 400'], why: '4K 清晰度与办公接口都齐备。', tradeoff: '适合把屏幕素质放在首位的人。', url: 'https://www.amazon.com/s?k=Dell+U2723QE' },
  { id: 'lg-27ul550', title: 'LG 27UL550-W 27 英寸 4K 显示器', brand: 'LG', model: '27UL550-W', platform: 'Best Buy', tone: 'bestbuy', market: '美国 · US', nativePrice: 'USD 299.99', rmbPrice: 2157, fx: '1 USD = 7.1882 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '10 分钟前更新', rating: 4.5, reviews: 641, stock: '有货', specs: ['27 英寸 4K IPS', 'HDR 10', 'HDMI ×2'], why: '4K 门槛价最低，办公与观影都够用。', tradeoff: '适合预算优先的 4K 需求。', url: 'https://www.bestbuy.com/site/searchpage.jsp?st=LG+27UL550' },
  { id: 'dell-s2722qc', title: 'Dell S2722QC 27 英寸 4K USB-C 显示器', brand: 'Dell', model: 'S2722QC', platform: 'Lazada', tone: 'lazada', market: '新加坡 · SG', nativePrice: 'SGD 539.00', rmbPrice: 2861, fx: '1 SGD = 5.3083 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '15 分钟前更新', rating: 4.6, reviews: 512, stock: '库存有限', specs: ['27 英寸 4K IPS', 'USB-C 65W', 'HDR 400'], why: '4K + USB-C 一线连接，价格居中。', tradeoff: '适合笔记本一线连屏的用户。', url: 'https://www.lazada.sg/catalog/?q=Dell%20S2722QC' },
  { id: 'salomon-x-ultra-4', title: 'Salomon X Ultra 4 GTX 防水徒步鞋', brand: 'Salomon', model: 'X Ultra 4 GTX', platform: 'Amazon', tone: 'amazon', market: '美国 · US', nativePrice: 'USD 169.95', rmbPrice: 1222, fx: '1 USD = 7.1882 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '6 分钟前更新', rating: 4.7, reviews: 1108, stock: '有货', specs: ['GORE-TEX 防水', 'Contagrip 抓地', '轻量支撑'], why: '防水与抓地均衡，适合轻装徒步。', tradeoff: '适合大部分入门徒步路线。', url: 'https://www.amazon.com/s?k=Salomon+X+Ultra+4+GTX' },
  { id: 'merrell-moab-3', title: 'Merrell Moab 3 防水徒步鞋', brand: 'Merrell', model: 'Moab 3', platform: 'Lazada', tone: 'lazada', market: '新加坡 · SG', nativePrice: 'SGD 159.00', rmbPrice: 844, fx: '1 SGD = 5.3083 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '11 分钟前更新', rating: 4.6, reviews: 748, stock: '有货', specs: ['防水皮革', 'Vibram 鞋底', '缓震中底'], why: '价格亲民，缓震与透气兼顾。', tradeoff: '适合注重性价比的日常徒步。', url: 'https://www.lazada.sg/catalog/?q=Merrell%20Moab%203' },
  { id: 'columbia-crestwood', title: 'Columbia Crestwood 轻便徒步鞋', brand: 'Columbia', model: 'Crestwood', platform: 'Amazon', tone: 'amazon', market: '美国 · US', nativePrice: 'USD 99.95', rmbPrice: 719, fx: '1 USD = 7.1882 CNY', fxAsOf: '更新于 2026-08-15 14:32', updated: '19 分钟前更新', rating: 4.4, reviews: 2260, stock: '暂无库存信息', specs: ['抓地外底', '缓震中底', '轻量鞋身'], why: '同品类里商品参考价最低。', tradeoff: '适合预算优先的户外需求。', url: 'https://www.amazon.com/s?k=Columbia+Crestwood' },
]

function Icon({ name, size = 18 }: { name: IconName; size?: number }) { const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }; const paths: Record<IconName, ReactNode> = { back: <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>, arrow: <><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></>, check: <path d="m5 12 4 4L19 6" />, chevron: <path d="m6 9 6 6 6-6" />, close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>, external: <><path d="M14 5h5v5" /><path d="M10 14 19 5" /><path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" /></>, eye: <><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>, 'eye-off': <><path d="m4 4 16 16" /><path d="M10.6 5.4A9.8 9.8 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.8 17.8 0 0 1-2.8 3.4" /><path d="M6 6.5A17 17 0 0 0 2 12s3.5 6.5 10 6.5a9 9 0 0 0 4-.9" /><path d="M9.5 9.5a3 3 0 0 0 4 4.5" /></>, filter: <><path d="M4 6h16" /><path d="M7 12h10" /><path d="M10 18h4" /></>, grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>, headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="13" width="4" height="6" rx="1.5" /><rect x="17" y="13" width="4" height="6" rx="1.5" /></>, info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>, monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></>, plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>, search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>, shoe: <><path d="M3 16.5C3 15 4 14 5.5 13l5-2c2-.8 4-1.2 6-1.2h1.8L21 12c.7.4 1 1 1 1.6 0 1.4-1.2 2.4-3 2.4H5c-1.2 0-2-.7-2-1.5Z" /><path d="M14 10l1.5-3" /></>, spark: <path d="m12 3-1.5 5.5L5 10l5.5 1.5L12 17l1.5-5.5L19 10l-5.5-1.5L12 3Z" />, star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />, target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>, bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" /><path d="M10.3 21a2 2 0 0 0 3.4 0" /></>, download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>, edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>, heart: <path d="M12 20s-7-4.4-9.2-9A5.3 5.3 0 0 1 12 6.7 5.3 5.3 0 0 1 21.2 11C19 15.6 12 20 12 20Z" />, logout: <><path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>, settings: <><path d="M4 7h10" /><path d="M18 7h2" /><circle cx="16" cy="7" r="2" /><path d="M4 17h4" /><path d="M12 17h8" /><circle cx="10" cy="17" r="2" /></>, trash: <><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5" /><path d="M14 11v5" /></>, user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.6-3.4 3.5-5 7-5s6.4 1.6 7 5" /></> }; return <svg {...common}>{paths[name]}</svg> }
function Button({ children, onClick, icon, variant = 'secondary', disabled, type = 'button' }: { children: ReactNode; onClick?: () => void; icon?: IconName; variant?: 'primary' | 'secondary' | 'quiet'; disabled?: boolean; type?: 'button' | 'submit' }) { return <button className={`button button-${variant}`} type={type} onClick={onClick} disabled={disabled}>{children}{icon && <Icon name={icon} size={15} />}</button> }
const platformLogo: Record<string, string> = { amazon: amazonLogo, bestbuy: bestbuyLogo, lazada: lazadaLogo }
function Mark({ product }: { product: Product }) { return <span className={`platform-mark ${product.tone}`}><img src={platformLogo[product.tone]} alt={product.platform} /></span> }
function budgetText(mission: Mission) { return mission.budget ? `¥${mission.budget.toLocaleString()} 内` : '未设置预算' }
function preferenceText(preference: Preference) { return preference === 'battery' ? '优先续航' : preference === 'noise' ? '优先降噪' : preference === 'lowest' ? '按商品价' : '综合推荐' }
const FX_RATE: Record<Currency, number> = { RMB: 1, USD: 7.1882, SGD: 5.3083 }
const CURRENCY_SYMBOL: Record<Currency, string> = { RMB: '¥', USD: '$', SGD: 'S$' }
const CURRENCY_NAME: Record<Currency, string> = { RMB: '人民币', USD: '美元', SGD: '新加坡元' }
function priceIn(rmb: number, c: Currency) { return c === 'RMB' ? rmb : Math.round(rmb / FX_RATE[c]) }
const DAY = 86_400_000
const maskPhone = (phone: string) => phone.length >= 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone
const accountFavKey = (identifier: string) => `interecagent.favs.${identifier}`
function readFavs(key: string): string[] { try { const saved = localStorage.getItem(key); return saved ? JSON.parse(saved) as string[] : [] } catch { return [] } }
function loadSessionUser(): AccountUser | null { try { const saved = localStorage.getItem('interecagent.user'); const p = saved ? JSON.parse(saved) : null; if (!p || typeof p !== 'object') return null; const phone = typeof p.phone === 'string' ? p.phone : typeof p.email === 'string' ? p.email : ''; if (!phone) return null; const expiresAt = typeof p.expiresAt === 'number' ? p.expiresAt : Date.now() + 30 * DAY; if (expiresAt < Date.now()) { localStorage.removeItem('interecagent.user'); return null } return { phone, name: typeof p.name === 'string' ? p.name : `用户${phone.slice(-4)}`, provider: 'phone', memberSince: typeof p.memberSince === 'string' ? p.memberSince : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date()), createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(), expiresAt, remember: p.remember !== false } } catch { return null } }
type AuthTab = 'otp' | 'password'
type AuthFlow = 'login' | 'register' | 'reset'
const MIN_PW = 6
const USERS_KEY = 'interecagent.users'
type StoredUser = { name: string; passwordHash: string; createdAt: number }
function readUsers(): Record<string, StoredUser> { try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}') } catch { return {} } }
function writeUsers(next: Record<string, StoredUser>) { localStorage.setItem(USERS_KEY, JSON.stringify(next)) }
function hashPw(pw: string): string { let h = 5381; for (let i = 0; i < pw.length; i++) { h = ((h * 33) ^ pw.charCodeAt(i)) >>> 0 } return `h${h.toString(16)}` }
type ProductCategory = 'headphones' | 'monitors' | 'shoes'
function intentCategory(intent: string): ProductCategory | null { if (/(耳机|降噪|headphone)/i.test(intent)) return 'headphones'; if (/(显示器|monitor|4k|屏幕)/i.test(intent)) return 'monitors'; if (/(徒步鞋|运动鞋|跑鞋|登山鞋|鞋)/i.test(intent)) return 'shoes'; return null }
function productCategory(product: Product): ProductCategory { return /(sony-xm5|bose-qc-ultra|sennheiser-m4|soundcore-q45)/.test(product.id) ? 'headphones' : /(显示器|monitor)/i.test(product.title) ? 'monitors' : 'shoes' }
const categoryIcon: Record<ProductCategory, IconName> = { headphones: 'headphones', monitors: 'monitor', shoes: 'shoe' }
function supportsIntent(intent: string) { return intentCategory(intent) !== null }
function supportsAudioPriorities(mission: Mission) { return intentCategory(mission.intent) === 'headphones' }
function stripBudget(text: string) { return text.replace(/(?:预算|不超过|到|改为)\s*[¥￥]?\s*\d{1,3}(?:,\d{3})*\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?/gi, '').replace(/[¥￥]\s*\d{1,3}(?:,\d{3})*\s*(?:元|块|人民币|rmb)?\s*(?:以内|之内)?/gi, '').replace(/\d{1,3}(?:,\d{3})*\s*(?:元|块|人民币|rmb)\s*(?:以内|之内)?/gi, '') }
function parseBudgetCNY(text: string) { const s = text.replace(/,/g, ''); const m = s.match(/(?:预算|不超过|到|改为)?\s*[¥￥]?\s*(\d{3,6})\s*(?:元|块|人民币|rmb)/i) ?? s.match(/[¥￥]\s*(\d{3,6})/) ?? s.match(/(?:预算|不超过|到|改为)\s*(\d{3,6})/); const n = m ? Number(m[1]) : NaN; return Number.isFinite(n) && n >= 100 ? n : undefined }
function extractIntent(text: string) { const trimmed = stripBudget(text).replace(/^(?:帮我找|帮我买|帮我挑|帮我|我想买|我要买|我要找|我想|想买|请帮我|给我|要买|买|找)\s*/gi, '').replace(/^一[副个台件双只]\s*/gi, '').replace(/优先\s*(续航|降噪)|只看有货|仅看有货|最低商品价|低价/gi, '').replace(/[，,。；;]+/g, ' ').trim(); return trimmed || '未命名购物任务' }
function parsePreference(text: string): Preference | null { return /优先\s*续航/.test(text) ? 'battery' : /优先\s*降噪/.test(text) ? 'noise' : /最低商品价|低价优先|价格优先/.test(text) ? 'lowest' : null }
function createMission(query: string, id: number, defaultPref: Preference): Mission { return { id, intent: extractIntent(query), budget: parseBudgetCNY(query), preference: parsePreference(query) ?? defaultPref, onlyInStock: /只看有货|仅看有货/.test(query), version: 1 } }
function phaseText(phase: TaskPhase, selected: string[]) { return phase === 'comparing' ? `比较中 · ${selected.length} 件` : selected.length ? `已选 ${selected.length} 件` : phase === 'shortlisting' ? '继续选择候选' : '查看候选' }
function nowText() { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()) }
function batteryHours(product: Product) { return Number(product.specs.find((spec) => spec.includes('续航'))?.match(/\d+/)?.[0] ?? 0) }
function candidatesFor(mission: Mission) { const category = intentCategory(mission.intent); let list = category ? products.filter((product) => productCategory(product) === category) : []; if (mission.onlyInStock) list = list.filter((product) => product.stock === '有货'); return list.sort((a, b) => { if (category === 'headphones' && mission.preference === 'battery') return batteryHours(b) - batteryHours(a) || a.rmbPrice - b.rmbPrice; if (category === 'headphones' && mission.preference === 'noise') return Number(b.brand === 'Bose') - Number(a.brand === 'Bose') || a.rmbPrice - b.rmbPrice; if (mission.preference === 'lowest') return a.rmbPrice - b.rmbPrice; const budget = mission.budget; const aBudget = budget !== undefined ? Number(a.rmbPrice > budget) : 0; const bBudget = budget !== undefined ? Number(b.rmbPrice > budget) : 0; return aBudget - bBudget || b.rating - a.rating }) }
function eligibleFor(mission: Mission) { const candidates = candidatesFor(mission); const budget = mission.budget; return budget !== undefined ? candidates.filter((product) => product.rmbPrice <= budget) : candidates }

function Header({ view, go, user, openLogin, openAccount, activeTask, onSwitch, currency, onCurrency }: { view: View; go: (view: View) => void; user: AccountUser | null; openLogin: () => void; openAccount: () => void; activeTask?: ShoppingTask; onSwitch: () => void; currency: Currency; onCurrency: () => void }) { return <header className="topbar"><button className="brand-lockup" onClick={() => go('home')}><span className="brand-mark">ir</span><span><strong>跨境选物台</strong><small>跨平台商品价比较</small></span></button><nav className="main-nav"><button className={view === 'home' ? 'is-active' : ''} onClick={() => go('home')}><Icon name="plus" size={15} />新建任务</button><button className={view === 'tasks' || view === 'discover' || view === 'compare' ? 'is-active' : ''} onClick={() => go('tasks')}><Icon name="spark" size={15} />我的任务</button>{user && activeTask && <><span className="nav-divider" aria-hidden="true" /><button className="topbar-task-chip" onClick={onSwitch}><span>当前任务</span><strong>{activeTask.mission.intent}</strong><Icon name="chevron" size={14} /></button></>}</nav><div className="topbar-actions"><button className="currency-link" onClick={onCurrency} aria-label="比较货币"><b>{currency}</b><Icon name="chevron" size={12} /></button></div>{user ? <button className="account-pill" onClick={openAccount} aria-label="账号与偏好"><span className="avatar-badge">{user.name.slice(0, 1)}</span><span className="account-pill-name">{user.name}</span><Icon name="chevron" size={13} /></button> : <button className="account-link" onClick={openLogin}><Icon name="user" size={15} />登录</button>}</header> }
function Home({ start }: { start: (query: string) => void }) { const [query, setQuery] = useState('帮我找一副适合通勤的降噪耳机，预算 2500 元以内'); const prompts = ['适合远程办公的 27 寸 4K 显示器，¥3,000 以内', '送给爸爸的轻便徒步鞋，¥1,000 以内', '降噪耳机，¥2,000 以内，优先续航']; return <main className="home-view"><div className="home-hero"><h1>想买什么？</h1><p>耳机、27 寸 4K 显示器和轻便徒步鞋均可比较。告诉我用途、预算和偏好，我会整理不同平台的商品价与证据。</p></div><form className="mission-composer" onSubmit={(event) => { event.preventDefault(); start(query) }}><div className="composer-label">描述你的需求</div><textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} aria-label="描述购物需求" /><div className="composer-footer"><span>商品价换算为 RMB；运费与税费以商户结算页为准</span><Button variant="primary" type="submit" icon="arrow" disabled={!query.trim()}>开始比较</Button></div></form><div className="prompt-row"><span>试试这样说</span>{prompts.map((prompt) => <button key={prompt} type="button" onClick={() => setQuery(prompt)}>{prompt}</button>)}</div><section className="home-preview" aria-label="比较示意"><div className="preview-heading"><span>比较示意</span><strong>通勤降噪耳机 · ¥2,500 内</strong><small>商品价估算 · 未含运费与税费</small></div><div className="preview-fx"><span>汇率基准</span><b>USD</b> 7.1882 <b>SGD</b> 5.3083 <em>更新于 14:32</em></div><div className="preview-rows" aria-label="示例比较结果"><div className="preview-row"><span className="platform-mark amazon"><img src={amazonLogo} alt="Amazon" /></span><b>Amazon US</b><strong>USD 299</strong><em>约 ¥2,149</em></div><div className="preview-row"><span className="platform-mark lazada"><img src={lazadaLogo} alt="Lazada" /></span><b>Lazada SG</b><strong>SGD 399</strong><em>约 ¥2,118</em></div><div className="preview-row"><span className="platform-mark bestbuy"><img src={bestbuyLogo} alt="Best Buy" /></span><b>Best Buy US</b><strong>USD 329</strong><em>约 ¥2,368</em></div></div><div className="preview-foot"><span>已统一商品价口径，可继续比较规格与评价</span><span>费用以商户结算页为准</span></div></section></main> }
function PriceEvidence({ product, compact = false, lowest = false, currency = 'RMB' }: { product: Product; compact?: boolean; lowest?: boolean; currency?: Currency }) { const amount = priceIn(product.rmbPrice, currency); return <div className={`price-evidence ${compact ? 'compact' : ''}${lowest ? ' is-lowest' : ''}`}><div><strong>{CURRENCY_SYMBOL[currency]}{amount.toLocaleString()}</strong><span>{product.nativePrice}</span></div><small>{product.fx} · {product.fxAsOf}</small><small>{compact ? '商品价估算 · 运费与税费待商户结算确认' : `${product.updated} · 商品价估算，运费与税费以商户结算页为准`}</small></div> }
function Brief({ mission }: { mission: Mission }) { return <section className="mission-brief" aria-label="当前任务条件"><div className="brief-filters"><span className="brief-condition brief-condition-primary">{mission.intent}</span><span className="brief-condition">预算 {budgetText(mission)}</span><span className="brief-condition">{preferenceText(mission.preference)}</span>{mission.onlyInStock && <span className="brief-condition">仅看有货</span>}</div></section> }
function EvidenceStrip({ candidates }: { candidates: Product[] }) { if (!candidates.length) return null; const sources = [...new Set(candidates.map((product) => `${product.platform} ${product.market.split('·')[1]?.trim() ?? ''}`))].join('、'); return <section className="evidence-strip"><div><Icon name="search" size={15} /><span><b>已检索</b> {sources}</span></div><div><Icon name="info" size={15} /><span><b>价格口径</b> 商品价估算；运费与税费未计入</span></div></section> }
function fxRatesFor(candidates: Product[]) { const map = new Map<string, string>(); for (const p of candidates) { const m = p.fx.match(/([A-Z]{3})\s*=\s*([\d.]+)/); if (m && !map.has(m[1])) map.set(m[1], m[2]) } return [...map.entries()] }
function FxStrip({ candidates }: { candidates: Product[] }) { if (!candidates.length) return null; const rates = fxRatesFor(candidates); const asOf = candidates[0].fxAsOf.match(/\d{2}:\d{2}/)?.[0]; return <div className="fx-strip"><span className="fx-strip-label">汇率基准</span>{rates.map(([code, rate]) => <span className="fx-rate" key={code}><b>{code}</b>{rate}</span>)}<span className="fx-strip-asof">更新于 {asOf}</span></div> }
function ChangeSummary({ change, undo }: { change: ChangeRecord | null; undo: () => void }) { if (!change) return null; return <section className="change-summary" aria-live="polite"><div><strong>本次变更</strong><p>{change.summary} · 候选 {change.resultBefore} → {change.resultAfter}</p></div><button onClick={undo}>撤销本次修改</button></section> }

function Conversation({ mission, apply, compare, canCompare, comparing = false, messages, append, latestChange, undo }: { mission: Mission; apply: (delta: Partial<Mission>, summary: string) => void; compare: () => void; canCompare: boolean; comparing?: boolean; messages: Message[]; append: (items: Message[]) => void; latestChange: ChangeRecord | null; undo: () => void }) {
  const [draft, setDraft] = useState('')
  const action = (name: string) => {
    if (name === '比较已选候选') { if (canCompare) compare(); else append([{ id: String(Date.now()), role: 'agent', text: '先加入两件候选，再开始对比。' }]); return }
    const preference: Preference = name === '优先降噪' ? 'noise' : name === '优先续航' ? 'battery' : name === '按商品价排序' ? 'lowest' : 'balanced'
    apply({ preference }, `排序：${preferenceText(preference)}`)
    append([{ id: `u-${Date.now()}`, role: 'user', text: name }, { id: `a-${Date.now()}`, role: 'agent', text: `已将推荐依据改为“${preferenceText(preference)}”。价格仍是商品价估算，运费和税费请以商户结算页为准。` }])
  }
  const submit = (event?: FormEvent) => {
    event?.preventDefault(); const text = draft.trim(); if (!text) return
    const budget = parseBudgetCNY(text); const onlyInStock = /只看有货|仅看有货/.test(text); const preference = parsePreference(text)
    const requestedIntent = extractIntent(text); const explicitIntent = /(?:换成|改找|我想买|帮我找|找一[副个台件]|显示器|徒步鞋|耳机)/.test(text) && supportsIntent(requestedIntent)
    const delta: Partial<Mission> = {}; const parts: string[] = []
    if (budget) { delta.budget = budget; parts.push(`预算 ¥${budget.toLocaleString()} 内`) }
    if (onlyInStock) { delta.onlyInStock = true; parts.push('仅看有货') }
    if (preference) { delta.preference = preference; parts.push(`排序：${preferenceText(preference)}`) }
    if (explicitIntent) { delta.intent = requestedIntent; if (!supportsAudioPriorities({ ...mission, intent: requestedIntent })) delta.preference = preference === 'battery' || preference === 'noise' ? 'balanced' : preference ?? 'balanced'; parts.push(`商品：${requestedIntent}`) }
    append([{ id: `u-${Date.now()}`, role: 'user', text }])
    if (parts.length) { apply(delta, parts.join(' · ')); append([{ id: `a-${Date.now()}`, role: 'agent', text: `已更新${parts.join('、')}。我只会按已识别的条件重排；商品价均未包含运费和税费。` }]) }
    else append([{ id: `a-${Date.now()}`, role: 'agent', text: `我还不能用“${text}”改变排序，因为当前候选没有对应的可比字段。你可以调整预算、库存、商品类别，或选择可用的排序条件。` }])
    setDraft('')
  }
  const audioActions = supportsAudioPriorities(mission) ? ['优先降噪', '优先续航', '先看综合推荐'] : ['按商品价排序', '先看综合推荐']
  return <aside className={`conversation-panel ${messages.length <= 1 ? 'is-brief' : ''}`}><div className="conversation-header"><div><span>选购助手</span></div></div><Brief mission={mission} /><ChangeSummary change={latestChange} undo={undo} /><div className="conversation-thread" aria-label="任务对话">{messages.map((message) => <div className={`conversation-message ${message.role}`} key={message.id}><div className="message-meta">{message.role === 'user' ? '你' : '选购助手'}</div><p>{message.text}</p>{message.actions && <div className="message-actions">{message.actions.map((name) => <button key={name} onClick={() => action(name)}>{name}</button>)}</div>}</div>)}</div><div className="conversation-suggestions">{audioActions.map((name) => <button key={name} onClick={() => action(name)}>{name}</button>)}<button onClick={() => apply({ onlyInStock: !mission.onlyInStock }, mission.onlyInStock ? '库存：显示全部' : '库存：仅看有货')}>{mission.onlyInStock ? '显示全部库存' : '只看有货'}</button>{!comparing && <button onClick={() => action('比较已选候选')}>对比已选</button>}</div><form className="conversation-composer" onSubmit={submit}><textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="例如：预算改为 ¥2000，或只看有货" aria-label="选购对话输入" /><div className="composer-row"><button className="send-button" disabled={!draft.trim()} aria-label="发送"><Icon name="arrow" size={16} /></button></div></form></aside>
}
function CandidateCard({ product, rank, selected, toggle, detail, budget, preference, lowest = false, currency = 'RMB' }: { product: Product; rank: number; selected: boolean; toggle: () => void; detail: () => void; budget?: number; preference: Preference; lowest?: boolean; currency?: Currency }) {
  const reason = preference === 'battery' && batteryHours(product) ? `续航 ${batteryHours(product)} 小时${product.id === 'sennheiser-m4' ? '，当前候选中最长。' : '。'}` : preference === 'noise' && product.brand === 'Bose' ? '降噪取向与当前偏好一致。' : preference === 'lowest' ? '当前按商品参考价由低至高排列。' : product.why
  return <article className={`product-card evidence-card ${selected ? 'is-selected' : ''}`}>
    <span className="candidate-rank">{String(rank).padStart(2, '0')}</span>
    <button className="product-image-button" onClick={detail}><div className={`product-image tone-${product.tone}`}><span className="category-icon" aria-hidden="true"><Icon name={categoryIcon[productCategory(product)]} size={42} /></span><span className="image-tag">{product.stock}</span></div></button>
    <div className="product-card-body"><div className="product-source"><span><Mark product={product} /> {product.platform}</span><span>{product.market}</span></div><button className="product-title" onClick={detail}>{product.title}</button><div className="rating-line"><span className="stars"><Icon name="star" size={13} /> {product.rating}</span><span>{product.reviews.toLocaleString()} 条评价</span></div><PriceEvidence product={product} compact lowest={lowest} currency={currency} /><div className="spec-line">{product.specs.slice(0, 2).map((spec) => <span key={spec}>{spec}</span>)}</div><p className="candidate-reason"><b>为什么排在这里</b>{reason}</p>{budget && product.rmbPrice > budget && <p className="budget-warning">超出预算 ¥{(product.rmbPrice - budget).toLocaleString()}</p>}<div className="card-bottom"><span className={product.stock === '有货' ? 'stock confirmed' : 'stock pending'}>{product.stock}</span><Button variant={selected ? 'primary' : 'secondary'} onClick={toggle} icon={selected ? 'check' : 'plus'}>{selected ? '已加入候选' : '加入候选'}</Button></div></div>
  </article>
}
function Decision({ candidates, mission }: { candidates: Product[]; mission: Mission }) { const product = candidates[0]; if (!product) return null; const explanation = mission.preference === 'battery' && batteryHours(product) ? `续航 ${batteryHours(product)} 小时，是当前可推荐候选中最长的。` : mission.preference === 'noise' && product.brand === 'Bose' ? '它的降噪取向与当前偏好最一致。' : mission.preference === 'lowest' ? '它是当前可推荐候选中商品参考价最低的一件。' : product.why; return <section className="decision-card"><div className="decision-icon"><Icon name="spark" size={20} /></div><div><span>当前推荐</span><h2>{product.brand} {product.model}</h2><p>{explanation} {product.tradeoff}</p><div className="decision-tags">{[mission.budget ? '商品价在预算内' : '未设置预算', mission.onlyInStock ? '当前有货' : '库存已列出', preferenceText(mission.preference)].map((tag) => <span key={tag}>{tag}</span>)}</div></div></section> }
function Discover({ mission, apply, selectedIds, toggle, compare, detail, messages, append, latestChange, undo, currency }: { mission: Mission; apply: (delta: Partial<Mission>, summary: string) => void; selectedIds: string[]; toggle: (id: string) => void; compare: () => void; detail: (product: Product) => void; messages: Message[]; append: (items: Message[]) => void; latestChange: ChangeRecord | null; undo: () => void; currency: Currency }) {
  const candidates = useMemo(() => candidatesFor(mission), [mission])
  const recommended = useMemo(() => eligibleFor(mission), [mission])
  const lowestId = candidates.length ? candidates.reduce((a, b) => a.rmbPrice <= b.rmbPrice ? a : b).id : ''
  const selected = products.filter((product) => selectedIds.includes(product.id))
  const platformCount = new Set(candidates.map((product) => product.platform)).size
  const unsupported = !supportsIntent(mission.intent)
  const hasTemporaryFilters = mission.preference !== 'balanced' || mission.onlyInStock
  const resetFilters = () => apply({ preference: 'balanced', onlyInStock: false }, '已重置筛选与排序')

  return (
    <main className="workspace-view">
      <div className="mission-header">
        <div>
          <div className="breadcrumb">我的任务 <Icon name="chevron" size={13} />推荐候选</div>
          <h1>{mission.intent}</h1>
          <div className="mission-subline"><span>{candidates.length ? '候选已就绪' : '等待补充条件'}</span>{candidates.length > 0 && <span>{candidates.length} 个候选{candidates.length === 1 ? '' : ` · ${platformCount} 个平台`}</span>}</div>
        </div>
      </div>
      <FxStrip candidates={candidates} />
      <div className="workspace-layout">
        <Conversation mission={mission} apply={apply} compare={compare} canCompare={selected.length >= 2} messages={messages} append={append} latestChange={latestChange} undo={undo} />
        <section className="results-region">
          <EvidenceStrip candidates={candidates} />
          {unsupported ? (
            <section className="empty-result">
              <Icon name="search" size={24} />
              <h2>暂未找到可比较的商品</h2>
              <p>目前可比较耳机、27 寸 4K 显示器和轻便徒步鞋。请修改商品描述后继续。</p>
              <Button onClick={() => apply({ intent: '通勤降噪耳机' }, '商品：通勤降噪耳机')}>查看耳机候选</Button>
            </section>
          ) : (
            <>
              {recommended.length ? (
                <Decision candidates={recommended} mission={mission} />
              ) : (
                <section className="empty-result">
                  <Icon name="search" size={24} />
                  <h2>预算内暂无符合条件的候选</h2>
                  <p>候选已按当前条件展示；可以提高预算、调整偏好或显示全部库存。</p>
                  <Button onClick={() => apply({ onlyInStock: false }, '库存：显示全部')}>显示全部库存</Button>
                </section>
              )}
              <div className="filter-bar">
                <div className="result-count"><strong>{candidates.length}</strong> 个候选 {platformCount > 0 && <span>· {platformCount} 个平台</span>}</div>
                <div className="filter-actions">
                  <button onClick={() => apply({ onlyInStock: !mission.onlyInStock }, mission.onlyInStock ? '库存：显示全部' : '库存：仅看有货')}><Icon name="filter" size={15} />{mission.onlyInStock ? '显示全部库存' : '只看有货'}</button>
                  <select value={mission.preference} onChange={(event) => apply({ preference: event.target.value as Preference }, `排序：${preferenceText(event.target.value as Preference)}`)} aria-label="候选排序">
                    <option value="balanced">综合推荐</option>
                    <option value="lowest">按商品价</option>
                    {supportsAudioPriorities(mission) && <><option value="noise">优先降噪</option><option value="battery">优先续航</option></>}
                  </select>
                  {mission.preference !== 'balanced' && <button className="active-filter-chip" onClick={() => apply({ preference: 'balanced' }, '排序：综合推荐')} aria-label={`移除${preferenceText(mission.preference)}排序`}>{preferenceText(mission.preference)} <Icon name="close" size={13} /></button>}
                  {mission.onlyInStock && <button className="active-filter-chip" onClick={() => apply({ onlyInStock: false }, '库存：显示全部')} aria-label="移除仅看有货筛选">只看有货 <Icon name="close" size={13} /></button>}
                  {hasTemporaryFilters && <><span className="filter-divider" aria-hidden="true" /><button className="clear-filters-button" onClick={resetFilters} title="恢复为综合推荐，并显示全部库存；不会修改商品需求、预算或已选候选">清除筛选</button></>}
                </div>
              </div>
              <section className="product-results">
                <div className="products-grid">
                  {candidates.map((product, index) => <CandidateCard key={product.id} product={product} rank={index + 1} selected={selectedIds.includes(product.id)} toggle={() => toggle(product.id)} detail={() => detail(product)} budget={mission.budget} preference={mission.preference} lowest={product.id === lowestId} currency={currency} />)}
                </div>
              </section>
            </>
          )}
        </section>
      </div>
      {selected.length > 0 && <div className="compare-tray">
        <div><span className="tray-count">{selected.length}</span><strong>已选候选</strong><small>最多 5 件</small></div>
        <div className="tray-items">{selected.map((product) => <button key={product.id} onClick={() => toggle(product.id)}>{product.brand} · 约 ¥{product.rmbPrice.toLocaleString()} <Icon name="close" size={13} /></button>)}</div>
        <Button variant="primary" onClick={compare} disabled={selected.length < 2} icon="arrow">开始对比</Button>
      </div>}
    </main>
  )
}
function Compare({ mission, selectedIds, back, detail, apply, onRemove, messages, append, latestChange, undo, currency }: { mission: Mission; selectedIds: string[]; back: () => void; detail: (product: Product) => void; apply: (delta: Partial<Mission>, summary: string) => void; onRemove: (id: string) => void; messages: Message[]; append: (items: Message[]) => void; latestChange: ChangeRecord | null; undo: () => void; currency: Currency }) {
  const items = products.filter((product) => selectedIds.includes(product.id))
  const lowestId = items.length ? items.reduce((a, b) => a.rmbPrice <= b.rmbPrice ? a : b).id : ''
  if (items.length < 2) return <main className="workspace-view"><section className="empty-result"><Icon name="grid" size={24} /><h2>还需要至少 2 件候选</h2><p>先在候选页加入商品，再进行横向比较。</p><Button variant="primary" onClick={back}>返回候选页</Button></section></main>
  const lead = candidatesFor(mission).filter((product) => selectedIds.includes(product.id))[0]
  const explanation = mission.preference === 'battery' && batteryHours(lead) ? `续航 ${batteryHours(lead)} 小时，是已选商品中最长的。` : mission.preference === 'noise' && lead.brand === 'Bose' ? '降噪取向与当前偏好最一致。' : `商品参考价约 ¥${lead.rmbPrice.toLocaleString()}，是已选商品中更低的一件。`
  const tableStyle = { gridTemplateColumns: `128px repeat(${items.length}, minmax(205px, 1fr))` }
  return <main className="workspace-view compare-view"><div className="mission-header"><div><div className="breadcrumb"><button onClick={back}>推荐候选</button><Icon name="chevron" size={13} />对比选择</div><h1>在 {items.length} 个候选中做决定</h1><div className="mission-meta"><span>任务 V{mission.version}</span><span>继续提问可更新推荐</span></div></div><button className="button button-quiet" onClick={back}><Icon name="back" size={15} />再挑候选</button></div><FxStrip candidates={items} /><div className="workspace-layout"><Conversation mission={mission} apply={apply} compare={() => {}} canCompare={true} comparing messages={messages} append={append} latestChange={latestChange} undo={undo} /><section className="results-region"><section className="decision-card compare-decision"><div className="decision-icon"><Icon name="spark" size={20} /></div><div><span>当前推荐</span><h2>{lead.brand} {lead.model}</h2><p>{explanation}</p><small className="decision-boundary">推荐基于商品价与可见规格；运费、税费和配送资格请在商户结算页确认。</small></div></section><EvidenceStrip candidates={items} /><section className="comparison-table-wrap"><div className="table-toolbar"><span>已选商品对比</span><span>{items.length >= 4 ? '左右拖动查看全部 · ' : ''}商品价估算，运费与税费以商户结算页为准</span></div><div className="comparison-table revised-table" style={tableStyle}><div className="comparison-label-column"><div>候选</div><div>商品价</div><div>规格</div><div>库存</div><div>适合谁</div><div>操作</div></div>{items.map((product) => <div className={`comparison-product ${product.id === lead.id ? 'is-recommended' : ''}`} key={product.id}><div className="comparison-product-head">{product.id === lead.id && <span className="compare-tag">当前推荐</span>}<Mark product={product} /><button onClick={() => detail(product)}>{product.title}<Icon name="external" size={13} /></button><button className="column-remove" onClick={() => onRemove(product.id)} aria-label={`移除 ${product.brand}`} title="移出对比"><Icon name="close" size={13} /></button></div><div className="compare-cell"><PriceEvidence product={product} compact lowest={product.id === lowestId} currency={currency} /></div><div className="compare-cell specs-cell">{product.specs.map((spec) => <span key={spec}>{spec}</span>)}</div><div className="compare-cell"><span className={product.stock === '有货' ? 'confirmed' : 'pending'}>{product.stock}</span></div><div className="compare-cell"><span>{product.tradeoff}</span></div><div className="compare-cell action-cell"><Button onClick={() => detail(product)}>查看详情</Button></div></div>)}</div></section></section></div></main>
}
function Drawer({ product, selected, close, toggle, signedIn, favorite, onFavorite, currency }: { product: Product; selected: boolean; close: () => void; toggle: () => void; signedIn: boolean; favorite: boolean; onFavorite: () => void; currency: Currency }) { const domain = new URL(product.url).hostname; return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><aside className="product-drawer" aria-label="商品详情"><div className="drawer-top"><span>商品详情</span><button className="icon-button" onClick={close} aria-label="关闭"><Icon name="close" size={18} /></button></div><div className={`drawer-image tone-${product.tone}`}><span className="category-icon" aria-hidden="true"><Icon name={categoryIcon[productCategory(product)]} size={56} /></span></div><div className="drawer-body"><div className="product-source"><span><Mark product={product} /> {product.platform}</span><span>{product.market}</span></div><h2>{product.title}</h2><PriceEvidence product={product} currency={currency} /><section className="drawer-section"><div className="section-title">商品信息</div><div className="spec-pills">{product.specs.map((spec) => <span key={spec}>{spec}</span>)}</div><p className="drawer-description">评分 {product.rating} · {product.reviews.toLocaleString()} 条评价 · 库存：{product.stock} · {product.updated}</p></section><section className="purchase-check"><span>查看商户报价</span><p>本服务只负责比较；{domain} 将提供商品详情与交易。</p><a className="button button-primary merchant-link" href={product.url} target="_blank" rel="noreferrer">前往 {product.platform} 查看<Icon name="external" size={15} /></a><small>商品价以商户页面为准。</small></section></div><div className="drawer-footer"><Button variant={favorite ? 'primary' : 'secondary'} onClick={onFavorite} icon={favorite ? 'check' : 'heart'}>{!signedIn ? '登录后收藏' : favorite ? '已收藏' : '收藏'}</Button><Button variant={selected ? 'primary' : 'secondary'} onClick={toggle}>{selected ? '已加入候选' : '加入候选'}</Button><Button variant="quiet" onClick={close}>返回任务</Button></div></aside></div> }
function LoginModal({ onClose, onLogin, initialFlow = 'login', initialPhone = '' }: { onClose: () => void; onLogin: (user: AccountUser) => void; initialFlow?: AuthFlow; initialPhone?: string }) {
  const [flow, setFlow] = useState<AuthFlow>(initialFlow)
  const [tab, setTab] = useState<AuthTab>('otp')
  const [phone, setPhone] = useState(initialPhone)
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [nickname, setNickname] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [showAgreement, setShowAgreement] = useState(false)
  const [step, setStep] = useState<'ident' | 'code'>('ident')
  const [code, setCode] = useState('')
  const [sentCode, setSentCode] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [attemptsLeft, setAttemptsLeft] = useState(5)
  const [locked, setLocked] = useState(false)
  const [expired, setExpired] = useState(false)
  const [resendIn, setResendIn] = useState(0)
  const [expiresIn, setExpiresIn] = useState(0)
  const [smsCard, setSmsCard] = useState<{ to: string; code: string } | null>(null)
  const [remember, setRemember] = useState(true)
  useEffect(() => {
    if (step !== 'code' || locked || expired) return
    const timer = window.setInterval(() => { setResendIn((s) => Math.max(0, s - 1)); setExpiresIn((s) => s - 1) }, 1000)
    return () => window.clearInterval(timer)
  }, [step, locked, expired])
  useEffect(() => { if (step === 'code' && !expired && expiresIn <= 0) { setExpired(true); setCodeError('验证码已过期，请重新获取。') } }, [step, expired, expiresIn])
  const clock = (s: number) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.max(0, s) % 60).padStart(2, '0')}`
  const deliver = (number: string) => { const next = String(Math.floor(100000 + Math.random() * 900000)); setSentCode(next); setSmsCard({ to: number, code: next }); setCode(''); setCodeError(null); setAttemptsLeft(5); setLocked(false); setExpired(false); setResendIn(60); setExpiresIn(300) }
  const finish = (number: string, name: string) => { onLogin({ phone: number, name, provider: 'phone', memberSince: new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date()), createdAt: Date.now(), expiresAt: Date.now() + (remember ? 30 * DAY : DAY), remember }) }
  const resetTransient = () => { setStep('ident'); setCode(''); setCodeError(null); setPwError(null); setPhoneError(null); setMismatch(false); setSentCode(''); setAttemptsLeft(5); setLocked(false); setExpired(false); setResendIn(0); setExpiresIn(0); setSmsCard(null); setPassword(''); setConfirm(''); setNickname(''); setShowPw(false) }
  const goto = (next: AuthFlow) => { if (next === flow) return; resetTransient(); setFlow(next) }
  const switchTab = (next: AuthTab) => { if (tab === next) return; resetTransient(); setTab(next) }
  const sendOtp = (number: string) => {
    if (!/^1[3-9]\d{9}$/.test(number)) { setPhoneError('请输入有效的手机号'); return }
    if ((flow === 'login' || flow === 'register') && !agreed) { setPhoneError('请先阅读并同意《用户协议》与《隐私政策》'); return }
    setPhoneError(null); setSending(true)
    window.setTimeout(() => { setSentTo(number); setStep('code'); deliver(number); setSending(false) }, 700)
  }
  const submitOtp = () => {
    if (locked || expired) return
    if (code.trim().length !== 6) { setCodeError('请输入 6 位验证码'); return }
    setVerifying(true); setCodeError(null)
    window.setTimeout(() => {
      if (code.trim() !== sentCode) {
        const left = attemptsLeft - 1; setAttemptsLeft(left); setCode('')
        setCodeError(left <= 0 ? '尝试次数过多，请重新获取验证码。' : `验证码错误，还可尝试 ${left} 次。`)
        if (left <= 0) setLocked(true)
        setVerifying(false); return
      }
      const users = readUsers()
      if (flow === 'register') {
        const name = nickname.trim() || `用户${sentTo.slice(-4)}`
        if (password.length < MIN_PW) { setPwError(`密码至少 ${MIN_PW} 位`); setVerifying(false); return }
        if (password !== confirm) { setPwError('两次输入的密码不一致'); setVerifying(false); return }
        writeUsers({ ...users, [sentTo]: { name, passwordHash: hashPw(password), createdAt: Date.now() } }); finish(sentTo, name)
      } else if (flow === 'reset') {
        const existing = users[sentTo]; const name = existing?.name ?? `用户${sentTo.slice(-4)}`
        if (password.length < MIN_PW) { setPwError(`密码至少 ${MIN_PW} 位`); setVerifying(false); return }
        if (password !== confirm) { setPwError('两次输入的密码不一致'); setVerifying(false); return }
        writeUsers({ ...users, [sentTo]: { name, passwordHash: hashPw(password), createdAt: existing?.createdAt ?? Date.now() } }); finish(sentTo, name)
      } else {
        const existing = users[sentTo]; const name = existing?.name ?? `用户${sentTo.slice(-4)}`
        if (!existing) writeUsers({ ...users, [sentTo]: { name, passwordHash: '', createdAt: Date.now() } })
        finish(sentTo, name)
      }
    }, 700)
  }
  const submitPassword = (number: string) => {
    if (!/^1[3-9]\d{9}$/.test(number)) { setPwError('请输入有效的手机号'); return }
    if (!password) { setPwError('请输入密码'); return }
    setPwError(null); setSubmitting(true)
    window.setTimeout(() => {
      const stored = readUsers()[number]
      if (!stored) { setMismatch(true); setPwError('该手机号尚未注册，请先注册。') }
      else if (!stored.passwordHash) { setMismatch(true); setPwError('该账号尚未设置密码，请先用验证码登录。') }
      else if (hashPw(password) !== stored.passwordHash) { setMismatch(true); setPwError('密码错误，请重试。') }
      else { setMismatch(false); finish(number, stored.name) }
      setSubmitting(false)
    }, 700)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const number = phone.replace(/\D/g, '').slice(0, 11)
    if (flow === 'login' && tab === 'password') { submitPassword(number); return }
    if (step === 'ident') { sendOtp(number); return }
    submitOtp()
  }
  const resend = () => { if (resendIn > 0 || sending) return; setSending(true); window.setTimeout(() => { deliver(sentTo); setSending(false) }, 700) }
  const heading = flow === 'register' ? '注册账号' : flow === 'reset' ? '重置密码' : '登录跨境选物台'
  const subtitle = step === 'ident' ? (flow === 'register' ? '绑定手机号，完成注册' : flow === 'reset' ? '验证码将发送到你的手机号' : tab === 'password' ? '使用手机号与密码登录' : '使用手机号验证码登录，无需设置密码') : `验证码已发送至 +86 ${maskPhone(sentTo)}`
  const phoneField = <div className="login-field"><label>手机号</label><div className="login-phone"><span className="login-phone-prefix">+86</span><input inputMode="tel" autoFocus value={phone} onChange={(event) => { setPhone(event.target.value.replace(/\D/g, '').slice(0, 11)); setPhoneError(null); setPwError(null); setMismatch(false) }} placeholder="请输入手机号" required /></div></div>
  const pwField = (label: string, value: string, set: (v: string) => void, placeholder: string) => <div className="login-field"><label>{label}</label><div className="login-pw"><input type={showPw ? 'text' : 'password'} value={value} onChange={(event) => { set(event.target.value); setPwError(null) }} placeholder={placeholder} autoComplete="off" /><button type="button" onClick={() => setShowPw(!showPw)} aria-label="显示或隐藏密码"><Icon name={showPw ? 'eye-off' : 'eye'} size={16} /></button></div></div>
  const codeField = <div className="login-field"><label>验证码</label><div className="login-code"><input inputMode="numeric" autoFocus value={code} onChange={(event) => { setCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setCodeError(null) }} placeholder="6 位数字" /><span className={`login-code-countdown ${expired ? 'is-expired' : ''}`}>{expired ? '已过期' : clock(expiresIn)}</span></div></div>
  const resendRow = <div className="login-resend">{resendIn > 0 ? <span>未收到？{resendIn} 秒后可重新发送</span> : <button type="button" onClick={resend} disabled={sending}>{sending ? '发送中…' : '重新发送验证码'}</button>}</div>
  const rememberRow = <label className="login-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>保持登录 30 天</span></label>
  const agreementPanel = <div className="login-agreement">跨境选物台仅将手机号、昵称用于账号恢复与个性化推荐，收藏与偏好可随账号找回；本服务不收集支付信息，验证码仅用于本次登录。</div>
  return <div className="login-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <form className="login-modal" onSubmit={submit}>
      <button type="button" className="icon-button login-close" onClick={onClose} aria-label="关闭"><Icon name="close" size={18} /></button>
      <aside className="login-brand">
        <div className="login-brand-head"><span className="login-brand-mark">ir</span><div><strong>跨境选物台</strong><small>跨平台商品价比较</small></div></div>
        <p className="login-brand-slogan">说清想买什么，我们跨平台比价，给出原价、汇率时间与商户链接的证据化推荐。</p>
        <ul className="login-brand-points"><li>跨平台聚合 · 多市场候选</li><li>人民币统一换算，保留原币种</li><li>推荐附原价、汇率时间与证据</li></ul>
        <p className="login-brand-foot">登录后同步收藏、偏好与价格提醒</p>
      </aside>
      <section className="login-form-panel">
      <div className="login-modal-head"><div><h2>{heading}</h2><p>{subtitle}</p></div></div>
      {flow === 'login' && <div className="auth-tabs"><button type="button" className={tab === 'otp' ? 'is-active' : ''} onClick={() => switchTab('otp')}>验证码登录</button><button type="button" className={tab === 'password' ? 'is-active' : ''} onClick={() => switchTab('password')}>密码登录</button></div>}
      {flow === 'login' && tab === 'password' && (
        <div className="login-form">
          {phoneField}
          {pwField('密码', password, setPassword, '请输入密码')}
          {pwError && <span className="login-error">{pwError}</span>}
          {mismatch && <div className="auth-links"><button type="button" onClick={() => goto('register')}>去注册</button><button type="button" onClick={() => goto('reset')}>用验证码设置密码</button></div>}
          <Button type="submit" variant="primary" disabled={!phone || !password || submitting}>{submitting ? '登录中…' : '登录'}</Button>
          <p className="login-agree-note">登录即代表你已阅读并同意<a onClick={(event) => { event.preventDefault(); setShowAgreement(!showAgreement) }}>《用户协议》</a>与<a onClick={(event) => { event.preventDefault(); setShowAgreement(!showAgreement) }}>《隐私政策》</a></p>
          {showAgreement && agreementPanel}
          <div className="auth-links"><button type="button" onClick={() => goto('register')}>新用户注册</button><button type="button" onClick={() => goto('reset')}>忘记密码</button></div>
        </div>
      )}
      {flow === 'login' && tab === 'otp' && step === 'ident' && (
        <div className="login-form">
          {phoneField}
          <div className="login-check"><input id="login-consent" type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><label htmlFor="login-consent">我已阅读并同意</label><a onClick={(event) => { event.preventDefault(); setShowAgreement(!showAgreement) }}>《用户协议》</a><span>与</span><a onClick={(event) => { event.preventDefault(); setShowAgreement(!showAgreement) }}>《隐私政策》</a></div>
          {showAgreement && agreementPanel}
          {phoneError && <span className="login-error">{phoneError}</span>}
          <Button type="submit" variant="primary" disabled={phone.replace(/\D/g, '').length !== 11 || !agreed || sending}>{sending ? '发送中…' : '获取验证码'}</Button>
        </div>
      )}
      {flow === 'login' && tab === 'otp' && step === 'code' && (
        <div className="login-form">
          {codeField}
          {resendRow}
          {codeError && <span className="login-error">{codeError}</span>}
          <Button type="submit" variant="primary" disabled={code.trim().length !== 6 || verifying || locked || expired}>{verifying ? '登录中…' : '登录'}</Button>
          {rememberRow}
        </div>
      )}
      {flow === 'register' && step === 'ident' && (
        <div className="login-form">
          {phoneField}
          <div className="login-check"><input id="reg-consent" type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><label htmlFor="reg-consent">我已阅读并同意</label><a onClick={(event) => { event.preventDefault(); setShowAgreement(!showAgreement) }}>《用户协议》</a><span>与</span><a onClick={(event) => { event.preventDefault(); setShowAgreement(!showAgreement) }}>《隐私政策》</a></div>
          {showAgreement && agreementPanel}
          {phoneError && <span className="login-error">{phoneError}</span>}
          <Button type="submit" variant="primary" disabled={phone.replace(/\D/g, '').length !== 11 || !agreed || sending}>{sending ? '发送中…' : '获取验证码'}</Button>
          <div className="auth-links"><button type="button" onClick={() => goto('login')}>返回登录</button></div>
        </div>
      )}
      {flow === 'register' && step === 'code' && (
        <div className="login-form">
          <div className="login-field"><label>昵称（可选）</label><input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder={`默认：用户${sentTo.slice(-4)}`} /></div>
          {codeField}
          {resendRow}
          {pwField('设置密码', password, setPassword, `至少 ${MIN_PW} 位`)}
          {pwField('确认密码', confirm, setConfirm, '再次输入密码')}
          {codeError && <span className="login-error">{codeError}</span>}
          {pwError && <span className="login-error">{pwError}</span>}
          <Button type="submit" variant="primary" disabled={code.trim().length !== 6 || !password || !confirm || verifying || locked || expired}>{verifying ? '提交中…' : '完成注册'}</Button>
          {rememberRow}
          <div className="auth-links"><button type="button" onClick={() => goto('login')}>返回登录</button></div>
        </div>
      )}
      {flow === 'reset' && step === 'ident' && (
        <div className="login-form">
          {phoneField}
          {phoneError && <span className="login-error">{phoneError}</span>}
          <Button type="submit" variant="primary" disabled={phone.replace(/\D/g, '').length !== 11 || sending}>{sending ? '发送中…' : '获取验证码'}</Button>
          <div className="auth-links"><button type="button" onClick={() => goto('login')}>返回登录</button></div>
        </div>
      )}
      {flow === 'reset' && step === 'code' && (
        <div className="login-form">
          {codeField}
          {resendRow}
          {pwField('新密码', password, setPassword, `至少 ${MIN_PW} 位`)}
          {pwField('确认新密码', confirm, setConfirm, '再次输入新密码')}
          {codeError && <span className="login-error">{codeError}</span>}
          {pwError && <span className="login-error">{pwError}</span>}
          <Button type="submit" variant="primary" disabled={code.trim().length !== 6 || !password || !confirm || verifying || locked || expired}>{verifying ? '提交中…' : '重置密码并登录'}</Button>
          {rememberRow}
          <div className="auth-links"><button type="button" onClick={() => goto('login')}>返回登录</button></div>
        </div>
      )}
      </section>
    </form>
    {smsCard && <div className="sms-toast" role="status"><div className="sms-toast-head"><span>短信</span><span className="sms-toast-sender">跨境选物台 · 1069 短信通道</span><button type="button" onClick={() => setSmsCard(null)} aria-label="关闭"><Icon name="close" size={14} /></button></div><div className="sms-toast-body"><div className="sms-toast-subject">登录验证码（+86 {maskPhone(smsCard.to)}）</div><div className="sms-toast-code">{smsCard.code}</div><small>验证码 5 分钟内有效，请勿转发给他人。</small></div></div>}
  </div>
}
function AccountDrawer({ user, onClose, onLogout, onRename, onExport, onDeleteAccount, onManagePassword, hasPassword, favorites, openProduct, defaultPreference, onDefaultPreference, currency }: { user: AccountUser; onClose: () => void; onLogout: () => void; onRename: (name: string) => void; onExport: () => void; onDeleteAccount: () => void; onManagePassword: () => void; hasPassword: boolean; favorites: Product[]; openProduct: (product: Product) => void; defaultPreference: Preference; onDefaultPreference: (preference: Preference) => void; currency: Currency }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(user.name)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const favItems = favorites.slice(0, 5)
  const expiresInDays = Math.max(0, Math.ceil((user.expiresAt - Date.now()) / DAY))
  const sessionText = user.remember ? `已保持登录 · 约 ${expiresInDays} 天后到期` : `本次会话 · 约 ${expiresInDays} 天后到期`
  const saveName = () => { const next = draft.trim(); if (next && next !== user.name) onRename(next); setEditing(false) }
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="account-drawer" aria-label="账号与偏好"><div className="account-head"><span>账号与偏好</span><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" size={18} /></button></div><div className="account-body"><div className="account-profile"><span className="avatar-large">{user.name.slice(0, 1)}</span><div className="account-profile-main">{editing ? <div className="account-name-edit"><input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus aria-label="昵称" /><button type="button" onClick={saveName}>保存</button><button type="button" onClick={() => { setEditing(false); setDraft(user.name) }}>取消</button></div> : <div className="account-name-row"><b>{user.name}</b><button className="icon-button" onClick={() => setEditing(true)} aria-label="编辑昵称"><Icon name="edit" size={14} /></button></div>}<p>+86 {maskPhone(user.phone)} · 手机号登录 · 加入于 {user.memberSince}</p></div></div><section className="account-section"><div className="section-title"><Icon name="settings" size={15} />偏好记忆</div><div className="account-row"><span className="account-row-label">新任务默认排序<small>未指定偏好时，新建任务沿用此排序依据</small></span><select className="account-select" value={defaultPreference} onChange={(event) => onDefaultPreference(event.target.value as Preference)} aria-label="新任务默认排序"><option value="balanced">综合推荐</option><option value="lowest">按商品价</option></select></div><div className="account-row"><span className="account-row-label">比较货币<small>价格按所选货币换算显示</small></span><span className="account-chip">{currency} · {CURRENCY_NAME[currency]}</span></div></section><section className="account-section"><div className="section-title"><Icon name="heart" size={15} />我的收藏</div>{favItems.length ? <div className="account-fav-list">{favItems.map((product) => <button key={product.id} className="account-fav" onClick={() => openProduct(product)}><Icon name="chevron" size={13} />{product.brand} {product.model} · 约 ¥{product.rmbPrice.toLocaleString()}</button>)}</div> : <p className="account-fav-empty">还没有收藏商品。在商品详情页点“收藏”，收藏会随账号保存。</p>}</section><section className="account-section"><div className="section-title"><Icon name="bell" size={15} />价格提醒</div><div className="account-row"><span className="account-row-label">人民币目标价 / 降价提醒<small>收藏后设置目标价，降价时通知你</small></span><span className="plan-badge">即将上线</span></div></section><section className="account-section"><div className="section-title"><Icon name="info" size={15} />安全与隐私</div><div className="account-row"><span className="account-row-label">当前会话<small>{sessionText}</small></span><span className="account-chip">{user.remember ? '保持登录' : '本次会话'}</span></div><div className="account-row"><span className="account-row-label">登录密码<small>{hasPassword ? '已设置，可用密码登录' : '未设置，仅支持验证码登录'}</small></span><button className="account-link-btn" onClick={onManagePassword}>{hasPassword ? '修改密码' : '设置密码'} <Icon name="edit" size={13} /></button></div><div className="account-row"><span className="account-row-label">协议与隐私</span><button className="account-link-btn" onClick={() => setShowPrivacy(!showPrivacy)}>《用户协议》《隐私政策》<Icon name="chevron" size={13} /></button></div>{showPrivacy && <div className="login-agreement">本服务仅保存手机号、昵称、收藏与偏好，用于账号恢复与个性化推荐；不收集支付信息，验证码仅用于本次登录。你可以随时导出或删除自己的数据。</div>}<div className="account-row"><span className="account-row-label">导出我的数据<small>下载账号信息、收藏、偏好与任务概览</small></span><button className="account-link-btn" onClick={onExport}>导出 <Icon name="download" size={13} /></button></div><div className="account-row">{confirmDelete ? <div className="account-delete-confirm"><span>确认删除？将清除账号收藏与偏好并退出登录。</span><button onClick={onDeleteAccount}>确认删除</button><button onClick={() => setConfirmDelete(false)}>取消</button></div> : <span className="account-row-label">删除账号<small>清除本账号的收藏与偏好，不可恢复</small></span>}{!confirmDelete && <button className="account-danger-btn" onClick={() => setConfirmDelete(true)}><Icon name="trash" size={13} />删除</button>}</div></section><button className="account-logout" onClick={onLogout}><Icon name="logout" size={15} />退出登录</button><p className="account-privacy">数据将按《隐私政策》处理；你可随时在“安全与隐私”中导出或删除自己的数据。</p></div></aside></div>
}
function TaskList({ tasks, activeId, open, create }: { tasks: ShoppingTask[]; activeId: number | null; open: (id: number) => void; create: () => void }) { return <main className="task-list-view"><div className="task-list-header"><div><h1>我的任务</h1><p>每个任务保留自己的对话、条件、候选与比较进度。</p></div><Button variant="primary" onClick={create} icon="plus">新建任务</Button></div>{tasks.length ? <section className="task-list" aria-label="已保存的选购任务">{tasks.map((task) => <button className={`task-list-item ${task.id === activeId ? 'is-current' : ''}`} key={task.id} onClick={() => open(task.id)}><div><strong>{task.mission.intent}</strong><p>{budgetText(task.mission)} · {preferenceText(task.mission.preference)}{task.mission.onlyInStock ? ' · 仅看有货' : ''}</p></div><div className="task-list-meta"><span>{task.id === activeId ? '当前处理' : phaseText(task.phase, task.selected)}</span><small>{task.updatedAt} 更新</small></div><Icon name="arrow" size={16} /></button>)}</section> : <section className="task-list-empty"><Icon name="spark" size={24} /><h2>还没有选购任务</h2><p>新建一个任务后，可以随时在这里继续对话和比较。</p><Button variant="primary" onClick={create}>新建任务</Button></section>}</main> }
function QuickSwitcher({ tasks, activeId, open, close, allTasks, create }: { tasks: ShoppingTask[]; activeId: number | null; open: (id: number) => void; close: () => void; allTasks: () => void; create: () => void }) { const [query, setQuery] = useState(''); const items = [...tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs).filter((task) => `${task.mission.intent} ${budgetText(task.mission)} ${preferenceText(task.mission.preference)}${task.mission.onlyInStock ? ' 仅看有货' : ''}`.includes(query.trim())); return <div className="switcher-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section className="task-switcher" role="dialog" aria-modal="true" aria-label="切换任务"><div className="switcher-heading"><div><strong>切换任务</strong><small>将恢复各任务上次的工作现场</small></div><button onClick={close} aria-label="关闭任务切换"><Icon name="close" size={16} /></button></div><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务名称、预算或偏好" aria-label="搜索任务" />{items.length ? <div className="switcher-list">{items.slice(0, 6).map((task) => <button className={task.id === activeId ? 'is-current' : ''} key={task.id} onClick={() => open(task.id)}><span><b>{task.mission.intent}</b><small>{budgetText(task.mission)} · {preferenceText(task.mission.preference)}{task.mission.onlyInStock ? ' · 仅看有货' : ''} · {task.updatedAt}</small></span>{task.id === activeId && <em>当前</em>}</button>)}</div> : <p className="switcher-empty">未找到匹配的任务</p>}<div className="switcher-footer"><button onClick={allTasks}>查看全部任务</button><button onClick={create}>新建任务</button></div></section></div> }
function CurrencyPicker({ currency, set, close }: { currency: Currency; set: (c: Currency) => void; close: () => void }) { const options: Currency[] = ['RMB', 'USD', 'SGD']; return <div className="currency-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section className="currency-popover" role="dialog" aria-label="比较货币"><div className="switcher-heading"><div><strong>比较货币</strong><small>价格按所选货币换算显示</small></div><button onClick={close} aria-label="关闭"><Icon name="close" size={16} /></button></div><div className="currency-list">{options.map((c) => <button className={c === currency ? 'is-current' : ''} key={c} onClick={() => { set(c); close() }}><b>{c}</b><small>{CURRENCY_NAME[c]} · {CURRENCY_SYMBOL[c]}</small>{c === currency && <em>当前</em>}</button>)}</div><p className="currency-note">商品价先统一换算为人民币，再按所选货币显示；运费与税费以商户结算页为准。</p></section></div> }
export default function App() {
  const [view, setView] = useState<View>('home')
  const [tasks, setTasks] = useState<ShoppingTask[]>(() => { try { const saved = localStorage.getItem('interecagent.tasks'); const parsed = saved ? JSON.parse(saved) : []; return Array.isArray(parsed) ? parsed.map((task) => ({ ...task, phase: task.phase ?? (task.selected?.length ? 'shortlisting' : 'collecting'), lastSurface: task.lastSurface ?? 'discover', createdAt: task.createdAt ?? task.updatedAt ?? nowText(), updatedAt: task.updatedAt ?? nowText(), updatedAtMs: task.updatedAtMs ?? task.id ?? Date.now() })) : [] } catch { return [] } })
  const [activeTaskId, setActiveTaskId] = useState<number | null>(() => { try { const saved = localStorage.getItem('interecagent.active-task'); return saved ? Number(saved) : null } catch { return null } })
  const [detail, setDetail] = useState<Product | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [user, setUser] = useState<AccountUser | null>(loadSessionUser)
  const [defaultPreference, setDefaultPreference] = useState<Preference>(() => { const saved = localStorage.getItem('interecagent.default-pref'); return saved === 'lowest' ? 'lowest' : 'balanced' })
  const [favorites, setFavorites] = useState<string[]>(() => { const u = loadSessionUser(); return readFavs(u ? accountFavKey(u.phone) : 'interecagent.favs') })
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginConfig, setLoginConfig] = useState<{ flow: AuthFlow; phone: string }>({ flow: 'login', phone: '' })
  const [accountOpen, setAccountOpen] = useState(false)
  const [currency, setCurrency] = useState<Currency>(() => { const saved = localStorage.getItem('interecagent.currency'); return saved === 'USD' || saved === 'SGD' ? saved : 'RMB' })
  const [currencyOpen, setCurrencyOpen] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const toastTimer = useRef<number | null>(null)
  const resumeRef = useRef<{ view?: View; query?: string } | null>(null)
  const activeTask = activeTaskId === null ? undefined : tasks.find((task) => task.id === activeTaskId)
  useEffect(() => { localStorage.setItem('interecagent.tasks', JSON.stringify(tasks)); if (activeTaskId !== null) localStorage.setItem('interecagent.active-task', String(activeTaskId)); else localStorage.removeItem('interecagent.active-task') }, [tasks, activeTaskId])
  useEffect(() => { if (user) localStorage.setItem('interecagent.user', JSON.stringify(user)); else localStorage.removeItem('interecagent.user'); localStorage.setItem('interecagent.default-pref', defaultPreference); localStorage.setItem('interecagent.currency', currency); localStorage.setItem(user ? accountFavKey(user.phone) : 'interecagent.favs', JSON.stringify(favorites)) }, [user, defaultPreference, favorites, currency])
  const updateActive = (update: (task: ShoppingTask) => ShoppingTask) => { if (!activeTask) return; setTasks((current) => current.map((task) => task.id === activeTask.id ? update(task) : task).sort((a, b) => b.updatedAtMs - a.updatedAtMs)) }
  const append = (items: Message[]) => updateActive((task) => ({ ...task, messages: [...task.messages, ...items], updatedAt: nowText(), updatedAtMs: Date.now() }))
  const apply = (delta: Partial<Mission>, summary: string) => updateActive((task) => { const before = task.mission; const next = { ...before, ...delta, version: before.version + 1 }; const selected = next.onlyInStock ? task.selected.filter((id) => products.find((product) => product.id === id)?.stock === '有货') : task.selected; return { ...task, mission: next, selected, phase: selected.length >= 2 && task.lastSurface === 'compare' ? 'comparing' : selected.length ? 'shortlisting' : 'collecting', updatedAt: nowText(), updatedAtMs: Date.now(), latestChange: { id: String(Date.now()), summary, before, selectedBefore: task.selected, resultBefore: candidatesFor(before).length, resultAfter: candidatesFor(next).length } } })
  const undo = () => { if (!activeTask?.latestChange) return; const change = activeTask.latestChange; updateActive((task) => ({ ...task, mission: change.before, selected: change.selectedBefore, phase: change.selectedBefore.length >= 2 && task.lastSurface === 'compare' ? 'comparing' : change.selectedBefore.length ? 'shortlisting' : 'collecting', latestChange: null, updatedAt: nowText(), updatedAtMs: Date.now(), messages: [...task.messages, { id: `undo-${Date.now()}`, role: 'agent', text: `已撤销“${change.summary}”，恢复之前的条件。` }] })) }
  const notify = (text: string) => { if (toastTimer.current) window.clearTimeout(toastTimer.current); const id = Date.now(); setToast({ id, text }); toastTimer.current = window.setTimeout(() => setToast(null), 2600) }
  const openLogin = () => { setLoginConfig({ flow: 'login', phone: '' }); setAccountOpen(false); setLoginOpen(true) }
  const openAccount = () => setAccountOpen(true)
  const openPassword = () => { setLoginConfig({ flow: 'reset', phone: user?.phone ?? '' }); setAccountOpen(false); setLoginOpen(true) }
  const login = (next: AccountUser) => { const merged = [...new Set([...readFavs(accountFavKey(next.phone)), ...readFavs('interecagent.favs'), ...favorites])]; localStorage.removeItem('interecagent.favs'); localStorage.setItem(accountFavKey(next.phone), JSON.stringify(merged)); setFavorites(merged); setUser(next); setLoginOpen(false); notify('已登录'); const resume = resumeRef.current; resumeRef.current = null; if (resume?.view) setView(resume.view); else if (resume?.query) beginTask(resume.query) }
  const logout = () => { if (user) localStorage.setItem(accountFavKey(user.phone), JSON.stringify(favorites)); setUser(null); setFavorites(readFavs('interecagent.favs')); setAccountOpen(false); setView('home'); notify('已退出登录') }
  const rename = (name: string) => { if (!user) return; setUser({ ...user, name }); notify('资料已保存') }
  const exportData = () => { if (!user) return; const payload = { profile: { phone: user.phone, name: user.name, memberSince: user.memberSince }, preferences: { defaultPreference, currency }, favorites: products.filter((product) => favorites.includes(product.id)).map((product) => ({ id: product.id, brand: product.brand, model: product.model, rmbPrice: product.rmbPrice })), tasks: tasks.map((task) => ({ intent: task.mission.intent, phase: task.phase, updatedAt: task.updatedAt })) }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `interecagent-${user.phone}-export.json`; link.click(); URL.revokeObjectURL(url); notify('数据已导出') }
  const deleteAccount = () => { if (!user) return; const users = readUsers(); if (users[user.phone]) { delete users[user.phone]; writeUsers(users) } localStorage.removeItem(accountFavKey(user.phone)); localStorage.removeItem('interecagent.default-pref'); localStorage.removeItem('interecagent.favs'); setFavorites([]); setUser(null); setAccountOpen(false); setView('home'); notify('账号已删除') }
  const toggleFavorite = (id: string) => setFavorites((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const beginTask = (query: string) => { const id = Date.now(); const mission = createMission(query, id, defaultPreference); const time = nowText(); const actions = supportsAudioPriorities(mission) ? ['优先降噪', '优先续航', '先看综合推荐'] : ['按商品价排序', '先看综合推荐']; const task: ShoppingTask = { id, mission, selected: [], latestChange: null, phase: 'collecting', lastSurface: 'discover', createdAt: time, updatedAt: time, updatedAtMs: id, messages: [{ id: `start-${id}`, role: 'agent', text: `已识别“${mission.intent}”${mission.budget ? `，商品价预算 ${budgetText(mission)}` : ''}。我先按${preferenceText(mission.preference)}整理候选；接下来请告诉我最在意的排序条件。商品价已换算为 RMB，运费、税费和配送资格将在商户结算页确认。`, actions }] }; setTasks((current) => [task, ...current]); setActiveTaskId(id); setView('discover') }
  const start = (query: string) => { if (!user) { resumeRef.current = { query }; openLogin(); return } beginTask(query) }
  const guide = (next: View) => { if (next === 'home') { setView('home'); return } if (!user) { resumeRef.current = { view: next }; openLogin(); return } setView(next) }
  const openTask = (id: number) => { const task = tasks.find((item) => item.id === id); if (!task) return; setActiveTaskId(id); setSwitcherOpen(false); setView(task.lastSurface) }
  const toggle = (id: string) => updateActive((task) => { const selected = task.selected.includes(id) ? task.selected.filter((item) => item !== id) : task.selected.length >= 5 ? task.selected : [...task.selected, id]; return { ...task, selected, phase: selected.length ? 'shortlisting' : 'collecting', lastSurface: 'discover', updatedAt: nowText(), updatedAtMs: Date.now() } })
  const compare = () => { if (!activeTask || activeTask.selected.length < 2) return; updateActive((task) => ({ ...task, phase: 'comparing', lastSurface: 'compare', updatedAt: nowText(), updatedAtMs: Date.now() })); setView('compare') }
  const backToCandidates = () => { updateActive((task) => ({ ...task, phase: task.selected.length ? 'shortlisting' : 'collecting', lastSurface: 'discover', updatedAt: nowText(), updatedAtMs: Date.now() })); setView('discover') }
  return <div className="app-shell"><Header view={view} go={guide} user={user} openLogin={openLogin} openAccount={openAccount} activeTask={activeTask} onSwitch={() => setSwitcherOpen(true)} currency={currency} onCurrency={() => setCurrencyOpen(true)} />{view === 'home' && <Home start={start} />}{view === 'tasks' && <TaskList tasks={[...tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs)} activeId={activeTaskId} open={openTask} create={() => setView('home')} />}{view === 'discover' && activeTask && <Discover mission={activeTask.mission} apply={apply} selectedIds={activeTask.selected} toggle={toggle} compare={compare} detail={setDetail} messages={activeTask.messages} append={append} latestChange={activeTask.latestChange} undo={undo} currency={currency} />}{view === 'compare' && activeTask && <Compare mission={activeTask.mission} selectedIds={activeTask.selected} back={backToCandidates} detail={setDetail} apply={apply} onRemove={toggle} messages={activeTask.messages} append={append} latestChange={activeTask.latestChange} undo={undo} currency={currency} />}{detail && activeTask && <Drawer product={detail} selected={activeTask.selected.includes(detail.id)} close={() => setDetail(null)} toggle={() => toggle(detail.id)} signedIn={!!user} favorite={!!user && favorites.includes(detail.id)} onFavorite={() => { if (!user) openLogin(); else toggleFavorite(detail.id) }} currency={currency} />}{switcherOpen && <QuickSwitcher tasks={tasks} activeId={activeTaskId} open={openTask} close={() => setSwitcherOpen(false)} allTasks={() => { setSwitcherOpen(false); setView('tasks') }} create={() => { setSwitcherOpen(false); setView('home') }} />}{currencyOpen && <CurrencyPicker currency={currency} set={setCurrency} close={() => setCurrencyOpen(false)} />}{loginOpen && <LoginModal key={`${loginConfig.flow}:${loginConfig.phone}`} initialFlow={loginConfig.flow} initialPhone={loginConfig.phone} onClose={() => { resumeRef.current = null; setLoginOpen(false) }} onLogin={login} />}{accountOpen && user && <AccountDrawer user={user} onClose={() => setAccountOpen(false)} onLogout={logout} onRename={rename} onExport={exportData} onDeleteAccount={deleteAccount} onManagePassword={openPassword} hasPassword={!!readUsers()[user.phone]?.passwordHash} favorites={products.filter((product) => favorites.includes(product.id))} openProduct={(product) => { setAccountOpen(false); setDetail(product) }} defaultPreference={defaultPreference} onDefaultPreference={setDefaultPreference} currency={currency} />}{toast && <div className="app-toast" key={toast.id} role="status">{toast.text}</div>}</div>
}
