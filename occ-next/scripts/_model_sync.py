"""刷新**供应商声明的模型目录**（`extensions/_providers/<name>.yaml` 的 `models` 那一栏）。

它只改那一栏：别的栏、以及它们之间的注释，原样留着。

**走配置舱那条写路径**（`src/extensions/writer.py`，ADR-033）。脚本与配置舱各写各的，
就会有两种"规范形式"，交替写让格式来回跳——而在此之前这里是 `yaml.safe_dump` 整体重写，
`uniapi/manifest.yaml` 那 1931 行就是那么变成 2 行注释的。

**密钥只过这一个进程，不落盘**：它从环境变量读，用完就没了——声明里存的是那个变量名。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# 让脚本能 import 到写路径（必须在 import src 之前）
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.extensions.writer import Declarations, read_document  # noqa: E402


def models_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    return base if base.endswith("/models") else f"{base}/models"


def fetch_models(url: str, api_key: str, timeout: int = 30) -> list[dict[str, Any]]:
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "occ-next-model-sync/1.0",
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"获取模型列表失败 HTTP {exc.code}: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"获取模型列表失败: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError("供应商返回的模型列表不是有效 JSON") from exc
    models = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        raise RuntimeError("模型列表响应缺少 data 数组")
    return [item for item in models if isinstance(item, dict) and str(item.get("id") or "").strip()]


def merge_models(models: list[dict[str, Any]],
                 previous: list[Any]) -> list[dict[str, Any]]:
    """上游那份 + 本地已经写过的事实。

    **本地那些跟着模型走的东西要留住**：`context`、`parameters` 是人工核对过的
    （上下文长度、这家这一档的默认旋钮），重建一遍就没了。所以按**名字**认领旧条目，
    再覆写上游说得清的那两格（`name` / `owned_by`）。
    """
    known = {str(item.get("name")): dict(item)
             for item in previous
             if isinstance(item, dict) and item.get("name")}
    merged: list[dict[str, Any]] = []
    for item in sorted(models, key=lambda value: str(value.get("id"))):
        name = str(item["id"]).strip()
        entry = known.get(name, {})
        entry["name"] = name
        owned = str(item.get("owned_by") or "").strip()
        if owned:
            entry["owned_by"] = owned
        merged.append(entry)
    return merged


def sync_provider(root: Path, provider: str, api_key_env: str, catalog_url: str,
                  timeout: int = 30) -> tuple[int, str]:
    declarations = Declarations(root)
    path = declarations.path_of("provider", provider)
    document = read_document(path) or {}
    if not isinstance(document, dict):
        raise ValueError(f"供应商声明必须是一个对象: {path}")
    env_name = str(document.get("api_key_env") or api_key_env)
    api_key = os.environ.get(env_name, "")
    if not api_key:
        raise RuntimeError(f"未设置 API Key 环境变量: {env_name}")
    url = models_url(catalog_url or str(document.get("base_url") or ""))
    models = fetch_models(url, api_key, timeout)
    declarations.set_field("provider", str(document.get("name") or provider), "models",
                           merge_models(models, list(document.get("models") or [])))
    return len(models), url


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="同步 OpenAI-compatible 供应商的模型目录")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--provider", required=True, help="供应商名（_providers/<name>.yaml）")
    parser.add_argument("--api-key-env", default="", help="不给就用声明里那一栏")
    parser.add_argument("--catalog-url", default="", help="不给就用声明里的 base_url")
    args = parser.parse_args(argv)
    try:
        count, url = sync_provider(args.root, args.provider, args.api_key_env, args.catalog_url)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"模型同步失败: {exc}", file=sys.stderr)
        return 1
    print(f"已从 {url} 更新 {args.provider}: {count} 个模型")
    return 0


def run_fixed(root: Path, provider: str, api_key_env: str, catalog_url: str,
              argv: list[str] | None = None) -> int:
    """给两个固定入口用。`--help` 不该去联网，所以先答它。"""
    if argv is not None and any(item in {"-h", "--help"} for item in argv):
        print(f"同步 {provider} 的模型目录，需要环境变量 {api_key_env}")
        return 0
    return main(["--root", str(root), "--provider", provider,
                 "--api-key-env", api_key_env, "--catalog-url", catalog_url])
