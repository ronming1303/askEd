"""Fetch a company's SEC EDGAR filing history by ticker, structured and sorted by date.

SEC requires every request to carry a User-Agent identifying the requester
(name + contact email). Set it via the SEC_EDGAR_IDENTITY env var, e.g.:

    export SEC_EDGAR_IDENTITY="Your Name your.email@example.com"
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta

import pandas as pd
from edgar import Company, Filing, find, set_identity

DEFAULT_IDENTITY = "askEd research user@example.com"

# Standard SEC Form 8-K / 6-K item codes -> plain-language description.
# (Public, fixed list defined by SEC regulation S-K Item 8.01 schedule —
# not something edgartools exposes, so we keep our own small lookup.)
EIGHT_K_ITEMS = {
    "Item 1.01": "Entry into a Material Definitive Agreement",
    "Item 1.02": "Termination of a Material Definitive Agreement",
    "Item 1.03": "Bankruptcy or Receivership",
    "Item 2.01": "Completion of Acquisition or Disposition of Assets",
    "Item 2.02": "Results of Operations and Financial Condition",
    "Item 2.03": "Creation of a Direct Financial Obligation",
    "Item 2.04": "Triggering Events That Accelerate a Direct Financial Obligation",
    "Item 2.05": "Costs Associated with Exit or Disposal Activities",
    "Item 2.06": "Material Impairments",
    "Item 3.01": "Notice of Delisting or Failure to Satisfy a Listing Rule",
    "Item 3.02": "Unregistered Sales of Equity Securities",
    "Item 3.03": "Material Modification to Rights of Security Holders",
    "Item 4.01": "Changes in Registrant's Certifying Accountant",
    "Item 4.02": "Non-Reliance on Previously Issued Financial Statements",
    "Item 5.01": "Changes in Control of Registrant",
    "Item 5.02": "Departure/Election of Directors or Officers; Appointment of Officers",
    "Item 5.03": "Amendments to Articles of Incorporation/Bylaws",
    "Item 5.07": "Submission of Matters to a Vote of Security Holders",
    "Item 7.01": "Regulation FD Disclosure",
    "Item 8.01": "Other Events",
    "Item 9.01": "Financial Statements and Exhibits",
}

_OWNERSHIP_FORM = re.compile(r"^[345](/A)?$")
_CURRENT_REPORT_FORM = re.compile(r"^(8-K|6-K)(/A)?$")
_SALE_NOTICE_FORM = re.compile(r"^144(/A)?$")
_FINANCIAL_REPORT_FORM = re.compile(r"^10-(K|Q)(/A)?$")
_THIRTEEN_F_FORM = re.compile(r"^13F")
_PROSPECTUS_FORM = re.compile(r"^424B")
_SCHEDULE_13_FORM = re.compile(r"^SCHEDULE 13[DG]")
_PROXY_FORM = re.compile(r"^(DEF\s*14A|DEFA14A|PX14A6G|PRE\s*14A)")

# Cap on how many Form 144 filings get opened just to build a timeline-row
# description. The bulk submissions JSON leaves primary_doc_description blank
# for every Form 144 — "" for all of them — so the only way to show who's
# selling and how much is to open the filing itself (one .obj() parse each,
# same per-filing cost as fetch_filing_detail). A page of filings typically
# holds only a handful of 144s; this cap just guards the case where someone
# filters specifically for form=144 with a high limit.
_MAX_SALE_NOTICE_DESCRIPTIONS = 12
_MAX_PROSPECTUS_DESCRIPTIONS = 8
_MAX_SCHEDULE_13_DESCRIPTIONS = 10
_MAX_PROXY_DESCRIPTIONS = 4


def _sale_notice_enrichment(obj) -> dict | None:
    """Everything the timeline needs for one Form 144 row: the inline label
    ('Deirdre O'Brien (Officer) — 50,000 sh. to sell, est. $12,776,500') plus
    a richer "business card" of context about the seller for a hover popover —
    where they're based, how long they've held the stock, what slice of their
    stake this sale represents, and whether it's a pre-scheduled 10b5-1 sale
    or a discretionary one. All of it comes off the same parsed obj, so the
    card is free once the filing is already open for the description."""
    person = getattr(obj, "person_selling", None)
    if not person:
        return None
    relationships = list(getattr(obj, "relationships", None) or [])
    units = getattr(obj, "units_to_be_sold", None)
    value = getattr(obj, "market_value", None)

    head = f"{person} ({', '.join(relationships)})" if relationships else person
    bits = []
    if units is not None:
        bits.append(f"{units:,.0f} sh. to sell")
    if value is not None:
        bits.append(f"est. ${value:,.0f}")
    description = f"{head} — {', '.join(bits)}" if bits else head

    address = getattr(obj, "address", None)
    pct = getattr(obj, "percent_of_holdings", None)
    card = {
        "name": person,
        "relationships": relationships,
        "city": getattr(address, "city", None) if address is not None else None,
        "state": getattr(address, "state_or_country", None) if address is not None else None,
        "holding_period_years": getattr(obj, "holding_period_years", None),
        "percent_of_holdings": float(pct) if pct is not None else None,
        "broker_name": getattr(obj, "broker_name", None),
        "is_10b5_1_plan": getattr(obj, "is_10b5_1_plan", None),
        "days_since_plan_adoption": getattr(obj, "days_since_plan_adoption", None),
        "cooling_off_compliant": getattr(obj, "cooling_off_compliant", None),
    }
    return {"description": description, "card": card}


def _enrich_sale_notice_descriptions(paired: list[tuple[dict, Filing]]) -> None:
    """Replace the generic 'Restricted stock sale notice (Form 144)' label,
    in place, with the seller's name/position/shares/value — and attach a
    "person_card" of supporting context (location, tenure, % of stake, plan
    status) for a business-card-style hover popover — for filings in the
    visible slice. Bounded so this stays a small, predictable handful of
    extra requests (see _MAX_SALE_NOTICE_DESCRIPTIONS)."""
    opened = 0
    for rec, filing in paired:
        if opened >= _MAX_SALE_NOTICE_DESCRIPTIONS:
            return
        if not _SALE_NOTICE_FORM.match(rec["form"]):
            continue
        opened += 1
        try:
            enrichment = _sale_notice_enrichment(filing.obj())
        except Exception:
            continue
        if enrichment:
            rec["description"] = enrichment["description"]
            rec["person_card"] = enrichment["card"]


def _format_amount_short(amount_str: str | None) -> str | None:
    """'$3,853,500,000' -> '$3.85B', '$350,000,000' -> '$350M'. Pass-through otherwise."""
    if not amount_str:
        return None
    m = re.search(r"[\d,\.]+(?:\s*(million|billion))?", amount_str, re.IGNORECASE)
    if not m:
        return amount_str
    try:
        v = float(m.group(0).split()[0].replace(",", ""))
        suffix = (m.group(1) or "").lower()
        if suffix == "billion":
            v *= 1e9
        elif suffix == "million":
            v *= 1e6
    except ValueError:
        return amount_str
    if v >= 1e9:
        trimmed = f"{v / 1e9:.3g}"
        return f"${trimmed}B"
    if v >= 1e6:
        trimmed = f"{v / 1e6:.3g}"
        return f"${trimmed}M"
    return amount_str


def _prospectus_description(obj) -> str | None:
    """One-line summary for a 424B filing: type + amount + price."""
    otype = getattr(obj, "offering_type", None)
    if otype is None or otype.value == "unknown":
        return None

    label = otype.display_name
    is_supplement = getattr(obj, "is_supplement", False)
    amount = getattr(obj, "offering_amount", None)
    price = getattr(obj, "offering_price", None)

    # Skip prices that are placeholder strings, not actual numbers
    _NON_NUMERIC_PRICES = {"at-the-market", "market-price", "preliminary-tbd", "exchange-offer"}
    price_display = price if price and price.lower() not in _NON_NUMERIC_PRICES else None

    head = f"Supplement · {label}" if is_supplement else label
    detail_parts = []
    short = _format_amount_short(amount)
    if short:
        detail_parts.append(short)
    if price_display:
        detail_parts.append(f"@ {price_display}")

    return f"{head} — {' · '.join(detail_parts)}" if detail_parts else head


def _format_shares_short(n) -> str | None:
    """1_099_168_953 -> '1.10B', 45_000_000 -> '45M', None -> None."""
    if n is None:
        return None
    try:
        v = float(n)
    except (TypeError, ValueError):
        return None
    if v >= 1e9:
        return f"{v / 1e9:.3g}B"
    if v >= 1e6:
        return f"{v / 1e6:.3g}M"
    if v >= 1e3:
        return f"{v / 1e3:.3g}K"
    return str(int(v))


def _schedule_13_description(obj) -> str | None:
    persons = list(getattr(obj, "reporting_persons", None) or [])
    filer = persons[0].name if persons else None
    pct = getattr(obj, "total_percent", None)
    shares = getattr(obj, "total_shares", None)
    if not filer:
        return None
    detail_parts = []
    if pct is not None:
        detail_parts.append(f"{float(pct):.2f}%")
    short = _format_shares_short(shares) if shares else None
    if short:
        detail_parts.append(f"{short} sh.")
    return f"{filer} — {' · '.join(detail_parts)}" if detail_parts else filer


def _enrich_schedule_13_descriptions(paired: list[tuple[dict, Filing]]) -> None:
    opened = 0
    for rec, filing in paired:
        if opened >= _MAX_SCHEDULE_13_DESCRIPTIONS:
            return
        if not _SCHEDULE_13_FORM.match(rec["form"]):
            continue
        opened += 1
        try:
            desc = _schedule_13_description(filing.obj())
        except Exception:
            continue
        if desc:
            rec["description"] = desc


def _proxy_description(form: str, obj) -> str | None:
    peo_name = getattr(obj, "peo_name", None)
    peo_comp = getattr(obj, "peo_total_comp", None)
    proposals = list(getattr(obj, "voting_proposals", None) or [])
    if not (peo_name or proposals):
        return None
    # Only label DEF 14A as "Annual Proxy"; supplemental forms get a lighter label
    is_main_proxy = re.match(r"^DEF\s*14A$", form, re.IGNORECASE) is not None
    label = "Annual Proxy" if is_main_proxy else "Proxy material"
    parts = []
    if peo_name and peo_comp:
        parts.append(f"CEO {peo_name} ${float(peo_comp) / 1e6:.1f}M")
    elif peo_name:
        parts.append(f"CEO {peo_name}")
    if proposals:
        parts.append(f"{len(proposals)} proposals")
    return f"{label} — {' · '.join(parts)}" if parts else label


def _enrich_proxy_descriptions(paired: list[tuple[dict, Filing]]) -> None:
    opened = 0
    for rec, filing in paired:
        if opened >= _MAX_PROXY_DESCRIPTIONS:
            return
        if not _PROXY_FORM.match(rec["form"]):
            continue
        opened += 1
        try:
            desc = _proxy_description(filing.form, filing.obj())
        except Exception:
            continue
        if desc:
            rec["description"] = desc


def _enrich_prospectus_descriptions(paired: list[tuple[dict, Filing]]) -> None:
    """Replace the blank 424B description with a one-line offering summary for the
    first _MAX_PROSPECTUS_DESCRIPTIONS prospectus filings in the visible slice."""
    opened = 0
    for rec, filing in paired:
        if opened >= _MAX_PROSPECTUS_DESCRIPTIONS:
            return
        if not _PROSPECTUS_FORM.match(rec["form"]):
            continue
        opened += 1
        try:
            desc = _prospectus_description(filing.obj())
        except Exception:
            continue
        if desc:
            rec["description"] = desc


def fetch_filings(ticker: str, forms: list[str] | None = None, limit: int | None = None,
                  newest_first: bool = True) -> dict:
    """Return the company's filings as structured, date-sorted records.

    Args:
        ticker: Stock ticker symbol, e.g. "AAPL".
        forms: Optional list of form types to filter on, e.g. ["10-K", "10-Q"].
        limit: Optional cap on the number of filings returned.
        newest_first: Sort order; True = most recent filing first.
    """
    company = Company(ticker)
    filings = company.get_filings(form=forms) if forms else company.get_filings()
    filings = list(filings)

    # Build every field from data already present in the bulk submissions JSON
    # (form, filing_date, accession_no, primary_document, ...). Do NOT touch
    # f.period_of_report / f.document — each access triggers a separate
    # per-filing network request (SGML or homepage fetch) and, across a
    # company's full filing history, blows through the SEC's 10 req/sec
    # limit and gets the IP temporarily blocked (HTTP 429).
    records = [
        {
            "form": f.form,
            "filing_date": str(f.filing_date),
            "accession_number": f.accession_no,
            "primary_document": f.primary_document,
            "description": f.primary_doc_description,
            "document_url": f"{f.base_dir}/{f.primary_document}" if f.primary_document else None,
            "index_url": f.homepage_url,
        }
        for f in filings
    ]
    paired = sorted(zip(records, filings), key=lambda rf: rf[0]["filing_date"], reverse=newest_first)
    if limit:
        paired = paired[:limit]

    _enrich_sale_notice_descriptions(paired)
    _enrich_prospectus_descriptions(paired)
    _enrich_schedule_13_descriptions(paired)
    _enrich_proxy_descriptions(paired)
    records = [rec for rec, _ in paired]

    return {
        "ticker": ticker.upper(),
        "company": company.name,
        "cik": company.cik,
        "filing_count": len(records),
        "filings": records,
    }


def _trades_to_records(df, columns: list[str]) -> list[dict]:
    """DataFrame -> list of dicts with only the given columns, NaN -> null."""
    if df is None or df.empty:
        return []
    present = [c for c in columns if c in df.columns]
    # round-trip through JSON so NaN/NaT become null (valid JSON)
    return json.loads(df[present].to_json(orient="records"))


def _extract_eps(obj) -> tuple[float | None, float | None]:
    """Pull basic/diluted EPS from the income statement — Financials.
    get_financial_metrics() covers revenue/income/balance-sheet figures but
    not per-share earnings, and that's the number most readers actually
    scan a 10-K/10-Q for."""
    try:
        df = obj.income_statement.to_dataframe()
    except Exception:
        return None, None
    if df is None or df.empty or "concept" not in df.columns:
        return None, None

    # first dated column = most recent reporting period (e.g. "2026-03-28 (Q2)")
    period_cols = [c for c in df.columns if re.match(r"^\d{4}-\d{2}-\d{2}", str(c))]
    if not period_cols:
        return None, None
    col = period_cols[0]

    def value_for(concept_suffix: str) -> float | None:
        rows = df[df["concept"].str.endswith(concept_suffix, na=False)]
        if rows.empty or pd.isna(rows.iloc[0][col]):
            return None
        return float(rows.iloc[0][col])

    return value_for("EarningsPerShareBasic"), value_for("EarningsPerShareDiluted")


def _statement_to_dict(stmt) -> dict | None:
    """Convert an edgartools Statement to a JSON-serializable dict with
    title, column headers, and rows (label + indentation level + values)."""
    try:
        md = stmt.to_markdown() if stmt is not None else None
    except Exception:
        return None
    if not md:
        return None

    title = ""
    headers: list[str] = []
    rows: list[dict] = []

    for line in md.splitlines():
        s = line.strip()
        if s.startswith("## "):
            title = s[3:].strip()
            continue
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.split("|")[1:-1]]
        if not cells:
            continue
        if not headers:
            # first pipe-row is the header
            headers = cells
            continue
        # skip the separator row (--- :--- etc.)
        if all(re.fullmatch(r"[-: ]+", c) for c in cells):
            continue
        label_raw = cells[0]
        is_sub = label_raw.startswith("*") and label_raw.endswith("*")
        label = label_raw.strip("* ").strip()
        if not label:
            continue
        rows.append({"label": label, "sub": is_sub, "values": cells[1:]})

    if not headers or not rows:
        return None
    return {"title": title, "headers": headers[1:], "rows": rows}


def _normalize_name(name) -> str:
    """'O'BRIEN DEIRDRE' and 'Deirdre O'Brien' -> the same key, by reducing
    to a sorted bag of lowercase word tokens (order/punctuation-independent)."""
    if not name:
        return ""
    return " ".join(sorted(re.findall(r"[a-z]+", str(name).lower())))


def _code_s_sales_by_date(obj) -> dict[str, int]:
    """Open-market sales (Table I, Code=S) from a Form 4 object, summed per
    date — this is what a Form 144 'proposed sale' ultimately shows up as."""
    table = getattr(obj, "non_derivative_table", None)
    tx = getattr(table, "transactions", None) if table is not None else None
    df = getattr(tx, "data", None) if tx is not None else None
    out: dict[str, int] = {}
    if df is not None and not df.empty and {"Code", "Date", "Shares"} <= set(df.columns):
        for _, row in df[df["Code"] == "S"].iterrows():
            out[row["Date"]] = out.get(row["Date"], 0) + int(row["Shares"])
    return out


def fetch_sale_summary(accession_number: str) -> dict | None:
    """Lightweight check for Form 3/4/5 timeline rows: does this filing report
    an open-market sale (Table I, Code=S)? If so, return a one-line summary
    ('Jane Doe — sold 20,338 sh. @ $255.12') plus a "person_card" of context
    for a hover popover — title/location, what slice of their position this
    sale represents, and what they're left holding; otherwise None, so the
    row keeps its generic 'FORM 4' label.

    Deliberately skips the heavier work fetch_filing_detail does (full table
    parsing, footnotes, related-filing search) — this runs once per Form 3/4/5
    row to progressively enrich the timeline after it first renders, so unlike
    fetch_filing_detail (one row, on demand) it has to stay cheap across many
    rows. Same per-filing network cost either way (one .obj() parse), just
    less post-processing.
    """
    filing = find(accession_number)
    if filing is None or not _OWNERSHIP_FORM.match(filing.form):
        return None

    obj = filing.obj()
    table = getattr(obj, "non_derivative_table", None)
    tx = getattr(table, "transactions", None) if table is not None else None
    df = getattr(tx, "data", None) if tx is not None else None
    if df is None or df.empty or not {"Code", "Shares", "Price"} <= set(df.columns):
        return None

    sales = df[df["Code"] == "S"]
    if sales.empty:
        return None

    total_shares = int(sales["Shares"].sum())
    prices = sales["Price"].dropna()
    avg_price = (
        float((sales["Shares"] * sales["Price"]).sum() / total_shares)
        if total_shares and not prices.empty else None
    )

    parts = [f"sold {total_shares:,} sh."]
    if avg_price is not None:
        parts.append(f"@ {'~' if len(sales) > 1 else ''}${avg_price:,.2f}")
    detail = " ".join(parts)

    name = getattr(obj, "insider_name", None)
    description = f"{name} — {detail}" if name else detail

    # "Remaining" is the post-transaction share count on each row; the last
    # sale row's value is what the filer holds once every reported sale in
    # this filing has gone through — the same "how big a bite was this"
    # context Form 144's percent_of_holdings gives, just derived rather than
    # self-reported (Form 4 doesn't carry a holdings-percentage field).
    remaining = None
    if "Remaining" in sales.columns:
        last = sales["Remaining"].iloc[-1]
        if pd.notna(last):
            remaining = int(last)
    percent_sold = (
        total_shares / (total_shares + remaining)
        if remaining is not None and (total_shares + remaining) > 0 else None
    )

    owner = next(iter(getattr(obj, "reporting_owners", None) or []), None)
    address = getattr(owner, "address", None) if owner is not None else None
    card = {
        "name": name,
        "position": getattr(owner, "position", None) if owner is not None else None,
        "city": getattr(address, "city", None) if address is not None else None,
        "state": getattr(address, "state_or_country", None) if address is not None else None,
        "shares_sold": total_shares,
        "avg_price": avg_price,
        "percent_sold": percent_sold,
        "remaining_shares": remaining,
    }
    return {"description": description, "card": card}


def _related_filing_summary(filing) -> dict:
    return {
        "accession_number": filing.accession_no,
        "form": filing.form,
        "filing_date": str(filing.filing_date),
    }


def _find_related_filing(company, detail: dict) -> dict | None:
    """Best-effort link between a Form 144 'notice of proposed sale' and the
    Form 4 that later reports the same sale as completed.

    SEC doesn't cross-reference these filings — they're independent
    submissions — so we match heuristically on (reporting person, sale
    date, share count), bounded to a short post/pre-filing date window so
    this stays a handful of extra .obj() parses, not a scan of the company's
    whole history. Each candidate costs one extra network request, same as
    fetch_filing_detail itself — that's why the window and candidate count
    are kept tight.
    """
    MAX_CANDIDATES = 5
    WINDOW_DAYS = 10

    if detail.get("kind") == "sale_notice":
        person = _normalize_name(detail.get("person_selling"))
        units = detail.get("units_to_be_sold")
        approx = detail.get("approx_sale_date")
        if not (person and units and approx):
            return None
        try:
            target = datetime.strptime(approx, "%m/%d/%Y").date()
        except ValueError:
            return None

        candidates = company.get_filings(
            form="4", date=f"{target}:{target + timedelta(days=WINDOW_DAYS)}")
        for cand in list(candidates)[:MAX_CANDIDATES]:
            cobj = cand.obj()
            if _normalize_name(getattr(cobj, "insider_name", None)) != person:
                continue
            sales = _code_s_sales_by_date(cobj)
            if sales.get(target.isoformat()) == units:
                summary = _related_filing_summary(cand)
                summary["relation"] = "Reported as completed in this Form 4"
                return summary
        return None

    if detail.get("kind") == "ownership":
        person = _normalize_name(detail.get("insider_name"))
        # Re-derive sales-by-date from the records we already extracted —
        # avoids re-parsing the DataFrame.
        sales: dict[str, int] = {}
        for row in detail.get("table_i", []):
            if row.get("Code") == "S" and row.get("Date") and row.get("Shares") is not None:
                sales[row["Date"]] = sales.get(row["Date"], 0) + int(row["Shares"])
        if not (person and sales):
            return None

        for date_str, shares in sales.items():
            try:
                d = datetime.strptime(date_str, "%Y-%m-%d").date()
            except ValueError:
                continue
            candidates = company.get_filings(
                form="144", date=f"{d - timedelta(days=WINDOW_DAYS)}:{d}")
            for cand in list(candidates)[:MAX_CANDIDATES]:
                cobj = cand.obj()
                if _normalize_name(getattr(cobj, "person_selling", None)) != person:
                    continue
                try:
                    cdate = datetime.strptime(cobj.approx_sale_date, "%m/%d/%Y").date()
                except (ValueError, TypeError):
                    continue
                if cdate == d and getattr(cobj, "units_to_be_sold", None) == shares:
                    summary = _related_filing_summary(cand)
                    summary["relation"] = "Pre-announced in this Form 144 notice"
                    return summary
        return None

    return None


def fetch_filing_detail(accession_number: str) -> dict:
    """Drill into a single filing's own document for the detail the bulk
    submissions list doesn't carry: insider names/positions/transaction
    amounts for Form 3/4/5, disclosed items + press release for 8-K/6-K.

    Unlike fetch_filings(), this DOES fetch and parse the filing's actual
    document (via Filing.obj()) — one extra network request per call. Call
    it lazily, on demand for a single filing the user has expanded, not in
    a loop over a whole filing history (see the rate-limit note above).
    """
    filing = find(accession_number)
    if filing is None:
        raise ValueError(f"No filing found for accession number '{accession_number}'")

    form = filing.form
    obj = filing.obj()
    detail = {"form": form}

    if _OWNERSHIP_FORM.match(form):
        detail["kind"] = "ownership"
        detail["insider_name"] = getattr(obj, "insider_name", None)
        detail["position"] = getattr(obj, "position", None)

        # Form 4 itself defines two distinct tables — we mirror that split
        # rather than merging, since "Table I"/"Table II" is the vocabulary
        # anyone reading the actual filing will recognize:
        #   Table I  — Non-Derivative Securities (open-market trades, option
        #              exercises (Code M), tax withholding (Code F), gifts, ...)
        #   Table II — Derivative Securities (options, RSUs, conversions)
        # NOTE: obj.market_trades is NOT the full Table I — it's pre-filtered
        # to open-market buy/sell codes (P/S) only, silently dropping Code M
        # (exercise) and Code F (withholding) rows that the actual filing
        # lists right alongside them. The complete table — matching what a
        # human sees in the filing — lives at non_derivative_table.transactions.
        # (Reading only market_trades is also why some filings looked "empty":
        # an RSU-vesting filing's Table I rows are all M/F, none S/P.)
        table_i_cols = ["Date", "TransactionType", "Code", "Shares", "Price", "AcquiredDisposed", "Remaining"]
        table_ii_cols = ["Date", "Security", "Underlying", "UnderlyingShares", "ExercisePrice",
                         "TransactionType", "Code", "Shares", "AcquiredDisposed", "Remaining"]

        non_derivative = getattr(obj, "non_derivative_table", None)
        non_derivative_tx = getattr(non_derivative, "transactions", None) if non_derivative is not None else None
        non_derivative_df = getattr(non_derivative_tx, "data", None) if non_derivative_tx is not None else None
        detail["table_i"] = _trades_to_records(non_derivative_df, table_i_cols)

        derivative = getattr(obj, "derivative_trades", None)
        derivative_df = getattr(derivative, "data", None) if derivative is not None else None
        detail["table_ii"] = _trades_to_records(derivative_df, table_ii_cols)

        # Numeric-looking cells (price, exercise price, ...) are sometimes
        # replaced with a footnote reference like "[F1]" when a single number
        # can't capture the real situation (e.g. an RSU has no true exercise
        # price, or a sale executed at multiple prices is reported as a
        # weighted average). The actual explanation lives in obj.footnotes —
        # surface it so "[F1]" isn't a dead end in the UI.
        footnotes = getattr(obj, "footnotes", None)
        if footnotes is not None and len(footnotes):
            detail["footnotes"] = footnotes.summary()["footnote"].to_dict()

    elif _SALE_NOTICE_FORM.match(form):
        detail["kind"] = "sale_notice"
        detail["person_selling"] = getattr(obj, "person_selling", None)
        detail["relationships"] = list(getattr(obj, "relationships", None) or [])
        detail["broker_name"] = getattr(obj, "broker_name", None)
        detail["approx_sale_date"] = getattr(obj, "approx_sale_date", None)
        detail["security_class"] = getattr(obj, "security_class", None)
        detail["units_to_be_sold"] = getattr(obj, "units_to_be_sold", None)
        detail["market_value"] = getattr(obj, "market_value", None)
        detail["is_10b5_1_plan"] = getattr(obj, "is_10b5_1_plan", None)

    elif _FINANCIAL_REPORT_FORM.match(form):
        detail["kind"] = "financial_report"
        detail["period_of_report"] = getattr(obj, "period_of_report", None)
        try:
            detail["income_statement"] = _statement_to_dict(obj.income_statement)
        except Exception:
            detail["income_statement"] = None
        try:
            detail["balance_sheet"] = _statement_to_dict(obj.balance_sheet)
        except Exception:
            detail["balance_sheet"] = None
        try:
            detail["cash_flow"] = _statement_to_dict(obj.cash_flow_statement)
        except Exception:
            detail["cash_flow"] = None

    elif _THIRTEEN_F_FORM.match(form):
        detail["kind"] = "thirteen_f"
        detail["report_period"] = str(getattr(obj, "report_period", None) or "")
        tv = getattr(obj, "total_value", None)
        detail["total_value"] = int(tv) if tv is not None else None
        detail["total_holdings"] = getattr(obj, "total_holdings", None)
        h = getattr(obj, "holdings", None)
        if h is not None and not h.empty:
            cols = [c for c in ["Issuer", "Ticker", "SharesPrnAmount", "Value"] if c in h.columns]
            h = h[cols].copy()
            if "Value" in h.columns:
                h = h.sort_values("Value", ascending=False)
            # Replace NaN (e.g. missing Ticker) with None for clean JSON
            h = h.where(h.notna(), None)
            # Explicit int conversion avoids numpy int64 JSON-serialization errors
            for col in ["SharesPrnAmount", "Value"]:
                if col in h.columns:
                    h[col] = h[col].apply(lambda v: int(v) if v is not None else None)
            detail["holdings"] = h.to_dict("records")
        else:
            detail["holdings"] = []

    elif _PROSPECTUS_FORM.match(form):
        detail["kind"] = "prospectus_424b"
        otype = getattr(obj, "offering_type", None)
        detail["offering_type"] = otype.value if otype is not None else None
        detail["offering_type_display"] = otype.display_name if otype is not None else None
        detail["offering_amount"] = getattr(obj, "offering_amount", None)
        detail["offering_price"] = getattr(obj, "offering_price", None)
        detail["is_atm"] = getattr(obj, "is_atm", False)
        detail["is_supplement"] = getattr(obj, "is_supplement", False)
        detail["is_preliminary"] = getattr(obj, "is_preliminary", False)
        detail["registration_number"] = getattr(obj, "registration_number", None)
        # Lead underwriter / placement agent
        uw = getattr(obj, "underwriting", None)
        detail["lead_manager"] = getattr(uw, "lead_manager", None) if uw is not None else None
        # Simplified pricing table: one dict per column (Per share / Total / etc.)
        pricing = getattr(obj, "pricing", None)
        if pricing is not None:
            cols = getattr(pricing, "columns", None) or []
            detail["pricing_rows"] = [
                {
                    "label": c.column_label,
                    "price": c.offering_price,
                    "discount": c.fee_or_discount,
                    "proceeds": c.proceeds,
                }
                for c in cols
            ]
        else:
            detail["pricing_rows"] = []
        # Selling stockholders count (PIPE / resale offerings)
        ss = getattr(obj, "selling_stockholders", None)
        detail["selling_stockholders_count"] = getattr(ss, "count", None) if ss is not None else None

    elif _SCHEDULE_13_FORM.match(form):
        detail["kind"] = "schedule_13"
        detail["is_amendment"] = getattr(obj, "is_amendment", False)
        detail["date_of_event"] = str(getattr(obj, "date_of_event", None) or "")
        detail["is_passive_investor"] = getattr(obj, "is_passive_investor", None)
        detail["total_shares"] = getattr(obj, "total_shares", None)
        pct = getattr(obj, "total_percent", None)
        detail["total_percent"] = float(pct) if pct is not None else None
        si = getattr(obj, "security_info", None)
        detail["security_title"] = getattr(si, "title", None) if si is not None else None
        persons = list(getattr(obj, "reporting_persons", None) or [])
        detail["reporting_persons"] = [
            {
                "name": p.name,
                "citizenship": p.citizenship,
                "type": p.type_of_reporting_person,
                "shares": p.aggregate_amount,
                "percent": float(p.percent_of_class) if p.percent_of_class else None,
                "sole_voting": p.sole_voting_power,
                "shared_voting": p.shared_voting_power,
                "sole_dispositive": p.sole_dispositive_power,
                "shared_dispositive": p.shared_dispositive_power,
            }
            for p in persons
        ]

    elif _PROXY_FORM.match(form):
        detail["kind"] = "proxy"
        detail["peo_name"] = getattr(obj, "peo_name", None)
        peo_comp = getattr(obj, "peo_total_comp", None)
        detail["peo_total_comp"] = float(peo_comp) if peo_comp else None
        ratio_obj = getattr(obj, "ceo_pay_ratio", None)
        ratio_val = getattr(ratio_obj, "ratio", None) if ratio_obj is not None else None
        detail["ceo_pay_ratio"] = int(ratio_val) if ratio_val else None
        median_pay = getattr(ratio_obj, "median_employee_compensation", None) if ratio_obj is not None else None
        detail["median_employee_compensation"] = int(median_pay) if median_pay else None
        proposals = list(getattr(obj, "voting_proposals", None) or [])
        detail["voting_proposals"] = [
            {
                "number": vp.number,
                "description": vp.description,
                "board_recommendation": vp.board_recommendation,
            }
            for vp in proposals
        ]
        detail["total_shareholder_return"] = (
            float(obj.total_shareholder_return)
            if getattr(obj, "total_shareholder_return", None) else None
        )
        detail["performance_measures"] = list(getattr(obj, "performance_measures", None) or [])

    elif _CURRENT_REPORT_FORM.match(form):
        detail["kind"] = "current_report"
        items = list(getattr(obj, "items", None) or [])
        detail["items"] = [{"code": item, "description": EIGHT_K_ITEMS.get(item, "")} for item in items]
        releases = list(getattr(obj, "press_releases", None) or [])
        detail["press_releases"] = [
            {"description": pr.description, "excerpt": pr.text()[:1200]}
            for pr in releases[:1]
        ]

    else:
        detail["kind"] = "generic"
        detail["note"] = "No structured detail view for this form type yet — use the document links above."

    # Form 144 "intent to sell" notices and Form 4 "completed sale" reports
    # often describe the same real-world transaction from two angles — link
    # them when we can find a confident match (see _find_related_filing).
    if detail.get("kind") in ("ownership", "sale_notice"):
        related = _find_related_filing(Company(filing.cik), detail)
        if related:
            detail["related"] = related

    return detail


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ticker", help="Stock ticker symbol, e.g. AAPL")
    parser.add_argument("--forms", help="Comma-separated form types to filter, e.g. 10-K,10-Q,8-K")
    parser.add_argument("--limit", type=int, help="Max number of filings to return")
    parser.add_argument("--oldest-first", action="store_true",
                        help="Sort chronologically (oldest first) instead of newest first")
    parser.add_argument("--json", action="store_true", help="Print raw JSON instead of a table")
    args = parser.parse_args()

    set_identity(os.environ.get("SEC_EDGAR_IDENTITY", DEFAULT_IDENTITY))

    forms = [f.strip() for f in args.forms.split(",")] if args.forms else None
    result = fetch_filings(args.ticker, forms=forms, limit=args.limit,
                           newest_first=not args.oldest_first)

    if args.json:
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return

    print(f"{result['company']} (ticker={result['ticker']}, CIK={result['cik']}) "
          f"— {result['filing_count']} filings")
    print(f"{'Filed':<12} {'Form':<8} {'Accession':<22} Document")
    for rec in result["filings"]:
        print(f"{rec['filing_date']:<12} {rec['form']:<8} "
              f"{rec['accession_number']:<22} "
              f"{rec['document_url'] or rec['index_url']}")


if __name__ == "__main__":
    main()
