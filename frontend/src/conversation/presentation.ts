import { ApiError } from './client'
import type { Message, QuoteLead, QuoteLeadPriceRange } from './types'

export const EVENT_LABELS: Record<string, string> = {
  'turn.accepted': '已接收请求',
  'turn.claimed': '正在理解意图',
  'turn.started': '正在执行核验',
  'assistant.message.committed': '已发布本轮结果',
}

export const DISCLOSURE_LABELS: Record<string, string> = {
  MERCHANT_PAGE_CHECK_REQUIRED: '最终价格、型号/版本、成色和可购买性以商家页为准',
  AFFILIATE_LINK_DISCLOSURE: '部分入口可能含推广或联盟关系',
  PROVIDER_RESULT_NOT_MARKET_ABSENCE: '本次无结果不代表市场不存在',
}

export function displayError(error: unknown): string {
  if (error instanceof ApiError) {
    const labels: Record<string, string> = {
      AUTHENTICATION_REQUIRED: '访问令牌无效或已过期。',
      REVISION_CONFLICT: '对话状态已更新，请刷新后重试。',
      CONVERSATION_TURN_ACTIVE: '上一轮仍在处理中。',
      CONVERSATION_NOT_FOUND: '这段对话不存在或已不可访问。',
    }
    return labels[error.code] ?? `请求失败（${error.code}）`
  }
  return error instanceof Error ? error.message : '发生未知错误。'
}

export function messageText(message: Message): string {
  return String(message.payload.text ?? message.payload.content ?? '')
}

export function conditionLabel(condition: QuoteLead['condition']): string {
  return {
    NEW: '全新',
    REFURBISHED: '翻新',
    USED: '二手',
    UNKNOWN: '成色未标明',
  }[condition]
}

function formatCurrency(amount: string, currency: string): string {
  return `${currency} ${amount}`
}

export function rangeText(range: QuoteLeadPriceRange): string {
  const { originalPrice } = range
  const minimum = formatCurrency(originalPrice.minAmount, originalPrice.currency)
  const maximum = formatCurrency(originalPrice.maxAmount, originalPrice.currency)
  return originalPrice.minAmount === originalPrice.maxAmount ? minimum : `${minimum} – ${maximum}`
}

export function cnyText(range: QuoteLeadPriceRange): string | null {
  if (!range.cnyEstimate) return null
  const minimum = formatCurrency(range.cnyEstimate.minAmount, 'CNY')
  const maximum = formatCurrency(range.cnyEstimate.maxAmount, 'CNY')
  return range.cnyEstimate.minAmount === range.cnyEstimate.maxAmount
    ? `约 ${minimum}`
    : `约 ${minimum} – ${maximum}`
}

export function formatObservedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}
