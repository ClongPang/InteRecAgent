# app/utils/path_utils.py
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
UPLOAD_ROOT = PROJECT_ROOT / "uploaded"
OUTPUT_ROOT = PROJECT_ROOT / "output"


def ensure_session_dir(thread_id: str) -> Path:
    """获取或创建本次任务的输出目录。"""
    session_dir = OUTPUT_ROOT / thread_id
    session_dir.mkdir(parents=True, exist_ok=True)
    return session_dir


def ensure_upload_dir(thread_id: str) -> Path:
    """获取或创建本次任务的上传目录。"""
    upload_dir = UPLOAD_ROOT / thread_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    return upload_dir


def safe_join(base: Path, *parts: str) -> Path:
    """防止 ../../ 越权访问的拼路径。"""
    target = (base / Path(*parts)).resolve()
    if not str(target).startswith(str(base.resolve())):
        raise ValueError(f"路径越权: {target}")
    return target