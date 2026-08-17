import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react'
import amazonLogo from './platform-logos/amazon.png'
import bestbuyLogo from './platform-logos/bestbuy.png'
import lazadaLogo from './platform-logos/lazada.png'

type View = 'home' | 'tasks' | 'discover' | 'compare'
type Preference = 'balanced' | 'noise' | 'battery' | 'lowest'
type IconName = 'back' | 'arrow' | 'bell' | 'check' | 'chevron' | 'close' | 'download' | 'edit' | 'external' | 'eye' | 'eye-off' | 'filter' | 'grid' | 'headphones' | 'heart' | 'info' | 'logout' | 'monitor' | 'plus' | 'search' | 'settings' | 'shoe' | 'spark' | 'star' | 'target' | 'trash' | 'user'
type AuthProvider = 'phone'
type Currency = 'RMB' | 'USD' | 'SGD'
type AccountUser = { phone: string; name: string; provider: AuthProvider; memberSince: string; createdAt: number; expiresAt: number; remember: boolean }
type Mission = { id: number; intent: string; budget?: number; preference: Preference; onlyInStock: boolean; version: number }
type Product = { id: string; title: string; brand: string; model: string; platform: string; tone: string; market: string; nativePrice: string; rmbPrice: number; fx: string; fxAsOf: string; updated: string; rating: number; reviews: number; stock: '有货' | '库存有限' | '暂无库存信息'; specs: string[]; why: string; tradeoff: string; url: string }
// —— 事件日志（追加式）：任务的唯一事实源，mission/selected/phase/version 全部由事件投影得到 ——
type CommandSource = 'chat' | 'quick-action' | 'filter-bar' | 'workspace' | 'system'
type MissionEvent =
  | { id: string; type: 'mission-created'; at: number; source: 'system'; mission: Mission; selected?: string[] }
  | { id: string; type: 'constraints-changed'; at: number; source: CommandSource; summary: string; before: Mission; after: Mission; selectedBefore: string[]; selectedAfter: string[]; resultBefore: number; resultAfter: number }
  | { id: string; type: 'constraints-undone'; at: number; source: CommandSource; ref: string; summary: string; before: Mission; after: Mission; selectedBefore: string[]; selectedAfter: string[]; resultBefore: number; resultAfter: number }
  | { id: string; type: 'selection-changed'; at: number; source: CommandSource; productId: string; added: boolean }

// —— 线程消息：条件变更/警告/澄清/推荐/里程碑与对话文本同为一级消息 ——
// at = 创建时间戳；createdVersion/basedOnVersion 用于"版本化断言"：条件版本超过后，action 失效、警告/推荐置灰。
type TextMessage = { id: string; kind: 'text'; role: 'user' | 'agent'; text: string; actions?: string[]; at?: number; createdVersion?: number }
type ChangeEventMessage = { id: string; kind: 'change-event'; eventId: string; changeKind: 'change' | 'undo'; source: CommandSource; summary: string; resultBefore: number; resultAfter: number; at?: number }
type WarningMessage = { id: string; kind: 'warning'; text: string; basedOnVersion?: number; at?: number }
type ClarificationMessage = { id: string; kind: 'clarification'; question: string; options: string[]; at?: number }
type RecommendationMessage = { id: string; kind: 'recommendation'; basedOnVersion: number; primaryId: string; alternativeIds: string[]; rationale: string[]; tradeoffs: string[]; at?: number }
type MilestoneMessage = { id: string; kind: 'milestone'; text: string; at?: number }
type ThreadMessage = TextMessage | ChangeEventMessage | WarningMessage | ClarificationMessage | RecommendationMessage | MilestoneMessage
type ChangeConstraintsFn = (delta: Partial<Mission>, summary: string, source: CommandSource, followUp?: ThreadMessage[]) => void

type TaskPhase = 'collecting' | 'shortlisting' | 'comparing'
type ShoppingTask = { id: number; events: MissionEvent[]; messages: ThreadMessage[]; lastSurface: 'discover' | 'compare'; createdAt: string; updatedAt: string; updatedAtMs: number }
type LegacyTask = { id?: unknown; mission?: Mission; selected?: unknown; messages?: unknown; events?: unknown; lastSurface?: unknown; createdAt?: unknown; updatedAt?: unknown; updatedAtMs?: unknown }

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
// Logo 在固定舞台中保持原始比例，平台名称与价格列因此可以稳定对齐。
function PlatformMark({ tone, name }: { tone: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const src = platformLogo[tone]
  return <span className={`platform-mark platform-mark--${tone}${failed || !src ? ' platform-mark--fallback' : ''}`} role="img" aria-label={name}>
    {failed || !src ? <span className="platform-mark-fallback">{name}</span> : <img src={src} alt="" onError={() => setFailed(true)} />}
  </span>
}
function Mark({ product }: { product: Product }) { return <PlatformMark tone={product.tone} name={product.platform} /> }
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
function extractIntent(text: string) { const trimmed = stripBudget(text).replace(/^(?:帮我找|帮我买|帮我挑|帮我|我想买|我要买|我要找|我想|想买|请帮我|给我|要买|买|找)\s*/gi, '').replace(/^一[副个台件双只]\s*/gi, '').replace(/优先\s*(续航|降噪)|只看有货|仅看有货|最低商品价|低价/gi, '').replace(/[，,。；;]+/g, ' ').trim(); return trimmed || '未命名选购' }
function parsePreference(text: string): Preference | null { return /优先\s*续航/.test(text) ? 'battery' : /优先\s*降噪/.test(text) ? 'noise' : /最低商品价|低价优先|价格优先/.test(text) ? 'lowest' : null }
function createMission(query: string, id: number, defaultPref: Preference): Mission { return { id, intent: extractIntent(query), budget: parseBudgetCNY(query), preference: parsePreference(query) ?? defaultPref, onlyInStock: /只看有货|仅看有货/.test(query), version: 1 } }
function phaseText(phase: TaskPhase, selected: string[]) { return phase === 'comparing' ? `比较中 · ${selected.length} 件` : selected.length ? `已选 ${selected.length} 件` : phase === 'shortlisting' ? '继续选择备选' : '查看备选' }
function nowText() { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()) }
function timeLabel(at?: number) { if (!at) return ''; const date = new Date(at); const sameDay = date.toDateString() === new Date().toDateString(); return new Intl.DateTimeFormat('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) }
function batteryHours(product: Product) { return Number(product.specs.find((spec) => spec.includes('续航'))?.match(/\d+/)?.[0] ?? 0) }
function candidatesFor(mission: Mission) { const category = intentCategory(mission.intent); let list = category ? products.filter((product) => productCategory(product) === category) : []; if (mission.onlyInStock) list = list.filter((product) => product.stock === '有货'); return list.sort((a, b) => { if (category === 'headphones' && mission.preference === 'battery') return batteryHours(b) - batteryHours(a) || a.rmbPrice - b.rmbPrice; if (category === 'headphones' && mission.preference === 'noise') return Number(b.brand === 'Bose') - Number(a.brand === 'Bose') || a.rmbPrice - b.rmbPrice; if (mission.preference === 'lowest') return a.rmbPrice - b.rmbPrice; const budget = mission.budget; const aBudget = budget !== undefined ? Number(a.rmbPrice > budget) : 0; const bBudget = budget !== undefined ? Number(b.rmbPrice > budget) : 0; return aBudget - bBudget || b.rating - a.rating }) }
function eligibleFor(mission: Mission) { const candidates = candidatesFor(mission); const budget = mission.budget; return budget !== undefined ? candidates.filter((product) => product.rmbPrice <= budget) : candidates }

let uidSeq = 0
function uid(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${(uidSeq += 1).toString(36)}` }

type MissionProjection = { mission: Mission; selected: string[]; phase: TaskPhase; undoneEventIds: Set<string>; reversibleEventId: string | null; reversibleSummary: string | null }
const FALLBACK_MISSION: Mission = { id: 0, intent: '未命名选购', preference: 'balanced', onlyInStock: false, version: 1 }
function derivePhase(selectedCount: number, lastSurface: 'discover' | 'compare'): TaskPhase { return selectedCount >= 2 && lastSurface === 'compare' ? 'comparing' : selectedCount ? 'shortlisting' : 'collecting' }
// 事件日志 → 当前状态。version 恒为 1 + 条件事件数：撤销也递增，绝不回退（AC-015）。
function projectMission(events: MissionEvent[], lastSurface: 'discover' | 'compare'): MissionProjection {
  let mission = FALLBACK_MISSION
  let selected: string[] = []
  let constraintCount = 0
  const changedIds: string[] = []
  const undoneIds = new Set<string>()
  for (const event of events) {
    if (event.type === 'mission-created') { mission = event.mission; selected = event.selected ?? [] }
    else if (event.type === 'constraints-changed') { mission = event.after; selected = event.selectedAfter; constraintCount += 1; changedIds.push(event.id) }
    else if (event.type === 'constraints-undone') { mission = event.after; selected = event.selectedAfter; constraintCount += 1; undoneIds.add(event.ref) }
    else if (event.type === 'selection-changed') { selected = event.added ? [...selected, event.productId] : selected.filter((id) => id !== event.productId) }
  }
  let reversibleEventId: string | null = null
  for (let index = changedIds.length - 1; index >= 0; index -= 1) { if (!undoneIds.has(changedIds[index])) { reversibleEventId = changedIds[index]; break } }
  const reversibleEvent = reversibleEventId === null ? null : events.find((event) => event.id === reversibleEventId)
  const reversibleSummary = reversibleEvent && reversibleEvent.type === 'constraints-changed' ? reversibleEvent.summary : null
  return { mission: { ...mission, version: 1 + constraintCount }, selected, phase: derivePhase(selected.length, lastSurface), undoneEventIds: undoneIds, reversibleEventId, reversibleSummary }
}

// localStorage 旧任务（直接存 mission/selected）迁入事件日志；事件格式只做消息 kind 补全。
function migrateTask(raw: LegacyTask): ShoppingTask | null {
  if (typeof raw.id !== 'number') return null
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : nowText()
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt
  const updatedAtMs = typeof raw.updatedAtMs === 'number' ? raw.updatedAtMs : raw.id
  const messages: ThreadMessage[] = Array.isArray(raw.messages) ? (raw.messages as unknown[]).map((item, index): ThreadMessage => {
    if (item && typeof item === 'object' && 'kind' in item) return item as ThreadMessage
    const legacy = item as { id?: unknown; role?: unknown; text?: unknown; actions?: unknown }
    const migrated: TextMessage = { id: typeof legacy.id === 'string' ? legacy.id : `migrated-${index}`, kind: 'text', role: legacy.role === 'user' ? 'user' : 'agent', text: typeof legacy.text === 'string' ? legacy.text : '' }
    if (Array.isArray(legacy.actions)) migrated.actions = legacy.actions as string[]
    return migrated
  }) : []
  const lastSurface = raw.lastSurface === 'compare' ? 'compare' : 'discover'
  if (Array.isArray(raw.events)) return { id: raw.id, events: raw.events as MissionEvent[], messages, lastSurface, createdAt, updatedAt, updatedAtMs }
  const mission: Mission = raw.mission && typeof raw.mission === 'object' ? { ...raw.mission, version: 1 } : { ...FALLBACK_MISSION, id: raw.id }
  const selected = Array.isArray(raw.selected) ? (raw.selected as string[]) : []
  return { id: raw.id, events: [{ id: uid('evt'), type: 'mission-created', at: updatedAtMs, source: 'system', mission, selected }], messages, lastSurface, createdAt, updatedAt, updatedAtMs }
}

// 唯一写入口：约束变更 / 撤销 / 选择全部落为事件并在线程留痕；工作区只读投影，不再有第二条写路径。
function useMissionCommand(activeTaskId: number | null, setTasks: Dispatch<SetStateAction<ShoppingTask[]>>) {
  const commit = useCallback((mutate: (task: ShoppingTask) => ShoppingTask) => {
    if (activeTaskId === null) return
    setTasks((current) => current.map((task) => (task.id === activeTaskId ? mutate(task) : task)).sort((a, b) => b.updatedAtMs - a.updatedAtMs))
  }, [activeTaskId, setTasks])
  const touch = (task: ShoppingTask, extra: { events?: MissionEvent[]; messages?: ThreadMessage[] }): ShoppingTask => ({ ...task, events: extra.events ? [...task.events, ...extra.events] : task.events, messages: extra.messages ? [...task.messages, ...extra.messages] : task.messages, updatedAt: nowText(), updatedAtMs: Date.now() })
  const appendMessages = useCallback((items: ThreadMessage[]) => { commit((task) => touch(task, { messages: items })) }, [commit])
  const changeConstraints = useCallback((delta: Partial<Mission>, summary: string, source: CommandSource, followUp: ThreadMessage[] = []) => {
    commit((task) => {
      const current = projectMission(task.events, task.lastSurface)
      const before = current.mission
      const after = { ...before, ...delta, version: before.version + 1 }
      const selectedAfter = after.onlyInStock ? current.selected.filter((id) => products.find((product) => product.id === id)?.stock === '有货') : current.selected
      const event: MissionEvent = { id: uid('evt'), type: 'constraints-changed', at: Date.now(), source, summary, before, after, selectedBefore: current.selected, selectedAfter, resultBefore: candidatesFor(before).length, resultAfter: candidatesFor(after).length }
      const receipt: ThreadMessage = { id: uid('m'), kind: 'change-event', eventId: event.id, changeKind: 'change', source, summary, resultBefore: event.resultBefore, resultAfter: event.resultAfter, at: event.at }
      const followUps = [...followUp]
      // 异常场景不留静默：仅在「进入」零可推荐状态时提示一次，避免零状态下反复刷屏。
      if (eligibleFor(before).length > 0 && eligibleFor(after).length === 0) followUps.push({ id: uid('m'), kind: 'warning', text: '当前条件下没有可推荐备选。可以试试提高预算、清除筛选，或在对话里换一类商品。', basedOnVersion: after.version, at: Date.now() })
      return touch(task, { events: [event], messages: [receipt, ...followUps] })
    })
  }, [commit])
  // 撤销 = 追加反向事件（引用被撤销事件），版本继续递增；可连续撤销到更早的未撤销变更。
  const undoLatest = useCallback((source: CommandSource = 'quick-action') => {
    commit((task) => {
      const current = projectMission(task.events, task.lastSurface)
      const ref = task.events.find((event) => event.id === current.reversibleEventId)
      if (!ref || ref.type !== 'constraints-changed') return task
      const summary = `撤销「${ref.summary}」，恢复之前的条件`
      const event: MissionEvent = { id: uid('evt'), type: 'constraints-undone', at: Date.now(), source, ref: ref.id, summary, before: current.mission, after: { ...ref.before, version: current.mission.version + 1 }, selectedBefore: current.selected, selectedAfter: ref.selectedBefore, resultBefore: candidatesFor(current.mission).length, resultAfter: candidatesFor(ref.before).length }
      const receipt: ThreadMessage = { id: uid('m'), kind: 'change-event', eventId: event.id, changeKind: 'undo', source, summary, resultBefore: event.resultBefore, resultAfter: event.resultAfter, at: event.at }
      const reply: ThreadMessage = { id: uid('m'), kind: 'text', role: 'agent', at: Date.now(), text: `已为你撤销「${ref.summary}」，恢复之前的条件；需要再撤一步，就点变更记录里的撤销。` }
      return touch(task, { events: [event], messages: [receipt, reply] })
    })
  }, [commit])
  const changeSelection = useCallback((productId: string, added: boolean, source: CommandSource = 'workspace') => {
    commit((task) => {
      const current = projectMission(task.events, task.lastSurface)
      if (added && (current.selected.includes(productId) || current.selected.length >= 4)) return task
      if (!added && !current.selected.includes(productId)) return task
      return touch(task, { events: [{ id: uid('evt'), type: 'selection-changed', at: Date.now(), source, productId, added }] })
    })
  }, [commit])
  return { appendMessages, changeConstraints, undoLatest, changeSelection }
}

// 推荐消息（创建时触发；条件变更后的过期标记与重推由第三批接管）。理由只引用价格/预算/排序事实。
function buildRecommendation(mission: Mission): RecommendationMessage | null {
  const eligible = eligibleFor(mission)
  if (!eligible.length) return null
  const [primary, ...rest] = eligible
  const alternatives = rest.slice(0, 2)
  const rationale = [
    `首选按「${preferenceText(mission.preference)}」在当前可推荐备选中排第一，商品价估算约 ¥${primary.rmbPrice.toLocaleString()}${mission.budget ? `，在预算 ¥${mission.budget.toLocaleString()} 内` : '（当前未设置预算）'}。`,
    alternatives.length ? `另给 ${alternatives.length} 件备选，按同一排序选出；点击商品可核对原币价与汇率时间。` : '当前可推荐备选只有 1 件，建议放宽条件后再比较。',
  ]
  return { id: uid('m'), kind: 'recommendation', basedOnVersion: mission.version, primaryId: primary.id, alternativeIds: alternatives.map((product) => product.id), rationale, tradeoffs: [primary.tradeoff], at: Date.now() }
}

function Header({ view, go, user, openLogin, openAccount, activeIntent, onSwitch, currency, onCurrency }: { view: View; go: (view: View) => void; user: AccountUser | null; openLogin: () => void; openAccount: () => void; activeIntent?: string; onSwitch: () => void; currency: Currency; onCurrency: () => void }) { return <header className="topbar"><button className="brand-lockup" onClick={() => go('home')}><span className="brand-mark">ir</span><span><strong>跨境选物台</strong><small>跨平台商品价比较</small></span></button><nav className="main-nav"><button className={view === 'home' ? 'is-active' : ''} onClick={() => go('home')}><Icon name="plus" size={15} />新建选购</button><button className={view === 'tasks' || view === 'discover' || view === 'compare' ? 'is-active' : ''} onClick={() => go('tasks')}><Icon name="spark" size={15} />我的选购</button>{user && activeIntent && <><span className="nav-divider" aria-hidden="true" /><button className="topbar-task-chip" onClick={onSwitch}><span>当前选购</span><strong>{activeIntent}</strong><Icon name="chevron" size={14} /></button></>}</nav><div className="topbar-actions"><button className="currency-link" onClick={onCurrency} aria-label="比较货币"><b>{currency}</b><Icon name="chevron" size={12} /></button></div>{user ? <button className="account-pill" onClick={openAccount} aria-label="账号与偏好"><span className="avatar-badge">{user.name.slice(0, 1)}</span><span className="account-pill-name">{user.name}</span><Icon name="chevron" size={13} /></button> : <button className="account-link" onClick={openLogin}><Icon name="user" size={15} />登录</button>}</header> }
function Home({ start }: { start: (query: string) => void }) {
  const [query, setQuery] = useState('帮我找一副适合通勤的降噪耳机，预算 2500 元以内')
  const prompts = ['适合远程办公的 27 寸 4K 显示器，¥3,000 以内', '送给爸爸的轻便徒步鞋，¥1,000 以内', '降噪耳机，¥2,000 以内，优先续航']
  // 比价示意从商品数据派生（汇率、时间与示例行），mock 更新后示意不会失真。
  const previewItems = products.slice(0, 3)
  const previewRates = new Map<string, string>()
  for (const product of previewItems) { const m = product.fx.match(/([A-Z]{3})\s*=\s*([\d.]+)/); if (m && !previewRates.has(m[1])) previewRates.set(m[1], m[2]) }
  const previewFxTime = previewItems[0].fxAsOf.match(/\d{2}:\d{2}/)?.[0] ?? ''
  return <main className="home-view"><div className="home-hero"><h1>想买什么？</h1><p>耳机、27 寸 4K 显示器和轻便徒步鞋均可比较。告诉我用途、预算和偏好，我会整理不同平台的商品价与证据。</p></div><form className="mission-composer" onSubmit={(event) => { event.preventDefault(); start(query) }}><div className="composer-label">描述你的需求</div><textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} aria-label="描述购物需求" /><div className="composer-footer"><span>商品价换算为 RMB；运费与税费以商户结算页为准</span><Button variant="primary" type="submit" icon="arrow" disabled={!query.trim()}>开始选购</Button></div></form><div className="prompt-row"><span>试试这样说</span>{prompts.map((prompt) => <button key={prompt} type="button" onClick={() => setQuery(prompt)}>{prompt}</button>)}</div><section className="home-preview" aria-label="比价示意"><div className="preview-heading"><span>比价示意</span><strong>通勤降噪耳机 · ¥2,500 内</strong><small>商品价估算 · 运费与税费以商户结算页为准</small></div><div className="preview-fx"><span>汇率基准</span>{[...previewRates.entries()].map(([code, rate]) => <span key={code} className="preview-rate"><b>{code}</b> {rate}</span>)}<em>更新于 {previewFxTime}</em></div><div className="preview-rows" aria-label="示例比较结果">{previewItems.map((product) => <div className="preview-row" key={product.id}><PlatformMark tone={product.tone} name={product.platform} /><b>{product.platform} {product.market.split('·')[1]?.trim() ?? ''}</b><strong>{product.nativePrice}</strong><em>约 ¥{product.rmbPrice.toLocaleString()}</em></div>)}</div><div className="preview-foot"><span>已统一商品价口径，可继续比较规格与评价</span><span>运费与税费以商户结算页为准</span></div></section></main>
}
function PriceEvidence({ product, compact = false, lowest = false, currency = 'RMB', compare = false }: { product: Product; compact?: boolean; lowest?: boolean; currency?: Currency; compare?: boolean }) { const amount = priceIn(product.rmbPrice, currency); return <div className={`price-evidence ${compact ? 'compact' : ''}${lowest ? ' is-lowest' : ''}${compare ? ' compare' : ''}`}><div><strong>{CURRENCY_SYMBOL[currency]}{amount.toLocaleString()}</strong><span>{product.nativePrice}</span></div><small>{product.fx} · {product.fxAsOf}</small>{!compare && <small>{compact ? '商品价估算 · 运费与税费以商户结算页为准' : `${product.updated} · 商品价估算，运费与税费以商户结算页为准`}</small>}</div> }
function Brief({ mission }: { mission: Mission }) { return <section className="mission-brief" aria-label="当前选购条件"><div className="brief-filters"><span className="brief-condition brief-condition-version" title="条件版本：每次变更（含撤销）递增，用于审计与旧结果失效">V{mission.version}</span><span className="brief-condition brief-condition-primary">{mission.intent}</span><span className="brief-condition">预算 {budgetText(mission)}</span><span className="brief-condition">{preferenceText(mission.preference)}</span>{mission.onlyInStock && <span className="brief-condition">仅看有货</span>}</div></section> }
function EvidenceStrip({ candidates }: { candidates: Product[] }) { if (!candidates.length) return null; const sources = [...new Set(candidates.map((product) => `${product.platform} ${product.market.split('·')[1]?.trim() ?? ''}`))].join('、'); return <section className="evidence-strip"><div><Icon name="search" size={15} /><span><b>已检索</b> {sources}</span></div><div><Icon name="info" size={15} /><span><b>价格口径</b> 商品价估算；运费与税费以商户结算页为准</span></div></section> }
function fxRatesFor(candidates: Product[]) { const map = new Map<string, string>(); for (const p of candidates) { const m = p.fx.match(/([A-Z]{3})\s*=\s*([\d.]+)/); if (m && !map.has(m[1])) map.set(m[1], m[2]) } return [...map.entries()] }
function FxStrip({ candidates }: { candidates: Product[] }) { if (!candidates.length) return null; const rates = fxRatesFor(candidates); const asOf = candidates[0].fxAsOf.match(/\d{2}:\d{2}/)?.[0]; return <div className="fx-strip"><span className="fx-strip-label">汇率基准</span>{rates.map(([code, rate]) => <span className="fx-rate" key={code}><b>{code}</b>{rate}</span>)}<span className="fx-strip-asof">更新于 {asOf}</span></div> }
type WorkspaceStage = 'discover' | 'compare'
function StageRail({ current }: { current: WorkspaceStage }) { const steps = [{ key: 'request', label: '需求', hint: '已识别' }, { key: 'discover', label: '备选', hint: '核对候选' }, { key: 'compare', label: '对比', hint: '做出决定' }] as const; const currentIndex = current === 'discover' ? 1 : 2; return <nav className="stage-rail" aria-label="选购进度">{steps.map((step, index) => <span className={`stage-step ${index < currentIndex ? 'is-done' : ''} ${index === currentIndex ? 'is-current' : ''}`} key={step.key}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{step.label}</strong><small>{index === currentIndex ? step.hint : index < currentIndex ? '已完成' : '待进行'}</small></span></span>)}</nav> }
function DecisionOverview({ candidates, eligibleCount, platformCount, mission }: { candidates: Product[]; eligibleCount: number; platformCount: number; mission: Mission }) { const lowest = candidates.length ? candidates.reduce((a, b) => a.rmbPrice <= b.rmbPrice ? a : b) : null; return <section className="decision-overview" aria-label="决策概览"><div className="decision-overview-copy"><span className="section-eyebrow">决策工作台</span><h2>先看结论，再核对候选</h2><p>{mission.budget ? `已按商品价预算 ¥${mission.budget.toLocaleString()} 过滤，并保留 ${mission.onlyInStock ? '有货' : '当前可见'} 候选。` : '已按当前需求整理候选，选择排序依据后再加入比较。'}</p></div><div className="decision-metrics"><div><strong>{eligibleCount}</strong><span>{mission.budget ? '预算内候选' : '可推荐候选'}</span></div><div><strong>{platformCount}</strong><span>可比平台</span></div><div><strong>{lowest ? `¥${lowest.rmbPrice.toLocaleString()}` : '—'}</strong><span>最低商品价</span></div></div></section> }

function sourceText(source: CommandSource) { return source === 'chat' ? '对话' : source === 'quick-action' ? '快捷操作' : source === 'filter-bar' ? '筛选栏' : source === 'workspace' ? '工作区' : '系统' }
function ChangeRow({ message, isUndoable, isUndone, onUndo }: { message: ChangeEventMessage; isUndoable: boolean; isUndone: boolean; onUndo: () => void }) {
  return <div className={`change-row${message.changeKind === 'undo' ? ' is-undo' : ''}${isUndone ? ' is-undone' : ''}`}>
    <span className="change-source">{sourceText(message.source)}</span>
    <span className="change-text">{message.summary}</span>
    <span className="change-count">{message.resultBefore} → {message.resultAfter} 件</span>
    {message.at ? <span className="change-time">{timeLabel(message.at)}</span> : null}
    {isUndoable && <button className="change-undo-button" onClick={onUndo}>撤销</button>}
    {isUndone && <span className="change-undone-badge">已撤销</span>}
  </div>
}
// 连续 3 条以上变更回执折叠为摘要，最新一条（含撤销入口）始终可见，避免线程刷屏。
function ChangeGroup({ messages, undoneEventIds, reversibleEventId, onUndo }: { messages: ChangeEventMessage[]; undoneEventIds: Set<string>; reversibleEventId: string | null; onUndo: () => void }) {
  const collapsible = messages.length > 2
  const [open, setOpen] = useState(!collapsible)
  const latest = messages[messages.length - 1]
  return <div className="change-group">
    {collapsible && <button type="button" className="change-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron" size={12} />条件变更 {messages.length} 次{open ? ' · 收起' : ` · 最新：${latest.summary}`}</button>}
    {(open ? messages : [latest]).map((message) => <ChangeRow key={message.id} message={message} isUndoable={message.eventId === reversibleEventId} isUndone={undoneEventIds.has(message.eventId)} onUndo={onUndo} />)}
  </div>
}
function RecommendationCard({ message, mission, openProduct, onReRecommend }: { message: RecommendationMessage; mission: Mission; openProduct: (product: Product) => void; onReRecommend?: () => void }) {
  const primary = products.find((product) => product.id === message.primaryId)
  const alternatives = message.alternativeIds.map((id) => products.find((product) => product.id === id)).filter((product): product is Product => Boolean(product))
  const stale = message.basedOnVersion !== mission.version
  return <div className={`thread-recommendation${stale ? ' is-stale' : ''}`}>
    <div className="thread-recommendation-head"><span>{stale ? '推荐 · 待更新' : '推荐'}</span><small>基于 V{message.basedOnVersion}{stale ? ` · 当前 V${mission.version}` : ''}{message.at ? ` · ${timeLabel(message.at)}` : ''}</small></div>
    {primary && <button type="button" className="rec-chip rec-chip-primary" onClick={() => openProduct(primary)}>{primary.title}<b>约 ¥{primary.rmbPrice.toLocaleString()}</b></button>}
    <ul>{message.rationale.map((line) => <li key={line}>{line}</li>)}</ul>
    {alternatives.length > 0 && <div className="rec-alternatives"><span>备选</span>{alternatives.map((product) => <button type="button" key={product.id} className="rec-chip" onClick={() => openProduct(product)}>{product.title}<b>约 ¥{product.rmbPrice.toLocaleString()}</b></button>)}</div>}
    {message.tradeoffs.length > 0 && <p className="rec-tradeoffs"><b>取舍</b>{message.tradeoffs.join('；')}</p>}
    {stale && onReRecommend && <button type="button" className="rec-refresh" onClick={onReRecommend}>按当前条件重新推荐</button>}
  </div>
}
function ThreadItem({ message, mission, onAction, onClarifyOption, openProduct, onReRecommend }: { message: Exclude<ThreadMessage, ChangeEventMessage>; mission: Mission; onAction: (name: string) => void; onClarifyOption: (option: string) => void; openProduct: (product: Product) => void; onReRecommend?: () => void }) {
  if (message.kind === 'warning') {
    const stale = message.basedOnVersion !== undefined && mission.version > message.basedOnVersion
    return <div className={`thread-warning${stale ? ' is-stale' : ''}`} role="status"><Icon name="info" size={14} /><span>{message.text}{stale ? '（此提示基于旧条件，已随条件更新失效）' : ''}</span></div>
  }
  if (message.kind === 'recommendation') return <RecommendationCard message={message} mission={mission} openProduct={openProduct} onReRecommend={onReRecommend} />
  if (message.kind === 'clarification') return <div className="conversation-message agent"><div className="message-meta">选购助手{message.at ? ` · ${timeLabel(message.at)}` : ''}</div><p>{message.question}</p><div className="message-actions">{message.options.map((option) => <button key={option} onClick={() => onClarifyOption(option)}>{option}</button>)}</div></div>
  if (message.kind === 'milestone') return <div className="milestone-row" role="status"><Icon name="target" size={13} /><span>{message.text}</span>{message.at ? <small>{timeLabel(message.at)}</small> : null}</div>
  return <div className={`conversation-message ${message.role}`}>
    <div className="message-meta">{message.role === 'user' ? '你' : '选购助手'}{message.at ? ` · ${timeLabel(message.at)}` : ''}</div>
    <p>{message.text}</p>
    {message.actions && <div className="message-actions">{message.actions.map((name) => {
      const expired = message.createdVersion !== undefined && mission.version > message.createdVersion
      return <button key={name} disabled={expired} title={expired ? '此快捷操作基于旧条件，已失效' : undefined} onClick={() => { if (!expired) onAction(name) }}>{name}</button>
    })}</div>}
  </div>
}
type ThreadBlock = { key: string; kind: 'single'; message: Exclude<ThreadMessage, ChangeEventMessage> } | { key: string; kind: 'changes'; messages: ChangeEventMessage[] }
function Thread({ messages, mission, undoneEventIds, reversibleEventId, onUndo, onAction, onClarifyOption, openProduct, onReRecommend }: { messages: ThreadMessage[]; mission: Mission; undoneEventIds: Set<string>; reversibleEventId: string | null; onUndo: () => void; onAction: (name: string) => void; onClarifyOption: (option: string) => void; openProduct: (product: Product) => void; onReRecommend?: () => void }) {
  const blocks: ThreadBlock[] = []
  let pending: { key: string; messages: ChangeEventMessage[] } | null = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.kind === 'change-event') { if (pending === null) pending = { key: `changes-${message.id}`, messages: [] }; pending.messages.push(message); continue }
    if (pending !== null) { blocks.push({ key: pending.key, kind: 'changes', messages: pending.messages }); pending = null }
    blocks.push({ key: `${message.kind}-${index}`, kind: 'single', message })
  }
  if (pending !== null) blocks.push({ key: pending.key, kind: 'changes', messages: pending.messages })
  // 新消息到达时跟随滚底；用户主动上翻浏览历史时不抢夺滚动位置（仅操作容器本身，不滚动整页）。
  const containerRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = useState(true)
  useEffect(() => { const el = containerRef.current; if (el && stickToBottom) el.scrollTop = el.scrollHeight }, [messages.length, stickToBottom])
  return <div className="conversation-thread" aria-label="选购对话" ref={containerRef} onScroll={(event) => { const el = event.currentTarget; setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48) }}>
    {blocks.map((block) => block.kind === 'single'
      ? <ThreadItem key={block.key} message={block.message} mission={mission} onAction={onAction} onClarifyOption={onClarifyOption} openProduct={openProduct} onReRecommend={onReRecommend} />
      : <ChangeGroup key={block.key} messages={block.messages} undoneEventIds={undoneEventIds} reversibleEventId={reversibleEventId} onUndo={onUndo} />)}
  </div>
}
function Conversation({ mission, selectedCount, canCompare, comparing = false, messages, undoneEventIds, reversibleEventId, reversibleSummary, compare, changeConstraints, undo, append, openProduct, onReRecommend }: { mission: Mission; selectedCount: number; canCompare: boolean; comparing?: boolean; messages: ThreadMessage[]; undoneEventIds: Set<string>; reversibleEventId: string | null; reversibleSummary: string | null; compare: () => void; changeConstraints: ChangeConstraintsFn; undo: () => void; append: (items: ThreadMessage[]) => void; openProduct: (product: Product) => void; onReRecommend?: () => void }) {
  const [draft, setDraft] = useState('')
  const action = (name: string) => {
    if (name === '比较已选商品') { if (canCompare) compare(); else append([{ id: uid('m'), kind: 'text', role: 'agent', at: Date.now(), text: '先加入两件备选，再开始对比。' }]); return }
    const preference: Preference = name === '优先降噪' ? 'noise' : name === '优先续航' ? 'battery' : name === '按商品价排序' ? 'lowest' : 'balanced'
    append([{ id: uid('m'), kind: 'text', role: 'user', text: name, at: Date.now() }, { id: uid('m'), kind: 'text', role: 'agent', at: Date.now(), text: `已将推荐依据改为“${preferenceText(preference)}”。价格仍是商品价估算，运费和税费请以商户结算页为准。` }])
    changeConstraints({ preference }, `排序：${preferenceText(preference)}`, 'quick-action')
  }
  const handleUserText = (text: string) => {
    const budget = parseBudgetCNY(text); const onlyInStock = /只看有货|仅看有货/.test(text); const preference = parsePreference(text)
    const requestedIntent = extractIntent(text); const explicitIntent = /(?:换成|改找|我想买|帮我找|找一[副个台件]|显示器|徒步鞋|耳机)/.test(text) && supportsIntent(requestedIntent)
    const delta: Partial<Mission> = {}; const parts: string[] = []
    if (budget) { delta.budget = budget; parts.push(`预算 ¥${budget.toLocaleString()} 内`) }
    if (onlyInStock) { delta.onlyInStock = true; parts.push('仅看有货') }
    if (preference) { delta.preference = preference; parts.push(`排序：${preferenceText(preference)}`) }
    if (explicitIntent) { delta.intent = requestedIntent; if (!supportsAudioPriorities({ ...mission, intent: requestedIntent })) delta.preference = preference === 'battery' || preference === 'noise' ? 'balanced' : preference ?? 'balanced'; parts.push(`商品：${requestedIntent}`) }
    append([{ id: uid('m'), kind: 'text', role: 'user', text, at: Date.now() }])
    if (parts.length) changeConstraints(delta, parts.join(' · '), 'chat', [{ id: uid('m'), kind: 'text', role: 'agent', at: Date.now(), text: `已更新${parts.join('、')}。我只会按已识别的条件重排；商品价均未包含运费和税费。` }])
    else append([
      { id: uid('m'), kind: 'text', role: 'agent', at: Date.now(), createdVersion: mission.version, text: `我暂时没听懂“${text}”。可以点下面的选项，或按「预算 ¥2000 内」「只看有货」「优先续航」这样的说法告诉我。` },
      { id: uid('m'), kind: 'clarification', at: Date.now(), question: '你想调整什么？', options: supportsAudioPriorities(mission) ? ['优先续航', '优先降噪', '低价优先', '只看有货'] : ['低价优先', '只看有货', '降噪耳机'] },
    ])
  }
  const submit = (event?: FormEvent) => { event?.preventDefault(); const text = draft.trim(); if (!text) return; handleUserText(text); setDraft('') }
  // 快捷操作按上下文生成：空结果时给恢复动作，选满 4 件时收窄为“开始对比”，常规状态给偏好排序。
  const candidateCount = candidatesFor(mission).length
  const eligibleCount = eligibleFor(mission).length
  const hasTemporaryFilters = mission.preference !== 'balanced' || mission.onlyInStock
  const suggestions: { label: string; run: () => void; primary?: boolean }[] = []
  if (!comparing && canCompare) suggestions.push({ label: `对比所选（${selectedCount} 件）`, run: () => action('比较已选商品'), primary: true })
  if (eligibleCount === 0 && hasTemporaryFilters) suggestions.push({ label: '清除筛选', run: () => changeConstraints({ preference: 'balanced', onlyInStock: false }, '已重置筛选与排序', 'quick-action') })
  if (candidateCount > 0 && eligibleCount > 0 && selectedCount < 4) {
    const preferenceActions = supportsAudioPriorities(mission) ? ['优先降噪', '优先续航'] : []
    for (const name of preferenceActions) suggestions.push({ label: name, run: () => action(name) })
    suggestions.push({ label: mission.onlyInStock ? '显示全部库存' : '只看有货', run: () => changeConstraints({ onlyInStock: !mission.onlyInStock }, mission.onlyInStock ? '库存：显示全部' : '库存：仅看有货', 'quick-action') })
  }
  return <aside className={`conversation-panel ${messages.length <= 1 ? 'is-brief' : ''}`}>
    <div className="conversation-header"><div><span>选购助手</span></div>{reversibleEventId && <div className="conversation-header-actions"><button type="button" className="undo-entry" onClick={undo} title={`撤销：${reversibleSummary ?? ''}`}>撤销最近变更</button></div>}</div>
    <Brief mission={mission} />
    <Thread messages={messages} mission={mission} undoneEventIds={undoneEventIds} reversibleEventId={reversibleEventId} onUndo={undo} onAction={action} onClarifyOption={handleUserText} openProduct={openProduct} onReRecommend={onReRecommend} />
    {suggestions.length > 0 && <div className="conversation-suggestions">{suggestions.map((suggestion) => <button key={suggestion.label} className={suggestion.primary ? 'is-primary' : ''} onClick={suggestion.run}>{suggestion.label}</button>)}</div>}
    <form className="conversation-composer" onSubmit={submit}><textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() } }} placeholder="例如：预算改为 ¥2000，或只看有货（Enter 发送）" aria-label="选购对话输入" /><div className="composer-row"><button className="send-button" disabled={!draft.trim()} aria-label="发送"><Icon name="arrow" size={16} /></button></div></form>
  </aside>
}
function CandidateCard({ product, rank, selected, toggle, detail, budget, preference, lowest = false, currency = 'RMB', lead = false }: { product: Product; rank: number; selected: boolean; toggle: () => void; detail: () => void; budget?: number; preference: Preference; lowest?: boolean; currency?: Currency; lead?: boolean }) {
  const reason = preference === 'battery' && batteryHours(product) ? `续航 ${batteryHours(product)} 小时${product.id === 'sennheiser-m4' ? '，当前备选中最长。' : '。'}` : preference === 'noise' && product.brand === 'Bose' ? '降噪取向与当前偏好一致。' : preference === 'lowest' ? '当前按商品参考价由低至高排列。' : product.why
  return <article className={`product-card evidence-card ${selected ? 'is-selected' : ''} ${lead ? 'is-lead' : ''}`}>
    <span className="candidate-rank">{String(rank).padStart(2, '0')}</span>
    {lead && <span className="candidate-focus">首选候选</span>}
    <button className="product-image-button" onClick={detail}><div className={`product-image tone-${product.tone}`}><span className="category-icon" aria-hidden="true"><Icon name={categoryIcon[productCategory(product)]} size={42} /></span><span className="image-tag">{product.stock}</span></div></button>
    <div className="product-card-body"><div className="product-source"><span><Mark product={product} /> {product.platform}</span><span>{product.market}</span></div><button className="product-title" onClick={detail}>{product.title}</button><div className="rating-line"><span className="stars"><Icon name="star" size={13} /> {product.rating}</span><span>{product.reviews.toLocaleString()} 条评价</span></div><PriceEvidence product={product} compact lowest={lowest} currency={currency} /><div className="spec-line">{product.specs.slice(0, 2).map((spec) => <span key={spec}>{spec}</span>)}</div><p className="candidate-reason"><b>为什么排在这里</b>{reason}</p>{budget && product.rmbPrice > budget && <p className="budget-warning">超出预算 ¥{(product.rmbPrice - budget).toLocaleString()}</p>}<div className="card-bottom"><span className={product.stock === '有货' ? 'stock confirmed' : 'stock pending'}>{product.stock}</span><Button variant={selected ? 'primary' : 'secondary'} onClick={toggle} icon={selected ? 'check' : 'plus'}>{selected ? '已加入备选' : '加入备选'}</Button></div></div>
  </article>
}
// 工作区“当前推荐”是线程中最新推荐的只读投影：条件变更后不再随排序静默换人，而是显示过期态并给出重推入口（UI-DEC-004）。
function Decision({ recommendation, candidates, mission, currency = 'RMB', onReRecommend }: { recommendation: RecommendationMessage | null; candidates: Product[]; mission: Mission; currency?: Currency; onReRecommend: () => void }) {
  const product = recommendation ? products.find((item) => item.id === recommendation.primaryId) : candidates[0]
  if (!product) return null
  const stale = !recommendation || recommendation.basedOnVersion !== mission.version
  if (stale) return <section className="decision-card decision-stale"><div className="decision-icon"><Icon name="spark" size={20} /></div><div className="decision-copy"><span>推荐 · 待更新</span><h2>{product.brand} {product.model}</h2><p>{recommendation ? `上面的推荐基于 V${recommendation.basedOnVersion} 的条件，任务已演进到 V${mission.version}，排序可能已变化。` : '当前任务还没有生成过推荐。'}</p><div className="decision-actions"><Button variant="primary" onClick={onReRecommend}>按当前条件重新推荐</Button></div></div><div className="decision-price"><span>商品价估算</span><strong>{CURRENCY_SYMBOL[currency]}{priceIn(product.rmbPrice, currency).toLocaleString()}</strong><small>{product.nativePrice} · {product.updated}</small></div></section>
  return <section className="decision-card"><div className="decision-icon"><Icon name="spark" size={20} /></div><div className="decision-copy"><span>当前推荐 · V{mission.version}</span><h2>{product.brand} {product.model}</h2><p>{recommendation.rationale[0]} {recommendation.tradeoffs[0] ?? ''}</p><div className="decision-tags">{[mission.budget ? '商品价在预算内' : '未设置预算', preferenceText(mission.preference)].map((tag) => <span key={tag}>{tag}</span>)}</div></div><div className="decision-price"><span>商品价估算</span><strong>{CURRENCY_SYMBOL[currency]}{priceIn(product.rmbPrice, currency).toLocaleString()}</strong><small>{product.nativePrice} · {product.updated}</small></div></section>
}
function Discover({ mission, selectedIds, toggle, compare, detail, messages, append, changeConstraints, undo, undoneEventIds, reversibleEventId, reversibleSummary, currency, recommendation, onReRecommend }: { mission: Mission; selectedIds: string[]; toggle: (id: string) => void; compare: () => void; detail: (product: Product) => void; messages: ThreadMessage[]; append: (items: ThreadMessage[]) => void; changeConstraints: ChangeConstraintsFn; undo: () => void; undoneEventIds: Set<string>; reversibleEventId: string | null; reversibleSummary: string | null; currency: Currency; recommendation: RecommendationMessage | null; onReRecommend: () => void }) {
  const candidates = useMemo(() => candidatesFor(mission), [mission])
  const recommended = useMemo(() => eligibleFor(mission), [mission])
  const lowestId = candidates.length ? candidates.reduce((a, b) => a.rmbPrice <= b.rmbPrice ? a : b).id : ''
  const selected = products.filter((product) => selectedIds.includes(product.id))
  const platformCount = new Set(candidates.map((product) => product.platform)).size
  const unsupported = !supportsIntent(mission.intent)
  const hasTemporaryFilters = mission.preference !== 'balanced' || mission.onlyInStock
  const resetFilters = () => changeConstraints({ preference: 'balanced', onlyInStock: false }, '已重置筛选与排序', 'filter-bar')

  return (
    <main className="workspace-view">
      <div className="mission-header">
        <div>
          <div className="breadcrumb">我的选购 <Icon name="chevron" size={13} />推荐备选</div>
          <h1>{mission.intent}</h1>
          <div className="mission-subline"><span>{candidates.length ? '备选已就绪' : '等待补充条件'}</span>{candidates.length > 0 && <span>{candidates.length} 件备选{candidates.length === 1 ? '' : ` · ${platformCount} 个平台`}</span>}</div>
        </div>
      </div>
      <StageRail current="discover" />
      <FxStrip candidates={candidates} />
      <div className="workspace-layout">
        <Conversation mission={mission} selectedCount={selected.length} canCompare={selected.length >= 2} compare={compare} messages={messages} append={append} changeConstraints={changeConstraints} undo={undo} undoneEventIds={undoneEventIds} reversibleEventId={reversibleEventId} reversibleSummary={reversibleSummary} openProduct={detail} onReRecommend={onReRecommend} />
        <section className="results-region">
          <EvidenceStrip candidates={candidates} />
          {unsupported ? (
            <section className="empty-result is-waiting">
              <Icon name="info" size={24} />
              <h2>正在等你补充信息</h2>
              <p>我还需要确认商品类别才能检索备选。请在左侧对话里选择一个选项，或直接描述你想找的东西。</p>
            </section>
          ) : (
            <>
              <DecisionOverview candidates={candidates} eligibleCount={recommended.length} platformCount={platformCount} mission={mission} />
              {recommended.length || recommendation ? (
                <Decision recommendation={recommendation} candidates={recommended} mission={mission} currency={currency} onReRecommend={onReRecommend} />
              ) : (
                <section className="empty-result">
                  <Icon name="search" size={24} />
                  <h2>预算内暂无符合条件的备选</h2>
                  <p>备选已按当前条件展示；可以提高预算、调整偏好或显示全部库存。</p>
                  <Button onClick={() => changeConstraints({ onlyInStock: false }, '库存：显示全部', 'quick-action')}>显示全部库存</Button>
                </section>
              )}
              <div className="candidate-section-heading"><div><span className="section-eyebrow">候选证据</span><h2>核对后加入比较</h2></div><p>每张卡片代表一个可比较候选，先看推荐依据，再决定是否加入。</p></div>
              <div className="filter-bar">
                <div className="result-count"><strong>{candidates.length}</strong> 件备选 {platformCount > 0 && <span>· {platformCount} 个平台</span>}</div>
                <div className="filter-actions">
                  <button onClick={() => changeConstraints({ onlyInStock: !mission.onlyInStock }, mission.onlyInStock ? '库存：显示全部' : '库存：仅看有货', 'filter-bar')}><Icon name="filter" size={15} />{mission.onlyInStock ? '显示全部库存' : '只看有货'}</button>
                  <select value={mission.preference} onChange={(event) => changeConstraints({ preference: event.target.value as Preference }, `排序：${preferenceText(event.target.value as Preference)}`, 'filter-bar')} aria-label="备选排序">
                    <option value="balanced">综合推荐</option>
                    <option value="lowest">按商品价</option>
                    {supportsAudioPriorities(mission) && <><option value="noise">优先降噪</option><option value="battery">优先续航</option></>}
                  </select>
                  {mission.preference !== 'balanced' && <button className="active-filter-chip" onClick={() => changeConstraints({ preference: 'balanced' }, '排序：综合推荐', 'filter-bar')} aria-label={`移除${preferenceText(mission.preference)}排序`}>{preferenceText(mission.preference)} <Icon name="close" size={13} /></button>}
                  {mission.onlyInStock && <button className="active-filter-chip" onClick={() => changeConstraints({ onlyInStock: false }, '库存：显示全部', 'filter-bar')} aria-label="移除仅看有货筛选">只看有货 <Icon name="close" size={13} /></button>}
                  {hasTemporaryFilters && <><span className="filter-divider" aria-hidden="true" /><button className="clear-filters-button" onClick={resetFilters} title="恢复为综合推荐，并显示全部库存；不会修改商品需求、预算或已选商品">清除筛选</button></>}
                </div>
              </div>
              <section className="product-results">
                <div className="products-grid">
                  {candidates.map((product, index) => <CandidateCard key={product.id} product={product} rank={index + 1} selected={selectedIds.includes(product.id)} toggle={() => toggle(product.id)} detail={() => detail(product)} budget={mission.budget} preference={mission.preference} lowest={product.id === lowestId} currency={currency} lead={recommended[0]?.id === product.id} />)}
                </div>
              </section>
            </>
          )}
          {/* 比较托盘吸附在结果列内（sticky），不会越过左栏遮挡对话面板 */}
          {selected.length > 0 && <div className="compare-tray">
            <div><span className="tray-count">{selected.length}</span><strong>已选商品</strong><small>最多 4 件</small></div>
            <div className="tray-items">{selected.map((product) => <button key={product.id} onClick={() => toggle(product.id)}>{product.brand} · 约 ¥{product.rmbPrice.toLocaleString()} <Icon name="close" size={13} /></button>)}</div>
            <Button variant="primary" onClick={compare} disabled={selected.length < 2} icon="arrow">开始对比</Button>
          </div>}
        </section>
      </div>
    </main>
  )
}
function Compare({ mission, selectedIds, back, detail, changeConstraints, onRemove, messages, append, undo, undoneEventIds, reversibleEventId, reversibleSummary, currency, onReRecommend }: { mission: Mission; selectedIds: string[]; back: () => void; detail: (product: Product) => void; changeConstraints: ChangeConstraintsFn; onRemove: (id: string) => void; messages: ThreadMessage[]; append: (items: ThreadMessage[]) => void; undo: () => void; undoneEventIds: Set<string>; reversibleEventId: string | null; reversibleSummary: string | null; currency: Currency; onReRecommend: () => void }) {
  const items = products.filter((product) => selectedIds.includes(product.id))
  const lowestId = items.length ? items.reduce((a, b) => a.rmbPrice <= b.rmbPrice ? a : b).id : ''
  if (items.length < 2) return <main className="workspace-view"><section className="empty-result"><Icon name="grid" size={24} /><h2>还需要至少 2 件备选</h2><p>先在备选页加入商品，再进行横向比较。</p><Button variant="primary" onClick={back}>返回备选页</Button></section></main>
  const lead = candidatesFor(mission).filter((product) => selectedIds.includes(product.id))[0]
  const explanation = mission.preference === 'battery' && batteryHours(lead) ? `续航 ${batteryHours(lead)} 小时，是已选商品中最长的。` : mission.preference === 'noise' && lead.brand === 'Bose' ? '降噪取向与当前偏好最一致。' : `商品参考价约 ¥${lead.rmbPrice.toLocaleString()}，是已选商品中更低的一件。`
  const isHeadphone = intentCategory(mission.intent) === 'headphones'
  const maxBattery = isHeadphone ? Math.max(...items.map((product) => batteryHours(product))) : 0
  const tableStyle = { '--compare-columns': items.length } as CSSProperties
  return <main className="workspace-view compare-view">
    <div className="mission-header">
      <div><div className="breadcrumb"><button onClick={back}>推荐备选</button><Icon name="chevron" size={13} />对比所选</div><h1>在 {items.length} 件备选中做决定</h1><div className="mission-meta"><span>选购 V{mission.version}</span><span>继续提问可更新推荐</span></div></div>
      <button className="button button-quiet" onClick={back}><Icon name="back" size={15} />再挑备选</button>
    </div>
    <StageRail current="compare" />
    <FxStrip candidates={items} />
    <div className="workspace-layout">
      <Conversation mission={mission} selectedCount={selectedIds.length} canCompare={true} comparing compare={() => {}} messages={messages} append={append} changeConstraints={changeConstraints} undo={undo} undoneEventIds={undoneEventIds} reversibleEventId={reversibleEventId} reversibleSummary={reversibleSummary} openProduct={detail} onReRecommend={onReRecommend} />
      <section className="results-region">
        <DecisionOverview candidates={items} eligibleCount={eligibleFor(mission).filter((product) => selectedIds.includes(product.id)).length} platformCount={new Set(items.map((product) => product.platform)).size} mission={mission} />
        <section className="decision-card compare-decision"><div className="decision-icon"><Icon name="spark" size={20} /></div><div className="decision-copy"><span>比较首选 · 按当前排序</span><h2>{lead.brand} {lead.model}</h2><p>{explanation}</p><small className="decision-boundary">此首选由当前条件实时排序得出，与时间线中基于版本的任务推荐相互独立；运费、税费与配送资格以商户结算页为准。</small></div><div className="decision-price"><span>商品价估算</span><strong>{CURRENCY_SYMBOL[currency]}{priceIn(lead.rmbPrice, currency).toLocaleString()}</strong><small>{lead.nativePrice} · {lead.updated}</small></div></section>
        <EvidenceStrip candidates={items} />
        <section className="comparison-table-wrap">
          <div className="table-toolbar"><span>关键差异</span><span>先比较商品价与取舍，再打开详情核对完整信息</span></div>
          <div className="comparison-table revised-table" style={tableStyle}>
            <div className="comparison-label-column"><div>候选</div><div>商品价</div><div>关键差异</div><div>操作</div></div>
            {items.map((product) => {
              const isLead = product.id === lead.id
              const isLowest = product.id === lowestId
              const missingStock = product.stock === '暂无库存信息'
              const bestBattery = isHeadphone && batteryHours(product) > 0 && batteryHours(product) === maxBattery
              return <div className={`comparison-product ${isLead ? 'is-recommended' : ''}`} key={product.id}>
                <div className="comparison-product-head">
                  <div className="cmp-head-tags">{isLead && <span className="compare-tag">当前推荐</span>}{isLowest && <span className="cmp-badge cmp-badge--lowest">最低价</span>}{missingStock && <span className="cmp-badge cmp-badge--missing">库存待确认</span>}</div>
                  <button className="column-remove" onClick={() => onRemove(product.id)} aria-label={`移除 ${product.brand}`} title="移出对比"><Icon name="close" size={13} /></button>
                  <Mark product={product} />
                  <button className="cmp-head-title" onClick={() => detail(product)}>{product.title}<Icon name="external" size={13} /></button>
                  <div className="cmp-head-meta"><span>{product.market}</span>{product.stock === '有货' ? <span className="stock-chip confirmed">有货</span> : product.stock === '库存有限' ? <span className="stock-chip pending">库存有限</span> : <span className="cmp-badge cmp-badge--missing">库存待确认</span>}</div>
                </div>
                <div className="compare-cell price-cell"><PriceEvidence product={product} compact lowest={isLowest} currency={currency} compare /></div>
                <div className="compare-cell insight-cell"><p>{product.tradeoff}</p><div className="insight-specs">{product.specs.slice(0, 2).map((spec) => { const best = bestBattery && /续航/.test(spec); return <span key={spec} className={best ? 'spec-best' : ''}>{spec}{best && <em>最长</em>}</span> })}</div></div>
                <div className="compare-cell action-cell"><Button onClick={() => detail(product)}>查看详情</Button></div>
              </div>
            })}
          </div>
        </section>
      </section>
    </div>
  </main>
}
function Drawer({ product, selected, close, toggle, signedIn, favorite, onFavorite, currency }: { product: Product; selected: boolean; close: () => void; toggle: () => void; signedIn: boolean; favorite: boolean; onFavorite: () => void; currency: Currency }) { const domain = new URL(product.url).hostname; return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><aside className="product-drawer" aria-label="商品详情"><div className="drawer-top"><span>商品详情</span><button className="icon-button" onClick={close} aria-label="关闭"><Icon name="close" size={18} /></button></div><div className={`drawer-image tone-${product.tone}`}><span className="category-icon" aria-hidden="true"><Icon name={categoryIcon[productCategory(product)]} size={56} /></span></div><div className="drawer-body"><div className="product-source"><span><Mark product={product} /> {product.platform}</span><span>{product.market}</span></div><h2>{product.title}</h2><PriceEvidence product={product} currency={currency} /><section className="drawer-section"><div className="section-title">商品信息</div><div className="spec-pills">{product.specs.map((spec) => <span key={spec}>{spec}</span>)}</div><p className="drawer-description">评分 {product.rating} · {product.reviews.toLocaleString()} 条评价 · 库存：{product.stock} · {product.updated}</p><p className="drawer-tradeoff"><b>适合谁</b>{product.tradeoff}</p></section><section className="purchase-check"><span>查看商户报价</span><p>本服务只负责比较；{domain} 将提供商品详情与交易。</p><a className="button button-primary merchant-link" href={product.url} target="_blank" rel="noreferrer">前往 {product.platform} 查看<Icon name="external" size={15} /></a><small>商品价以商户结算页为准。</small></section></div><div className="drawer-footer"><Button variant={favorite ? 'primary' : 'secondary'} onClick={onFavorite} icon={favorite ? 'check' : 'heart'}>{!signedIn ? '登录后收藏' : favorite ? '已收藏' : '收藏'}</Button><Button variant={selected ? 'primary' : 'secondary'} onClick={toggle}>{selected ? '已加入备选' : '加入备选'}</Button><Button variant="quiet" onClick={close}>返回选购</Button></div></aside></div> }
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
    <form className="login-modal" role="dialog" aria-modal="true" aria-label="登录跨境选物台" onSubmit={submit}>
      <button type="button" className="icon-button login-close" onClick={onClose} aria-label="关闭"><Icon name="close" size={18} /></button>
      <aside className="login-brand">
        <div className="login-brand-head"><span className="login-brand-mark">ir</span><div><strong>跨境选物台</strong><small>跨平台商品价比较</small></div></div>
        <p className="login-brand-slogan">说清想买什么，我们跨平台比价，给出原价、汇率时间与商户链接的证据化推荐。</p>
        <ul className="login-brand-points"><li>跨平台聚合 · 多市场备选</li><li>人民币统一换算，保留原币种</li><li>推荐附原价、汇率时间与证据</li></ul>
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
          <div className="auth-links"><button type="button" onClick={() => goto('register')}>新用户注册</button><button type="button" onClick={() => goto('reset')}>忘记密码</button></div>
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
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="account-drawer" role="dialog" aria-label="账号与偏好"><div className="account-head"><span>账号与偏好</span><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" size={18} /></button></div><div className="account-body"><div className="account-profile"><span className="avatar-large">{user.name.slice(0, 1)}</span><div className="account-profile-main">{editing ? <div className="account-name-edit"><input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus aria-label="昵称" /><button type="button" onClick={saveName}>保存</button><button type="button" onClick={() => { setEditing(false); setDraft(user.name) }}>取消</button></div> : <div className="account-name-row"><b>{user.name}</b><button className="icon-button" onClick={() => setEditing(true)} aria-label="编辑昵称"><Icon name="edit" size={14} /></button></div>}<p>+86 {maskPhone(user.phone)} · 手机号登录 · 加入于 {user.memberSince}</p></div></div><section className="account-section"><div className="section-title"><Icon name="settings" size={15} />偏好记忆</div><div className="account-row"><span className="account-row-label">新选购默认排序<small>未指定偏好时，新建选购沿用此排序依据</small></span><select className="account-select" value={defaultPreference} onChange={(event) => onDefaultPreference(event.target.value as Preference)} aria-label="新选购默认排序"><option value="balanced">综合推荐</option><option value="lowest">按商品价</option></select></div><div className="account-row"><span className="account-row-label">比较货币<small>价格按所选货币换算显示</small></span><span className="account-chip">{currency} · {CURRENCY_NAME[currency]}</span></div></section><section className="account-section"><div className="section-title"><Icon name="heart" size={15} />我的收藏</div>{favItems.length ? <div className="account-fav-list">{favItems.map((product) => <button key={product.id} className="account-fav" onClick={() => openProduct(product)}><Icon name="chevron" size={13} />{product.brand} {product.model} · 约 ¥{product.rmbPrice.toLocaleString()}</button>)}</div> : <p className="account-fav-empty">还没有收藏商品。在商品详情页点“收藏”，收藏会随账号保存。</p>}</section><section className="account-section"><div className="section-title"><Icon name="bell" size={15} />价格提醒</div><div className="account-row"><span className="account-row-label">人民币目标价 / 降价提醒<small>收藏后设置目标价，降价时通知你</small></span><span className="plan-badge">即将上线</span></div></section><section className="account-section"><div className="section-title"><Icon name="info" size={15} />安全与隐私</div><div className="account-row"><span className="account-row-label">当前会话<small>{sessionText}</small></span><span className="account-chip">{user.remember ? '保持登录' : '本次会话'}</span></div><div className="account-row"><span className="account-row-label">登录密码<small>{hasPassword ? '已设置，可用密码登录' : '未设置，仅支持验证码登录'}</small></span><button className="account-link-btn" onClick={onManagePassword}>{hasPassword ? '修改密码' : '设置密码'} <Icon name="edit" size={13} /></button></div><div className="account-row"><span className="account-row-label">协议与隐私</span><button className="account-link-btn" onClick={() => setShowPrivacy(!showPrivacy)}>《用户协议》《隐私政策》<Icon name="chevron" size={13} /></button></div>{showPrivacy && <div className="login-agreement">本服务仅保存手机号、昵称、收藏与偏好，用于账号恢复与个性化推荐；不收集支付信息，验证码仅用于本次登录。你可以随时导出或删除自己的数据。</div>}<div className="account-row"><span className="account-row-label">导出我的数据<small>下载账号信息、收藏、偏好与选购概览</small></span><button className="account-link-btn" onClick={onExport}>导出 <Icon name="download" size={13} /></button></div><div className="account-row">{confirmDelete ? <div className="account-delete-confirm"><span>确认删除？将清除账号收藏与偏好并退出登录。</span><button onClick={onDeleteAccount}>确认删除</button><button onClick={() => setConfirmDelete(false)}>取消</button></div> : <span className="account-row-label">删除账号<small>清除本账号的收藏与偏好，不可恢复</small></span>}{!confirmDelete && <button className="account-danger-btn" onClick={() => setConfirmDelete(true)}><Icon name="trash" size={13} />删除</button>}</div></section><button className="account-logout" onClick={onLogout}><Icon name="logout" size={15} />退出登录</button><p className="account-privacy">数据将按《隐私政策》处理；你可随时在“安全与隐私”中导出或删除自己的数据。</p></div></aside></div>
}
function TaskRow({ task, isCurrent, open, onDelete }: { task: ShoppingTask; isCurrent: boolean; open: () => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const view = projectMission(task.events, task.lastSurface)
  return <div className={`task-list-entry ${isCurrent ? 'is-current' : ''}`}>
    <button className="task-list-item" onClick={open}><div><strong>{view.mission.intent}</strong><p>{budgetText(view.mission)} · {preferenceText(view.mission.preference)}{view.mission.onlyInStock ? ' · 仅看有货' : ''} · V{view.mission.version}</p></div><div className="task-list-meta"><span>{isCurrent ? '当前处理' : phaseText(view.phase, view.selected)}</span><small>{task.updatedAt} 更新</small></div><Icon name="arrow" size={16} /></button>
    {confirming
      ? <div className="task-delete-confirm"><span>删除这笔选购？不可恢复。</span><button onClick={onDelete}>确认删除</button><button onClick={() => setConfirming(false)}>取消</button></div>
      : <button className="task-delete" aria-label={`删除 ${view.mission.intent}`} title="删除这笔选购" onClick={() => setConfirming(true)}><Icon name="trash" size={13} />删除</button>}
  </div>
}
function TaskList({ tasks, activeId, open, create, onDelete }: { tasks: ShoppingTask[]; activeId: number | null; open: (id: number) => void; create: () => void; onDelete: (id: number) => void }) { return <main className="task-list-view"><div className="task-list-header"><div><h1>我的选购</h1><p>每笔选购保留自己的对话、条件、备选与比较进度。</p></div><Button variant="primary" onClick={create} icon="plus">新建选购</Button></div>{tasks.length ? <section className="task-list" aria-label="已保存的选购">{tasks.map((task) => <TaskRow key={task.id} task={task} isCurrent={task.id === activeId} open={() => open(task.id)} onDelete={() => onDelete(task.id)} />)}</section> : <section className="task-list-empty"><Icon name="spark" size={24} /><h2>还没有选购</h2><p>新建一笔选购后，可以随时在这里继续对话和比较。</p><Button variant="primary" onClick={create}>新建选购</Button></section>}</main> }
function QuickSwitcher({ tasks, activeId, open, close, allTasks, create }: { tasks: ShoppingTask[]; activeId: number | null; open: (id: number) => void; close: () => void; allTasks: () => void; create: () => void }) { const [query, setQuery] = useState(''); const items = [...tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs).map((task) => ({ task, view: projectMission(task.events, task.lastSurface) })).filter(({ view }) => `${view.mission.intent} ${budgetText(view.mission)} ${preferenceText(view.mission.preference)}${view.mission.onlyInStock ? ' 仅看有货' : ''}`.includes(query.trim())); return <div className="switcher-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section className="task-switcher" role="dialog" aria-modal="true" aria-label="切换选购"><div className="switcher-heading"><div><strong>切换选购</strong><small>将恢复各选购上次的工作现场</small></div><button onClick={close} aria-label="关闭选购切换"><Icon name="close" size={16} /></button></div><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索选购名称、预算或偏好" aria-label="搜索选购" />{items.length ? <div className="switcher-list">{items.slice(0, 6).map(({ task, view }) => <button className={task.id === activeId ? 'is-current' : ''} key={task.id} onClick={() => open(task.id)}><span><b>{view.mission.intent}</b><small>{budgetText(view.mission)} · {preferenceText(view.mission.preference)}{view.mission.onlyInStock ? ' · 仅看有货' : ''} · V{view.mission.version} · {task.updatedAt}</small></span>{task.id === activeId && <em>当前</em>}</button>)}</div> : <p className="switcher-empty">未找到匹配的选购</p>}<div className="switcher-footer"><button onClick={allTasks}>查看全部选购</button><button onClick={create}>新建选购</button></div></section></div> }
function CurrencyPicker({ currency, set, close }: { currency: Currency; set: (c: Currency) => void; close: () => void }) { const options: Currency[] = ['RMB', 'USD', 'SGD']; return <div className="currency-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section className="currency-popover" role="dialog" aria-label="比较货币"><div className="switcher-heading"><div><strong>比较货币</strong><small>价格按所选货币换算显示</small></div><button onClick={close} aria-label="关闭"><Icon name="close" size={16} /></button></div><div className="currency-list">{options.map((c) => <button className={c === currency ? 'is-current' : ''} key={c} onClick={() => { set(c); close() }}><b>{c}</b><small>{CURRENCY_NAME[c]} · {CURRENCY_SYMBOL[c]}</small>{c === currency && <em>当前</em>}</button>)}</div><p className="currency-note">商品价先统一换算为人民币，再按所选货币显示；运费与税费以商户结算页为准。</p></section></div> }
export default function App() {
  const [view, setView] = useState<View>('home')
  const [tasks, setTasks] = useState<ShoppingTask[]>(() => { try { const saved = localStorage.getItem('interecagent.tasks'); const parsed = saved ? JSON.parse(saved) : []; return Array.isArray(parsed) ? parsed.map((raw) => migrateTask(raw as LegacyTask)).filter((task): task is ShoppingTask => task !== null) : [] } catch { return [] } })
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
  const projection = useMemo(() => projectMission(activeTask?.events ?? [], activeTask?.lastSurface ?? 'discover'), [activeTask])
  const latestRecommendation = useMemo(() => { const list = activeTask?.messages ?? []; for (let index = list.length - 1; index >= 0; index -= 1) { const message = list[index]; if (message.kind === 'recommendation') return message } return null }, [activeTask])
  const { appendMessages, changeConstraints, undoLatest, changeSelection } = useMissionCommand(activeTaskId, setTasks)
  const reRecommend = useCallback(() => { const recommendation = buildRecommendation(projection.mission); if (recommendation) appendMessages([recommendation]) }, [appendMessages, projection.mission])
  const append = appendMessages
  const undo = useCallback(() => { undoLatest('quick-action') }, [undoLatest])
  const toggle = useCallback((id: string) => { changeSelection(id, !projection.selected.includes(id), 'workspace') }, [changeSelection, projection.selected])
  const setSurface = (surface: 'discover' | 'compare') => { if (!activeTask) return; setTasks((current) => current.map((task) => task.id === activeTask.id ? { ...task, lastSurface: surface, updatedAt: nowText(), updatedAtMs: Date.now() } : task).sort((a, b) => b.updatedAtMs - a.updatedAtMs)) }
  const compare = () => {
    if (!activeTask || projection.selected.length < 2) return
    // 决策里程碑留痕：进入比较是任务的关键转折，写进线程时间线。
    const names = projection.selected.map((productId) => products.find((product) => product.id === productId)?.brand ?? productId).join('、')
    appendMessages([{ id: uid('m'), kind: 'milestone', at: Date.now(), text: `开始比较 ${names}` }])
    setSurface('compare'); setView('compare')
  }
  const backToCandidates = () => { setSurface('discover'); setView('discover') }
  const deleteTask = (taskId: number) => { setTasks((current) => current.filter((task) => task.id !== taskId)); if (activeTaskId === taskId) { setActiveTaskId(null); setView('home') } }
  // Escape 逐层关闭覆盖层；覆盖层打开时锁定背景滚动（防滚动穿透）。
  const overlayOpen = Boolean(detail) || switcherOpen || currencyOpen || accountOpen || loginOpen
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (detail) setDetail(null)
      else if (switcherOpen) setSwitcherOpen(false)
      else if (currencyOpen) setCurrencyOpen(false)
      else if (accountOpen) setAccountOpen(false)
      else if (loginOpen) { resumeRef.current = null; setLoginOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, switcherOpen, currencyOpen, accountOpen, loginOpen])
  useEffect(() => { document.body.style.overflow = overlayOpen ? 'hidden' : ''; return () => { document.body.style.overflow = '' } }, [overlayOpen])
  useEffect(() => { localStorage.setItem('interecagent.tasks', JSON.stringify(tasks)); if (activeTaskId !== null) localStorage.setItem('interecagent.active-task', String(activeTaskId)); else localStorage.removeItem('interecagent.active-task') }, [tasks, activeTaskId])
  useEffect(() => { if (user) localStorage.setItem('interecagent.user', JSON.stringify(user)); else localStorage.removeItem('interecagent.user'); localStorage.setItem('interecagent.default-pref', defaultPreference); localStorage.setItem('interecagent.currency', currency); localStorage.setItem(user ? accountFavKey(user.phone) : 'interecagent.favs', JSON.stringify(favorites)) }, [user, defaultPreference, favorites, currency])
  const notify = (text: string) => { if (toastTimer.current) window.clearTimeout(toastTimer.current); const id = Date.now(); setToast({ id, text }); toastTimer.current = window.setTimeout(() => setToast(null), 2600) }
  const openLogin = () => { setLoginConfig({ flow: 'login', phone: '' }); setAccountOpen(false); setLoginOpen(true) }
  const openAccount = () => setAccountOpen(true)
  const openPassword = () => { setLoginConfig({ flow: 'reset', phone: user?.phone ?? '' }); setAccountOpen(false); setLoginOpen(true) }
  const login = (next: AccountUser) => { const merged = [...new Set([...readFavs(accountFavKey(next.phone)), ...readFavs('interecagent.favs'), ...favorites])]; localStorage.removeItem('interecagent.favs'); localStorage.setItem(accountFavKey(next.phone), JSON.stringify(merged)); setFavorites(merged); setUser(next); setLoginOpen(false); notify('已登录'); const resume = resumeRef.current; resumeRef.current = null; if (resume?.view) setView(resume.view); else if (resume?.query) beginTask(resume.query) }
  const logout = () => { if (user) localStorage.setItem(accountFavKey(user.phone), JSON.stringify(favorites)); setUser(null); setFavorites(readFavs('interecagent.favs')); setAccountOpen(false); setView('home'); notify('已退出登录') }
  const rename = (name: string) => { if (!user) return; setUser({ ...user, name }); notify('资料已保存') }
  const exportData = () => { if (!user) return; const payload = { profile: { phone: user.phone, name: user.name, memberSince: user.memberSince }, preferences: { defaultPreference, currency }, favorites: products.filter((product) => favorites.includes(product.id)).map((product) => ({ id: product.id, brand: product.brand, model: product.model, rmbPrice: product.rmbPrice })), tasks: tasks.map((task) => { const snapshot = projectMission(task.events, task.lastSurface); return { intent: snapshot.mission.intent, phase: snapshot.phase, version: snapshot.mission.version, updatedAt: task.updatedAt } }) }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `interecagent-${user.phone}-export.json`; link.click(); URL.revokeObjectURL(url); notify('数据已导出') }
  const deleteAccount = () => { if (!user) return; const users = readUsers(); if (users[user.phone]) { delete users[user.phone]; writeUsers(users) } localStorage.removeItem(accountFavKey(user.phone)); localStorage.removeItem('interecagent.default-pref'); localStorage.removeItem('interecagent.favs'); setFavorites([]); setUser(null); setAccountOpen(false); setView('home'); notify('账号已删除') }
  const toggleFavorite = (id: string) => setFavorites((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const beginTask = (query: string) => {
    const id = Date.now(); const mission = createMission(query, id, defaultPreference); const time = nowText()
    const known = supportsIntent(mission.intent)
    const opening: ThreadMessage[] = []
    if (known) {
      const actions = supportsAudioPriorities(mission) ? ['优先降噪', '优先续航', '先看综合推荐'] : ['按商品价排序', '先看综合推荐']
      opening.push({ id: uid('m'), kind: 'text', role: 'agent', at: id, createdVersion: 1, text: `已识别“${mission.intent}”${mission.budget ? `，商品价预算 ${budgetText(mission)}` : ''}。备选已按「${preferenceText(mission.preference)}」整理在右侧，原币价与汇率时间见价格证据。你可以继续告诉我新条件，或用下方快捷按钮调整；商品价为估算，运费、税费和配送资格以商户结算页为准。`, actions })
      if (mission.budget === undefined) opening.push({ id: uid('m'), kind: 'warning', at: id, basedOnVersion: 1, text: '这条需求没有提到人民币预算，当前备选未按预算过滤；告诉我预算后我会重新筛选。' })
      const recommendation = buildRecommendation(mission)
      if (recommendation) opening.push(recommendation)
    } else {
      // 硬缺失：先问一个问题再检索，结果区保持等待态（UI-DEC-003），不预渲染候选。
      opening.push({ id: uid('m'), kind: 'text', role: 'agent', at: id, text: '我还没确定你要找的商品类别。先回答左侧的问题，我再检索备选。' })
      opening.push({ id: uid('m'), kind: 'clarification', at: id, question: '你想找的是哪一类商品？', options: ['通勤降噪耳机', '27 寸 4K 显示器', '轻便徒步鞋'] })
    }
    const task: ShoppingTask = { id, events: [{ id: uid('evt'), type: 'mission-created', at: id, source: 'system', mission }], messages: opening, lastSurface: 'discover', createdAt: time, updatedAt: time, updatedAtMs: id }
    setTasks((current) => [task, ...current]); setActiveTaskId(id); setView('discover')
  }
  const start = (query: string) => { if (!user) { resumeRef.current = { query }; openLogin(); return } beginTask(query) }
  const guide = (next: View) => { if (next === 'home') { setView('home'); return } if (!user) { resumeRef.current = { view: next }; openLogin(); return } setView(next) }
  const openTask = (id: number) => { const task = tasks.find((item) => item.id === id); if (!task) return; setActiveTaskId(id); setSwitcherOpen(false); setView(task.lastSurface) }
  return <div className="app-shell"><Header view={view} go={guide} user={user} openLogin={openLogin} openAccount={openAccount} activeIntent={activeTask ? projection.mission.intent : undefined} onSwitch={() => setSwitcherOpen(true)} currency={currency} onCurrency={() => setCurrencyOpen(true)} />{view === 'home' && <Home start={start} />}{view === 'tasks' && <TaskList tasks={[...tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs)} activeId={activeTaskId} open={openTask} create={() => setView('home')} onDelete={deleteTask} />}{view === 'discover' && activeTask && <Discover mission={projection.mission} selectedIds={projection.selected} toggle={toggle} compare={compare} detail={setDetail} messages={activeTask.messages} append={append} changeConstraints={changeConstraints} undo={undo} undoneEventIds={projection.undoneEventIds} reversibleEventId={projection.reversibleEventId} reversibleSummary={projection.reversibleSummary} currency={currency} recommendation={latestRecommendation} onReRecommend={reRecommend} />}{view === 'compare' && activeTask && <Compare mission={projection.mission} selectedIds={projection.selected} back={backToCandidates} detail={setDetail} changeConstraints={changeConstraints} onRemove={toggle} messages={activeTask.messages} append={append} undo={undo} undoneEventIds={projection.undoneEventIds} reversibleEventId={projection.reversibleEventId} reversibleSummary={projection.reversibleSummary} currency={currency} onReRecommend={reRecommend} />}{detail && activeTask && <Drawer product={detail} selected={projection.selected.includes(detail.id)} close={() => setDetail(null)} toggle={() => toggle(detail.id)} signedIn={!!user} favorite={!!user && favorites.includes(detail.id)} onFavorite={() => { if (!user) openLogin(); else toggleFavorite(detail.id) }} currency={currency} />}{switcherOpen && <QuickSwitcher tasks={tasks} activeId={activeTaskId} open={openTask} close={() => setSwitcherOpen(false)} allTasks={() => { setSwitcherOpen(false); setView('tasks') }} create={() => { setSwitcherOpen(false); setView('home') }} />}{currencyOpen && <CurrencyPicker currency={currency} set={setCurrency} close={() => setCurrencyOpen(false)} />}{loginOpen && <LoginModal key={`${loginConfig.flow}:${loginConfig.phone}`} initialFlow={loginConfig.flow} initialPhone={loginConfig.phone} onClose={() => { resumeRef.current = null; setLoginOpen(false) }} onLogin={login} />}{accountOpen && user && <AccountDrawer user={user} onClose={() => setAccountOpen(false)} onLogout={logout} onRename={rename} onExport={exportData} onDeleteAccount={deleteAccount} onManagePassword={openPassword} hasPassword={!!readUsers()[user.phone]?.passwordHash} favorites={products.filter((product) => favorites.includes(product.id))} openProduct={(product) => { setAccountOpen(false); setDetail(product) }} defaultPreference={defaultPreference} onDefaultPreference={setDefaultPreference} currency={currency} />}{toast && <div className="app-toast" key={toast.id} role="status">{toast.text}</div>}</div>
}
