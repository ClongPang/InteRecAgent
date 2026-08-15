# app/api/connection.py
import asyncio
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: dict[str, WebSocket] = {}
        self.active = self.active_connections
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, thread_id: str) -> None:
        await websocket.accept()
        async with self._lock:
            self.active_connections[thread_id] = websocket

    async def disconnect(self, websocket: WebSocket, thread_id: str) -> None:
        # 关键：判断对象身份，避免重连时误刷新连接
        async with self._lock:
            if self.active_connections.get(thread_id) is websocket:
                del self.active_connections[thread_id]

    async def send_to_thread(self, payload: dict, thread_id: str) -> None:
        ws = self.active_connections.get(thread_id)
        if ws is None:
            return  # 前端尚未连接 / 已断开，丢弃事件
        try:
            await ws.send_json(payload)
        except Exception:
            # 发送异常一般是连接已断
            await self.disconnect(ws, thread_id)


manager = ConnectionManager()
