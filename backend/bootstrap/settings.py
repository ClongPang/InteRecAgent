from __future__ import annotations

from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    """环境配置唯一读取点, 业务模块不得读取 os.environ。

    变量名带 `INTEREC_` 前缀（见 .env.example）；BuyWhere Key 向后兼容旧名。
    """

    model_config = SettingsConfigDict(
        env_prefix="INTEREC_",
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        populate_by_name=True,
    )

    env: str = "development"
    data_source: str = "fixture"  # fixture（无 Key 可跑）| live（真实 BuyWhere/Frankfurter）
    database_url: str = "postgresql+asyncpg://interec:interec@localhost:5432/interec"
    buywhere_api_key: str = Field(
        default="",
        validation_alias=AliasChoices(
            "INTEREC_BUYWHERE_API_KEY", "BUYWHERE_API_KEY", "BuyWhere_API"
        ),
    )
    llm_provider: str = "unconfigured"  # unconfigured | openai_compat | deepseek
    llm_api_key: str = ""
    llm_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-v4-flash"
    llm_timeout: float = 30.0
    llm_max_retries: int = 2
    log_level: str = "INFO"

    # 上游控制
    buywhere_timeout: float = 15.0
    buywhere_max_retries: int = 3
    buywhere_max_concurrency: int = Field(default=3, ge=1)
    fx_timeout: float = 10.0
    fx_max_retries: int = 3
    search_max_concurrency: int = 3
    research_max_wall_time_ms: int = Field(default=45_000, ge=1_000)
    # Runtime category allow-list; it may only narrow published CategoryContracts.
    # INTEREC_V2_ENABLED_ITEM_TYPES='["smartphone","headphones"]'
    v2_enabled_item_types: list[str] = Field(
        default_factory=lambda: ["smartphone", "headphones"]
    )
