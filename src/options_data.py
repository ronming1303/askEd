"""Options implied volatility from CBOE's free, public delayed-quotes feed
(cdn.cboe.com) — no auth needed, but the underlying company must actually
have listed options for the ticker to return anything.

CBOE's own iv30 field (a VIX-style, ~30-calendar-day constant-maturity
implied volatility) is the headline number. Individual contract IVs are
also used to build an IV "smile" (IV by strike) for the nearest expiration
— separate from and not directly comparable to iv30, since it's whatever
the nearest listed expiration happens to be (could be days away, not 30).
"""

import re

import requests

CBOE_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/{ticker}.json"
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
