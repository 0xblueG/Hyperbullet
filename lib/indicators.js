function ema(arr, period) {
  if (arr.length < period) return Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  const out = Array(arr.length).fill(null);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += arr[i];
  out[period - 1] = sma / period;
  for (let i = period; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(null);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0));
  }
  let avgG = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgL = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = Array(closes.length).fill(null);
  out[period] = 100 - (100 / (1 + (avgG / (avgL || 1e-10))));
  for (let i = period + 1; i < closes.length; i++) {
    avgG = (avgG * (period - 1) + gains[i - 1]) / period;
    avgL = (avgL * (period - 1) + losses[i - 1]) / period;
    const rs = avgG / (avgL || 1e-10);
    out[i] = 100 - (100 / (1 + rs));
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const macdLine = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const valid = macdLine.filter(v => v != null);
  const sigValid = ema(valid, signal);
  const signalLine = Array(closes.length).fill(null);
  const first = macdLine.findIndex(v => v != null);
  for (let i = 0; i < sigValid.length; i++) {
    const idx = first + signal - 1 + i;
    if (idx < signalLine.length) signalLine[idx] = sigValid[i];
  }
  return { macdLine, signalLine };
}

export function computeIndicators(candles /* [{o,h,l,c,v,ts},...] */) {
  if (!candles?.length) throw new Error("No candles");
  const sorted = [...candles].sort((a, b) => a.ts - b.ts);
  const closes = sorted.map(x => Number(x.c));

  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200); // will remain null with 50 points
  const rsi14 = rsi(closes, 14);
  const { macdLine, signalLine } = macd(closes, 12, 26, 9);

  const i = closes.length - 1;
  const vals = {
    ema50: ema50[i] ?? null,
    ema200: ema200[i] ?? null,
    rsi14: rsi14[i] ?? null,
    macd: macdLine[i] ?? null,
    macdSignal: signalLine[i] ?? null,
  };

  // --- Simple scoring ---
  let score = 0;
  const W = { trend: 40, rsi: 30, macd: 30 };

  if (vals.ema50 != null && vals.ema200 != null) {
    if (closes[i] > vals.ema50 && vals.ema50 > vals.ema200) score += W.trend;
    else if (closes[i] < vals.ema50 && vals.ema50 < vals.ema200) score -= W.trend;
  } else if (vals.ema50 != null) {
    if (closes[i] > vals.ema50) score += W.trend / 2;
    else if (closes[i] < vals.ema50) score -= W.trend / 2;
  }

  if (vals.rsi14 != null) {
    if (vals.rsi14 >= 60) score += W.rsi;
    else if (vals.rsi14 <= 40) score -= W.rsi;
  }

  if (vals.macd != null && vals.macdSignal != null) {
    if (vals.macd > vals.macdSignal && vals.macd > 0) score += W.macd;
    else if (vals.macd < vals.macdSignal && vals.macd < 0) score -= W.macd;
  }

  score = Math.max(-100, Math.min(100, score));
  const label = score > 20 ? "Bullish" : (score < -20 ? "Bearish" : "Neutral");

  return { ...vals, score, label, lastTs: sorted[i].ts };
}
