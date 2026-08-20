#!/usr/bin/env python3
"""Fetch W&B's live model IDs and documented model metadata."""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request
from decimal import Decimal
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

MODELS_URL = "https://api.inference.wandb.ai/v1/models"
CATALOG_URL = "https://docs.wandb.ai/inference/models"


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._table = []
        elif self._table is not None and tag == "tr":
            self._row = []
        elif self._row is not None and tag in {"th", "td"}:
            self._cell = []
        elif self._cell is not None and tag == "br":
            self._cell.append(" ")

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"th", "td"} and self._cell is not None:
            assert self._row is not None
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            assert self._table is not None
            self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--auth-file",
        type=Path,
        default=Path("agent/auth.json"),
        help="Pi auth.json containing wandb.key; ignored when WANDB_API_KEY is set",
    )
    parser.add_argument("--output", type=Path, help="Write JSON to this path instead of stdout")
    return parser.parse_args()


def api_key(auth_file: Path) -> str:
    if key := os.environ.get("WANDB_API_KEY"):
        return key
    try:
        auth = json.loads(auth_file.read_text())
        key = auth["wandb"]["key"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError) as exc:
        raise SystemExit(
            f"Set WANDB_API_KEY or provide a Pi auth file containing wandb.key: {exc}"
        ) from exc
    if not isinstance(key, str) or not key:
        raise SystemExit("The W&B API key is empty or is not a string")
    return key


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        raise urllib.error.HTTPError(req.full_url, code, "redirect rejected", headers, fp)


def fetch(
    url: str,
    headers: dict[str, str] | None = None,
    allow_redirects: bool = True,
) -> bytes:
    request_headers = {"User-Agent": "pi-wandb-model-sync/1.0", **(headers or {})}
    request = urllib.request.Request(url, headers=request_headers)
    opener = (
        urllib.request.build_opener()
        if allow_redirects
        else urllib.request.build_opener(RejectRedirects())
    )
    with opener.open(request, timeout=30) as response:
        return response.read()


def context_tokens(value: str) -> int:
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([kKmM])", value.strip())
    if not match:
        raise ValueError(f"Unsupported context-window value: {value!r}")
    multiplier = 1_000 if match.group(2).lower() == "k" else 1_000_000
    tokens = Decimal(match.group(1)) * multiplier
    if tokens != tokens.to_integral_value():
        raise ValueError(f"Context-window value does not resolve to whole tokens: {value!r}")
    return int(tokens)


def documented_models(html: str) -> dict[str, dict[str, Any]]:
    parser = TableParser()
    parser.feed(html)
    result: dict[str, dict[str, Any]] = {}
    catalog_index = 0
    required = [
        "Model",
        "Model ID (for API usage)",
        "Type",
        "Context Window",
        "Parameters",
        "Description",
    ]

    for table in parser.tables:
        if not table or table[0] != required:
            continue
        experimental = catalog_index > 0
        catalog_index += 1
        for cells in table[1:]:
            if len(cells) != len(required):
                continue
            row = dict(zip(required, cells))
            model_id = row["Model ID (for API usage)"]
            if model_id in result:
                raise ValueError(f"Duplicate model in W&B documentation: {model_id}")
            modalities = [
                part.lower()
                for part in re.split(r"\s*,\s*|\s+", row["Type"].strip())
                if part
            ]
            unsupported = set(modalities) - {"text", "vision"}
            if unsupported:
                raise ValueError(f"Unsupported modalities for {model_id}: {sorted(unsupported)}")
            result[model_id] = {
                "id": model_id,
                "name": row["Model"],
                "input": ["text", "image"] if "vision" in modalities else ["text"],
                "contextWindow": context_tokens(row["Context Window"]),
                "parameters": row["Parameters"],
                "description": row["Description"],
                "experimental": experimental,
            }

    if not result:
        raise ValueError("No model catalog tables found in W&B documentation")
    return result


def main() -> int:
    args = parse_args()
    key = api_key(args.auth_file)
    endpoint = json.loads(
        fetch(
            MODELS_URL,
            {"Authorization": f"Bearer {key}"},
            allow_redirects=False,
        ).decode("utf-8")
    )
    endpoint_ids = [model["id"] for model in endpoint.get("data", [])]
    if not endpoint_ids or len(endpoint_ids) != len(set(endpoint_ids)):
        raise ValueError("The W&B endpoint returned no model IDs or duplicate IDs")

    docs = documented_models(fetch(CATALOG_URL).decode("utf-8"))
    missing_docs = sorted(set(endpoint_ids) - docs.keys())
    stale_docs = sorted(docs.keys() - set(endpoint_ids))
    models = [
        docs.get(
            model_id,
            {
                "id": model_id,
                "name": None,
                "input": None,
                "contextWindow": None,
                "parameters": None,
                "description": None,
                "experimental": None,
            },
        )
        for model_id in endpoint_ids
    ]

    result = {
        "retrievedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "endpoint": MODELS_URL,
        "catalog": CATALOG_URL,
        "models": models,
        "missingDocumentation": missing_docs,
        "documentedButUnavailable": stale_docs,
    }
    rendered = json.dumps(result, indent=4) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
        print(f"wrote {len(endpoint_ids)} models to {args.output}", file=sys.stderr)
        if missing_docs:
            print(
                "warning: W&B documentation lacks metadata for: " + ", ".join(missing_docs),
                file=sys.stderr,
            )
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
