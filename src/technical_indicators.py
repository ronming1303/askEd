"""Classic technical-analysis indicators computed purely from OHLC bars
already fetched for the price chart — no external data source, no I/O.

SMA 20/50 (trend), RSI(14) (momentum oscillator, Wilder's smoothing), and
MACD(12,26,9) (trend/momentum) are the three shown in the Technical
Indicators sidebar panel.
"""

import pandas as pd


def compute_indicators(bars: list[dict]) -> list[dict]:
    """bars: date-ascending list of dicts with a 'close' key. Returns the
    same list with sma20, sma50, rsi14, macd, macd_signal, macd_hist added
    to each dict — None wherever there isn't enough history yet to compute
    a value (the initial warm-up window).
    """
    if not bars:
        return bars

    close = pd.Series([b["close"] for b in bars], dtype=float)

    sma20 = close.rolling(20).mean()
    sma50 = close.rolling(50).mean()

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    macd_signal = macd.ewm(span=9, adjust=False).mean()
    macd_hist = macd - macd_signal

    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / 14, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / 14, adjust=False).mean()
    rs = avg_gain / avg_loss
    rsi14 = 100 - (100 / (1 + rs))

    def _clean(series: pd.Series) -> list:
        # series.where(series.notna(), None) is a no-op on a float64 Series —
        # pandas coerces None right back to NaN to keep the dtype uniform, so
        # the None-replacement has to happen at the plain-Python-list level.
        return [None if pd.isna(v) else float(v) for v in series]

    sma20_vals = _clean(sma20)
    sma50_vals = _clean(sma50)
    rsi14_vals = _clean(rsi14)
    macd_vals = _clean(macd)
    macd_signal_vals = _clean(macd_signal)
    macd_hist_vals = _clean(macd_hist)

    for i, bar in enumerate(bars):
        bar["sma20"] = sma20_vals[i]
        bar["sma50"] = sma50_vals[i]
        bar["rsi14"] = rsi14_vals[i]
        bar["macd"] = macd_vals[i]
        bar["macd_signal"] = macd_signal_vals[i]
        bar["macd_hist"] = macd_hist_vals[i]

    return bars
