"""Polymarket's monthly "will TICKER hit $X" prediction-market series —
market-implied probability of a stock touching various price levels within
the current calendar month.

Public, no-auth API (gamma-api.polymarket.com) — but needs a browser-like
User-Agent or it 403s. Coverage is spotty: verified against a 26-ticker
sample, only ~40% (skewed toward volatile/"story" stocks — PLTR, COIN,
MSTR, HOOD — rather than pure market cap; even MSFT/GOOGL/AMZN have no
series) have an active series, so a missing result is the normal case, not
an error.
"""

import json
import re
from datetime import datetime, timezone

import requests

SEARCH_URL = "https://gamma-api.polymarket.com/public-search"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"

_QUESTION_RE = re.compile(r"\((HIGH|LOW)\)\s*\$([\d,]+)")


def get_price_probabilities(ticker: str, company_name: str) -> list[dict]:
    """Current month's price-threshold markets for a ticker, if Polymarket
    has that series. Returns [] if there's no matching active event —
    normal for most tickers, not a failure.

    Each returned dict: {"side": "HIGH"|"LOW", "strike": float,
    "yes_price": float (0-1, the market-implied probability)}, sorted by
    strike descending.
    """
    resp = requests.get(
        SEARCH_URL,
        params={"q": f"{company_name} {ticker}", "events_status": "active"},
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    resp.raise_for_status()
    events = resp.json().get("events", [])

    # The recurring monthly series has a predictable slug
    # ("what-price-will-aapl-hit-in-july-2026") — distinct from the
    # separate weekly series this search also turns up. Prefer whichever
    # matching event's date range actually covers today, in case the
    # search returns both the current and an adjacent month.
    prefix = f"what-price-will-{ticker.lower()}-hit-in-"
    candidates = [e for e in events if e.get("slug", "").startswith(prefix)]
    if not candidates:
        return []

    now = datetime.now(timezone.utc)

    def _covers_now(event: dict) -> bool:
        try:
            start = datetime.fromisoformat(event["startDate"].replace("Z", "+00:00"))
            end = datetime.fromisoformat(event["endDate"].replace("Z", "+00:00"))
            return start <= now <= end
        except (KeyError, ValueError):
            return False

    event = next((e for e in candidates if _covers_now(e)), candidates[0])

    # A freshly-created month's series can sit at an untraded 50/50 for
    # every strike until real trading starts — that's not a meaningful
    # signal, so treat "no volume yet" the same as "no market at all".
    if not event.get("volume"):
        return []

    results = []
    for market in event.get("markets", []):
        match = _QUESTION_RE.search(market.get("question", ""))
        if not match:
            continue
        try:
            outcomes = json.loads(market["outcomes"])
            prices = json.loads(market["outcomePrices"])
            yes_price = float(prices[outcomes.index("Yes")])
        except (KeyError, ValueError, IndexError, json.JSONDecodeError):
            continue
        results.append({
            "side": match.group(1),
            "strike": float(match.group(2).replace(",", "")),
            "yes_price": yes_price,
        })

    results.sort(key=lambda r: r["strike"], reverse=True)
    return results
