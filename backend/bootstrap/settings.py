from __future__ import annotations

from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    """环境配置唯一读取点（ARC-006）。业务模块不得读取 os.environ。

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
    llm_provider: str = "unconfigured"  # unconfigured | deepseek | openai ...
    log_level: str = "INFO"

    # 上游控制
    buywhere_timeout: float = 15.0
    buywhere_max_retries: int = 3
    fx_timeout: float = 10.0
    fx_max_retries: int = 3
    search_max_concurrency: int = 3
