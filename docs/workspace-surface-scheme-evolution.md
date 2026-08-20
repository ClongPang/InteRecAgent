# 工作台表面：问题与方案变迁

**版本**：1.0  
**日期**：2026-08-20  
**项目**：InteRecAgent · 跨境选物台  
**文档类型**：问题复盘 + 方案取舍  
**范围**：直播验收后用户能直接碰到的两层表面：商户商品页跳转、工作台视觉层次。不改推荐事实、不改 DST、不改 LangGraph 外层边。

本文接 [working-memory-scheme-evolution.md](./working-memory-scheme-evolution.md)。那里收束了任务记忆如何进模型。这里收束的是**候选已经对了，人却看不清、点不出去**。产品边界不变：本服务只比较，成交在商户站；不得把 BuyWhere 包装地址当外链。

---

## 1. 变迁总览

表面失败不是「CSS 不好看」一个问题。它同时是跳转正确性和信息层次问题：外链打到 403，候选被挤成 320px 文字条，有图的卡片组件从未挂上。

```text
阶段 0  包装地址当商户外链
        present 优先 click_url
        抽屉 <a href={product.merchant_url}>
        对话栏 1fr，结果栏 320px
        MissionView 只用 EvidenceDock
        CandidateCard 不用 image_url
            │
            ▼
阶段 1  浏览器对照
        BuyWhere /api/click → 403
        内层才是 Decathlon / Shopify PDP
        对话栏像主舞台，商品像边注
            │
            ▼
阶段 2  跳转与投影拆开
        unwrap 只服务用户跳转（必须 https 商户域）
        page_key 仍服务 listing 身份（http 内层也可对齐）
        旧 candidate_sets 读出时再拆一次
        前端 merchantHref 兜底已落库的 click URL
            │
            ▼
阶段 3  工作台层次翻过来
        对话 sticky 侧栏 + 带图卡片主区
        推荐条限行、备选改标签
        抽屉两按钮、列表两列
        shopify_* slug 显示成商户名
```

| 阶段 | 用户能看见的失败 | 根因层级 | 最终落点 |
|---|---|---|---|
| 0 | 「前往商户」打开一串 click URL，页面 403 | 把追踪包装当成 PDP | `merchant_page_url` / `merchantHref` |
| 0 | 候选挤在窄列文字条，没有商品图 | 布局把对话当主列；卡片未挂上 | `is-dialogue` 侧栏 + `CandidateCard` |
| 2 | 旧任务刷新后仍跳 click | 库里已是包装地址 | 读出投影再 unwrap，前端再拆一次 |
| 3 | `前往 shopify_decathlon_com` | BuyWhere merchant slug 原样展示 | `platformName` + 主机名按钮文案 |

---

## 2. 商户跳转为何失败

BuyWhere 检索项同时带 `url`（商户 PDP）和 `click_url`（`https://buywhere.ai/api/click?url=...&product_id=...`）。包装地址给 BuyWhere 记点击用，**浏览器直开会 403**。

阶段 0 的投影是：

```text
merchant_url = https_url(click_url) or https_url(url)
```

`https_url` 只检查 `https://` 前缀，包装地址合法通过。抽屉再原样 `target=_blank`。用户标签页标题变成整段 click URL，页面打不开。

直播对照（轻便徒步鞋任务 `343b797a-…`）：

| 字段 | 值 | 能否当外链 |
|---|---|---|
| `click_url` | `https://buywhere.ai/api/click?url=https%3A%2F%2Fwww.decathlon.com%2Fproducts%2F…` | 否，403 |
| 解开后的 PDP | `https://www.decathlon.com/products/mens-warm-and-waterproof-hiking-boots-sh100-mid-height-133825` | 是，Decathlon 商品页 |

路径 slug 里可能写 SH100，页面标题仍是 NH100。那是 BuyWhere / 商户 slug 不一致，**不是跳转目标错了**。跳转验收看的是：主机不是 `buywhere.`，页面能打开，标题是同一款鞋。

4K 显示器任务同样：包装拆开后落到 `pczonekw.myshopify.com/products/aoc-u27g4-…`，不是 BuyWhere。

---

## 3. 跳转与身份为什么要拆成两个函数

`identity.py` 里本来就有 `page_key`：为了否定对齐，会从 click 包装里取出商户路径。用户跳转如果复用同一套规则，会把 **http 内层**也当成可点外链（`https_url` 仍禁止 http，这条不能松）。

| 函数 | 给谁用 | 规则 |
|---|---|---|
| `_unwrap_click` | 内部共用 | 仅当 host 含 `buywhere.` 且 path 是 `/api/click` 时取出 `url=` |
| `unwrap_merchant_url` / `merchant_page_url` | 用户外链 | 必须 `https`，host 不得再含 `buywhere.` |
| `page_key` | listing 身份 | 解开后取 `host+path`；http 内层仍可对齐，不要求能跳转 |
| 前端 `merchantHref` | 已落库的旧记录 | 与 `unwrap_merchant_url` 同语义，避免只靠重搜才修好 |

投影顺序：`merchant_page_url(product.url, product.click_url)`，**PDP 优先，包装兜底**。读出旧 `candidate_sets` 时对 `url` / `merchant_url` / `click_url` 再走一遍。前端抽屉和推荐条的「前往商户」都走 `merchantHref`，旧任务不用重搜。

不采用的方案：

| 方案 | 主张 | 否决原因 |
|---|---|---|
| 继续用 click 并服务端 302 | 保留 BuyWhere 追踪 | 包装本身 403，用户走不通；本产品不承接成交回传 |
| 只改前端、不改投影 | 少动后端 | 新写入的 `candidate_sets` 仍是包装地址；API 调用方也会跳错 |
| 只改后端、不改前端 | 一次投影搞定 | 库里已有 click；HMR / 旧 payload 仍会 403 |
| 跳转到 BuyWhere 商品卡 | 「官方详情」 | 用户要的是商户报价页；产品边界是 merchant jump |

---

## 4. 工作台为什么看起来像坏了

CSS 注释写着「对话 = 边注」，实现却反了：

```text
.workspace-layout.is-dialogue  →  minmax(0, 1fr) 320px
.conversation-panel.is-primary →  position:static; min-height: min(720px, …)
```

HTML 顺序是对话在前、结果在后。第一列吃掉整行，结果栏只剩 320px。`CandidateCard` 和三列 `.products-grid` 都在代码里，`MissionView` 却只渲染 `EvidenceDock` 窄列表。卡片永不读 `image_url`，永远是品类图标，再叠「评分未提供 / 评价数未提供」。推荐条把 rationale、tradeoff、全部备选标题挤成一段。抽屉 footer 是 `1fr 1fr 1.2fr`，只有两个按钮。选购列表是单列宽行，中间大片留白。

翻过来之后：

```text
对话 sticky 侧栏   minmax(300px, 360px)
结果主区           1fr：推荐条 + 带图卡片（对话旁两列）
抽屉 footer        1fr 1fr
选购列表           两列卡片（窄屏回一列）
```

`is-primary` 不再用 720px 最小高度把对话栏撑成空盒子，高度跟随视口，输入框保持可达。商家 slug `shopify_decathlon_com` 显示为 Decathlon；跳转按钮用解开后的主机名（`前往 decathlon.com 查看`）。

不采用的方案：

| 方案 | 主张 | 否决原因 |
|---|---|---|
| 重做整套设计系统 | 视觉问题「很大」 | 本轮失败点是层次和跳转，不是换字体配色 |
| 保留 EvidenceDock 再叠一层卡片 | 少删代码 | 同一批候选出现两次，窄屏更挤 |
| 对话仍作主列、只加宽结果 | 少动 grid | 对话没有那么多要读的字；人要看的是图和价 |

---

## 5. 直播对照

| 页面 | 阶段 0 | 修复后实况 |
|---|---|---|
| 徒步鞋工作台 | 对话约满宽，右侧 320px 文字条，无图 | 对话约 360px，结果约 963px；14 张卡都有 `product-photo` |
| 抽屉「前往商户」 | `buywhere.ai/api/click?…` → 403 | `decathlon.com/products/…` ，页面标题为 NH100 徒步靴 |
| 推荐条跳转 | 无，或同样走包装 | `decision-jump` 直达同一 PDP |
| 4K 显示器首选 | 同包装问题 | `pczonekw.myshopify.com/products/aoc-u27g4-…` |
| 我的选购 | 单列宽行 | 两列 `465px 465px` |

匿名身份与任务未改：`X-Anonymous-User-ID=e3a8df38-…`；徒步鞋 `343b797a-…`，4K `2bcc7e51-…`。后端无 reload，改投影后必须只重启 **8002**，不得动占用 8000 的其他项目。

---

## 6. 文件对照

| 变迁 | 新增 | 主要改动 |
|---|---|---|
| 商户 PDP 投影 | `frontend/src/lib/merchant.ts` | `rec/identity.py`（`unwrap_merchant_url` / `merchant_page_url`）、`present.py` `candidate_record` / 读出投影 |
| 工作台层次 | — | `MissionView.tsx` 挂 `CandidateCard`；`CandidateCard.tsx` 用 `image_url`；`DecisionCard.tsx` 限行 + 备选标签 + 跳转 |
| 抽屉与商家名 | — | `ProductDrawer.tsx`、`platform.ts` |
| 布局 | — | `styles.css`：`is-dialogue`、`.is-primary`、`.products-grid`、`.drawer-footer`、`.task-list`、`.decision-alts` |

测试加在 `tests/test_public_contract.py`：包装地址不得出现在 `merchant_url`；旧记录读出时再拆一次；`page_key` 仍对齐商户路径。

---

## 7. 以后不要退回去的几条

1. **用户外链必须是商户 PDP。** 不要把 `buywhere.*/api/click` 或 affiliate 短链写进 `merchant_url`。  
2. **跳转和 listing 身份共用解开，不共用验收。** 身份允许 http 内层；跳转只许 https 商户域。  
3. **旧 candidate_sets 会带着包装地址。** 读出和前端都要再拆，不能假设库里已经是 PDP。  
4. **对话是边注，候选是主区。** 不要再把 `is-dialogue` 设成 `1fr + 320px`。  
5. **有 `image_url` 就出图。** 不要用「评分未提供」填空；没有的字段就不写。  
6. **本服务不结账。** 修复跳转是为了把人送到商户站，不是在站内模拟商详。

这六条是本轮表面问题收束后的约束。下一轮若要动外链、卡片或工作台 grid，先对照这里的 403 和 320px 边栏。记忆与过滤仍看 [working-memory-scheme-evolution.md](./working-memory-scheme-evolution.md)。
