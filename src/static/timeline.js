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
    const [filingsRes, newsRes, pricesRes, latest10QRes] = await Promise.all([
      fetch(`/api/filings?ticker=${encodeURIComponent(ticker)}&days=${encodeURIComponent(days)}`),
      fetch(`/api/news?ticker=${encodeURIComponent(ticker)}&days=${encodeURIComponent(days)}`).catch(() => null),
      fetch(`/api/prices?ticker=${encodeURIComponent(ticker)}&days=${encodeURIComponent(days)}`).catch(() => null),
      fetch(`/api/latest-filing?ticker=${encodeURIComponent(ticker)}&form=10-Q`).catch(() => null),
    ]);
    const data = await filingsRes.json();
    if (!filingsRes.ok) throw new Error(data.error || "Request failed");
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
    tab.days = days;
    tab.priceData = Array.isArray(prices) ? prices : [];
    renderCompanyInfo(data, tab);
    renderTimeline(data.filings, news, tab);
    renderPriceChart(tab);
    renderLatest10Q(tab, latest10Q);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
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

  if (!filings.length && !newsArr.length) {
    timelineEl.innerHTML = `<li class="empty">No filings match these criteria.</li>`;
    return;
  }

  // Merge filings and news articles then sort newest-first. Rows are evenly
  // spaced by sequence rather than proportionally to real date gaps — filing
  // dates cluster unevenly, and sequence-based spacing keeps every row legible.
  const allItems = [
    ...filings.map(f => ({ type: "filing", date: f.filing_date, data: f })),
    ...newsArr.map(a => ({ type: "news", date: a.date, data: a })),
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
    } else {
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
      .map(i => `<li><b>${i.code}</b>${i.description ? ` — ${i.description}` : ""}</li>`).join("");
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

// Preload a sample ticker on first visit so the page demonstrates itself
// before a user types anything.
loadTicker("AAPL", parseInt(daysInput.value) || 30);
