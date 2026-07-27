"""Options data from two free, public, no-auth feeds:

- CBOE's delayed-quotes feed (cdn.cboe.com) for implied volatility —
  get_implied_volatility().
- Nasdaq's own option-chain feed (api.nasdaq.com — the same host already
  used for short interest) for bid/ask/volume/open interest per strike,
  which CBOE's feed doesn't expose in the compact form needed here —
  get_option_chain().

Both need the underlying to actually have listed options; a ticker with
none returns None from either, which is the normal case for most tickers,
not a failure.
"""

import re
from datetime import date, timedelta

import requests

CBOE_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/{ticker}.json"
NASDAQ_CHAIN_URL = "https://api.nasdaq.com/api/quote/{ticker}/option-chain"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"

_SYMBOL_RE = re.compile(r"^[A-Z]+(\d{6})([CP])(\d{8})$")


def get_implied_volatility(ticker: str) -> dict | None:
    """None if CBOE has no options coverage for this ticker (no listed
    options, or an unrecognized symbol) — the normal case for many
    tickers, not a failure.
    """
    resp = requests.get(
        CBOE_URL.format(ticker=ticker.upper()),
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    # This feed is a static per-ticker JSON file behind what looks like an
    # S3 bucket — a ticker with no listed options (or no coverage) 403s
    # ("AccessDenied") rather than 404ing, since the object just doesn't
    # exist. Either way it means "no data for this ticker", not a real
    # auth failure.
    if resp.status_code in (403, 404):
        return None
    resp.raise_for_status()

    payload = resp.json().get("data")
    if not payload or not payload.get("options") or payload.get("iv30") is None:
        return None

    by_expiry: dict[str, list[tuple[str, float, float | None, float | None]]] = {}
    for opt in payload["options"]:
        match = _SYMBOL_RE.match(opt.get("option", ""))
        if not match:
            continue
        expiry, side, strike_str = match.groups()
        by_expiry.setdefault(expiry, []).append(
            (side, int(strike_str) / 1000, opt.get("iv"), opt.get("open_interest"))
        )

    smile = []
    expiration = None
    if by_expiry:
        expiry, rows = min(by_expiry.items())
        expiration = f"20{expiry[:2]}-{expiry[2:4]}-{expiry[4:6]}"

        by_strike: dict[float, dict] = {}
        for side, strike, iv, open_interest in rows:
            # Deep ITM/OTM contracts with no real trading interest produce
            # unstable/junk IV reads (including a literal 0.0 for otherwise
            # liquid-looking contracts) — require actual open interest for
            # a strike to be considered a real reading.
            if iv is None or iv <= 0 or iv > 5 or not open_interest:
                continue
            entry = by_strike.setdefault(strike, {"strike": strike})
            entry["call_iv" if side == "C" else "put_iv"] = round(iv * 100, 1)
        smile = sorted(by_strike.values(), key=lambda r: r["strike"])

    return {
        "iv30": round(payload["iv30"], 1),
        "iv30_change": payload.get("iv30_change"),
        "current_price": payload.get("current_price"),
        "expiration": expiration,
        "smile": smile,
    }


def _num(value: str | None) -> float | None:
    """Nasdaq renders a missing quote as the literal string "--"."""
    if value in (None, "--", ""):
        return None
    return float(value.replace(",", ""))


def get_option_chain(ticker: str) -> dict | None:
    """Bid/ask/volume/open interest per strike for the nearest expiration.
    Unlike short interest, this isn't restricted to Nasdaq-listed tickers —
    verified against JPM (NYSE) working fine, since Nasdaq's site chains
    cover any optionable security regardless of primary listing exchange.
    Returns None if there's no chain for this ticker at all.
    """
    today = date.today()
    resp = requests.get(
        NASDAQ_CHAIN_URL.format(ticker=ticker.upper()),
        params={
            "assetclass": "stocks",
            "limit": 200,
            "fromdate": today.isoformat(),
            "todate": (today + timedelta(days=14)).isoformat(),
            "callput": "callput",
            "money": "all",
            "type": "all",
        },
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=10,
    )
    resp.raise_for_status()
    payload = resp.json().get("data")
    if not payload or not payload.get("table") or not payload["table"].get("rows"):
        return None

    rows = payload["table"]["rows"]
    # Rows are pre-sorted nearest-expiration-first; the first row with a
    # strike (the ones before it are just an "expirygroup" header divider)
    # fixes which expiration this chain covers — take only that block.
    first_expiry = next((r["expiryDate"] for r in rows if r.get("strike")), None)
    if first_expiry is None:
        return None

    chain = []
    for r in rows:
        if r.get("expiryDate") != first_expiry or not r.get("strike"):
            continue
        chain.append({
            "strike": float(r["strike"]),
            "call_bid": _num(r.get("c_Bid")),
            "call_ask": _num(r.get("c_Ask")),
            "call_volume": _num(r.get("c_Volume")),
            "call_oi": _num(r.get("c_Openinterest")),
            "put_bid": _num(r.get("p_Bid")),
            "put_ask": _num(r.get("p_Ask")),
            "put_volume": _num(r.get("p_Volume")),
            "put_oi": _num(r.get("p_Openinterest")),
        })

    if not chain:
        return None

    chain.sort(key=lambda r: r["strike"])
    return {"expiration": first_expiry, "chain": chain}
