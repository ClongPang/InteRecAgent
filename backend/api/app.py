from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .errors import register_exception_handlers
from .middleware import TraceMiddleware
from .routes import events, health, missions, snapshots


def create_app(container) -> FastAPI:
    """Create the API and own all process-scoped resources through its lifespan."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        session_factory = container.build_session_factory()
        dispatcher = container.build_run_dispatcher(session_factory)
        command_service = container.build_command_service(session_factory)
        app.state.container = container
        app.state.session_factory = session_factory
        app.state.dispatcher = dispatcher
        app.state.command_service = command_service
        await dispatcher.start()
        try:
            yield
        finally:
            await dispatcher.stop(grace_seconds=5.0)
            await container.aclose()

    app = FastAPI(title="InteRecAgent API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(TraceMiddleware)
    register_exception_handlers(app)
    app.include_router(health.router, prefix="/api/v1")
    app.include_router(missions.router, prefix="/api/v1/missions")
    app.include_router(events.router, prefix="/api/v1/missions")
    app.include_router(snapshots.router, prefix="/api/v1")
    return app
