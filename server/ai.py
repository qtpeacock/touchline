"""The AI model behind the practice builder: gpt-6-luna through Portkey, plus token prices.

The key is PORTKEY_API_KEY, read from a .env file in this project's folder first and then from the
folder one level above it (where the course staff keep theirs). It never leaves the server.
"""
import os
from functools import lru_cache

from dotenv import load_dotenv

from .db import ROOT

os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

from openai import AsyncOpenAI, omit  # noqa: E402
from pydantic_ai.models.openai import OpenAIResponsesModel, OpenAIResponsesModelSettings  # noqa: E402
from pydantic_ai.providers.openai import OpenAIProvider  # noqa: E402

# Project folder first, then one level up. load_dotenv never overrides a value that is already set,
# so the first file that has the key wins.
for env_file in (ROOT / ".env", ROOT.parent / ".env"):
    if env_file.exists():
        load_dotenv(env_file, override=False)

# The course key may only be used with this model. Deliberately not read from the environment.
MODEL_NAME = "gpt-6-luna"
PORTKEY_BASE_URL = "https://api.portkey.ai/v1"

# USD per 1M tokens, OpenAI Standard tier (same table as the Lecture 11 tokenomics demo).
# input_tokens already includes cached tokens, so cached ones are taken out before pricing the rest.
PRICES = {"input": 0.10, "cached_input": 0.01, "cache_write": 0.125, "output": 0.50}


def cost_usd(usage: dict) -> float:
    cached = usage.get("cache_read_tokens", 0)
    written = usage.get("cache_write_tokens", 0)
    uncached = max(usage.get("input_tokens", 0) - cached - written, 0)
    return (uncached * PRICES["input"] + cached * PRICES["cached_input"] + written * PRICES["cache_write"]
            + usage.get("output_tokens", 0) * PRICES["output"]) / 1_000_000


def ai_ready() -> bool:
    return bool(os.getenv("PORTKEY_API_KEY", "").strip())


def settings(max_tokens: int, cache_key: str) -> OpenAIResponsesModelSettings:
    """Low reasoning effort and a cap on each answer keep every step short and cheap.

    The cache key sends each agent's requests to the same cache, so its long, unchanging
    instructions are billed at the cached rate after the first call.
    """
    return OpenAIResponsesModelSettings(
        max_tokens=max_tokens, openai_reasoning_effort="low", openai_prompt_cache_key=f"touchline-{cache_key}",
    )


class CachedInstructionsModel(OpenAIResponsesModel):
    """Sends each agent's instructions as the first input item with an explicit cache breakpoint.

    OpenAI won't put a cache breakpoint on top-level `instructions`, so the stable prompt goes in a
    developer message instead; everything that changes per run (the request, tool results) comes after it.
    """

    async def _map_messages(self, messages, model_settings, model_request_parameters, **kwargs):
        instructions, items = await super()._map_messages(messages, model_settings, model_request_parameters, **kwargs)
        if not isinstance(instructions, str) or not instructions:
            return instructions, items
        developer = {
            "role": "developer",
            "content": [{"type": "input_text", "text": instructions, "prompt_cache_breakpoint": {"mode": "explicit"}}],
        }
        return omit, [developer, *items]


@lru_cache(maxsize=1)
def build_model() -> CachedInstructionsModel:
    """gpt-6-luna on Portkey's OpenAI-compatible endpoint. Uses the Responses API, which this model
    needs for function tools."""
    key = os.getenv("PORTKEY_API_KEY", "").strip()
    if not key:
        raise RuntimeError("PORTKEY_API_KEY is not set. Put it in a .env file in this folder or the folder above it.")
    client = AsyncOpenAI(api_key=key, base_url=PORTKEY_BASE_URL, default_headers={"x-portkey-api-key": key}, timeout=90)
    return CachedInstructionsModel(MODEL_NAME, provider=OpenAIProvider(openai_client=client))
