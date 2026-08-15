# app/agent/llm.py
import os
from functools import lru_cache
from langchain.chat_models import init_chat_model
from dotenv import load_dotenv
load_dotenv()  # 默认加载当前目录下的 .env 文件


@lru_cache(maxsize=1)
def get_llm():
    """主 / 子 AgentLoop 共用的大模型实例。"""
    return init_chat_model(
        os.environ["DEEPSEEK_MODEL_MAIN"],
        model_provider="openai",
        api_key=os.getenv("DEEPSEEK_API_KEY"),
        base_url=os.getenv("DEEPSEEK_BASE_URL"),
        temperature=0.3,
    )


@lru_cache(maxsize=1)
def get_judge_llm():
    """评测体系 (Rubric judge) 专用的强模型。"""
    return init_chat_model(
        os.environ.get("DEEPSEEK_MODEL_JUDGE"),
        model_provider="openai",
        api_key=os.getenv("DEEPSEEK_API_KEY"),
        base_url=os.getenv("DEEPSEEK_BASE_URL"),
        temperature=0.0,
    )


@lru_cache(maxsize=1)
def get_lite_llm():
    """过程级轻量检查模型，用于 semantic assertion 和 drift detection."""
    model = (
        os.environ.get("DEEPSEEK_MODEL_LITE")
        or os.environ.get("DEEPSEEK_MODEL_JUDGE")
        or os.environ.get("DEEPSEEK_MODEL_MAIN")
    )
    if not model:
        raise RuntimeError("Missing DEEPSEEK_MODEL_LITE/JUDGE/MAIN for lite checks")

    return init_chat_model(
        model,
        model_provider="openai",
        api_key=os.getenv("DEEPSEEK_API_KEY"),
        base_url=os.getenv("DEEPSEEK_BASE_URL"),
        temperature=0.0,
    )
