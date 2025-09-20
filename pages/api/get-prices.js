// pages/api/get-prices.js

export default function handler(req, res) {
  if (req.method === 'GET') {
    // Example response data
    const prices = [
      { id: 1, name: 'Product A', price: 10.99 },
      { id: 2, name: 'Product B', price: 19.99 },
      { id: 3, name: 'Product C', price: 5.49 }
    ];
    res.status(200).json({ prices });
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
