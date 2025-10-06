// pages/api/get-prices-supabase.js
import { createClient } from '@supabase/supabase-js';
import { computeIndicators } from '../../lib/indicators.js';

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const schema = process.env.SUPABASE_SCHEMA || 'public';
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  // Set DB schema on client; .from() should receive a plain table name string
  return createClient(url, key, { auth: { persistSession: false }, db: { schema } });
}

function normalizeTableName(name, fallback) {
  const raw = String(name || fallback || '').trim();
  // remove surrounding quotes and optional leading 'public.'
  return raw.replace(/^['"]|['"]$/g, '').replace(/^public\./i, '');
}

// Convert epoch ms into the DB time type configured for candles
function toDbTime(ms) {
  const mode = String(process.env.SUPABASE_CANDLES_TIME_TYPE || 'timestamp').toLowerCase();
  if (mode === 'ms' || mode === 'epoch_ms' || mode === 'bigint') return Number(ms);
  if (mode === 's' || mode === 'sec' || mode === 'seconds' || mode === 'epoch_s') return Math.floor(Number(ms) / 1000);
  // default: ISO string for timestamp/timestamptz columns
  return new Date(Number(ms)).toISOString();
}

// Convert epoch ms for indicators timestamp, allowing separate env override
function toDbTimeIndicators(ms) {
  const fallback = process.env.SUPABASE_CANDLES_TIME_TYPE || 'timestamp';
  const mode = String(process.env.SUPABASE_INDICATORS_TIME_TYPE || fallback).toLowerCase();
  if (mode === 'ms' || mode === 'epoch_ms' || mode === 'bigint') return Number(ms);
  if (mode === 's' || mode === 'sec' || mode === 'seconds' || mode === 'epoch_s') return Math.floor(Number(ms) / 1000);
  return new Date(Number(ms)).toISOString();
}

async function fetchCandles(symbols, interval = '4h', n = 50) {
  const intervalMs = 4 * 60 * 60 * 1000; // 4h in ms
  const endTime = Date.now();
  const startTime = endTime - intervalMs * n;
  const results = {};
  for (const symbol of symbols) {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: symbol, interval, startTime, endTime } })
    });
    if (!res.ok) {
      results[symbol] = { error: `Failed to fetch candles (${res.status})` };
      continue;
    }
    const data = await res.json();
    results[symbol] = Array.isArray(data) ? data : [];
  }
  return results;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    // 1) Get first 10 valid symbols from Hyperliquid mids
    const midsRes = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    });
    if (!midsRes.ok) throw new Error('Failed to fetch mids');
    const mids = await midsRes.json();
    const symbols = Object.keys(mids).filter((s) => /^[a-zA-Z0-9]+$/.test(s)).slice(0, 100);

    // 2) Fetch candles
    const candlesBySymbol = await fetchCandles(symbols, '4h', 200);

    // 3) Compute indicators and prepare rows (last-only per symbol)
    const indicatorsRows = [];
    const candlesRows = [];
    for (const symbol of symbols) {
      const candles = candlesBySymbol[symbol];
      if (!Array.isArray(candles) || candles.length === 0) continue;
      const norm = candles.map((c) => ({
        o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v), ts: Number(c.t)
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
        lastTs: indicators.lastTs != null ? toDbTimeIndicators(indicators.lastTs) : null
      });

      // Only keep the last candle per symbol
      const last = norm[norm.length - 1];
      candlesRows.push({
        symbol,
        interval: '4h',
        start: toDbTime(last.ts),
        end: toDbTime(last.ts + 4 * 60 * 60 * 1000),
        open: last.o,
        close: last.c,
        high: last.h,
        low: last.l,
        volume: last.v
      });
    }

    // 4) Insert into Supabase
  const supabase = getSupabaseClient();
  const candlesTable = normalizeTableName(process.env.SUPABASE_CANDLES_TABLE, 'candles');
  const indicatorsTable = normalizeTableName(process.env.SUPABASE_INDICATORS_TABLE, 'indicators');
  const debug = {
    candlesTable,
    indicatorsTable,
    conflictKeys: {
      candles: String(process.env.SUPABASE_ONCONFLICT_CANDLES || process.env.SUPABASE_ONCONFLICT || 'symbol,start,interval'),
      indicators: String(process.env.SUPABASE_ONCONFLICT_INDICATORS || process.env.SUPABASE_ONCONFLICT || 'symbol,lastTs')
    },
    timeType: {
      candles: String(process.env.SUPABASE_CANDLES_TIME_TYPE || 'timestamp'),
      indicators: String(process.env.SUPABASE_INDICATORS_TIME_TYPE || process.env.SUPABASE_CANDLES_TIME_TYPE || 'timestamp')
    }
  };
  console.log('Supabase tables -> candles:', candlesTable, 'indicators:', indicatorsTable);

    // Batch inserts in chunks to avoid payload limits
    // Try to upsert rows to avoid unique constraint errors.
  // Always upsert on symbol for last-only strategy
  const onConflictKeyCandles = 'symbol';
  const onConflictKeyIndicators = String(process.env.SUPABASE_ONCONFLICT_INDICATORS || process.env.SUPABASE_ONCONFLICT || 'symbol');
    async function insertChunks(tableName, rows, chunkSize = 500) {
      if (!rows?.length) return { written: 0, errors: [] };
      if (typeof tableName !== 'string') throw new Error(`Invalid table name: ${String(tableName)}`);
      let written = 0;
      const errors = [];
      const fallbacks = [];
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        // Use upsert with appropriate conflict keys, log errors and continue per chunk
        try {
          const onConflict = tableName === candlesTable ? onConflictKeyCandles : onConflictKeyIndicators;
          const { data, error: upsertError } = await supabase
            .from(tableName)
            .upsert(chunk, { onConflict })
            .select('*');
          if (upsertError) {
            console.warn(`Upsert error on ${tableName}:`, upsertError.message);
            errors.push({ table: tableName, op: 'upsert', message: upsertError.message, details: upsertError.details || null, hint: upsertError.hint || null, code: upsertError.code || null });
            // Try a plain insert fallback
            const { data: dataIns, error: insertError } = await supabase.from(tableName).insert(chunk).select('*');
            if (insertError) {
              console.warn(`Insert fallback error on ${tableName}:`, insertError.message);
              errors.push({ table: tableName, op: 'insert', message: insertError.message, details: insertError.details || null, hint: insertError.hint || null, code: insertError.code || null });
              // If candles table appears to have PK(symbol), perform a last-per-symbol fallback upsert on 'symbol'
              const isNoConstraint = upsertError?.code === '42P10';
              const isDupSymbol = insertError?.code === '23505' && /\(symbol\)=/.test(String(insertError?.details || ''));
              if (tableName === candlesTable && isNoConstraint && isDupSymbol) {
                // Build last candle per symbol within this chunk
                const lastBySymbol = new Map();
                for (const row of chunk) {
                  const key = row.symbol;
                  const prev = lastBySymbol.get(key);
                  const toMillis = (v) => typeof v === 'number' ? v : Date.parse(v);
                  if (!prev || toMillis(row.start) > toMillis(prev.start)) {
                    lastBySymbol.set(key, row);
                  }
                }
                const condensed = Array.from(lastBySymbol.values());
                try {
                  const { data: fbData, error: fbErr } = await supabase
                    .from(tableName)
                    .upsert(condensed, { onConflict: 'symbol' })
                    .select('*');
                  if (fbErr) {
                    console.warn(`Secondary fallback upsert(symbol) failed on ${tableName}:`, fbErr.message);
                    errors.push({ table: tableName, op: 'upsert(symbol)-fallback', message: fbErr.message, code: fbErr.code || null });
                  } else {
                    fallbacks.push({ table: tableName, strategy: 'latest-per-symbol' });
                    written += Array.isArray(fbData) ? fbData.length : 0;
                  }
                } catch (e2) {
                  errors.push({ table: tableName, op: 'upsert(symbol)-fatal', message: String(e2?.message || e2) });
                }
              }
              // For indicators, if constraint mismatch, upsert on symbol only
              if (tableName === indicatorsTable && upsertError?.code === '42P10') {
                try {
                  const { data: fbData2, error: fbErr2 } = await supabase
                    .from(tableName)
                    .upsert(chunk, { onConflict: 'symbol' })
                    .select('*');
                  if (fbErr2) {
                    console.warn(`Indicators fallback upsert(symbol) failed:`, fbErr2.message);
                    errors.push({ table: tableName, op: 'upsert(symbol)-fallback', message: fbErr2.message, code: fbErr2.code || null });
                  } else {
                    fallbacks.push({ table: tableName, strategy: 'upsert-on-symbol' });
                    written += Array.isArray(fbData2) ? fbData2.length : 0;
                  }
                } catch (e3) {
                  errors.push({ table: tableName, op: 'upsert(symbol)-fatal', message: String(e3?.message || e3) });
                }
              }
              continue;
            }
            written += Array.isArray(dataIns) ? dataIns.length : 0;
          } else {
            written += Array.isArray(data) ? data.length : 0;
          }
        } catch (e) {
          const msg = String(e?.message || e);
          console.error(`InsertChunks fatal error on ${tableName}:`, msg);
          errors.push({ table: tableName, op: 'fatal', message: msg });
          // don't throw to avoid killing the whole process; continue
          continue;
        }
      }
      return { written, errors, fallbacks };
    }

  const { written: candlesWritten, errors: candleErrors, fallbacks: candleFallbacks } = await insertChunks(candlesTable, candlesRows);
    const { written: indicatorsWritten, errors: indicatorErrors, fallbacks: indicatorFallbacks } = await insertChunks(indicatorsTable, indicatorsRows);

  res.status(200).json({ ok: true, symbols, candlesPrepared: candlesRows.length, indicatorsPrepared: indicatorsRows.length, candlesWritten, indicatorsWritten, debug: { ...debug, strategy: 'last-only-per-symbol' }, errors: { candles: candleErrors, indicators: indicatorErrors }, fallbacks: { candles: candleFallbacks, indicators: indicatorFallbacks } });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
