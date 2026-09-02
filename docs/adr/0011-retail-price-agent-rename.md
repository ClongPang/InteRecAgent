# ADR-0011：统一采用 RetailPriceAgent 命名

- 状态：Accepted
- 日期：2026-09-02

## 决策

项目公开名称、GitHub 仓库、npm workspace、服务与遥测标识统一为 `RetailPriceAgent`。该名称直接表达零售商品报价查询场景，不再使用容易被理解为推荐系统的 `Rec`。

活动数据库 Schema 为 `retail_price_agent`。迁移 `0026_retail_price_agent_namespace.sql` 原位重命名已有 Schema，并重建包含 Schema 或会话变量名称的安全函数与 RLS Policy；历史迁移保持不变，以保留已记录的 checksum。运行时环境变量使用 `RETAIL_PRICE_*`，同时读取原前缀作为升级兼容入口，新名称优先。

## 边界

改名不改变产品合同：系统仍面向新加坡市场中已明确购买目标的用户，提供带商家来源和观测时间的报价线索，不承诺商品推荐、全网最低价、库存或购买结果。
