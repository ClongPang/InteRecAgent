# 交付 Issue：当前购物任务对话与回复质量

**日期**：2026-08-20  
**任务**：`29546d5f-010b-4d22-85e8-c6ae2a572054`  
**阶段**：`ready`，约束版本 2  
**约束**：query=`降噪耳机 通勤`，预算 2500 元，市场 US/SG  
**文档类型**：联调问题交付，不是方案变迁

本文只记录**已经发生、有事件和候选集可核对**的问题。研究控环本身（检索 3 次、池子 12、选出 6）按 [docs/research-loop-scheme-evolution.md](./docs/research-loop-scheme-evolution.md) 跑完了；失败在路由、集合质量和**对用户说的话**。

---

## 1. 对话实录

| 序 | 角色 | 原文（摘要） | 系统判定 |
|---|---|---|---|
| 1 | 用户 | 帮我找一副适合通勤的降噪耳机，预算 2500 元以内 | `refine_constraints` → research |
| 1 | 助手 | 推荐 Soundcore Space One（整段英文 SEO 标题），约 520 元，当前候选里最便宜，探索检索 | `compose_ready_reply` |
| 2 | 用户 | 有lazada平台的吗 | `ask_about_item` → **talk** |
| 2 | 助手 | 仍讲这款 Soundcore / amazon.sg / SG / 预算内；未提 Lazada | `_overview_reply` |
| 3 | 用户 | 帮我比前两个 | `compare_items` → talk |
| 3 | 助手 | 对照 Soundcore（¥520，amazon.sg）与 1-Vibe Lite（¥1675，shopify）；结论只是前者更便宜 | `_compare_reply` |

研究过程（第一趟 run `dfbc00e1-…`）：

1. `降噪耳机 通勤` → 收到 16 件，规则后 keep 7/7，并入 7  
2. 改写 `ANC headphones travel` → 收到 40 件，keep 11/13，并入 5（去重 6），池子 12  
3. 改写 `wireless noise cancelling over ear headphones` → **0 件**  
4. 模型从 12 件中选 TopK=6

当前对照 6 件：

| 序 | 标题（截断） | 商户 | 市场 | 约人民币 |
|---|---|---|---|---|
| 1 | Soundcore by Anker, Space One, Active Noise Cancelling Headphones… | amazon.sg | SG | 520 |
| 2 | 1-Vibe Lite 真無線降噪耳機 | shopify | US | 1675 |
| 3 | Wireless Noise Reduction Headset | shopify | US | 1063 |
| 4 | Wireless Noise-Cancelling Headphones | shopify_buy30620_crate | US | 1917 |
| 5 | Wantek T3 ANC Over Ear Bluetooth Headphones | shopify | US | 982 |
| 6 | JBL Live 660NC | shopify_6ave_com | （空） | 925 |

列表里**没有 Lazada**。SG 仅 amazon.sg。

---

## 2. 对话流程问题

### I-01 平台问句走错支路

「有 lazada 平台的吗」是改召回 / 过滤条件，应走 refilter 或 research。被收成 `ask_about_item`，`route_turn` 焊死 talk，于是：

- 不按商户过滤现有池子  
- 不改检索再搜 Lazada  
- 不回答「这批有没有」

`ASK_ITEM` 的提示词只覆盖保修 / 为什么 / 有货，没有平台、商户、市场。

### I-02 TopK 仍是弱 listing

keep 几乎全留（7/7、11/13）。6 件里只有 Space One 和 JBL 像可买的主体；JBL 排到第 6。中间是 Shopify 泛标题。用户「比前两个」被迫对比一款真货和一款来路不明的真无线。

### I-03 第三次改写空搜

`wireless noise cancelling over ear headphones` 收回 0 件，白烧一次 BuyWhere，池子停在 12，未达 N=25。

### I-04 用户问的平台当前不存在，也没被解释

SG 应可能出 Lazada，这批没有。系统既没说「当前 6 件里没有 Lazada」，也没提议扩市场或换词。

---

## 3. 对用户说的话：问题

三句助手消息都**不是模型现写的**。首轮 `compose_ready_reply`，后两轮 `compose_talk_reply`。模型在本趟只做 keep / 改写 / TopK。下面批的是用户读到的文本。

### I-05 答非所问

第二句应用户问 Lazada，得到的是焦点商品概览（价、amazon.sg、SG、预算）。一句不提平台。

### I-06 把 listing 文案当商品名

三轮都把整段 Amazon SEO 标题嵌进句子当主语（2X Stronger Voice Reduction、40H ANC Playtime…）。对照里同一长标题出现两次。没有短名「Soundcore Space One」。

### I-07 推荐理由只有「这批里最便宜」

首句有效信息：人民币估算最低，约 520，落在 2500 内。用户要的是通勤降噪。`belief.use_case = 通勤` 已记下，回复未用。形态、ANC、头戴/入耳都没进句子。

### I-08 免责声明压过回答

连续出现系统旁白：

- 「依据是已记录的价格与市场，不是评分或商户声明的品牌」  
- 「保修和库存未提供，因此不是推荐理由」  
- 「这是按关键词检索的探索结果，不是精确型号匹配」  
- 「这些不能用来判断好坏」

合规边界对，但对用户是朗读能力说明书，不是购物建议。

### I-09 自相矛盾

`_overview_reply` 写死「快照未提供……品牌」。标题开头已是 Soundcore by Anker。品牌缺失被当成常量，不看标题。

### I-10 对照没有对照点

「帮我比前两个」只比估算价和市场，结论「A 更低」。真无线 vs 头戴、amazon.sg vs shopify、是否适合通勤都没有。两件不好比，话还装作比完了。

### I-11 回答是证据卡片朗读稿

模板把字段用顿号拼成一段。没有先答用户这一句，没有短标题，没有对齐用途的理由。三轮同一个味道。

---

## 4. 建议改动（尚未做）

按对用户伤害排序，不在本 issue 里实现。

1. **平台 / 商户问句**收成约束或过滤意图，走 refilter / research；talk 时至少回答「当前列表有没有」。  
2. **对用户展示短标题**（品牌 + 型号，截断 SEO 尾巴）；模板禁止整段 title 当主语。  
3. **推荐理由对齐用途和规格线索**，不要只报「当前集合最低价」。  
4. **免责声明收成一句或脚注**，不要每轮复读。  
5. **对照先说差在哪**（形态、平台、价差），比不动的维度明确说快照没有。  
6. **keep / TopK 收紧弱 Shopify 泛标题**；改写词避免第三次空搜。  
7. **`_overview_reply` 的缺失字段按快照实况写**，标题已有品牌就不要说没有品牌。

---

## 5. 核对位置

| 证据 | 位置 |
|---|---|
| 任务与信念 | `shopping_missions.constraints_json`，id 如上 |
| 事件流 | `mission_events` sequence 1–19 |
| 6 件对照 | `candidate_sets` `382851f3-5495-4730-ba10-945a79af0578` |
| 路由 | `backend/application/services/route.py`、`nlu.py` |
| 回复模板 | `backend/application/services/grounded.py` |
| 研究环 | `backend/agent/loop.py`、`judges.py` |

---

## 6. 验收时怎样算修掉

- 再说「有 Lazada 吗」：要么列表出现 Lazada，要么明确说没有并给出下一步，不能复读当前 amazon.sg 款。  
- 助手消息里商品名可读，不再出现整段卖点清单当主语。  
- 首推理由能对上「通勤」或「降噪」，不只是最低价。  
- 「比前两个」能说出至少一项非价格差异，或承认两件不好比。  
- 同一句回复不再声称「没有品牌」同时朗读带品牌的标题。
