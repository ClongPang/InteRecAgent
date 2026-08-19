"""按配置装配 ModelBackend。只接收原始配置，不导入 bootstrap.Settings。"""
from __future__ import annotations

from ...application.ports import ModelBackend
from .openai_compat import DEFAULT_BASE_URL, DEFAULT_MODEL, OpenAICompatModelBackend
from .unconfigured import UnconfiguredModelBackend

COMPAT_PROVIDERS = frozenset({"openai_compat", "deepseek"})


class UnsupportedLLMProviderError(RuntimeError):
    """未知 llm_provider。消息不含 Key。"""


def build_model_backend(
    *,
    provider: str,
    api_key: str = "",
    base_url: str = DEFAULT_BASE_URL,
    model: str = DEFAULT_MODEL,
    timeout: float = 30.0,
    max_retries: int = 2,
) -> ModelBackend:
    name = (provider or "unconfigured").strip().lower()
    if name == "unconfigured":
        return UnconfiguredModelBackend()
    if name in COMPAT_PROVIDERS:
        if not api_key:
            raise UnsupportedLLMProviderError(
                "llm_provider=openai_compat 需要 INTEREC_LLM_API_KEY；未配置时请使用 unconfigured"
            )
        return OpenAICompatModelBackend(
            api_key,
            base_url=base_url or DEFAULT_BASE_URL,
            model=model or DEFAULT_MODEL,
            timeout=timeout,
            max_retries=max_retries,
        )
    raise UnsupportedLLMProviderError(
        f"llm_provider={name} 暂未实现；支持 unconfigured | openai_compat | deepseek"
    )
