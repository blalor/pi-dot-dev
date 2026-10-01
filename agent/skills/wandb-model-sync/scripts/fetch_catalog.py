#!/usr/bin/env python3
"""Fetch and reconcile W&B's live model metadata from structured sources."""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

MODELS_URL = "https://api.inference.wandb.ai/v1/models"
QA_MODELS_URL = "https://api.qa.inference.wandb.ai/v1/models"
PROVIDER_ENDPOINTS = {"wandb": MODELS_URL, "wandb-qa": QA_MODELS_URL}
PROVIDER_ENV_KEYS = {"wandb": "WANDB_API_KEY", "wandb-qa": "WANDB_QA_API_KEY"}
CATALOG_URL = "https://trace.wandb.ai/inference/catalog/models"
MODELS_DEV_URL = "https://trace.wandb.ai/inference/modelsdev/models"
OPENAPI_URL = "https://trace.wandb.ai/openapi.json"
OPENAPI_SHA256 = "".join(
    ("892b111ab6a1756e", "1eea0462f023fa6c", "bd9ca467d9fb7e4a", "7d7f99887cb5aa9a")
)
LIFECYCLE_STAGES = {"experimental", "general-availability", "deprecated", "retired"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--auth-file",
        type=Path,
        default=Path("agent/auth.json"),
        help="Pi auth.json containing the provider key; ignored when its environment variable is set",
    )
    parser.add_argument(
        "--auth-provider",
        choices=tuple(PROVIDER_ENDPOINTS),
        default="wandb",
        help="W&B provider and credential to query (default: wandb)",
    )
    parser.add_argument("--output", type=Path, help="Write JSON to this path instead of stdout")
    return parser.parse_args()


def api_key(auth_file: Path, provider: str) -> str:
    environment_key = PROVIDER_ENV_KEYS[provider]
    if key := os.environ.get(environment_key):
        return key
    try:
        auth = json.loads(auth_file.read_text())
        key = auth[provider]["key"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError) as exc:
        raise SystemExit(
            f"Set {environment_key} or provide a Pi auth file containing "
            f"{provider}.key: {exc}"
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


def fetch_json(
    url: str,
    headers: dict[str, str] | None = None,
    allow_redirects: bool = True,
) -> Any:
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "pi-wandb-model-sync/2.0",
        **(headers or {}),
    }
    request = urllib.request.Request(url, headers=request_headers)
    opener = (
        urllib.request.build_opener()
        if allow_redirects
        else urllib.request.build_opener(RejectRedirects())
    )
    with opener.open(request, timeout=30) as response:
        return json.load(response)


def positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def endpoint_model_ids(payload: Any) -> list[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("The W&B endpoint returned an invalid schema")
    ids: list[str] = []
    for model in payload["data"]:
        model_id = model.get("id") if isinstance(model, dict) else None
        if not isinstance(model_id, str) or not model_id:
            raise ValueError("The W&B endpoint returned a model without a valid ID")
        ids.append(model_id)
    if not ids:
        raise ValueError("The W&B endpoint returned no model IDs")
    duplicates = sorted({model_id for model_id in ids if ids.count(model_id) > 1})
    if duplicates:
        raise ValueError(f"The W&B endpoint returned duplicate IDs: {', '.join(duplicates)}")
    return ids


def catalog_models(payload: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        raise ValueError("The W&B catalog returned an invalid schema")
    result: dict[str, dict[str, Any]] = {}
    for model in payload["models"]:
        model_id = model.get("idPlayground") if isinstance(model, dict) else None
        if not isinstance(model_id, str) or not model_id:
            raise ValueError("The W&B catalog returned a model without a valid ID")
        if model_id in result:
            raise ValueError(f"The W&B catalog returned duplicate ID: {model_id}")
        result[model_id] = model
    return result


def models_dev_models(payload: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("The W&B models.dev catalog returned an invalid schema")
    result: dict[str, dict[str, Any]] = {}
    for provider in payload.values():
        models = provider.get("models") if isinstance(provider, dict) else None
        if not isinstance(models, dict):
            raise ValueError("The W&B models.dev catalog returned an invalid provider")
        for model_id, model in models.items():
            if not isinstance(model, dict) or model.get("id") != model_id:
                raise ValueError(f"The W&B models.dev catalog returned invalid ID: {model_id}")
            if model_id in result:
                raise ValueError(f"The W&B models.dev catalog returned duplicate ID: {model_id}")
            result[model_id] = model
    return result


def validated_model(
    model_id: str,
    catalog: dict[str, dict[str, Any]],
    models_dev: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if model_id not in catalog:
        raise ValueError(f"W&B catalog metadata is missing for endpoint model: {model_id}")
    if model_id not in models_dev:
        raise ValueError(f"W&B models.dev metadata is missing for endpoint model: {model_id}")

    model = catalog[model_id]
    dev = models_dev[model_id]
    label = model.get("label")
    inputs = model.get("modalitiesInput")
    outputs = model.get("modalitiesOutput")
    context_window = model.get("contextWindow")
    reasoning = model.get("featureReasoning")
    tool_calling = model.get("featureToolCalling")
    lifecycle = model.get("lifecycleStage")
    description = model.get("descriptionShort")

    if not isinstance(label, str) or not label:
        raise ValueError(f"W&B catalog has an invalid label for: {model_id}")
    if (
        not isinstance(inputs, list)
        or not inputs
        or any(value not in {"text", "image"} for value in inputs)
    ):
        raise ValueError(f"W&B catalog has invalid input modalities for: {model_id}")
    if (
        not isinstance(outputs, list)
        or not outputs
        or any(value not in {"text", "image"} for value in outputs)
    ):
        raise ValueError(f"W&B catalog has invalid output modalities for: {model_id}")
    if not positive_int(context_window):
        raise ValueError(f"W&B catalog has an invalid context window for: {model_id}")
    if not isinstance(reasoning, bool) or not isinstance(tool_calling, bool):
        raise ValueError(f"W&B catalog has invalid capability metadata for: {model_id}")
    if lifecycle not in LIFECYCLE_STAGES:
        raise ValueError(f"W&B catalog has an invalid lifecycle stage for: {model_id}")
    if not isinstance(description, str) or not description.strip():
        raise ValueError(f"W&B catalog has an invalid description for: {model_id}")

    dev_limit = dev.get("limit")
    dev_modalities = dev.get("modalities")
    if not isinstance(dev_limit, dict) or not isinstance(dev_modalities, dict):
        raise ValueError(f"W&B models.dev has invalid metadata for: {model_id}")
    advertised_output = dev_limit.get("output")
    if not positive_int(advertised_output):
        raise ValueError(f"W&B models.dev has an invalid output limit for: {model_id}")

    comparisons = {
        "contextWindow": (context_window, dev_limit.get("context")),
        "input": (inputs, dev_modalities.get("input")),
        "reasoning": (reasoning, dev.get("reasoning")),
        "toolCalling": (tool_calling, dev.get("tool_call")),
    }
    disagreements = [
        field for field, (catalog_value, dev_value) in comparisons.items()
        if catalog_value != dev_value
    ]
    if disagreements:
        raise ValueError(
            f"W&B catalog and models.dev disagree for {model_id}: "
            + ", ".join(disagreements)
        )

    return {
        "id": model_id,
        "name": label,
        "input": inputs,
        "contextWindow": context_window,
        "reasoning": reasoning,
        "toolCalling": tool_calling,
        "advertisedMaxOutputTokens": advertised_output,
        "lifecycleStage": lifecycle,
        "description": description,
    }


def canonical_sha256(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def openapi_fingerprint() -> dict[str, Any]:
    try:
        sha256 = canonical_sha256(fetch_json(OPENAPI_URL))
    except Exception as exc:
        print(
            f"warning: W&B OpenAPI fingerprint unavailable ({type(exc).__name__}); "
            "structured model validation passed",
            file=sys.stderr,
        )
        return {
            "sha256": None,
            "expectedSha256": OPENAPI_SHA256,
            "changed": None,
            "available": False,
        }

    changed = sha256 != OPENAPI_SHA256
    if changed:
        print(
            "warning: W&B OpenAPI schema hash changed; structured model validation passed",
            file=sys.stderr,
        )
    return {
        "sha256": sha256,
        "expectedSha256": OPENAPI_SHA256,
        "changed": changed,
        "available": True,
    }


def main() -> int:
    args = parse_args()
    endpoint_url = PROVIDER_ENDPOINTS[args.auth_provider]
    endpoint = fetch_json(
        endpoint_url,
        {"Authorization": f"Bearer {api_key(args.auth_file, args.auth_provider)}"},
        allow_redirects=False,
    )
    endpoint_ids = endpoint_model_ids(endpoint)
    catalog = catalog_models(fetch_json(CATALOG_URL))
    models_dev = models_dev_models(fetch_json(MODELS_DEV_URL))
    models = [validated_model(model_id, catalog, models_dev) for model_id in endpoint_ids]

    result = {
        "retrievedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sources": {
            "endpoint": endpoint_url,
            "catalog": CATALOG_URL,
            "modelsDev": MODELS_DEV_URL,
            "openapi": OPENAPI_URL,
        },
        "openapi": openapi_fingerprint(),
        "models": models,
        "missingDocumentation": [],
        "documentedButUnavailable": sorted(set(catalog) - set(endpoint_ids)),
    }
    rendered = json.dumps(result, indent=4) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
        print(f"wrote {len(endpoint_ids)} models to {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
