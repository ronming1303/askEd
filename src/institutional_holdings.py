"""Per-quarter institutional ownership snapshot for a ticker, aggregated from
SEC's market-wide Form 13F structured data — NOT a filing by the searched
company itself, but a reverse-index across every institutional manager's
holdings that quarter.

Two numbers per quarter:
    institutional_ownership_pct = sum of all 13F-reported share positions in
                                   this ticker / the company's total shares
                                   outstanding
    concentration_pct           = the 100 largest 13F filers' combined shares
                                   / all 13F filers' combined shares, that
                                   quarter

Raw quarterly data is downloaded and trimmed by refresh_13f_data.py into
data/13f_raw/<quarter_id>/*.parquet — this module only ever reads what's
already cached there; it never downloads anything itself, so it's cheap and
safe to call from a live web request.

Does not call set_identity() itself — same convention as edgar_filings.py;
the importer (web_app.py) sets it once at startup.
"""

import argparse
import json
import os
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
from edgar import Company
from edgar.reference.tickers import cusip_ticker_mapping

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
RAW_DIR = DATA_DIR / "13f_raw"
SNAPSHOT_DIR = DATA_DIR / "institutional_snapshots"

TOP_N_CONCENTRATION = 100

# 13F filings are due 45 days after each calendar quarter-end — a quarter's
# aggregate ownership data isn't actually publicly knowable until then, so
# timeline entries are dated at quarter-end + this lag, not the quarter-end
# itself.
DISCLOSURE_LAG_DAYS = 45

_QUARTER_END_MONTH_DAY = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}


def _quarter_end_date(quarter_id: str) -> date:
    year, q = int(quarter_id[:4]), int(quarter_id[5])
    month, day = _QUARTER_END_MONTH_DAY[q]
    return date(year, month, day)


def resolve_cusip(ticker: str) -> str | None:
    """Ticker -> CUSIP via edgartools' bundled mapping (local file, no network)."""
    df = cusip_ticker_mapping()
    match = df[df["Ticker"] == ticker.upper()]
    return match.index[0] if len(match) else None


def list_cached_quarters() -> list[str]:
    """Quarter ids under RAW_DIR that finished downloading (have _meta.json) —
    guards against a half-written dir from an interrupted refresh run.
    """
    if not RAW_DIR.is_dir():
        return []
    return sorted(
        p.name for p in RAW_DIR.iterdir()
        if p.is_dir() and (p / "_meta.json").exists()
    )


def compute_quarter_snapshot(cusip: str, quarter_id: str) -> dict | None:
    """Aggregate one quarter's 13F data for a single CUSIP. Returns None if
    the CUSIP has zero reported positions that quarter (e.g. pre-IPO).
    """
    qdir = RAW_DIR / quarter_id
    infotable = pd.read_parquet(qdir / "infotable.parquet")
    # Filers hand-enter CUSIPs and sometimes get the case wrong (e.g.
    # "21873s108" vs the correct "21873S108") — match case-insensitively.
    rows = infotable[infotable["CUSIP"].str.upper() == cusip.upper()]
    rows = rows[rows["PUTCALL"].isna()]  # shares only, exclude options line items
    if rows.empty:
        return None

    submission = pd.read_parquet(qdir / "submission.parquet")
    merged = rows.merge(submission, on="ACCESSION_NUMBER")

    # A single accession can legitimately report the same CUSIP across
    # multiple rows (split by voting-authority/investment-discretion
    # category) — sum them, don't deduplicate.
    per_accession = merged.groupby(
        ["CIK", "ACCESSION_NUMBER", "FILING_DATE"], as_index=False
    )["SSHPRNAMT"].sum()

    # If a CIK filed more than one accession this quarter (original +
    # amendment), keep only the most recently filed one.
    per_accession["FILING_DATE"] = pd.to_datetime(per_accession["FILING_DATE"], format="mixed")
    per_accession = per_accession.sort_values("FILING_DATE").drop_duplicates(
        subset=["CIK"], keep="last"
    )

    total_shares = int(per_accession["SSHPRNAMT"].sum())
    top100_shares = int(
        per_accession.sort_values("SSHPRNAMT", ascending=False).head(TOP_N_CONCENTRATION)["SSHPRNAMT"].sum()
    )

    return {
        "total_13f_shares": total_shares,
        "top100_shares": top100_shares,
        "concentration_pct": round(top100_shares / total_shares * 100, 1),
        "filer_count": len(per_accession),
    }


def shares_outstanding_asof(ticker: str, quarter_end: date) -> tuple[float | None, str | None]:
    """Shares outstanding from the closest 10-Q/10-K cover-page date at or
    after quarter_end. Cover-page counts are dated ~3-4 weeks after the
    quarter actually ends (not the quarter-end itself) — a small timing
    mismatch that's immaterial for a company like AAPL with no large
    intra-quarter share issuance, and not solved further here.
    """
    company = Company(ticker)
    facts = company.get_facts().get_all_facts()
    candidates = [
        f for f in facts
        if "EntityCommonStockSharesOutstanding" in str(f.concept)
        and f.period_end is not None
        and f.period_end >= quarter_end
    ]
    if not candidates:
        return None, None
    best = min(candidates, key=lambda f: f.period_end)
    return float(best.value), str(best.period_end)


def _snapshot_cache_path(ticker: str) -> Path:
    return SNAPSHOT_DIR / f"{ticker.upper()}.json"


def _load_cached_snapshots(ticker: str) -> dict:
    path = _snapshot_cache_path(ticker)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _save_cached_snapshots(ticker: str, payload: dict) -> None:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = _snapshot_cache_path(ticker)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload))
    os.replace(tmp, path)


def get_snapshots_for_ticker(ticker: str) -> list[dict]:
    """All available quarterly institutional-ownership snapshots for a
    ticker, newest first. Never downloads anything — only reads whatever
    refresh_13f_data.py has already cached under data/13f_raw/. Returns []
    if the ticker's CUSIP can't be resolved or no quarters are cached yet.
    """
    ticker = ticker.upper()
    cached = _load_cached_snapshots(ticker)

    cusip = cached.get("cusip") or resolve_cusip(ticker)
    if cusip is None:
        return []

    available_quarters = list_cached_quarters()
    quarters = cached.get("quarters", {})

    dirty = cached.get("cusip") != cusip
    for quarter_id in available_quarters:
        if quarter_id in quarters:
            continue
        snapshot = compute_quarter_snapshot(cusip, quarter_id)
        if snapshot is None:
            continue  # e.g. pre-IPO this quarter — try again once new quarters land

        quarter_end = _quarter_end_date(quarter_id)
        shares_out, shares_out_asof = shares_outstanding_asof(ticker, quarter_end)
        ownership_pct = (
            round(snapshot["total_13f_shares"] / shares_out * 100, 1)
            if shares_out else None
        )

        quarters[quarter_id] = {
            "quarter": quarter_id,
            "quarter_end": quarter_end.isoformat(),
            "disclosed_date": (quarter_end + timedelta(days=DISCLOSURE_LAG_DAYS)).isoformat(),
            "institutional_ownership_pct": ownership_pct,
            "concentration_pct": snapshot["concentration_pct"],
            "total_13f_shares": snapshot["total_13f_shares"],
            "filer_count": snapshot["filer_count"],
            "shares_outstanding": shares_out,
            "shares_outstanding_asof": shares_out_asof,
        }
        dirty = True

    if dirty:
        _save_cached_snapshots(ticker, {"cusip": cusip, "quarters": quarters})

    return sorted(quarters.values(), key=lambda s: s["quarter_end"], reverse=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ticker", help="Stock ticker symbol, e.g. AAPL")
    args = parser.parse_args()

    from edgar import set_identity
    set_identity(os.environ.get("SEC_EDGAR_IDENTITY", "askEd research user@example.com"))

    snapshots = get_snapshots_for_ticker(args.ticker)
    if not snapshots:
        print(f"No institutional data available for {args.ticker} (no cached quarters or unresolvable ticker)")
        return

    header = f"{'quarter':<8} {'ownership%':>10} {'concentration%':>15} {'filers':>8} {'disclosed':>12}"
    print(header)
    for s in snapshots:
        print(
            f"{s['quarter']:<8} {s['institutional_ownership_pct']!s:>10} "
            f"{s['concentration_pct']!s:>15} {s['filer_count']:>8} {s['disclosed_date']:>12}"
        )


if __name__ == "__main__":
    main()
