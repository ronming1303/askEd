"""Download and cache SEC's quarterly Form 13F structured data sets, trimmed
to what institutional_holdings.py needs.

This is a standalone script, not a Flask route — meant to be run manually or
on a periodic schedule (13F data only updates once a quarter, ~45-60 days
after each quarter-end). It never runs inside a web request.

Usage:
    python3 src/refresh_13f_data.py                # fetch anything new
    python3 src/refresh_13f_data.py --limit 2       # cap to 2 new archives
    python3 src/refresh_13f_data.py --dry-run       # list what would download
    python3 src/refresh_13f_data.py --prune-older-than-quarters 8
"""

import argparse
import json
import os
import re
import shutil
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd
import requests
from bs4 import BeautifulSoup

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
RAW_DIR = DATA_DIR / "13f_raw"
SEEN_ARCHIVES_PATH = RAW_DIR / "_seen_archives.json"

LISTING_URL = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets"
USER_AGENT = os.environ.get("SEC_EDGAR_IDENTITY", "askEd research user@example.com")

INFOTABLE_COLS = ["ACCESSION_NUMBER", "CUSIP", "VALUE", "SSHPRNAMT", "SSHPRNAMTTYPE", "PUTCALL"]
SUBMISSION_COLS = ["ACCESSION_NUMBER", "CIK", "SUBMISSIONTYPE", "PERIODOFREPORT", "FILING_DATE"]
COVERPAGE_COLS = ["ACCESSION_NUMBER", "FILINGMANAGER_NAME"]

_QUARTER_END_MONTH_DAY = {(1, 2, 3): 1, (4, 5, 6): 2, (7, 8, 9): 3, (10, 11, 12): 4}


def _period_to_quarter_id(period_str: str) -> str:
    """'31-MAR-2026' -> '2026Q1'."""
    d = pd.to_datetime(period_str, format="%d-%b-%Y")
    for months, q in _QUARTER_END_MONTH_DAY.items():
        if d.month in months:
            return f"{d.year}Q{q}"
    raise ValueError(f"Could not map period '{period_str}' to a quarter")


def _load_seen_archives() -> dict:
    if not SEEN_ARCHIVES_PATH.exists():
        return {}
    try:
        return json.loads(SEEN_ARCHIVES_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _save_seen_archives(seen: dict) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    SEEN_ARCHIVES_PATH.write_text(json.dumps(seen, indent=2))


def list_archive_urls() -> list[str]:
    resp = requests.get(LISTING_URL, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    urls = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.endswith("_form13f.zip"):
            urls.append(href if href.startswith("http") else f"https://www.sec.gov{href}")
    return urls


def _extract_member(zf: zipfile.ZipFile, filename: str, dest_dir: Path) -> Path:
    """Find a member by basename regardless of an enclosing folder in the
    zip (some archives nest everything under a subdirectory, others don't).
    """
    matches = [n for n in zf.namelist() if n.endswith(filename)]
    if not matches:
        raise FileNotFoundError(f"{filename} not found in archive")
    dest = dest_dir / filename
    with zf.open(matches[0]) as src, open(dest, "wb") as out:
        shutil.copyfileobj(src, out)
    return dest


def _read_infotable_filtered(path: Path, keep_accessions: set[str]) -> pd.DataFrame:
    """INFOTABLE.tsv is ~350-400MB / ~3.8M rows — read in chunks and keep
    only rows belonging to accessions we already know we want, rather than
    loading the whole thing into memory.
    """
    chunks = []
    for chunk in pd.read_csv(
        path, sep="\t", usecols=INFOTABLE_COLS, dtype={"CUSIP": str}, chunksize=500_000
    ):
        chunks.append(chunk[chunk["ACCESSION_NUMBER"].isin(keep_accessions)])
    return pd.concat(chunks, ignore_index=True) if chunks else pd.DataFrame(columns=INFOTABLE_COLS)


def process_archive(url: str, tmp_dir: Path) -> str:
    """Download, trim, and cache one archive. Returns the quarter_id it
    represents (whether or not this call actually wrote new parquet files —
    the caller records url->quarter_id in the manifest either way).
    """
    tmp_dir.mkdir(parents=True, exist_ok=True)
    zip_path = tmp_dir / "archive.zip"

    with requests.get(url, headers={"User-Agent": USER_AGENT}, stream=True, timeout=180) as resp:
        resp.raise_for_status()
        with open(zip_path, "wb") as f:
            shutil.copyfileobj(resp.raw, f)

    with zipfile.ZipFile(zip_path) as zf:
        submission_path = _extract_member(zf, "SUBMISSION.tsv", tmp_dir)
        coverpage_path = _extract_member(zf, "COVERPAGE.tsv", tmp_dir)
        infotable_path = _extract_member(zf, "INFOTABLE.tsv", tmp_dir)

    submission = pd.read_csv(submission_path, sep="\t", usecols=SUBMISSION_COLS, dtype={"CIK": str})
    dominant_period = submission["PERIODOFREPORT"].value_counts().idxmax()
    quarter_id = _period_to_quarter_id(dominant_period)

    quarter_dir = RAW_DIR / quarter_id
    if (quarter_dir / "_meta.json").exists():
        return quarter_id  # already cached from an earlier archive — nothing to do

    submission = submission[submission["PERIODOFREPORT"] == dominant_period]
    keep_accessions = set(submission["ACCESSION_NUMBER"])

    coverpage = pd.read_csv(coverpage_path, sep="\t", usecols=COVERPAGE_COLS)
    coverpage = coverpage[coverpage["ACCESSION_NUMBER"].isin(keep_accessions)]

    infotable = _read_infotable_filtered(infotable_path, keep_accessions)

    quarter_dir.mkdir(parents=True, exist_ok=True)
    submission.to_parquet(quarter_dir / "submission.parquet", index=False)
    coverpage.to_parquet(quarter_dir / "coverpage.parquet", index=False)
    infotable.to_parquet(quarter_dir / "infotable.parquet", index=False)

    (quarter_dir / "_meta.json").write_text(json.dumps({
        "source_url": url,
        "downloaded_at": date.today().isoformat(),
        "dominant_period_of_report": dominant_period,
        "quarter_id": quarter_id,
        "row_counts": {
            "submission": len(submission),
            "coverpage": len(coverpage),
            "infotable": len(infotable),
        },
    }, indent=2))

    return quarter_id


def prune_older_than(n_quarters: int) -> None:
    quarters = sorted(
        p.name for p in RAW_DIR.iterdir()
        if p.is_dir() and (p / "_meta.json").exists()
    )
    for quarter_id in quarters[:-n_quarters] if n_quarters > 0 else []:
        shutil.rmtree(RAW_DIR / quarter_id)
        print(f"pruned {quarter_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None, help="Max new archives to process this run")
    parser.add_argument("--dry-run", action="store_true", help="List new archives without downloading")
    parser.add_argument("--force", action="store_true", help="Reprocess archives even if already in the seen-manifest")
    parser.add_argument("--prune-older-than-quarters", type=int, default=None)
    args = parser.parse_args()

    seen = _load_seen_archives()
    urls = list_archive_urls()
    new_urls = [u for u in urls if args.force or u not in seen]

    if args.limit is not None:
        new_urls = new_urls[:args.limit]

    if args.dry_run:
        print(f"{len(new_urls)} new archive(s) would be processed:")
        for u in new_urls:
            print(f"  {u}")
        return

    if not new_urls:
        print("No new archives to process.")
    else:
        for url in new_urls:
            print(f"processing {url} ...")
            tmp_dir = RAW_DIR / ".tmp"
            try:
                quarter_id = process_archive(url, tmp_dir)
                seen[url] = quarter_id
                _save_seen_archives(seen)
                print(f"  -> {quarter_id} cached")
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

    if args.prune_older_than_quarters is not None:
        prune_older_than(args.prune_older_than_quarters)


if __name__ == "__main__":
    main()
