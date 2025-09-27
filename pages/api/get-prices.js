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
        .slice(1, 2);
      const candleResults = {};

      // Calculate time range for last 50 candles (4h interval)
      const intervalMs = 4 * 60 * 60 * 1000; // 4 hours in ms
      const now = Date.now();
      const endTime = now;
      const startTime = endTime - intervalMs * 50;  


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
          // Post each candle to Airtable (in batches of 10, as per Airtable API limits)
          if (Array.isArray(candleData) && candleData.length > 0) {
            for (let i = 0; i < candleData.length; i += 10) {
              const batch = candleData.slice(i, i + 10).map((candle) => ({
                fields: {
                  symbol,
                  interval: candle.i,
                  start: Number(candle.t),
                  end: Number(candle.T),
                  open: Number(candle.o),
                  close: Number(candle.c),
                  high: Number(candle.h),
                  low: Number(candle.l),
                  volume: Number(candle.v),
                  trades: Number(candle.n)
                }
              }));
              const airtableRes = await fetch(airtableUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ records: batch })
              });
              if (!airtableRes.ok) {
                const errorText = await airtableRes.text();
                console.error('Airtable error:', errorText);
                throw new Error(`Airtable API error: ${airtableRes.status} ${airtableRes.statusText} - ${errorText}`);
              }
            }
          }
        } else {
          candleResults[symbol] = { error: 'Failed to fetch candleSnapshot' };
          console.log(candleRes);
        }
      }

      res.status(200).json({ prices: data, candleSnapshot: candleResults });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
