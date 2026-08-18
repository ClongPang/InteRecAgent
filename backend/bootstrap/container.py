from __future__ import annotations

from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..agent.graph import build_graph
from ..agent.runner import LangGraphMissionRunner
from ..application.ports import FxSource, ModelBackend, ProductSource
from ..application.services import MissionCommandService, SearchService
from ..infrastructure.fx_sources.fixed import FixedFxSource
from ..infrastructure.fx_sources.frankfurter import FrankfurterFxSource
from ..infrastructure.llm.unconfigured import UnconfiguredModelBackend
from ..infrastructure.persistence.database import create_engine, session_factory
from ..infrastructure.persistence.unit_of_work import SqlAlchemyUnitOfWork
from ..infrastructure.product_sources.buywhere import BuyWhereProductSource
from ..infrastructure.product_sources.fixture import FixtureProductSource
from ..infrastructure.runtime.in_process_dispatcher import InProcessRunDispatcher
from .settings import Settings

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "buywhere"


class ConfigurationError(RuntimeError):
    """组合根配置错误（消息不含 Key 值）。"""


class Container:
    """组合根：根据 Settings 装配 Port 实现。

    CLI 与 FastAPI 共享同一 container。商品源、汇率源、调度器在进程内单例，
    避免 lifespan 与 Command Service 各持一份 dispatcher。
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or Settings()
        self._engine = None
        self._product_source: ProductSource | None = None
        self._fx_source: FxSource | None = None
        self._model_backend: ModelBackend | None = None
        self._dispatcher: InProcessRunDispatcher | None = None

    def build_session_factory(self) -> async_sessionmaker[AsyncSession]:
        """共享 AsyncEngine 驱动的会话工厂（请求级会话）。"""
        if self._engine is None:
            self._engine = create_engine(self.settings.database_url)
        return session_factory(self._engine)

    async def aclose(self) -> None:
        """关闭共享资源（lifespan 结束时调用）。"""
        self._dispatcher = None
        for source in (self._product_source, self._fx_source):
            closer = getattr(source, "aclose", None)
            if closer is not None:
                await closer()
        self._product_source = None
        self._fx_source = None
        self._model_backend = None
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None

    def build_product_source(self) -> ProductSource:
        if self._product_source is None:
            self._product_source = self._new_product_source()
        return self._product_source

    def _new_product_source(self) -> ProductSource:
        if self.settings.data_source == "fixture":
            return FixtureProductSource(FIXTURES_DIR)
        if not self.settings.buywhere_api_key:
            raise ConfigurationError(
                "data_source=live 需要 INTEREC_BUYWHERE_API_KEY；未配置 Key 时请使用默认 fixture 模式"
            )
        return BuyWhereProductSource(
            api_key=self.settings.buywhere_api_key,
            timeout=self.settings.buywhere_timeout,
            max_retries=self.settings.buywhere_max_retries,
        )

    def build_fx_source(self) -> FxSource:
        if self._fx_source is None:
            self._fx_source = self._new_fx_source()
        return self._fx_source

    def _new_fx_source(self) -> FxSource:
        if self.settings.data_source == "fixture":
            return FixedFxSource()
        return FrankfurterFxSource(
            timeout=self.settings.fx_timeout,
            max_retries=self.settings.fx_max_retries,
        )

    def build_search_service(self) -> SearchService:
        return SearchService(
            products=self.build_product_source(),
            fx=self.build_fx_source(),
            max_concurrency=self.settings.search_max_concurrency,
        )

    def build_model_backend(self) -> ModelBackend:
        """LLM 接缝。骨架仅支持 unconfigured（确定性 fallback）；真实 Provider 后续加入。"""
        if self._model_backend is None:
            if self.settings.llm_provider != "unconfigured":
                raise ConfigurationError(
                    f"llm_provider={self.settings.llm_provider} 暂未实现；骨架仅支持 unconfigured"
                )
            self._model_backend = UnconfiguredModelBackend()
        return self._model_backend

    def build_mission_runner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> LangGraphMissionRunner:
        """装配 Agent 状态图。每个图节点运行时各自打开独立事务。"""
        graph = build_graph(
            products=self.build_product_source(),
            fx=self.build_fx_source(),
            model_backend=self.build_model_backend(),
            uow_factory=lambda: SqlAlchemyUnitOfWork(session_factory),
            max_concurrency=self.settings.search_max_concurrency,
        )
        return LangGraphMissionRunner(graph)

    def build_run_dispatcher(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> InProcessRunDispatcher:
        if self._dispatcher is None:
            self._dispatcher = InProcessRunDispatcher(
                self.build_mission_runner(session_factory), session_factory
            )
        return self._dispatcher

    def build_command_service(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> MissionCommandService:
        """装配 HTTP Command Service；与 lifespan 共用同一 RunDispatcher。"""
        return MissionCommandService(
            uow_factory=lambda: SqlAlchemyUnitOfWork(session_factory),
            dispatcher=self.build_run_dispatcher(session_factory),
        )
