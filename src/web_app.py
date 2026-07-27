"""Tiny demo: enter a ticker, see its SEC filings laid out on a hoverable timeline.

Run with:
    python3 src/web_app.py
Then open http://127.0.0.1:5000
"""

import os
from datetime import date, datetime, timedelta
from pathlib import Path

import requests as http_requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from edgar import Company, CompanyNotFoundError, set_identity

from edgar_filings import fetch_filing_detail, fetch_filings, fetch_latest_filing, fetch_sale_summary
from institutional_holdings import get_snapshots_for_ticker
from options_data import get_implied_volatility, get_option_chain
from prediction_market import get_price_probabilities
from technical_indicators import compute_indicators

load_dotenv(Path(__file__).parent.parent / ".env")
set_identity(os.environ.get("SEC_EDGAR_IDENTITY", "askEd research user@example.com"))

app = Flask(__name__)

# fetch_filing_detail() makes an extra network request per filing (it parses
# the filing's own document, not the cheap bulk list) — cache by accession
# number so re-expanding a row in the UI doesn't refetch from SEC.
_detail_cache: dict[str, dict] = {}

# Same idea as _detail_cache: the timeline progressively enriches each Form
# 3/4/5 row with a "sold X sh. @ $Y" summary in the background after it first
# renders — cache by accession so re-searching the same ticker doesn't refetch.
_sale_summary_cache: dict[str, dict | None] = {}
_news_cache: dict[str, list] = {}
_price_cache: dict[str, list] = {}
_latest_filing_cache: dict[str, dict | None] = {}
_institutional_cache: dict[str, list] = {}
_short_interest_cache: dict[str, list] = {}
_prediction_market_cache: dict[str, list] = {}
_options_iv_cache: dict[str, dict | None] = {}


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/filings")
def api_filings():
    ticker = request.args.get("ticker", "").strip()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    days = request.args.get("days", default=30, type=int)
    forms_param = request.args.get("forms", "").strip()
    forms = [f.strip() for f in forms_param.split(",") if f.strip()] or None

    try:
        result = fetch_filings(ticker, forms=forms, days=days, newest_first=True)
    except CompanyNotFoundError as exc:
        return jsonify({
            "error": f"Could not find a ticker for '{ticker}'",
            "suggestions": exc.suggestions,
        }), 404
    except Exception as exc:
        return jsonify({"error": f"Could not fetch filings for '{ticker}': {exc}"}), 502

    return jsonify(result)


@app.get("/api/filing-detail")
def api_filing_detail():
    accession = request.args.get("accession", "").strip()
    if not accession:
        return jsonify({"error": "accession is required"}), 400

    if accession not in _detail_cache:
        try:
            _detail_cache[accession] = fetch_filing_detail(accession)
        except Exception as exc:
            return jsonify({"error": f"Could not fetch detail for '{accession}': {exc}"}), 502

    return jsonify(_detail_cache[accession])


@app.get("/api/sale-summary")
def api_sale_summary():
    accession = request.args.get("accession", "").strip()
    if not accession:
        return jsonify({"error": "accession is required"}), 400

    if accession not in _sale_summary_cache:
        try:
            _sale_summary_cache[accession] = fetch_sale_summary(accession)
        except Exception as exc:
            return jsonify({"error": f"Could not fetch sale summary for '{accession}': {exc}"}), 502

    return jsonify(_sale_summary_cache[accession])


@app.get("/api/latest-filing")
def api_latest_filing():
    ticker = request.args.get("ticker", "").strip()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    form = request.args.get("form", "10-Q").strip()
    cache_key = f"{ticker.upper()}:{form}"

    if cache_key not in _latest_filing_cache:
        try:
            _latest_filing_cache[cache_key] = fetch_latest_filing(ticker, form=form)
        except Exception as exc:
            return jsonify({"error": f"Could not fetch latest {form} for '{ticker}': {exc}"}), 502

    result = _latest_filing_cache[cache_key]
    if result is None:
        return jsonify({"error": f"No {form} filings found for '{ticker}'"}), 404
    return jsonify(result)


@app.get("/api/institutional-holdings")
def api_institutional_holdings():
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    if ticker not in _institutional_cache:
        try:
            _institutional_cache[ticker] = get_snapshots_for_ticker(ticker)
        except Exception as exc:
            return jsonify({"error": f"Could not compute institutional holdings for '{ticker}': {exc}"}), 502

    return jsonify(_institutional_cache[ticker])


@app.get("/api/short-interest")
def api_short_interest():
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    if ticker not in _short_interest_cache:
        try:
            # Nasdaq's own (undocumented, consumer-site) API — free, no auth,
            # but only covers Nasdaq-listed tickers. Unsupported tickers
            # (NYSE-listed, etc.) come back with data: null, not an error —
            # treat that the same way, as "nothing to show" rather than fail.
            resp = http_requests.get(
                f"https://api.nasdaq.com/api/quote/{ticker}/short-interest",
                params={"assetclass": "stocks"},
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=10,
            )
            resp.raise_for_status()
            payload = resp.json()
            table = (payload.get("data") or {}).get("shortInterestTable") or {}
            rows = table.get("rows") or []
            _short_interest_cache[ticker] = [
                {
                    "settlement_date": datetime.strptime(row["settlementDate"], "%m/%d/%Y").strftime("%Y-%m-%d"),
                    "short_interest_shares": int(row["interest"].replace(",", "")),
                    "avg_daily_volume": int(row["avgDailyShareVolume"].replace(",", "")),
                    "days_to_cover": row["daysToCover"],
                }
                for row in rows
            ]
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502

    return jsonify(_short_interest_cache[ticker])


@app.get("/api/prediction-market")
def api_prediction_market():
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    if ticker not in _prediction_market_cache:
        try:
            company_name = Company(ticker).name
            _prediction_market_cache[ticker] = get_price_probabilities(ticker, company_name)
        except CompanyNotFoundError:
            _prediction_market_cache[ticker] = []
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502

    return jsonify(_prediction_market_cache[ticker])


@app.get("/api/options-iv")
def api_options_iv():
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    if ticker not in _options_iv_cache:
        # CBOE (IV) and Nasdaq (bid/ask/volume/open interest) are two
        # independent feeds merged into one response — one failing or
        # having no coverage shouldn't take down the other.
        try:
            result = get_implied_volatility(ticker)
        except Exception:
            result = None
        try:
            chain = get_option_chain(ticker)
        except Exception:
            chain = None
        if chain:
            result = result or {}
            result["chain"] = chain["chain"]
            result["chain_expiration"] = chain["expiration"]
        _options_iv_cache[ticker] = result

    return jsonify(_options_iv_cache[ticker])


@app.get("/api/news")
def api_news():
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    api_key = os.environ.get("POLYGON_API_KEY", "")
    if not api_key:
        return jsonify({"error": "POLYGON_API_KEY not configured"}), 503

    days = request.args.get("days", default=30, type=int)
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    cache_key = f"{ticker}:{days}"

    if cache_key not in _news_cache:
        try:
            resp = http_requests.get(
                "https://api.polygon.io/v2/reference/news",
                params={
                    "ticker": ticker, "limit": 1000, "order": "desc",
                    "published_utc.gte": cutoff, "apiKey": api_key,
                },
                timeout=10,
            )
            resp.raise_for_status()
            raw = resp.json().get("results", [])
            _news_cache[cache_key] = [
                {
                    "date": item["published_utc"][:10],
                    "title": item["title"],
                    "description": item.get("description", ""),
                    "url": item["article_url"],
                    "source": item["publisher"]["name"],
                    "sentiment": (item.get("insights") or [{}])[0].get("sentiment"),
                }
                for item in raw
            ]
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502

    return jsonify(_news_cache[cache_key])


@app.get("/api/prices")
def api_prices():
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    api_key = os.environ.get("POLYGON_API_KEY", "")
    if not api_key:
        return jsonify({"error": "POLYGON_API_KEY not configured"}), 503

    days = request.args.get("days", default=30, type=int)
    to_date = date.today().isoformat()
    display_from = date.today() - timedelta(days=days)
    cache_key = f"{ticker}:{days}"

    if cache_key not in _price_cache:
        try:
            # Fetch extra lookback before the display window so SMA50/MACD's
            # EMA26 have room to warm up — trimmed back to the requested
            # window below, so this stays invisible to callers.
            fetch_from = (display_from - timedelta(days=130)).isoformat()
            resp = http_requests.get(
                f"https://api.polygon.io/v2/aggs/ticker/{ticker}/range/1/day/{fetch_from}/{to_date}",
                params={"adjusted": "true", "sort": "asc", "apiKey": api_key},
                timeout=10,
            )
            resp.raise_for_status()
            raw = resp.json().get("results", [])
            bars = [
                {
                    "date": datetime.utcfromtimestamp(bar["t"] / 1000).strftime("%Y-%m-%d"),
                    "open": bar["o"],
                    "high": bar["h"],
                    "low": bar["l"],
                    "close": bar["c"],
                    "volume": bar["v"],
                }
                for bar in raw
            ]
            bars = compute_indicators(bars)
            display_from_str = display_from.isoformat()
            _price_cache[cache_key] = [b for b in bars if b["date"] >= display_from_str]
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502

    return jsonify(_price_cache[cache_key])


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "0") == "1")
