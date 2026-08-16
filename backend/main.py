"""uvicorn 入口：`uvicorn backend.main:app`。"""
from __future__ import annotations

from .api.app import create_app
from .bootstrap.container import Container

container = Container()
app = create_app(container)
