from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

import app.api.server as server
import app.utils.path_utils as path_utils


class ApiFileEndpointTests(unittest.TestCase):
    def test_upload_and_download_files(self) -> None:
        original_output_root = server.OUTPUT_ROOT
        original_upload_root = path_utils.UPLOAD_ROOT

        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            output_root = tmp_root / "output"
            upload_root = tmp_root / "uploaded"
            server.OUTPUT_ROOT = output_root
            path_utils.UPLOAD_ROOT = upload_root

            try:
                client = TestClient(server.app)

                upload_resp = client.post(
                    "/api/upload",
                    params={"thread_id": "thread-1"},
                    files={"file": ("reference.png", b"image-bytes", "image/png")},
                )
                self.assertEqual(upload_resp.status_code, 200)
                self.assertEqual(upload_resp.json()["status"], "ok")
                self.assertEqual((upload_root / "thread-1" / "reference.png").read_bytes(), b"image-bytes")

                session_dir = output_root / "thread-1"
                session_dir.mkdir(parents=True)
                (session_dir / "summary.md").write_text("result", encoding="utf-8")

                download_resp = client.get("/api/files/thread-1/summary.md")
                self.assertEqual(download_resp.status_code, 200)
                self.assertEqual(download_resp.content, b"result")

                missing_resp = client.get("/api/files/thread-1/missing.md")
                self.assertEqual(missing_resp.status_code, 404)
            finally:
                server.OUTPUT_ROOT = original_output_root
                path_utils.UPLOAD_ROOT = original_upload_root


if __name__ == "__main__":
    unittest.main()
