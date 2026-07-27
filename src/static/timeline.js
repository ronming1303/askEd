const CATEGORIES = [
  { match: /^10-K|^20-F|^40-F/, label: "Annual report (10-K/20-F/40-F)", short: "Annual report", color: "#ff6b6b" },
  { match: /^10-Q/, label: "Quarterly report (10-Q)", short: "Quarterly report", color: "#ffa94d" },
  { match: /^8-K|^6-K/, label: "Material event (8-K/6-K)", short: "Material event", color: "#4dabf7" },
  { match: /14A/, label: "Proxy material (DEF 14A, etc.)", short: "Proxy", color: "#9775fa" },
  { match: /^[345](\/A)?$/, label: "Insider transaction (Form 3/4/5)", short: "Insider", color: "#51cf66" },
  { match: /^13F/, label: "Institutional holdings (13F)", short: "13F", color: "#20c997" },
  { match: /^144/, label: "Restricted stock sale notice (Form 144)", short: "Form 144", color: "#fcc419" },
  { match: /^S-/, label: "Securities registration (S-1/S-3/...)", short: "Registration", color: "#f06595" },
];
const OTHER = { label: "Other", short: "Other", color: "#868e96" };
const OTHER_IDX = CATEGORIES.length; // sentinel index for OTHER category
const NEWS_CAT = { label: "News article", short: "News", color: "#74c0fc" };
const NEWS_IDX = CATEGORIES.length + 1; // sentinel index for news entries

// Not a filing by the searched company — an aggregate reverse-indexed from
// every OTHER institution's Form 13F that quarter. Deliberately a distinct
// color from the "^13F" category above, which means the opposite thing
// (this company reporting on ITS OWN holdings in other companies).
const INSTITUTIONAL_CAT = { label: "Institutional ownership snapshot (13F aggregate)", short: "Ownership", color: "#3b5bdb" };
const INSTITUTIONAL_IDX = CATEGORIES.length + 2; // sentinel index for institutional-ownership entries

// Bi-monthly FINRA-reported short interest (via Nasdaq's public API) —
// Nasdaq-listed tickers only; unsupported tickers just get an empty list.
const SHORT_INTEREST_CAT = { label: "Short interest (bi-monthly)", short: "Short interest", color: "#d9480f" };
const SHORT_INTEREST_IDX = CATEGORIES.length + 3; // sentinel index for short-interest entries

function categorize(form) {
  for (const cat of CATEGORIES) {
    if (cat.match.test(form)) return cat;
  }
  return OTHER;
}

const form = document.getElementById("search-form");
const tickerInput = document.getElementById("ticker-input");
const daysInput = document.getElementById("days-input");
const status = document.getElementById("status");
const enrichStatus = document.getElementById("enrich-status");
const enrichDot = enrichStatus.querySelector(".enrich-dot");
const enrichLabel = enrichStatus.querySelector(".enrich-label");
const tabBar = document.getElementById("tab-bar");
const tabContents = document.getElementById("tab-contents");

// These three point to the active tab's elements; reassigned by activateTab().
let companyInfo = null;
let timeline = null;
let linkOverlay = null;

let expandedEntries = new Set();

// Per-tab state: each search creates an entry here.
const tabState = new Map(); // id -> { id, ticker, pane, companyInfoEl, timelineEl, svgEl, expandedEntries, enrichState }
let activeTabId = null;

function newTab(ticker) {
  const id = `tab-${Date.now()}`;
  const pane = document.createElement("div");
  pane.className = "tab-pane";
  pane.dataset.tabId = id;
  pane.innerHTML = `
    <div class="company-info">
      <div class="company-header"></div>
      <div class="filter-bar" hidden></div>
    </div>
    <div class="pane-layout">
      <div class="timeline-wrapper">
        <div class="timeline-inner">
          <svg class="link-overlay"></svg>
          <ol class="timeline"></ol>
        </div>
      </div>
      <aside class="price-panel" hidden>
        <div class="price-summary">
          <span class="price-ticker"></span>
          <span class="price-value"></span>
          <span class="price-change"></span>
          <span class="price-summary-date"></span>
        </div>
        <div class="price-ohlc price-ohlc-empty"></div>
        <svg class="price-chart" viewBox="0 0 280 110" preserveAspectRatio="none">
          <path class="price-area"></path>
          <path class="price-line"></path>
          <line class="price-hover-wick" hidden></line>
          <rect class="price-hover-body" hidden></rect>
        </svg>
        <div class="price-date-range">
          <span class="price-date-from"></span>
          <span class="price-date-to"></span>
        </div>
        <div class="price-10q" hidden>
          <div class="p10q-header">
            <span class="p10q-label">Latest 10-Q</span>
            <span class="p10q-date"></span>
          </div>
          <div class="p10q-extra"></div>
        </div>
        <div class="inst-panel" hidden>
          <div class="ip-header">
            <span class="ip-label">Institutional Ownership</span>
            <span class="ip-date"></span>
          </div>
          <div class="ip-extra"></div>
        </div>
        <div class="short-panel" hidden>
          <div class="si-header">
            <span class="si-label">Short Interest</span>
            <span class="si-date"></span>
          </div>
          <div class="si-extra"></div>
        </div>
        <div class="tech-panel" hidden>
          <div class="tp-header">
            <span class="tp-label">Technical Indicators</span>
            <span class="tp-date"></span>
          </div>
          <div class="tp-extra">
            <div class="tp-block">
              <div class="tp-block-label">SMA 20 / 50 &amp; Bollinger Bands</div>
              <svg class="tp-sma-chart" viewBox="0 0 260 70" preserveAspectRatio="none"></svg>
            </div>
            <div class="tp-block">
              <div class="tp-block-label">Volume</div>
              <svg class="tp-volume-chart" viewBox="0 0 260 36" preserveAspectRatio="none"></svg>
            </div>
            <div class="tp-block">
              <div class="tp-block-label">RSI (14)</div>
              <svg class="tp-rsi-chart" viewBox="0 0 260 50" preserveAspectRatio="none"></svg>
            </div>
            <div class="tp-block">
              <div class="tp-block-label">MACD (12, 26, 9)</div>
              <svg class="tp-macd-chart" viewBox="0 0 260 60" preserveAspectRatio="none"></svg>
            </div>
          </div>
        </div>
        <div class="pm-panel" hidden>
          <div class="pm-header">
            <span class="pm-label">Prediction Market (Polymarket)</span>
            <span class="pm-date"></span>
          </div>
          <div class="pm-extra"></div>
        </div>
        <div class="iv-panel" hidden>
          <div class="iv-header">
            <span class="iv-label">Implied Volatility (Options)</span>
            <span class="iv-date"></span>
          </div>
          <div class="iv-extra">
            <div class="iv-smile-label"></div>
            <svg class="iv-smile-chart" viewBox="0 0 260 72" preserveAspectRatio="none"></svg>
            <div class="chain-label"></div>
            <div class="chain-rows"></div>
          </div>
        </div>
      </aside>
    </div>
  `;
  tabContents.appendChild(pane);
  const state = {
    id,
    ticker,
    pane,
    companyInfoEl: pane.querySelector(".company-header"),
    filterBarEl:   pane.querySelector(".filter-bar"),
    timelineEl:    pane.querySelector(".timeline"),
    svgEl:         pane.querySelector(".link-overlay"),
    pricePanelEl:  pane.querySelector(".price-panel"),
    priceChartEl:  pane.querySelector(".price-chart"),
    priceData: [],
    priceChartGeom: null,
    expandedEntries: new Set(),
    dimmedCategories: new Set(),
    enrichState: { gen: 0, checked: 0, total: 0, done: false },
    fetchingFilings: false,
    fetchingDetail: 0,
    hasLoaded: false,
  };
  tabState.set(id, state);
  return state;
}

function activateTab(id) {
  // Save expandedEntries of the tab we're leaving.
  if (activeTabId && tabState.has(activeTabId)) {
    tabState.get(activeTabId).expandedEntries = expandedEntries;
  }
  // Show only the target pane.
  for (const [tid, st] of tabState) st.pane.hidden = (tid !== id);

  activeTabId = id;
  const st = tabState.get(id);
  companyInfo = st.companyInfoEl;
  timeline    = st.timelineEl;
  linkOverlay = st.svgEl;
  expandedEntries = st.expandedEntries;

  // Sync the indicator with this tab's full loading state.
  syncTabIndicator(st);

  updateTabBar();
  redrawLink();
}

function closeTab(id) {
  const st = tabState.get(id);
  if (!st) return;
  st.enrichState.gen++; // stop any in-flight enrichment for this tab
  st.pane.remove();
  tabState.delete(id);
  if (activeTabId === id) {
    const remaining = [...tabState.keys()];
    if (remaining.length) {
      activateTab(remaining[remaining.length - 1]);
    } else {
      activeTabId = null;
      companyInfo = timeline = linkOverlay = null;
      expandedEntries = new Set();
      hideEnrichStatus();
      updateTabBar();
    }
  } else {
    updateTabBar();
  }
}

function updateTabBar() {
  tabBar.hidden = tabState.size === 0;
  tabBar.innerHTML = "";
  for (const [id, st] of tabState) {
    const btn = document.createElement("button");
    btn.className = `tab${id === activeTabId ? " active" : ""}`;
    btn.dataset.tabId = id;
    btn.innerHTML = `${escapeHtml(st.ticker)}<span class="tab-close" data-close-id="${escapeAttr(id)}">×</span>`;
    btn.addEventListener("click", (e) => {
      const closeId = e.target.dataset.closeId;
      if (closeId) { e.stopPropagation(); closeTab(closeId); }
      else activateTab(id);
    });
    tabBar.appendChild(btn);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const ticker = tickerInput.value.trim().toUpperCase();
  if (!ticker) return;
  loadTicker(ticker, parseInt(daysInput.value) || 30);
});

// Search is strictly by exact ticker (see fetch_filings -> Company(ticker)),
// not company name — so a CompanyNotFoundError's fuzzy suggestions (already
// computed server-side by edgartools' search index) are surfaced here as
// clickable "did you mean" chips instead of a dead-end error string.
status.addEventListener("click", (e) => {
  const btn = e.target.closest(".ticker-suggestion");
  if (!btn) return;
  tickerInput.value = btn.dataset.ticker;
  loadTicker(btn.dataset.ticker, parseInt(daysInput.value) || 30);
});

function renderSearchError(message, suggestions) {
  const chips = (suggestions || []).map(s => `
    <button type="button" class="ticker-suggestion" data-ticker="${escapeAttr(s.ticker)}">${escapeHtml(s.ticker)} — ${escapeHtml(s.company)}</button>
  `).join("");
  status.innerHTML = `
    <span>Error: ${escapeHtml(message)}</span>
    ${chips ? `<div class="suggestions">Did you mean: ${chips}</div>` : ""}
  `;
}

window.addEventListener("resize", redrawLink);

// .entry-details animates its height via a CSS transition (grid-template-rows
// 0fr -> 1fr), so a row's marker keeps moving for ~0.2s after it expands or
// collapses. Redraw once that settles — otherwise the line is measured against
// a mid-transition layout and stays pointing at a stale position forever.
// Use delegation on the stable container so the listener survives tab switches.
tabContents.addEventListener("transitionend", (e) => {
  if (e.propertyName === "grid-template-rows") redrawLink();
});

async function loadTicker(ticker, days) {
  status.textContent = "";
  const tab = newTab(ticker);
  activateTab(tab.id);
  clearLink();

  tab.fetchingFilings = true;
  syncTabIndicator(tab);
  try {
    const [filingsRes, newsRes, pricesRes, latest10QRes, institutionalRes, shortInterestRes, predictionMarketRes, optionsIvRes] = await Promise.all([
      fetch(`/api/filings?ticker=${encodeURIComponent(ticker)}&days=${encodeURIComponent(days)}`),
      fetch(`/api/news?ticker=${encodeURIComponent(ticker)}&days=${encodeURIComponent(days)}`).catch(() => null),
      fetch(`/api/prices?ticker=${encodeURIComponent(ticker)}&days=${encodeURIComponent(days)}`).catch(() => null),
      fetch(`/api/latest-filing?ticker=${encodeURIComponent(ticker)}&form=10-Q`).catch(() => null),
      fetch(`/api/institutional-holdings?ticker=${encodeURIComponent(ticker)}`).catch(() => null),
      fetch(`/api/short-interest?ticker=${encodeURIComponent(ticker)}`).catch(() => null),
      fetch(`/api/prediction-market?ticker=${encodeURIComponent(ticker)}`).catch(() => null),
      fetch(`/api/options-iv?ticker=${encodeURIComponent(ticker)}`).catch(() => null),
    ]);
    const data = await filingsRes.json();
    if (!filingsRes.ok) {
      const err = new Error(data.error || "Request failed");
      err.suggestions = data.suggestions;
      throw err;
    }
    let news = [];
    if (newsRes && newsRes.ok) {
      try { news = await newsRes.json(); } catch {}
    }
    let prices = [];
    if (pricesRes && pricesRes.ok) {
      try { prices = await pricesRes.json(); } catch {}
    }
    let latest10Q = null;
    if (latest10QRes && latest10QRes.ok) {
      try { latest10Q = await latest10QRes.json(); } catch {}
    }
    let institutional = [];
    if (institutionalRes && institutionalRes.ok) {
      try { institutional = await institutionalRes.json(); } catch {}
    }
    let shortInterest = [];
    if (shortInterestRes && shortInterestRes.ok) {
      try { shortInterest = await shortInterestRes.json(); } catch {}
    }
    let predictionMarket = [];
    if (predictionMarketRes && predictionMarketRes.ok) {
      try { predictionMarket = await predictionMarketRes.json(); } catch {}
    }
    let optionsIv = null;
    if (optionsIvRes && optionsIvRes.ok) {
      try { optionsIv = await optionsIvRes.json(); } catch {}
    }
    tab.days = days;
    tab.priceData = Array.isArray(prices) ? prices : [];
    tab.institutionalData = Array.isArray(institutional) ? institutional : [];
    tab.shortInterestData = Array.isArray(shortInterest) ? shortInterest : [];
    tab.predictionMarketData = Array.isArray(predictionMarket) ? predictionMarket : [];
    tab.optionsIvData = optionsIv;
    renderCompanyInfo(data, tab);
    renderTimeline(data.filings, news, tab);
    renderPriceChart(tab);
    renderTechnicalPanel(tab);
    renderLatest10Q(tab, latest10Q);
    renderInstitutionalPanel(tab, tab.institutionalData);
    renderShortInterestPanel(tab, tab.shortInterestData);
    renderPredictionMarketPanel(tab, tab.predictionMarketData);
    renderImpliedVolatilityPanel(tab, tab.optionsIvData);
  } catch (err) {
    renderSearchError(err.message, err.suggestions);
    closeTab(tab.id);
  } finally {
    tab.fetchingFilings = false;
    tab.hasLoaded = true;
    syncTabIndicator(tab);
  }
}

function renderCompanyInfo(data, tab) {
  const range = tab.days === 1 ? "past 1 day" : `past ${tab.days} days`;
  tab.companyInfoEl.innerHTML =
    `<b>${data.company}</b> <span class="meta">· ${data.ticker} · CIK ${data.cik} · ${data.filing_count} filings · ${range}</span>`;
}

function renderTimeline(filings, news, tab) {
  const timelineEl = tab.timelineEl;
  timelineEl.innerHTML = "";
  tab.expandedEntries = new Set();
  if (activeTabId === tab.id) expandedEntries = new Set();

  const newsArr = news || [];
  const instArr = tab.institutionalData || [];
  const shortArr = tab.shortInterestData || [];

  if (!filings.length && !newsArr.length && !instArr.length && !shortArr.length) {
    timelineEl.innerHTML = `<li class="empty">No filings match these criteria.</li>`;
    return;
  }

  // Merge filings, news articles, institutional-ownership snapshots, and
  // short-interest readings then sort newest-first. Rows are evenly spaced
  // by sequence rather than proportionally to real date gaps — filing dates
  // cluster unevenly, and sequence-based spacing keeps every row legible.
  const allItems = [
    ...filings.map(f => ({ type: "filing", date: f.filing_date, data: f })),
    ...newsArr.map(a => ({ type: "news", date: a.date, data: a })),
    ...instArr.map(s => ({ type: "institutional", date: s.disclosed_date, data: s })),
    ...shortArr.map(s => ({ type: "short_interest", date: s.settlement_date, data: s })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const pairs = [];

  for (const item of allItems) {
    if (item.type === "filing") {
      const filing = item.data;
      const cat = categorize(filing.form);

      // Form 144 rows carry a "person_card" alongside their enriched
      // description — see descriptionHtml/wirePersonCard for how the seller's
      // name gets split out into a hover-triggering business-card popover.
      const desc = filing.description || cat.label;
      const card = filing.person_card;
      const descHtml = descriptionHtml(desc, card);
      const catIdx = CATEGORIES.indexOf(cat) === -1 ? OTHER_IDX : CATEGORIES.indexOf(cat);

      const entry = document.createElement("li");
      entry.className = "entry";
      entry.dataset.accession = filing.accession_number;
      entry.dataset.catIdx = catIdx;
      entry.innerHTML = `
        <div class="entry-row">
          <div class="entry-date">${filing.filing_date}</div>
          <div class="entry-spine"><span class="marker" style="background:${cat.color}"></span></div>
          <div class="entry-card">
            <span class="badge" style="background:${cat.color}">${filing.form}</span>
            <span class="entry-desc">${descHtml}</span>
          </div>
        </div>
        <div class="entry-details">
          <div class="entry-details-clip">
            <div class="entry-details-inner">
              <div><span class="field">Accession No.</span>${filing.accession_number}</div>
              <div><span class="field">Primary document</span>${filing.primary_document || "—"}</div>
              <div>
                <span class="field">Links</span>
                <a href="${filing.document_url}" target="_blank" rel="noopener">View document</a>
                &nbsp;·&nbsp;
                <a href="${filing.index_url}" target="_blank" rel="noopener">Filing index</a>
              </div>
              <div class="entry-extra"></div>
            </div>
          </div>
        </div>
      `;

      entry.querySelector(".entry-card").addEventListener("click", () => toggleExpand(entry, filing));
      const trigger = entry.querySelector(".person-card-trigger");
      if (trigger && card) wirePersonCard(trigger, card);
      entry.addEventListener("mouseenter", () => highlightPriceDate(tab, filing.filing_date));
      entry.addEventListener("mouseleave", () => clearPriceHighlight(tab));

      timelineEl.appendChild(entry);
      pairs.push({ entry, filing });
    } else if (item.type === "news") {
      const article = item.data;
      const sentMap = { positive: "#51cf66", negative: "#ff6b6b", neutral: "#868e96" };
      const sentColor = sentMap[article.sentiment] || "#868e96";
      const sentLabel = article.sentiment
        ? article.sentiment.charAt(0).toUpperCase() + article.sentiment.slice(1)
        : null;

      const entry = document.createElement("li");
      entry.className = "entry";
      entry.dataset.catIdx = NEWS_IDX;
      entry.innerHTML = `
        <div class="entry-row">
          <div class="entry-date">${article.date}</div>
          <div class="entry-spine"><span class="marker" style="background:${NEWS_CAT.color}"></span></div>
          <div class="entry-card">
            <span class="badge" style="background:${NEWS_CAT.color}">News</span>
            <span class="entry-desc">${escapeHtml(article.title)}</span>
            ${sentLabel ? `<span class="news-sent-inline" style="color:${sentColor}">${escapeHtml(sentLabel)}</span>` : ""}
          </div>
        </div>
        <div class="entry-details">
          <div class="entry-details-clip">
            <div class="entry-details-inner">
              <div class="news-meta">${escapeHtml(article.source)}${sentLabel ? ` · <span class="news-sentiment" style="color:${sentColor}">${escapeHtml(sentLabel)}</span>` : ""}</div>
              ${article.description ? `<p class="news-body">${escapeHtml(article.description)}</p>` : ""}
              <div style="margin-top:8px"><a href="${escapeAttr(article.url)}" target="_blank" rel="noopener">Read full article →</a></div>
            </div>
          </div>
        </div>
      `;

      entry.querySelector(".entry-card").addEventListener("click", () => {
        if (expandedEntries.has(entry)) {
          entry.classList.remove("expanded");
          expandedEntries.delete(entry);
        } else {
          entry.classList.add("expanded");
          expandedEntries.add(entry);
        }
      });
      entry.addEventListener("mouseenter", () => highlightPriceDate(tab, article.date));
      entry.addEventListener("mouseleave", () => clearPriceHighlight(tab));

      timelineEl.appendChild(entry);
      pairs.push({ entry });
    } else if (item.type === "institutional") {
      const snap = item.data;
      const ownershipStr = fmtPct(snap.institutional_ownership_pct);
      const concentrationStr = fmtPct(snap.concentration_top100_pct);

      const entry = document.createElement("li");
      entry.className = "entry";
      entry.dataset.catIdx = INSTITUTIONAL_IDX;
      entry.innerHTML = `
        <div class="entry-row">
          <div class="entry-date">${snap.disclosed_date}</div>
          <div class="entry-spine"><span class="marker" style="background:${INSTITUTIONAL_CAT.color}"></span></div>
          <div class="entry-card">
            <span class="badge" style="background:${INSTITUTIONAL_CAT.color}">${INSTITUTIONAL_CAT.short}</span>
            <span class="entry-desc">Institutional ownership ${ownershipStr} · Top 100 concentration ${concentrationStr} (${escapeHtml(snap.quarter)})</span>
          </div>
        </div>
        <div class="entry-details">
          <div class="entry-details-clip">
            <div class="entry-details-inner">
              <div><span class="field">Quarter end</span>${snap.quarter_end}</div>
              <div><span class="field">Concentration</span>Top10 ${fmtPct(snap.concentration_top10_pct)} · Top20 ${fmtPct(snap.concentration_top20_pct)} · Top50 ${fmtPct(snap.concentration_top50_pct)} · Top100 ${fmtPct(snap.concentration_top100_pct)}</div>
              <div><span class="field">Total 13F shares</span>${snap.total_13f_shares.toLocaleString()}</div>
              <div><span class="field">Reporting institutions</span>${snap.filer_count.toLocaleString()}</div>
              <div><span class="field">Shares outstanding</span>${snap.shares_outstanding != null ? `${Math.round(snap.shares_outstanding).toLocaleString()} (as of ${snap.shares_outstanding_asof})` : "—"}</div>
            </div>
          </div>
        </div>
      `;

      entry.querySelector(".entry-card").addEventListener("click", () => {
        if (expandedEntries.has(entry)) {
          entry.classList.remove("expanded");
          expandedEntries.delete(entry);
        } else {
          entry.classList.add("expanded");
          expandedEntries.add(entry);
        }
      });
      entry.addEventListener("mouseenter", () => highlightPriceDate(tab, snap.disclosed_date));
      entry.addEventListener("mouseleave", () => clearPriceHighlight(tab));

      timelineEl.appendChild(entry);
      pairs.push({ entry });
    } else if (item.type === "short_interest") {
      const si = item.data;

      const entry = document.createElement("li");
      entry.className = "entry";
      entry.dataset.catIdx = SHORT_INTEREST_IDX;
      entry.innerHTML = `
        <div class="entry-row">
          <div class="entry-date">${si.settlement_date}</div>
          <div class="entry-spine"><span class="marker" style="background:${SHORT_INTEREST_CAT.color}"></span></div>
          <div class="entry-card">
            <span class="badge" style="background:${SHORT_INTEREST_CAT.color}">${SHORT_INTEREST_CAT.short}</span>
            <span class="entry-desc">Short interest ${formatBigShares(si.short_interest_shares)} · ${si.days_to_cover.toFixed(1)} days to cover</span>
          </div>
        </div>
        <div class="entry-details">
          <div class="entry-details-clip">
            <div class="entry-details-inner">
              <div><span class="field">Settlement date</span>${si.settlement_date}</div>
              <div><span class="field">Short interest</span>${si.short_interest_shares.toLocaleString()} shares</div>
              <div><span class="field">Avg daily volume</span>${si.avg_daily_volume.toLocaleString()}</div>
              <div><span class="field">Days to cover</span>${si.days_to_cover.toFixed(2)}</div>
            </div>
          </div>
        </div>
      `;

      entry.querySelector(".entry-card").addEventListener("click", () => {
        if (expandedEntries.has(entry)) {
          entry.classList.remove("expanded");
          expandedEntries.delete(entry);
        } else {
          entry.classList.add("expanded");
          expandedEntries.add(entry);
        }
      });
      entry.addEventListener("mouseenter", () => highlightPriceDate(tab, si.settlement_date));
      entry.addEventListener("mouseleave", () => clearPriceHighlight(tab));

      timelineEl.appendChild(entry);
      pairs.push({ entry });
    }
  }

  tab.dimmedCategories = new Set();
  renderFilterBar(tab, pairs);
  enrichSaleSummaries(pairs.filter(p => p.filing), tab);
}

function renderFilterBar(tab, pairs) {
  const bar = tab.filterBarEl;
  // Collect present category indices in display order
  const present = new Set(pairs.map(({ entry }) => parseInt(entry.dataset.catIdx, 10)));
  if (present.size <= 1) { bar.hidden = true; return; }

  bar.innerHTML = "";
  bar.hidden = false;

  const allCats = [
    ...CATEGORIES.map((c, i) => ({ ...c, idx: i })),
    { ...OTHER, idx: OTHER_IDX },
    { ...NEWS_CAT, idx: NEWS_IDX },
    { ...INSTITUTIONAL_CAT, idx: INSTITUTIONAL_IDX },
    { ...SHORT_INTEREST_CAT, idx: SHORT_INTEREST_IDX },
  ];
  for (const cat of allCats) {
    if (!present.has(cat.idx)) continue;
    const btn = document.createElement("button");
    btn.className = "filter-pill";
    btn.dataset.catIdx = cat.idx;
    btn.innerHTML = `<span class="fp-dot" style="background:${cat.color}"></span>${cat.short}`;
    btn.addEventListener("click", () => {
      const { dimmedCategories } = tab;
      if (dimmedCategories.has(cat.idx)) {
        dimmedCategories.delete(cat.idx);
        btn.classList.remove("off");
      } else {
        dimmedCategories.add(cat.idx);
        btn.classList.add("off");
      }
      applyFilters(tab);
    });
    bar.appendChild(btn);
  }
}

function applyFilters(tab) {
  for (const li of tab.timelineEl.querySelectorAll(".entry")) {
    const catIdx = parseInt(li.dataset.catIdx, 10);
    const isDimmed = tab.dimmedCategories.has(catIdx);
    li.classList.toggle("dimmed", isDimmed);
    if (isDimmed && li.classList.contains("expanded")) {
      li.classList.remove("expanded");
      tab.expandedEntries.delete(li);
      if (activeTabId === tab.id) expandedEntries.delete(li);
    }
  }
  if (activeLink && (activeLink.source.classList.contains("dimmed") ||
                     activeLink.target.classList.contains("dimmed"))) {
    clearLink();
  } else {
    redrawLink();
  }
}

// Both Form 144 (eagerly, in renderTimeline) and Form 3/4/5 (progressively,
// in enrichSaleSummaries below) enrich their row's description with a
// "person_card"/"card" of context about the filer. Whenever the description
// leads with that person's name, split it into its own span so it can be
// wired up as a hover trigger for the business-card popover (wirePersonCard);
// otherwise just escape the plain label.
function descriptionHtml(desc, card) {
  if (card && card.name && desc.startsWith(card.name)) {
    return `<span class="person-card-trigger">${escapeHtml(card.name)}</span>${escapeHtml(desc.slice(card.name.length))}`;
  }
  return escapeHtml(desc);
}

const _OWNERSHIP_FORM_RE = /^[345](\/A)?$/;
const saleSummaryCache = new Map();

// Traffic-light readout for the background enrichment: amber + pulsing while
// rows are still being filled in, green and steady when done. Lets the user
// tell "still settling" from "final state" at a glance. Each tab owns its own
// enrichState; setEnrichStatus only fires when the relevant tab is active.
function setEnrichStatus(state, label) {
  enrichStatus.hidden = false;
  enrichStatus.dataset.state = state;
  enrichLabel.textContent = label;
}

function hideEnrichStatus() {
  enrichStatus.hidden = true;
}

// Single source of truth for the indicator. Call whenever any loading state changes.
// Priority: fetching filings > loading detail > checking insiders > done > hidden.
function syncTabIndicator(tab) {
  if (!tab || activeTabId !== tab.id) return;
  if (tab.fetchingFilings) {
    setEnrichStatus("loading", `Fetching ${tab.ticker} filings…`);
  } else if (tab.fetchingDetail > 0) {
    const n = tab.fetchingDetail;
    setEnrichStatus("loading", `Loading ${n > 1 ? n + " filing details" : "filing detail"}…`);
  } else {
    const es = tab.enrichState;
    if (es.total > 0 && !es.done) {
      setEnrichStatus("loading", `Checking ${es.total} insider filing${es.total === 1 ? "" : "s"} for sale details… (${es.checked}/${es.total})`);
    } else if (tab.hasLoaded) {
      setEnrichStatus("done", "");
    } else {
      hideEnrichStatus();
    }
  }
}

// Form 3/4/5 rows start with the generic "FORM 4" label and fill in with a
// "sold X sh. @ $Y" summary as each filing's Table I gets checked for a
// Code=S row — one request at a time, in the background. Per-tab enrichState
// carries the generation counter, so closing a tab or switching away stops
// the indicator update (but lets the fetch queue drain naturally; results
// land in saleSummaryCache and render into the tab's DOM either way).
function enrichSaleSummaries(pairs, tab) {
  const es = tab.enrichState;
  const myGen = ++es.gen;
  const queue = pairs.filter(({ filing }) => _OWNERSHIP_FORM_RE.test(filing.form));

  if (!queue.length) {
    syncTabIndicator(tab);
    return;
  }
  es.checked = 0;
  es.total = queue.length;
  es.done = false;
  syncTabIndicator(tab);

  (async () => {
    for (const { entry, filing } of queue) {
      if (myGen !== es.gen) return;
      const acc = filing.accession_number;

      let summary = saleSummaryCache.get(acc);
      if (summary === undefined) {
        try {
          const res = await fetch(`/api/sale-summary?accession=${encodeURIComponent(acc)}`);
          summary = res.ok ? await res.json() : null;
        } catch {
          summary = null;
        }
        saleSummaryCache.set(acc, summary);
      }

      if (myGen !== es.gen) return;
      if (summary && summary.description) {
        const descEl = entry.querySelector(".entry-desc");
        if (descEl) {
          descEl.innerHTML = descriptionHtml(summary.description, summary.card);
          const trigger = descEl.querySelector(".person-card-trigger");
          if (trigger && summary.card) wirePersonCard(trigger, summary.card);
        }
      }

      es.checked += 1;
      syncTabIndicator(tab);
    }
    if (myGen === es.gen) {
      es.done = true;
      syncTabIndicator(tab); // hides the indicator once all done
    }
  })();
}

// Form 144 "business card": hovering the seller's name (wired in
// renderTimeline, above) pops up a small card with context the inline label
// has no room for — where they're based, how long they've held the stock,
// what slice of their stake this sale represents, and whether it's a
// pre-scheduled 10b5-1 sale or a one-off discretionary one. One shared
// element is reused for every trigger and repositioned/repopulated on hover,
// the same way .footnote-ref reuses the browser's native tooltip — except
// here the content needs real layout, so it's a positioned div instead of a
// `title` attribute. Appended to <body> (not the row) so .entry-desc's
// overflow:hidden / text-overflow:ellipsis can't clip it.
const personCard = document.createElement("div");
personCard.className = "person-card";
personCard.hidden = true;
document.body.appendChild(personCard);

let personCardHideTimer = null;

function wirePersonCard(trigger, card) {
  trigger.addEventListener("mouseenter", () => showPersonCard(trigger, card));
  trigger.addEventListener("mouseleave", hidePersonCard);
}

function showPersonCard(trigger, card) {
  clearTimeout(personCardHideTimer);
  personCard.innerHTML = personCardHtml(card);
  personCard.hidden = false;
  positionPersonCard(trigger);
  // Let the "hidden -> block" layout settle before animating opacity in,
  // otherwise the transition is skipped and the card just snaps into view.
  requestAnimationFrame(() => personCard.classList.add("visible"));
}

function hidePersonCard() {
  personCard.classList.remove("visible");
  personCardHideTimer = setTimeout(() => { personCard.hidden = true; }, 150);
}

function positionPersonCard(trigger) {
  const anchor = trigger.getBoundingClientRect();
  const card = personCard.getBoundingClientRect();
  const margin = 8;

  let top = anchor.bottom + margin;
  if (top + card.height > window.innerHeight - margin) {
    top = anchor.top - card.height - margin;
  }
  let left = anchor.left;
  left = Math.min(left, window.innerWidth - card.width - margin);
  left = Math.max(left, margin);

  personCard.style.top = `${top}px`;
  personCard.style.left = `${left}px`;
}

function pct(fraction, noun) {
  const p = fraction * 100;
  return `${p < 0.01 ? "&lt; 0.01" : p.toFixed(p < 1 ? 3 : 1)}% of ${noun}`;
}

const has = (v) => v !== null && v !== undefined;

// Form 144 (person_card) and Form 3/4/5 (card from /api/sale-summary) carry
// different fields — the former is self-reported (tenure, % of holdings,
// broker, 10b5-1 plan status), the latter derived from the transaction table
// itself (% of position this sale represents, shares left afterwards), since
// Form 4 doesn't carry those self-reported figures. Build whichever lines the
// payload actually supports rather than assuming one shape.
function personCardHtml(card) {
  const role = Array.isArray(card.relationships) ? card.relationships.join(", ") : (card.position || "");
  const location = [card.city, card.state].filter(Boolean).join(", ");
  const subline = [role, location].filter(Boolean).join(" · ");

  const lines = [];
  if (has(card.holding_period_years)) {
    const yrs = card.holding_period_years;
    lines.push(`Holding ${yrs < 1 ? "&lt; 1 yr" : `~${yrs.toFixed(1)} yrs`}`);
  }
  if (has(card.percent_of_holdings)) lines.push(`Selling ${pct(card.percent_of_holdings, "stake")}`);
  if (has(card.percent_sold)) lines.push(`Sold ${pct(card.percent_sold, "position")}`);
  if (has(card.remaining_shares)) lines.push(`Now holds ${formatNumber(card.remaining_shares)} sh.`);
  if (card.broker_name) lines.push(`Via ${escapeHtml(card.broker_name)}`);
  if (card.is_10b5_1_plan === true) {
    const adopted = card.days_since_plan_adoption;
    const cooling = card.cooling_off_compliant === true ? " · cooling-off ✓"
      : card.cooling_off_compliant === false ? " · cooling-off ✗" : "";
    lines.push(`10b5-1 plan${has(adopted) ? ` · adopted ${adopted}d ago` : ""}${cooling}`);
  } else if (card.is_10b5_1_plan === false) {
    lines.push("Discretionary sale (no 10b5-1 plan)");
  }

  return `
    <div class="pc-name">${escapeHtml(card.name)}</div>
    ${subline ? `<div class="pc-role">${escapeHtml(subline)}</div>` : ""}
    ${lines.length ? `<div class="pc-divider"></div>${lines.map((l) => `<div class="pc-line">${l}</div>`).join("")}` : ""}
  `;
}

// Accordion: clicking a row expands it downward to reveal the details
// that don't fit inline; clicking it again (or another row) collapses it.
// First expansion lazily fetches the richer per-filing detail (insider
// names/amounts for Form 4, disclosed items for 8-K) — an extra request
// per filing, so we only ever do it for the one row the user opens.
function toggleExpand(entry, filing) {
  if (expandedEntries.has(entry)) {
    entry.classList.remove("expanded");
    expandedEntries.delete(entry);
    if (activeLink && (activeLink.source === entry || activeLink.target === entry)) {
      clearLink();
    }
  } else {
    entry.classList.add("expanded");
    expandedEntries.add(entry);
    loadExtraDetail(entry, filing);
  }
}

const extraDetailCache = new Map();

async function loadExtraDetail(entry, filing) {
  const slot = entry.querySelector(".entry-extra");

  // Re-render from cache on every (re-)expansion rather than skipping when
  // already loaded — cheap (no network), and needed so the related-filing
  // link gets rewired/redrawn each time the row opens (e.g. after the
  // timeline has scrolled or another row's expansion changed row positions).
  if (extraDetailCache.has(filing.accession_number)) {
    renderExtraDetail(slot, extraDetailCache.get(filing.accession_number));
    return;
  }

  const tab = activeTabId ? tabState.get(activeTabId) : null;
  if (tab) { tab.fetchingDetail++; syncTabIndicator(tab); }

  slot.innerHTML = `<div class="extra-loading">Loading detail…</div>`;
  try {
    const res = await fetch(`/api/filing-detail?accession=${encodeURIComponent(filing.accession_number)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    extraDetailCache.set(filing.accession_number, data);
    renderExtraDetail(slot, data);
  } catch (err) {
    slot.innerHTML = `<div class="extra-loading">Couldn't load detail: ${err.message}</div>`;
  } finally {
    if (tab) { tab.fetchingDetail--; syncTabIndicator(tab); }
  }
}

function renderExtraDetail(slot, data) {
  const sourceEntry = slot.closest(".entry");

  if (data.kind === "ownership") {
    const footnotes = data.footnotes || null;
    // Only list footnotes actually linked from a visible "[Fn]" reference —
    // a filing can define footnotes for fields we don't render at all
    // (e.g. holdings rows), and dumping those would just add noise.
    const referenced = new Set();
    const tableI = renderTableI(data.table_i || [], footnotes, referenced);
    const tableII = renderTableII(data.table_ii || [], footnotes, referenced);
    slot.innerHTML = `
      <div class="extra-title">Reporting owner</div>
      <div class="extra-line">${data.insider_name || "—"}${data.position ? ` · ${data.position}` : ""}</div>
      ${tableI}
      ${tableII}
      ${(!data.table_i?.length && !data.table_ii?.length)
        ? `<div class="extra-line muted">No transaction table parsed — this filing may report only holdings with no reportable transactions.</div>`
        : ""}
      ${renderFootnotes(footnotes, referenced)}
      ${renderRelatedLine(data.related)}
    `;
    wireRelatedLine(slot, sourceEntry, data.related);
    return;
  }

  if (data.kind === "sale_notice") {
    const relationships = (data.relationships || []).join(", ");
    const planLabel = data.is_10b5_1_plan === true ? "Yes — Rule 10b5-1 plan"
      : data.is_10b5_1_plan === false ? "No"
      : "—";
    slot.innerHTML = `
      <div class="extra-title">Planned sale</div>
      <div class="extra-line">${escapeHtml(data.person_selling || "—")}${relationships ? ` · ${escapeHtml(relationships)}` : ""}</div>
      <div><span class="field">Approx. sale date</span>${escapeHtml(data.approx_sale_date || "—")}</div>
      <div><span class="field">Shares to sell</span>${formatNumber(data.units_to_be_sold)} ${escapeHtml(data.security_class || "")}</div>
      <div><span class="field">Est. market value</span>${formatMoney(data.market_value)}</div>
      <div><span class="field">Broker</span>${escapeHtml(data.broker_name || "—")}</div>
      <div><span class="field">10b5-1 plan</span>${planLabel}</div>
      ${renderRelatedLine(data.related)}
    `;
    wireRelatedLine(slot, sourceEntry, data.related);
    return;
  }

  if (data.kind === "financial_report") {
    const stmts = [
      { key: "income_statement", label: "Income" },
      { key: "balance_sheet",    label: "Balance Sheet" },
      { key: "cash_flow",        label: "Cash Flow" },
    ].filter(s => data[s.key]);

    if (!stmts.length) {
      slot.innerHTML = `<div class="extra-line muted">No XBRL financial data parsed for this filing.</div>`;
      return;
    }

    const buildTable = (stmt) => {
      const heads = stmt.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("");
      const bodyRows = stmt.rows.map(r => {
        const cls = r.sub ? " class=\"fin-sub\"" : "";
        const vals = r.values.map(v => `<td class="fin-val">${escapeHtml(v)}</td>`).join("");
        return `<tr${cls}><td class="fin-label">${escapeHtml(r.label)}</td>${vals}</tr>`;
      }).join("");
      return `<div class="fin-scroll"><table class="fin-table"><thead><tr><th></th>${heads}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
    };

    const tabBtns = stmts.map((s, i) =>
      `<button class="fin-tab${i === 0 ? " active" : ""}" data-idx="${i}">${s.label}</button>`
    ).join("");
    const panes = stmts.map((s, i) =>
      `<div class="fin-pane${i === 0 ? " active" : ""}">${buildTable(data[s.key])}</div>`
    ).join("");

    slot.innerHTML = `<div class="fin-stmts"><div class="fin-tabbar">${tabBtns}</div>${panes}</div>`;

    const container = slot.querySelector(".fin-stmts");
    container.querySelectorAll(".fin-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        container.querySelectorAll(".fin-tab").forEach((b, i) => b.classList.toggle("active", i === idx));
        container.querySelectorAll(".fin-pane").forEach((p, i) => p.classList.toggle("active", i === idx));
      });
    });
    return;
  }

  if (data.kind === "thirteen_f") {
    const holdings = data.holdings || [];
    const rows = holdings.map((h) => {
      const ticker = h.Ticker ? `<span class="hld-ticker">${escapeHtml(h.Ticker)}</span>` : `<span class="hld-ticker muted">—</span>`;
      const shares = h.SharesPrnAmount !== null && h.SharesPrnAmount !== undefined
        ? formatBigShares(h.SharesPrnAmount) : "—";
      const value = h.Value !== null && h.Value !== undefined
        ? formatBigMoney(h.Value) : "—";
      const pct = (data.total_value && h.Value)
        ? ` <span class="muted">${(h.Value / data.total_value * 100).toFixed(1)}%</span>` : "";
      return `<div class="hld-row">${ticker}<span class="hld-name">${escapeHtml(h.Issuer || "—")}</span><span class="hld-shares muted">${shares}</span><span class="hld-value">${value}${pct}</span></div>`;
    }).join("");
    slot.innerHTML = `
      <div class="extra-title">Portfolio holdings</div>
      <div class="extra-line">As of ${escapeHtml(data.report_period || "—")} &nbsp;·&nbsp; ${data.total_holdings ?? "?"} position${data.total_holdings === 1 ? "" : "s"} &nbsp;·&nbsp; total ${formatBigMoney(data.total_value)}</div>
      <div class="hld-table">${rows || `<div class="extra-line muted">No holdings parsed for this filing.</div>`}</div>
    `;
    return;
  }

  if (data.kind === "schedule_13") {
    const persons = data.reporting_persons || [];
    const amendFlag = data.is_amendment ? `<span class="prs-flag">Amendment</span> ` : "";
    const passiveFlag = data.is_passive_investor === false
      ? `<span class="prs-flag" style="background:#3b2020;color:#f08080">Active investor</span> `
      : (data.is_passive_investor ? `<span class="prs-flag">Passive</span> ` : "");

    const summaryHtml = [
      ["As of",         escapeHtml(data.date_of_event || "—")],
      ["Security",      escapeHtml(data.security_title || "—")],
      ["Total stake",   data.total_percent != null ? `${data.total_percent.toFixed(2)}%` : "—"],
      ["Total shares",  data.total_shares != null ? Number(data.total_shares).toLocaleString() : "—"],
    ].map(([k, v]) => `<div class="prs-row"><span class="field">${k}</span>${v}</div>`).join("");

    const personRows = persons.map(p => `
      <tr>
        <td>${escapeHtml(p.name || "—")}</td>
        <td>${p.percent != null ? p.percent.toFixed(2) + "%" : "—"}</td>
        <td>${p.shares != null ? Number(p.shares).toLocaleString() : "—"}</td>
        <td>${p.sole_voting != null ? Number(p.sole_voting).toLocaleString() : "—"}</td>
        <td>${p.shared_voting != null ? Number(p.shared_voting).toLocaleString() : "—"}</td>
      </tr>`).join("");

    slot.innerHTML = `
      <div class="extra-title">Beneficial ownership report</div>
      <div class="extra-line">${amendFlag}${passiveFlag}</div>
      <div class="prs-facts">${summaryHtml}</div>
      ${persons.length ? `
        <div class="extra-title" style="margin-top:12px">Reporting persons</div>
        <table class="trades">
          <thead><tr><th>Name</th><th>Stake %</th><th>Shares</th><th>Sole voting</th><th>Shared voting</th></tr></thead>
          <tbody>${personRows}</tbody>
        </table>` : ""}
    `;
    return;
  }

  if (data.kind === "proxy") {
    const proposals = data.voting_proposals || [];
    const proposalRows = proposals.map(p => {
      const rec = p.board_recommendation
        ? ` <span class="muted" style="font-size:11px">(Board: ${escapeHtml(p.board_recommendation)})</span>`
        : "";
      return `<li>${escapeHtml(p.description)}${rec}</li>`;
    }).join("");

    const compHtml = data.peo_total_comp != null
      ? `$${(data.peo_total_comp / 1e6).toFixed(1)}M total compensation` : "";
    const ratioHtml = data.ceo_pay_ratio != null
      ? `<div class="prs-row"><span class="field">CEO pay ratio</span>${data.ceo_pay_ratio.toLocaleString()}:1 vs. median employee${data.median_employee_compensation ? ` ($${(data.median_employee_compensation/1000).toFixed(0)}K)` : ""}</div>`
      : "";
    const tsrHtml = data.total_shareholder_return != null
      ? `<div class="prs-row"><span class="field">TSR (3-yr)</span>${data.total_shareholder_return.toFixed(1)}%</div>` : "";
    const pmHtml = (data.performance_measures || []).length
      ? `<div class="prs-row"><span class="field">Perf. measures</span>${escapeHtml(data.performance_measures.join(" · "))}</div>` : "";

    slot.innerHTML = `
      <div class="extra-title">Executive compensation</div>
      <div class="prs-facts">
        ${data.peo_name ? `<div class="prs-row"><span class="field">CEO</span>${escapeHtml(data.peo_name)}${compHtml ? ` — ${compHtml}` : ""}</div>` : ""}
        ${ratioHtml}${tsrHtml}${pmHtml}
      </div>
      ${proposals.length ? `
        <div class="extra-title" style="margin-top:12px">Voting proposals</div>
        <ul class="items">${proposalRows}</ul>` : ""}
      ${(!data.peo_name && !proposals.length) ? `<div class="extra-line muted">No structured data extracted for this proxy filing.</div>` : ""}
    `;
    return;
  }

  if (data.kind === "prospectus_424b") {
    const typeDisplay = escapeHtml(data.offering_type_display || "Unknown");
    const flags = [
      data.is_supplement  ? "Supplement"  : null,
      data.is_preliminary ? "Preliminary" : null,
      data.is_atm         ? "At-the-Market" : null,
    ].filter(Boolean);

    const factsHtml = [
      ["Offering type",   typeDisplay],
      ["Amount",          data.offering_amount ? escapeHtml(data.offering_amount) : "—"],
      ["Price",           data.offering_price  ? escapeHtml(data.offering_price)  : "—"],
      ["Lead underwriter", data.lead_manager   ? escapeHtml(data.lead_manager)    : "—"],
      ["Registration",    data.registration_number ? escapeHtml(data.registration_number) : "—"],
      data.selling_stockholders_count != null
        ? ["Selling stockholders", data.selling_stockholders_count.toLocaleString()]
        : null,
    ].filter(Boolean).map(([k, v]) =>
      `<div class="prs-row"><span class="field">${k}</span>${v}</div>`
    ).join("");

    const flagsHtml = flags.length
      ? `<div class="extra-line">${flags.map(f => `<span class="prs-flag">${f}</span>`).join(" ")}</div>`
      : "";

    const pricingRows = (data.pricing_rows || []).filter(r => r.label);
    const pricingHtml = pricingRows.length ? `
      <div class="extra-title">Pricing table</div>
      <table class="trades">
        <thead><tr><th></th><th>Offering price</th><th>Discount / fee</th><th>Proceeds</th></tr></thead>
        <tbody>${pricingRows.map(r => `<tr>
          <td>${escapeHtml(r.label || "")}</td>
          <td>${escapeHtml(r.price || "—")}</td>
          <td>${escapeHtml(r.discount || "—")}</td>
          <td>${escapeHtml(r.proceeds || "—")}</td>
        </tr>`).join("")}</tbody>
      </table>` : "";

    slot.innerHTML = `
      <div class="extra-title">Offering details</div>
      ${flagsHtml}
      <div class="prs-facts">${factsHtml}</div>
      ${pricingHtml}
    `;
    return;
  }

  if (data.kind === "current_report") {
    const items = (data.items || [])
      .map(i => `<li><b>${i.code}</b>${i.description ? ` — ${i.description}` : ""}${i.ai_summary ? `<div class="ai-summary">${escapeHtml(i.ai_summary)}</div>` : ""}</li>`).join("");
    const releases = (data.press_releases || []).map(p => `
      <div class="extra-title">Press release (${escapeHtml(p.description)})</div>
      <p class="excerpt">${escapeHtml(p.excerpt)}${p.excerpt.length >= 1200 ? "…" : ""}</p>
    `).join("");
    slot.innerHTML = `
      ${items ? `<div class="extra-title">Items disclosed</div><ul class="items">${items}</ul>` : ""}
      ${releases}
      ${(!items && !releases) ? `<div class="extra-line muted">No items or press release parsed for this filing.</div>` : ""}
    `;
    return;
  }

  slot.innerHTML = `<div class="extra-line muted">${escapeHtml(data.note || "No extra detail available for this form type.")}</div>`;
}

// Form 4 itself defines these two tables — labeling them "Table I"/"Table II"
// matches the vocabulary anyone reading the actual SEC filing already knows.
function renderTableI(rows, footnotes, referenced) {
  if (!rows.length) return "";
  const body = rows.map(t => `
    <tr>
      <td>${t.Date ?? "—"}</td>
      <td>${t.TransactionType ?? "—"}</td>
      <td>${t.Code ?? "—"}</td>
      <td>${formatNumber(t.Shares)}</td>
      <td>${renderAmountCell(t.Price, footnotes, referenced)}</td>
      <td>${t.AcquiredDisposed ?? "—"}</td>
      <td>${formatNumber(t.Remaining)}</td>
    </tr>
  `).join("");
  return `
    <div class="extra-title">Table I — Non-derivative securities</div>
    <table class="trades">
      <thead><tr><th>Date</th><th>Type</th><th>Code</th><th>Shares</th><th>Price</th><th>A/D</th><th>Remaining</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderTableII(rows, footnotes, referenced) {
  if (!rows.length) return "";
  const body = rows.map(t => `
    <tr>
      <td>${t.Date ?? "—"}</td>
      <td>${escapeHtml(t.Security ?? "—")}</td>
      <td>${t.TransactionType ?? "—"}</td>
      <td>${t.Code ?? "—"}</td>
      <td>${formatNumber(t.Shares)}</td>
      <td>${renderAmountCell(t.ExercisePrice, footnotes, referenced)}</td>
      <td>${t.AcquiredDisposed ?? "—"}</td>
      <td>${formatNumber(t.Remaining)}</td>
    </tr>
  `).join("");
  return `
    <div class="extra-title">Table II — Derivative securities</div>
    <table class="trades">
      <thead><tr><th>Date</th><th>Security</th><th>Type</th><th>Code</th><th>Shares</th><th>Exercise px</th><th>A/D</th><th>Remaining</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

// A "price" cell is sometimes a real number, and sometimes a footnote
// reference like "[F1]" — used when a single number can't capture the
// reality (no true exercise price for an RSU, weighted-average sale price
// across multiple trades, etc.). Render the reference as a hoverable span
// carrying the actual footnote text, so "[F1]" stops being a dead end.
function renderAmountCell(value, footnotes, referenced) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return formatPrice(value);
  return linkFootnotes(String(value), footnotes, referenced);
}

function linkFootnotes(text, footnotes, referenced) {
  if (!footnotes) return escapeHtml(text);
  const pattern = /\[F(\d+)\]/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    const id = `F${m[1]}`;
    const note = footnotes[id];
    if (note) {
      referenced?.add(id);
      out += `<span class="footnote-ref" title="${escapeAttr(note)}">${escapeHtml(m[0])}</span>`;
    } else {
      out += escapeHtml(m[0]);
    }
    last = pattern.lastIndex;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

// Show only footnotes actually linked from a "[Fn]" reference rendered above —
// the filing's full footnote bank can include notes for fields we never show.
function renderFootnotes(footnotes, referenced) {
  if (!footnotes || !referenced || !referenced.size) return "";
  const ids = [...referenced].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const items = ids.map(id => `<li><b>[${id}]</b> ${escapeHtml(footnotes[id])}</li>`).join("");
  return `<div class="extra-title">Footnotes</div><ul class="footnotes">${items}</ul>`;
}

// SEC doesn't cross-reference Form 144 "intent to sell" notices with the
// Form 4 that later reports the same sale as completed — the backend links
// them heuristically (same person, date, share count). When it finds a
// match, draw a connecting line between the two rows' markers so the
// relationship is visible at a glance, not just described in text.
function renderRelatedLine(related) {
  if (!related) return "";
  return `
    <div class="extra-line related-link">
      <span class="link-icon">⚭</span> ${escapeHtml(related.relation)} —
      Form ${escapeHtml(related.form)} filed ${escapeHtml(related.filing_date)}
      <span class="related-hint">(click to locate)</span>
    </div>
  `;
}

function wireRelatedLine(slot, sourceEntry, related) {
  if (!related || !sourceEntry) return;
  const link = slot.querySelector(".related-link");
  if (!link) return;

  const targetEntry = timeline.querySelector(`[data-accession="${related.accession_number}"]`);
  if (!targetEntry) {
    link.classList.add("muted");
    link.querySelector(".related-hint").textContent = "(not in the currently loaded range — try a higher limit)";
    return;
  }

  link.addEventListener("click", () => {
    targetEntry.scrollIntoView({ behavior: "smooth", block: "center" });
    targetEntry.classList.add("pulse");
    setTimeout(() => targetEntry.classList.remove("pulse"), 1200);
  });
  drawLink(sourceEntry, targetEntry);
}

let activeLink = null;

function drawLink(sourceEntry, targetEntry) {
  activeLink = { source: sourceEntry, target: targetEntry };
  redrawLink();
}

function clearLink() {
  activeLink = null;
  if (linkOverlay) linkOverlay.innerHTML = "";
}

// Re-run on resize (row layout can reflow) and on every render-from-cache —
// no need to track scroll: the overlay lives inside the scrolling content,
// so it scrolls in lockstep with the rows it connects.
function redrawLink() {
  if (!linkOverlay) return;
  linkOverlay.innerHTML = "";
  if (!activeLink) return;
  const { source, target } = activeLink;
  const sourceMarker = source.querySelector(".marker");
  const targetMarker = target.querySelector(".marker");
  if (!sourceMarker || !targetMarker) return;

  const overlayRect = linkOverlay.getBoundingClientRect();
  const sr = sourceMarker.getBoundingClientRect();
  const tr = targetMarker.getBoundingClientRect();
  const x1 = sr.left + sr.width / 2 - overlayRect.left;
  const y1 = sr.top + sr.height / 2 - overlayRect.top;
  const x2 = tr.left + tr.width / 2 - overlayRect.left;
  const y2 = tr.top + tr.height / 2 - overlayRect.top;
  const bow = 44;
  const midY = (y1 + y2) / 2;

  const svgNS = "http://www.w3.org/2000/svg";
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", `M ${x1} ${y1} C ${x1 - bow} ${midY} ${x2 - bow} ${midY} ${x2} ${y2}`);
  path.setAttribute("class", "link-path");
  linkOverlay.appendChild(path);

  for (const [cx, cy] of [[x1, y1], [x2, y2]]) {
    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
    dot.setAttribute("r", 5);
    dot.setAttribute("class", "link-endpoint");
    linkOverlay.appendChild(dot);
  }
}

function formatNumber(n) {
  return (n === null || n === undefined) ? "—" : Number(n).toLocaleString();
}

function fmtPct(n) {
  return n != null ? `${n}%` : "—";
}

function formatPrice(n) {
  return (n === null || n === undefined) ? "—" : `$${Number(n).toFixed(2)}`;
}

function formatMoney(n) {
  return (n === null || n === undefined) ? "—" : `$${Math.round(Number(n)).toLocaleString()}`;
}

// 10-K/10-Q figures run into the hundreds of billions — "$416,161,000,000"
// doesn't read at a glance, so scale to the largest unit that keeps it short.
function formatBigMoney(n) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return formatMoney(v);
}

function formatBigShares(n) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B sh.`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M sh.`;
  return `${formatNumber(v)} sh.`;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Price chart -----------------------------------------------------------

function renderPriceChart(tab) {
  const data = tab.priceData;
  const panel = tab.pricePanelEl;
  if (!data || data.length < 2) {
    panel.hidden = true;
    tab.priceChartGeom = null;
    return;
  }
  panel.hidden = false;

  const W = 280, H = 110;
  const lows = data.map(d => d.low);
  const highs = data.map(d => d.high);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = (max - min) || 1;

  const points = data.map((bar, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((bar.close - min) / range) * H;
    return { x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${W} ${H} L 0 ${H} Z`;

  tab.priceChartEl.querySelector(".price-line").setAttribute("d", linePath);
  tab.priceChartEl.querySelector(".price-area").setAttribute("d", areaPath);

  tab.priceChartGeom = { points, width: W, height: H, min, max, range };

  panel.querySelector(".price-ticker").textContent = tab.ticker;
  panel.querySelector(".price-date-from").textContent = data[0].date;
  panel.querySelector(".price-date-to").textContent = data[data.length - 1].date;

  clearPriceHighlight(tab);
}

function findNearestPriceBar(priceData, dateStr) {
  if (!priceData || !priceData.length) return null;
  let result = priceData[0];
  for (const bar of priceData) {
    if (bar.date <= dateStr) result = bar;
    else break;
  }
  return result;
}

function showPriceSummary(tab, bar) {
  const data = tab.priceData;
  const panel = tab.pricePanelEl;
  const valueEl = panel.querySelector(".price-value");
  const changeEl = panel.querySelector(".price-change");
  const dateEl = panel.querySelector(".price-summary-date");
  const ohlcEl = panel.querySelector(".price-ohlc");

  if (!bar) {
    const first = data[0], last = data[data.length - 1];
    const pct = ((last.close - first.close) / first.close) * 100;
    valueEl.textContent = `$${last.close.toFixed(2)}`;
    changeEl.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% (${data.length}d)`;
    changeEl.style.color = pct >= 0 ? "#2eaa55" : "#e0524d";
    dateEl.textContent = "Latest";
    // Keep the OHLC row's layout space reserved (visibility: hidden) so the
    // chart doesn't resize when hovering toggles it on/off.
    ohlcEl.classList.add("price-ohlc-empty");
    ohlcEl.innerHTML =
      `<span>O <b>—</b></span><span>H <b>—</b></span><span>L <b>—</b></span>` +
      `<span>C <b>—</b></span><span>Vol <b>—</b></span>`;
    return;
  }

  const idx = data.indexOf(bar);
  const prev = data[idx - 1];
  valueEl.textContent = `$${bar.close.toFixed(2)}`;
  if (prev) {
    const pct = ((bar.close - prev.close) / prev.close) * 100;
    changeEl.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    changeEl.style.color = pct >= 0 ? "#2eaa55" : "#e0524d";
  } else {
    changeEl.textContent = "";
  }
  dateEl.textContent = bar.date;

  ohlcEl.classList.remove("price-ohlc-empty");
  ohlcEl.innerHTML =
    `<span>O <b>${bar.open.toFixed(2)}</b></span>` +
    `<span>H <b>${bar.high.toFixed(2)}</b></span>` +
    `<span>L <b>${bar.low.toFixed(2)}</b></span>` +
    `<span>C <b>${bar.close.toFixed(2)}</b></span>` +
    `<span>Vol <b>${formatBigShares(bar.volume).replace(" sh.", "")}</b></span>`;
}

function highlightPriceDate(tab, dateStr) {
  const geom = tab.priceChartGeom;
  if (!geom) return;
  const bar = findNearestPriceBar(tab.priceData, dateStr);
  if (!bar) return;
  const idx = tab.priceData.indexOf(bar);
  const { x } = geom.points[idx];

  const toY = (price) => geom.height - ((price - geom.min) / geom.range) * geom.height;
  const yHigh = toY(bar.high);
  const yLow = toY(bar.low);
  const yOpen = toY(bar.open);
  const yClose = toY(bar.close);
  const isUp = bar.close >= bar.open;
  const color = isUp ? "#2eaa55" : "#e0524d";
  const candleW = Math.max(2, Math.min(8, (geom.width / tab.priceData.length) * 0.6));

  const wick = tab.priceChartEl.querySelector(".price-hover-wick");
  wick.setAttribute("x1", x);
  wick.setAttribute("x2", x);
  wick.setAttribute("y1", yHigh.toFixed(2));
  wick.setAttribute("y2", yLow.toFixed(2));
  wick.setAttribute("stroke", color);
  wick.removeAttribute("hidden");

  const body = tab.priceChartEl.querySelector(".price-hover-body");
  const bodyTop = Math.min(yOpen, yClose);
  const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
  body.setAttribute("x", (x - candleW / 2).toFixed(2));
  body.setAttribute("y", bodyTop.toFixed(2));
  body.setAttribute("width", candleW.toFixed(2));
  body.setAttribute("height", bodyHeight.toFixed(2));
  body.setAttribute("fill", color);
  body.removeAttribute("hidden");

  showPriceSummary(tab, bar);
}

function clearPriceHighlight(tab) {
  if (!tab.priceChartEl) return;
  tab.priceChartEl.querySelector(".price-hover-wick").setAttribute("hidden", "");
  tab.priceChartEl.querySelector(".price-hover-body").setAttribute("hidden", "");
  if (tab.priceData && tab.priceData.length) showPriceSummary(tab, null);
}

// --- Latest 10-Q card --------------------------------------------------

function renderLatest10Q(tab, filing) {
  const box = tab.pricePanelEl.querySelector(".price-10q");
  if (!filing) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  tab.pricePanelEl.hidden = false;
  box.querySelector(".p10q-date").textContent = filing.filing_date;

  const header = box.querySelector(".p10q-header");
  const extra = box.querySelector(".p10q-extra");
  // Replace any previously-bound listener (renderLatest10Q can run again
  // for the same tab when the user re-searches the same ticker).
  const newHeader = header.cloneNode(true);
  header.replaceWith(newHeader);

  newHeader.addEventListener("click", () => {
    const expanded = box.classList.toggle("expanded");
    if (expanded && !extra.dataset.loaded) {
      loadLatest10QDetail(extra, filing);
    }
  });
}

async function loadLatest10QDetail(extra, filing) {
  extra.innerHTML = `<div class="extra-loading">Loading detail…</div>`;
  try {
    if (extraDetailCache.has(filing.accession_number)) {
      renderExtraDetail(extra, extraDetailCache.get(filing.accession_number));
    } else {
      const res = await fetch(`/api/filing-detail?accession=${encodeURIComponent(filing.accession_number)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      extraDetailCache.set(filing.accession_number, data);
      renderExtraDetail(extra, data);
    }
    extra.dataset.loaded = "1";
    extra.insertAdjacentHTML("beforeend",
      `<div style="margin-top:8px"><a href="${escapeAttr(filing.document_url)}" target="_blank" rel="noopener">View full filing →</a></div>`);
  } catch (err) {
    extra.innerHTML = `<div class="extra-loading">Couldn't load detail: ${err.message}</div>`;
  }
}

// Snapshots already arrive in full from /api/institutional-holdings (unlike
// the 10-Q card above, there's no per-row detail to lazy-fetch) — this just
// lays out every cached quarter, most recent first, as a small table.
function renderInstitutionalPanel(tab, snapshots) {
  const box = tab.pricePanelEl.querySelector(".inst-panel");
  if (!snapshots || !snapshots.length) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  tab.pricePanelEl.hidden = false;
  box.querySelector(".ip-date").textContent = snapshots[0].quarter;

  const header = box.querySelector(".ip-header");
  const extra = box.querySelector(".ip-extra");
  // Replace any previously-bound listener (this can run again for the same
  // tab when the user re-searches the same ticker).
  const newHeader = header.cloneNode(true);
  header.replaceWith(newHeader);

  // snapshots are newest-first, so the next array entry is one quarter older
  // — every column's up/down indicator compares against that same prior row.
  const cellWithDelta = (curSnap, prevSnap, key) => {
    const cur = curSnap[key];
    const prev = prevSnap ? prevSnap[key] : null;
    const valueStr = fmtPct(cur);
    if (cur == null || prev == null) return valueStr;
    const delta = cur - prev;
    const color = delta >= 0 ? "#2eaa55" : "#e0524d";
    const arrow = delta >= 0 ? "▲" : "▼";
    return `${valueStr}<br><span class="ip-delta" style="color:${color}">${arrow}${Math.abs(delta).toFixed(1)}</span>`;
  };

  const rows = snapshots.map((s, i) => {
    const prev = snapshots[i + 1];
    return `
      <tr>
        <td class="ip-q">${escapeHtml(s.quarter)}</td>
        <td class="ip-own">${cellWithDelta(s, prev, "institutional_ownership_pct")}</td>
        <td>${cellWithDelta(s, prev, "concentration_top10_pct")}</td>
        <td>${cellWithDelta(s, prev, "concentration_top20_pct")}</td>
        <td>${cellWithDelta(s, prev, "concentration_top50_pct")}</td>
        <td>${cellWithDelta(s, prev, "concentration_top100_pct")}</td>
      </tr>
    `;
  }).join("");

  extra.innerHTML = `
    <table class="ip-table">
      <thead>
        <tr><th>Qtr</th><th>Own%</th><th>10</th><th>20</th><th>50</th><th>100</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  newHeader.addEventListener("click", () => {
    box.classList.toggle("expanded");
  });
}

// Same idea as renderInstitutionalPanel, but bi-monthly (~24 points/year
// instead of ~4) — the table gets its own scroll container rather than
// growing the whole sidebar card to match.
function renderShortInterestPanel(tab, snapshots) {
  const box = tab.pricePanelEl.querySelector(".short-panel");
  if (!snapshots || !snapshots.length) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  tab.pricePanelEl.hidden = false;
  box.querySelector(".si-date").textContent = snapshots[0].settlement_date;

  const header = box.querySelector(".si-header");
  const extra = box.querySelector(".si-extra");
  // Replace any previously-bound listener (this can run again for the same
  // tab when the user re-searches the same ticker).
  const newHeader = header.cloneNode(true);
  header.replaceWith(newHeader);

  const deltaBadge = (delta, suffix, digits) => {
    if (delta == null) return "";
    const color = delta >= 0 ? "#2eaa55" : "#e0524d";
    const arrow = delta >= 0 ? "▲" : "▼";
    return `<br><span class="ip-delta" style="color:${color}">${arrow}${Math.abs(delta).toFixed(digits)}${suffix}</span>`;
  };

  // snapshots are newest-first, so the next array entry is the prior
  // settlement date — that's what each delta compares against.
  const rows = snapshots.map((s, i) => {
    const prev = snapshots[i + 1];
    const sharesDeltaPct = prev
      ? (s.short_interest_shares - prev.short_interest_shares) / prev.short_interest_shares * 100
      : null;
    const coverDelta = prev ? s.days_to_cover - prev.days_to_cover : null;
    return `
      <tr>
        <td class="ip-q">${s.settlement_date}</td>
        <td class="ip-own">${formatBigShares(s.short_interest_shares)}${deltaBadge(sharesDeltaPct, "%", 1)}</td>
        <td>${s.days_to_cover.toFixed(2)}${deltaBadge(coverDelta, "", 2)}</td>
      </tr>
    `;
  }).join("");

  extra.innerHTML = `
    <table class="ip-table">
      <thead>
        <tr><th>Date</th><th>Short Int.</th><th>Days Cov.</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  newHeader.addEventListener("click", () => {
    box.classList.toggle("expanded");
  });
}

// Coverage is spotty by design (see prediction_market.py) — most tickers
// will get [] back, which is the normal/expected case, not an error.
// Entries arrive sorted by strike descending (HIGH strikes above the
// current price, then LOW strikes below), which already reads like a rough
// probability distribution once laid out top to bottom.
function renderPredictionMarketPanel(tab, rows) {
  const box = tab.pricePanelEl.querySelector(".pm-panel");
  if (!rows || !rows.length) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  tab.pricePanelEl.hidden = false;
  box.querySelector(".pm-date").textContent = "this month";

  const header = box.querySelector(".pm-header");
  const extra = box.querySelector(".pm-extra");
  const newHeader = header.cloneNode(true);
  header.replaceWith(newHeader);

  const priceData = tab.priceData || [];
  const currentPrice = priceData.length ? priceData[priceData.length - 1].close : null;
  const currentPriceNote = currentPrice != null ? ` Currently ${formatPrice(currentPrice)}.` : "";

  // HIGH and LOW are symmetric halves of the same distribution (odds of
  // touching a price above vs. below where it trades now) — one merged
  // list, direction shown per-row via arrow rather than splitting them
  // apart with a divider. Already-resolved strikes (yes_price pinned at 0
  // or 1 — the price already touched there this month, or is now out of
  // reach) are dimmed rather than dropped: still a useful reference for
  // this month's actual traded range, just no longer a live forecast.
  // Volume is shown per row since liquidity is uneven strike to strike —
  // a probability with little size behind it is a much weaker signal.
  const rowsHtml = rows.map(r => {
    const pct = (r.yes_price * 100).toFixed(1);
    const up = r.side === "HIGH";
    const arrow = up ? "▲" : "▼";
    const arrowColor = up ? "#2eaa55" : "#e0524d";
    const volLabel = r.volume > 0 ? formatMoney(r.volume) : "—";
    return `
      <div class="pm-row${r.resolved ? " pm-row-resolved" : ""}">
        <span class="pm-arrow" style="color:${arrowColor}">${arrow}</span>
        <span class="pm-strike">$${r.strike.toLocaleString()}</span>
        <div class="pm-bar-track"><div class="pm-bar-fill" style="width:${pct}%; background:${arrowColor}"></div></div>
        <span class="pm-pct">${pct}%</span>
        <span class="pm-vol">${volLabel}</span>
      </div>
    `;
  }).join("");

  extra.innerHTML = `
    <div class="pm-note">Market-implied odds of ${escapeHtml(tab.ticker)} touching each price this month (▲ above, ▼ below), with $ volume traded on that specific strike. Dimmed rows already resolved this month (price already reached, or now out of reach) — a reference point, not a live forecast.${currentPriceNote}</div>
    ${rowsHtml}
  `;

  newHeader.addEventListener("click", () => {
    box.classList.toggle("expanded");
  });
}

// iv30 (CBOE's own ~30-calendar-day constant-maturity implied volatility,
// VIX-style) is the headline number. The smile chart below it is IV by
// strike for whichever expiration happens to be nearest — a different,
// shorter maturity than iv30, not directly comparable to it, just useful
// to see the skew (OTM puts usually price richer than calls — that's
// crash-protection demand, not a bearish "call", same non-directional
// caveat as the prediction-market panel).
function renderImpliedVolatilityPanel(tab, iv) {
  const box = tab.pricePanelEl.querySelector(".iv-panel");
  const chain = (iv && iv.chain) || [];
  if (!iv || (iv.iv30 == null && !chain.length)) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  tab.pricePanelEl.hidden = false;

  const change = iv.iv30_change;
  const changeHtml = (change != null && change !== 0)
    ? ` <span style="color:${change >= 0 ? "#2eaa55" : "#e0524d"}">${change >= 0 ? "▲" : "▼"}${Math.abs(change).toFixed(1)}</span>`
    : "";
  box.querySelector(".iv-date").innerHTML = iv.iv30 != null ? `${iv.iv30}%${changeHtml}` : "";

  const header = box.querySelector(".iv-header");
  const newHeader = header.cloneNode(true);
  header.replaceWith(newHeader);
  newHeader.addEventListener("click", () => {
    box.classList.toggle("expanded");
  });

  // --- IV smile chart (CBOE) ---
  const smile = iv.smile || [];
  const label = box.querySelector(".iv-smile-label");
  const svg = box.querySelector(".iv-smile-chart");
  if (smile.length < 2) {
    label.textContent = iv.iv30 != null ? "Not enough listed strikes for a smile chart" : "";
    svg.innerHTML = "";
  } else {
    renderIvSmile(svg, label, iv, smile);
  }

  // --- Option chain (Nasdaq): bid/ask/volume/open interest per strike ---
  const chainLabel = box.querySelector(".chain-label");
  const chainRows = box.querySelector(".chain-rows");
  if (!chain.length) {
    chainLabel.textContent = "";
    chainRows.innerHTML = "";
    return;
  }

  chainLabel.textContent = `Option chain (Nasdaq), ${iv.chain_expiration || "nearest"} expiration`;

  const fmtCount = (n) => n == null ? "—" : (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${Math.round(n)}`);
  const fmtBidAsk = (bid, ask) => `${bid != null ? bid.toFixed(2) : "—"}×${ask != null ? ask.toFixed(2) : "—"}`;

  chainRows.innerHTML = chain.map(r => `
    <div class="chain-row">
      <div class="chain-strike">$${r.strike.toLocaleString()}</div>
      <div class="chain-side"><span class="chain-tag chain-tag-call">C</span>${fmtBidAsk(r.call_bid, r.call_ask)} <span class="chain-meta">Vol ${fmtCount(r.call_volume)} · OI ${fmtCount(r.call_oi)}</span></div>
      <div class="chain-side"><span class="chain-tag chain-tag-put">P</span>${fmtBidAsk(r.put_bid, r.put_ask)} <span class="chain-meta">Vol ${fmtCount(r.put_volume)} · OI ${fmtCount(r.put_oi)}</span></div>
    </div>
  `).join("");
}

function renderIvSmile(svg, label, iv, smile) {
  label.textContent = `IV by strike, ${iv.expiration || "nearest"} expiration (blue = calls, orange = puts)`;

  // x is scaled by the actual strike price, not by rank/index — real
  // strike spacing is uneven (e.g. $2.50 apart near the money, $20-25
  // apart out at the wings), and plotting by index would compress those
  // wide gaps down to the same width as the tight ones, distorting the
  // skew's actual shape.
  const W = 260, H = 60;
  const allIv = smile.flatMap(r => [r.call_iv, r.put_iv]).filter(v => v != null);
  const min = Math.min(...allIv), max = Math.max(...allIv);
  const range = (max - min) || 1;
  const strikeMin = smile[0].strike, strikeMax = smile[smile.length - 1].strike;
  const strikeRange = (strikeMax - strikeMin) || 1;
  const xFor = (strike) => ((strike - strikeMin) / strikeRange) * W;
  const yFor = (v) => H - ((v - min) / range) * H;

  const pathFor = (key) => {
    const pts = [];
    smile.forEach((r) => {
      if (r[key] == null) return;
      pts.push({ x: xFor(r.strike), y: yFor(r[key]) });
    });
    return pts.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  };

  // Vertical reference line at the actual current price (not just the
  // nearest listed strike), placed on the same value-proportional scale.
  const curX = iv.current_price != null ? xFor(iv.current_price) : null;

  // X-axis tick labels — a handful of evenly-spaced strikes (not every
  // listed one, which would overlap at this width) so it's clear which
  // dollar level each part of the curve belongs to.
  const TICKS = 4;
  const axisY = H + 10;
  const ticksHtml = Array.from({ length: TICKS }, (_, i) => strikeMin + (strikeRange * i) / (TICKS - 1))
    .map((strike, i) => {
      const x = xFor(strike);
      const anchor = i === 0 ? "start" : (i === TICKS - 1 ? "end" : "middle");
      return `<text x="${x.toFixed(2)}" y="${axisY}" font-size="7" fill="#a0a8bc" text-anchor="${anchor}">$${Math.round(strike)}</text>`;
    }).join("");

  svg.innerHTML = `
    ${curX != null ? `<line x1="${curX.toFixed(2)}" y1="0" x2="${curX.toFixed(2)}" y2="${H}" stroke="#dee2e6" stroke-width="1" stroke-dasharray="3,2" />` : ""}
    ${ticksHtml}
    <path d="${pathFor("call_iv")}" fill="none" stroke="#3b6ef0" stroke-width="1.5" />
    <path d="${pathFor("put_iv")}" fill="none" stroke="#f76707" stroke-width="1.5" />
  `;
}

// Unlike the panels above, this reads tab.priceData directly — no separate
// fetch. api_prices() already fetches extra lookback before the display
// window so SMA50/MACD have room to warm up, then trims back down, so every
// bar already carries sma20/sma50/rsi14/macd/macd_signal/macd_hist (null
// during the warm-up window, which for a very new listing can mean "for the
// whole visible range" — the null-filtering below just draws a shorter line
// starting wherever values become valid).
function renderTechnicalPanel(tab) {
  const box = tab.pricePanelEl.querySelector(".tech-panel");
  const data = tab.priceData;
  const hasAny = data && data.some(d => d.sma20 != null || d.rsi14 != null || d.macd != null);
  if (!data || data.length < 2 || !hasAny) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  tab.pricePanelEl.hidden = false;
  box.querySelector(".tp-date").textContent = data[data.length - 1].date;

  const header = box.querySelector(".tp-header");
  const newHeader = header.cloneNode(true);
  header.replaceWith(newHeader);
  newHeader.addEventListener("click", () => {
    box.classList.toggle("expanded");
  });

  const n = data.length;
  // Same index-based x-scale as renderPriceChart, but skips null points
  // (the warm-up prefix) rather than plotting through them.
  const pathFor = (values, W, H, min, max) => {
    const range = (max - min) || 1;
    const pts = [];
    values.forEach((v, i) => {
      if (v == null) return;
      pts.push({ x: (i / (n - 1)) * W, y: H - ((v - min) / range) * H });
    });
    return pts.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  };

  // --- SMA 20/50 + Bollinger Bands(20,2) over close ---
  const closeVals = data.map(d => d.close);
  const sma20Vals = data.map(d => d.sma20);
  const sma50Vals = data.map(d => d.sma50);
  const bbUpperVals = data.map(d => d.bb_upper);
  const bbLowerVals = data.map(d => d.bb_lower);
  const smaAll = [...closeVals, ...sma20Vals, ...sma50Vals, ...bbUpperVals, ...bbLowerVals].filter(v => v != null);
  const smaMin = Math.min(...smaAll), smaMax = Math.max(...smaAll);
  const smaW = 260, smaH = 70;

  // Filled envelope between the bands — built as one closed polygon (upper
  // edge left-to-right, then lower edge back right-to-left) rather than two
  // separate lines, so it can be filled as a single translucent shape.
  const areaBetween = (upperVals, lowerVals, W, H, min, max) => {
    const range = (max - min) || 1;
    const idxs = [];
    upperVals.forEach((v, i) => { if (v != null && lowerVals[i] != null) idxs.push(i); });
    if (!idxs.length) return "";
    const xy = (v, i) => `${((i / (n - 1)) * W).toFixed(2)} ${(H - ((v - min) / range) * H).toFixed(2)}`;
    const upper = idxs.map((i, k) => `${k === 0 ? "M" : "L"} ${xy(upperVals[i], i)}`).join(" ");
    const lower = [...idxs].reverse().map(i => `L ${xy(lowerVals[i], i)}`).join(" ");
    return `${upper} ${lower} Z`;
  };

  box.querySelector(".tp-sma-chart").innerHTML = `
    <path d="${areaBetween(bbUpperVals, bbLowerVals, smaW, smaH, smaMin, smaMax)}" fill="#3b6ef01a" stroke="none" />
    <path d="${pathFor(bbUpperVals, smaW, smaH, smaMin, smaMax)}" fill="none" stroke="#3b6ef066" stroke-width="1" stroke-dasharray="2,2" />
    <path d="${pathFor(bbLowerVals, smaW, smaH, smaMin, smaMax)}" fill="none" stroke="#3b6ef066" stroke-width="1" stroke-dasharray="2,2" />
    <path d="${pathFor(closeVals, smaW, smaH, smaMin, smaMax)}" fill="none" stroke="#ced4da" stroke-width="1.25" />
    <path d="${pathFor(sma20Vals, smaW, smaH, smaMin, smaMax)}" fill="none" stroke="#3b6ef0" stroke-width="1.5" />
    <path d="${pathFor(sma50Vals, smaW, smaH, smaMin, smaMax)}" fill="none" stroke="#f76707" stroke-width="1.5" />
  `;

  // --- Volume, colored by up/down day vs. the prior close ---
  const volumeVals = data.map(d => d.volume);
  const volMax = Math.max(...volumeVals.filter(v => v != null), 1);
  const volW = 260, volH = 36;
  const volBarW = (volW / n) * 0.7;
  const volBars = volumeVals.map((v, i) => {
    if (v == null) return "";
    const h = (v / volMax) * volH;
    const x = (i / (n - 1)) * volW - volBarW / 2;
    const prevClose = i > 0 ? closeVals[i - 1] : null;
    const color = (prevClose == null || closeVals[i] >= prevClose) ? "#2eaa55" : "#e0524d";
    return `<rect x="${x.toFixed(2)}" y="${(volH - h).toFixed(2)}" width="${volBarW.toFixed(2)}" height="${h.toFixed(2)}" fill="${color}" opacity="0.75" />`;
  }).join("");
  box.querySelector(".tp-volume-chart").innerHTML = volBars;

  // --- RSI(14), fixed 0-100 scale with 30/70 reference lines ---
  const rsiVals = data.map(d => d.rsi14);
  const rsiW = 260, rsiH = 50;
  const rsiY = (v) => (rsiH - (v / 100) * rsiH).toFixed(2);
  box.querySelector(".tp-rsi-chart").innerHTML = `
    <line x1="0" y1="${rsiY(70)}" x2="${rsiW}" y2="${rsiY(70)}" stroke="#dee2e6" stroke-width="1" stroke-dasharray="3,2" />
    <line x1="0" y1="${rsiY(30)}" x2="${rsiW}" y2="${rsiY(30)}" stroke="#dee2e6" stroke-width="1" stroke-dasharray="3,2" />
    <path d="${pathFor(rsiVals, rsiW, rsiH, 0, 100)}" fill="none" stroke="#ae3ec9" stroke-width="1.5" />
  `;

  // --- MACD(12,26,9): line + signal + histogram ---
  const macdVals = data.map(d => d.macd);
  const signalVals = data.map(d => d.macd_signal);
  const histVals = data.map(d => d.macd_hist);
  const macdAll = [...macdVals, ...signalVals, ...histVals].filter(v => v != null);
  const macdMin = Math.min(0, ...macdAll), macdMax = Math.max(0, ...macdAll);
  const macdW = 260, macdH = 60;
  const macdRange = (macdMax - macdMin) || 1;
  const barW = (macdW / n) * 0.6;
  const zeroY = macdH - ((0 - macdMin) / macdRange) * macdH;
  const bars = histVals.map((v, i) => {
    if (v == null) return "";
    const x = (i / (n - 1)) * macdW - barW / 2;
    const y = macdH - ((v - macdMin) / macdRange) * macdH;
    const top = Math.min(y, zeroY), h = Math.abs(y - zeroY);
    return `<rect x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${v >= 0 ? "#2eaa55" : "#e0524d"}" />`;
  }).join("");
  box.querySelector(".tp-macd-chart").innerHTML = `
    ${bars}
    <path d="${pathFor(macdVals, macdW, macdH, macdMin, macdMax)}" fill="none" stroke="#3b6ef0" stroke-width="1.25" />
    <path d="${pathFor(signalVals, macdW, macdH, macdMin, macdMax)}" fill="none" stroke="#f76707" stroke-width="1.25" />
  `;
}

// Preload a sample ticker on first visit so the page demonstrates itself
// before a user types anything.
loadTicker("AAPL", parseInt(daysInput.value) || 30);
