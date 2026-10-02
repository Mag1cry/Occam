"""拉一次 UniAPI 的 `/v1/models`，刷新 `extensions/_providers/uniapi.yaml` 的模型目录。"""
from __future__ import annotations

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _model_sync import run_fixed  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(run_fixed(Path(__file__).resolve().parents[1], "uniapi",
                               "UNIAPI_API_KEY", "https://api.uniapi.top/v1", sys.argv[1:]))
