// pages/api/get-prices.js

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      // Replace with the actual Hyperliquid API endpoint for prices
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' })
      });
      if (!response.ok) {
        throw new Error('Failed to fetch prices from Hyperliquid');
      }
      const data = await response.json();
      res.status(200).json({ prices: data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
