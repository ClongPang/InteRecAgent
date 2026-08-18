"""FastAPI app factory（BE-001/P4-W01）。依赖通过 container 注入；api 层不 import Infrastructure。"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .errors import register_exception_handlers
from .middleware import TraceMiddleware
from .routes import events, health, missions, snapshots


def create_app(container) -> FastAPI:
    '''
    利用 FastAPI 的 asynccontextmanager 实现异步生命周期
    在应用启动前执行初始化，在关闭时执行清理
    '''
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        session_factory = container.build_session_factory()
        # Command Service 必须与 lifespan 共用同一 dispatcher，否则 start/stop 管不到后台任务。
        dispatcher = container.build_run_dispatcher(session_factory)
        command_service = container.build_command_service(session_factory)
        app.state.container = container
        app.state.session_factory = session_factory
        app.state.dispatcher = dispatcher
        app.state.command_service = command_service
        await dispatcher.start()          # 启动调度器（如开启后台工作线程/进程）
        yield                             # 应用运行期间，此处挂起
        await dispatcher.stop(grace_seconds=5.0)  # 优雅停止调度器，最多等待5秒
        await container.aclose()          # 关闭容器，释放所有资源（如数据库连接池）

    app = FastAPI(title="InteRecAgent API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:4173", "http://127.0.0.1:4173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(TraceMiddleware)
    register_exception_handlers(app) # 调用一个外部函数，将自定义异常处理器注册到应用上，以便统一处理业务异常并返回规范化错误响应
    app.include_router(health.router, prefix="/api/v1")
    app.include_router(missions.router, prefix="/api/v1/missions")
    app.include_router(events.router, prefix="/api/v1/missions")
    app.include_router(snapshots.router, prefix="/api/v1")
    return app
