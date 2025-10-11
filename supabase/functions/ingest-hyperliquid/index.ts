// Supabase Edge Function: ingest-hyperliquid
// Runtime: Deno (Edge). Fetches Hyperliquid candles, computes indicators, and upserts last-only per symbol into Supabase.
// Deployment: supabase functions deploy ingest-hyperliquid
import { createClient } from 'https://esm.sh/@supabase/supabase-js';
// ---- Indicator utilities ----
function ema(arr, period) {
  if (arr.length < period) return Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  const out = Array(arr.length).fill(null);
  let sma = 0;
  for(let i = 0; i < period; i++)sma += arr[i];
  out[period - 1] = sma / period;
  for(let i = period; i < arr.length; i++)out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(null);
  const gains = [], losses = [];
  for(let i = 1; i < closes.length; i++){
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  let avgG = gains.slice(0, period).reduce((a, b)=>a + b, 0) / period;
  let avgL = losses.slice(0, period).reduce((a, b)=>a + b, 0) / period;
  const out = Array(closes.length).fill(null);
  const rs0 = avgG / (avgL || 1e-10);
  out[period] = 100 - 100 / (1 + rs0);
  for(let i = period + 1; i < closes.length; i++){
    avgG = (avgG * (period - 1) + gains[i - 1]) / period;
    avgL = (avgL * (period - 1) + losses[i - 1]) / period;
    const rs = avgG / (avgL || 1e-10);
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}
function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const macdLine = closes.map((_, i)=>ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const valid = macdLine.filter((v)=>v != null);
  const sigValid = ema(valid, signal);
  const signalLine = Array(closes.length).fill(null);
  const first = macdLine.findIndex((v)=>v != null);
  for(let i = 0; i < sigValid.length; i++){
    const idx = first + signal - 1 + i;
    if (idx < signalLine.length) signalLine[idx] = sigValid[i];
  }
  return {
    macdLine,
    signalLine
  };
}
function computeIndicators(candles) {
  if (!candles?.length) throw new Error('No candles');
  const sorted = [
    ...candles
  ].sort((a, b)=>a.ts - b.ts);
  const closes = sorted.map((x)=>Number(x.c));
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const { macdLine, signalLine } = macd(closes, 12, 26, 9);
  const i = closes.length - 1;
  const vals = {
    ema50: ema50[i] ?? null,
    ema200: ema200[i] ?? null,
    rsi14: rsi14[i] ?? null,
    macd: macdLine[i] ?? null,
    macdSignal: signalLine[i] ?? null
  };
  let score = 0;
  const W = {
    trend: 40,
    rsi: 30,
    macd: 30
  };
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
  const label = score > 20 ? 'Bullish' : score < -20 ? 'Bearish' : 'Neutral';
  return {
    ...vals,
    score,
    label,
    lastTs: sorted[i].ts
  };
}
function toDbTime(ms, mode) {
  const m = (mode || 'timestamp').toLowerCase();
  if (m === 'ms' || m === 'epoch_ms' || m === 'bigint') return Number(ms);
  if (m === 's' || m === 'sec' || m === 'seconds' || m === 'epoch_s') return Math.floor(Number(ms) / 1000);
  return new Date(Number(ms)).toISOString();
}
function intervalToMs(interval) {
  const s = (interval || '4h').toLowerCase();
  if (s.endsWith('m')) return Number(s.slice(0, -1)) * 60 * 1000;
  if (s.endsWith('h')) return Number(s.slice(0, -1)) * 60 * 60 * 1000;
  if (s.endsWith('d')) return Number(s.slice(0, -1)) * 24 * 60 * 60 * 1000;
  return 4 * 60 * 60 * 1000;
}
async function fetchCandles(symbols, interval = '4h', n = 200) {
  const intervalMs = intervalToMs(interval);
  const endTime = Date.now();
  const startTime = endTime - intervalMs * n;
  const results = {};
  for (const symbol of symbols){
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: {
          coin: symbol,
          interval,
          startTime,
          endTime
        }
      })
    });
    if (!r.ok) {
      results[symbol] = [];
      continue;
    }
    const data = await r.json();
    results[symbol] = Array.isArray(data) ? data : [];
  }
  return results;
}
Deno.serve(async (req)=>{
  try {
    const url = new URL(req.url);
    const interval = url.searchParams.get('interval') || '4h';
    const n = Number(url.searchParams.get('n') || '200');
    const limit = Number(url.searchParams.get('limit') || '100');
    // Supabase secrets cannot start with SUPABASE_, so we use SB_* names
    const SUPABASE_URL = Deno.env.get('SB_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY');
    const SUPABASE_SCHEMA = Deno.env.get('SB_SCHEMA') || 'public';
    const CANDLES_TABLE = (Deno.env.get('SB_CANDLES_TABLE') || 'candles').replace(/^public\./i, '');
    const INDICATORS_TABLE = (Deno.env.get('SB_INDICATORS_TABLE') || 'indicators').replace(/^public\./i, '');
    const CANDLES_TIME_TYPE = Deno.env.get('SB_CANDLES_TIME_TYPE') || 'timestamp';
    const INDICATORS_TIME_TYPE = Deno.env.get('SB_INDICATORS_TIME_TYPE') || CANDLES_TIME_TYPE;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false
      },
      db: {
        schema: SUPABASE_SCHEMA
      }
    });
    // 1) symbols
    const midsRes = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'allMids'
      })
    });
    if (!midsRes.ok) throw new Error('Failed to fetch mids');
    const mids = await midsRes.json();
    const symbols = Object.keys(mids).filter((s)=>/^[a-zA-Z0-9]+$/.test(s)).slice(0, limit);
    // 2) candles
    const candlesBySymbol = await fetchCandles(symbols, interval, n);
    // 3) indicators + last-only candle rows
    const indicatorsRows = [];
    const candlesRows = [];
    for (const symbol of symbols){
      const candles = candlesBySymbol[symbol];
      if (!Array.isArray(candles) || candles.length === 0) continue;
      const norm = candles.map((c)=>({
          o: Number(c.o),
          h: Number(c.h),
          l: Number(c.l),
          c: Number(c.c),
          v: Number(c.v),
          ts: Number(c.t)
        }));
      const indicators = computeIndicators(norm);
      indicatorsRows.push({
        symbol,
        ema50: Number(indicators.ema50),
        ema200: indicators.ema200 !== null ? Number(indicators.ema200) : null,
        rsi14: Number(indicators.rsi14),
        macd: Number(indicators.macd),
        macdSignal: Number(indicators.macdSignal),
        score: Number(indicators.score),
        label: indicators.label,
        lastTs: indicators.lastTs != null ? toDbTime(indicators.lastTs, INDICATORS_TIME_TYPE) : null
      });
      const last = norm[norm.length - 1];
      candlesRows.push({
        symbol,
        interval,
        start: toDbTime(last.ts, CANDLES_TIME_TYPE),
        end: toDbTime(last.ts + intervalToMs(interval), CANDLES_TIME_TYPE),
        open: last.o,
        close: last.c,
        high: last.h,
        low: last.l,
        volume: last.v
      });
    }
    async function insertChunks(tableName, rows, onConflict, chunkSize = 500) {
      if (!rows?.length) return {
        written: 0,
        errors: []
      };
      let written = 0;
      const errors = [];
      for(let i = 0; i < rows.length; i += chunkSize){
        const chunk = rows.slice(i, i + chunkSize);
        const { data, error } = await supabase.from(tableName).upsert(chunk, {
          onConflict
        }).select('*');
        if (error) {
          errors.push({
            table: tableName,
            op: 'upsert',
            code: error.code,
            message: error.message
          });
          continue;
        }
        written += Array.isArray(data) ? data.length : 0;
      }
      return {
        written,
        errors
      };
    }
    const { written: candlesWritten, errors: candleErrors } = await insertChunks(CANDLES_TABLE, candlesRows, 'symbol');
    const { written: indicatorsWritten, errors: indicatorErrors } = await insertChunks(INDICATORS_TABLE, indicatorsRows, 'symbol');
    const body = {
      ok: true,
      symbols,
      candlesPrepared: candlesRows.length,
      indicatorsPrepared: indicatorsRows.length,
      candlesWritten,
      indicatorsWritten,
      debug: {
        tables: {
          candles: CANDLES_TABLE,
          indicators: INDICATORS_TABLE
        },
        timeType: {
          candles: CANDLES_TIME_TYPE,
          indicators: INDICATORS_TIME_TYPE
        },
        strategy: 'last-only-per-symbol'
      },
      errors: {
        candles: candleErrors,
        indicators: indicatorErrors
      }
    };
    return new Response(JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: String(e?.message || e)
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});
