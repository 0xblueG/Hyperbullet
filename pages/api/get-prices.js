import { computeIndicators } from '../../lib/indicators.js';
// pages/api/get-prices.js

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      // Fetch prices from Hyperliquid
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' })
      });
      if (!response.ok) {
        throw new Error('Failed to fetch prices from Hyperliquid');
      }
      const data = await response.json();

      // Write to Airtable
      const apiKey = process.env.AIRTABLE_API_KEY;
      const baseId = process.env.AIRTABLE_BASE_ID;
      const tableName = process.env.AIRTABLE_TABLE_NAME;
      if (!apiKey || !baseId || !tableName) {
        throw new Error('Airtable environment variables are not set');
      }


      // Prepare Airtable API request for candles only
      const airtableUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;

      // Fetch candleSnapshot for the first 10 valid asset symbols in a 4-hour timeframe for the last 50 candles
      const assetSymbols = Object.keys(data)
        .filter((symbol) => /^[a-zA-Z0-9]+$/.test(symbol))
        .slice(1, 200);
      const candleResults = {};

      // Calculate time range for last 50 candles (4h interval)
      const intervalMs = 4 * 60 * 60 * 1000; // 4 hours in ms
      const now = Date.now();
      const endTime = now;
      const startTime = endTime - intervalMs * 300;  


      const indicatorsBySymbol = {};
      for (const symbol of assetSymbols) {
        const candleRes = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'candleSnapshot',
            req: {
              coin: symbol,
              interval: '4h',
              startTime,
              endTime
            }
          })
        });
        if (candleRes.ok) {
          const candleData = await candleRes.json();
          candleResults[symbol] = candleData;
          // Compute indicators for each symbol
          if (Array.isArray(candleData) && candleData.length > 0) {
            try {
              const indicators = computeIndicators(
                candleData.map(c => ({
                  o: Number(c.o),
                  h: Number(c.h),
                  l: Number(c.l),
                  c: Number(c.c),
                  v: Number(c.v),
                  ts: Number(c.t)
                }))
              );
              indicatorsBySymbol[symbol] = indicators;

              // Push indicators to Airtable
              const apiKey = process.env.AIRTABLE_API_KEY;
              const baseId = process.env.AIRTABLE_BASE_ID;
              const tableName = process.env.AIRTABLE_TABLE_NAME;
              if (apiKey && baseId && tableName) {
                await fetch(`https://api.airtable.com/v0/${baseId}/${tableName}`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    records: [{
                      fields: {
                        symbol,
                        ema50: Number(indicators.ema50),
                        ema200: indicators.ema200 !== null ? Number(indicators.ema200) : null,
                        rsi14: Number(indicators.rsi14),
                        macd: Number(indicators.macd),
                        macdSignal: Number(indicators.macdSignal),
                        score: Number(indicators.score),
                        label: indicators.label,
                        lastTs: Number(indicators.lastTs)
                      }
                    }]
                  })
                });
              }
            } catch (err) {
              indicatorsBySymbol[symbol] = { error: err.message };
            }
          }
        } else {
          candleResults[symbol] = { error: 'Failed to fetch candleSnapshot' };
          indicatorsBySymbol[symbol] = { error: 'Failed to fetch candleSnapshot' };
          console.log(candleRes);
        }
      }

  res.status(200).json({ prices: data, candleSnapshot: candleResults, indicators: indicatorsBySymbol });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
