"""Tiny demo: enter a ticker, see its SEC filings laid out on a hoverable timeline.

Run with:
    python3 src/web_app.py
Then open http://127.0.0.1:5000
"""

import os

from flask import Flask, jsonify, render_template, request
from edgar import set_identity

from edgar_filings import fetch_filing_detail, fetch_filings, fetch_sale_summary

DEFAULT_IDENTITY = "askEd research rliu38@stevens.edu"
set_identity(os.environ.get("SEC_EDGAR_IDENTITY", DEFAULT_IDENTITY))

app = Flask(__name__)

# fetch_filing_detail() makes an extra network request per filing (it parses
# the filing's own document, not the cheap bulk list) — cache by accession
# number so re-expanding a row in the UI doesn't refetch from SEC.
_detail_cache: dict[str, dict] = {}

# Same idea as _detail_cache: the timeline progressively enriches each Form
# 3/4/5 row with a "sold X sh. @ $Y" summary in the background after it first
# renders — cache by accession so re-searching the same ticker doesn't refetch.
_sale_summary_cache: dict[str, dict | None] = {}


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/filings")
def api_filings():
    ticker = request.args.get("ticker", "").strip()
    if not ticker:
        return jsonify({"error": "ticker is required"}), 400

    limit = request.args.get("limit", default=40, type=int)
    forms_param = request.args.get("forms", "").strip()
    forms = [f.strip() for f in forms_param.split(",") if f.strip()] or None

    try:
        result = fetch_filings(ticker, forms=forms, limit=limit, newest_first=True)
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


if __name__ == "__main__":
    app.run(debug=True)
