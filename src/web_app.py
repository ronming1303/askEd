"""Tiny demo: enter a ticker, see its SEC filings laid out on a hoverable timeline.

Run with:
    python3 src/web_app.py
Then open http://127.0.0.1:5000
"""

import os
from pathlib import Path

import requests as http_requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from edgar import set_identity

from edgar_filings import fetch_filing_detail, fetch_filings, fetch_sale_summary

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


@app.get("/api/news")
def api_news():
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    api_key = os.environ.get("POLYGON_API_KEY", "")
    if not api_key:
        return jsonify({"error": "POLYGON_API_KEY not configured"}), 503

    from datetime import date, timedelta
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


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "0") == "1")
