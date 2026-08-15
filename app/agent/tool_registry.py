# app/agent/tool_registry.py
# dispatch_tool 在下面单独导入避免循环引用
from app.agent.dispatch_tool import dispatch_tool
from app.tools.category_insight import category_insight
from app.tools.chat_fallback import chat_fallback
from app.tools.item_picker import item_picker
from app.tools.item_search import item_search
from app.tools.planner import planner
from app.tools.price_compare import price_compare
from app.tools.shipping_calc import shipping_calc
from app.tools.shopping_summary import shopping_summary
from app.tools.web_search import web_search


FULL_TOOL_SET = [
    planner,
    chat_fallback,
    web_search,
    category_insight,
    item_search,
    item_picker,
    price_compare,
    shipping_calc,
    shopping_summary,
    dispatch_tool,  # 元工具：fork 同质子 AgentLoop
]


# 终结性工具：调到这些就收敛
TERMINAL_TOOLS = {"shopping_summary", "chat_fallback"}
