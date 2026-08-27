import type { RankedComparableOffer, ValidatedDecision } from "./types.js";

function renderOffer(item: RankedComparableOffer, label: string): string {
  const offer = item.offer;
  const stock = offer.stock === "IN_STOCK" ? "已观察到有货" : offer.stock === "OUT_OF_STOCK" ? "已观察到缺货" : "库存未知";
  const market = offer.marketEvidence.level === "TARGET_DOMAIN_MARKET_CONSISTENT" ? `${offer.retrievalMarket}（目标站点域名与市场一致）` : `${offer.retrievalMarket}（仅 Provider 市场归类，未验证配送）`;
  const condition = offer.condition === "UNKNOWN" ? "商品状态未知" : `商品状态：${offer.condition}`;
  return `${label}：${offer.title}\n- ${offer.originalMoney.amount} ${offer.originalMoney.currency}（约 ¥${offer.cnyEstimate.amount}）\n- 检索范围：${market}\n- ${offer.merchant}（${offer.merchantDomain}）\n- ${condition}；${stock}；观察时间 ${offer.observedAt}\n- ${offer.outboundUrl}`;
}

export function renderDecision(decision: ValidatedDecision): string {
  if (decision.mode === "CLARIFICATION") return "还需要一个明确的商品名称或型号，才能开始证据化比较。";
  if (decision.mode === "NO_MATCH") return "本次检索没有形成证据完整、身份一致且市场信息不冲突的可比较报价。未验证候选不会进入推荐。";
  if (decision.mode === "FAILED") return "本次研究未能可靠完成，请稍后重试。";
  if (!decision.primaryOffer) throw new Error("Validated recommendation lacks primary offer");
  const blocks = [renderOffer(decision.primaryOffer, "主推荐")];
  decision.alternatives.forEach((item, index) => blocks.push(renderOffer(item, `备选 ${index + 1}`)));
  blocks.push("说明：人民币金额按已记录汇率快照估算，不含税费、运费和支付成本；市场归类不等于配送资格，最终条件以商户结算页为准。");
  return blocks.join("\n\n");
}
