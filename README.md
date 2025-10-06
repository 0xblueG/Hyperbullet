This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## API: /api/get-prices-supabase

Fetches candles and indicators from Hyperliquid and writes into Supabase.

- Candles strategy: last-only per symbol (one row per asset), upsert on `symbol`.
- Indicators: computed on the full fetched window (default 50 candles at 4h) and upsert on `symbol`.

### Request

- Method: GET
- URL: `http://localhost:3000/api/get-prices-supabase` (or port chosen by Next.js, e.g. 3001)
- Query params (optional, not yet configurable via URL):
	- interval: fixed to `4h` in code
	- n: fixed to `50` in code

### Response (example)

```json
{
	"ok": true,
	"symbols": ["0G", "2Z", ...],
	"candlesPrepared": 9,
	"indicatorsPrepared": 9,
	"candlesWritten": 9,
	"indicatorsWritten": 9,
	"debug": {
		"candlesTable": "candles",
		"indicatorsTable": "indicators",
		"conflictKeys": { "candles": "symbol", "indicators": "symbol" },
		"timeType": { "candles": "timestamp", "indicators": "timestamp" },
		"strategy": "last-only-per-symbol"
	},
	"errors": { "candles": [], "indicators": [] },
	"fallbacks": { "candles": [], "indicators": [] }
}
```

Notes:
- `candlesPrepared`/`indicatorsPrepared` comptent les lignes prêtes à l’écriture.
- `candlesWritten`/`indicatorsWritten` sont le nombre réel inséré/upserté.
- Si un symbole n’a pas d’historique disponible sur la fenêtre demandée, il est ignoré.

### Environment variables

Add these to `.env.local`:

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_SCHEMA=public
SUPABASE_CANDLES_TABLE=candles
SUPABASE_INDICATORS_TABLE=indicators
SUPABASE_CANDLES_TIME_TYPE=timestamp   # or ms/s depending on your column types
# Optional, if indicators time type differs
# SUPABASE_INDICATORS_TIME_TYPE=timestamp
```

Important: `.env.local` must not be committed. The service role key is sensitive.

### Supabase schema

This route assumes one latest row per symbol in `candles` and upserts on `symbol`:

```
-- Example (timestamps variant)
CREATE TABLE IF NOT EXISTS public.candles (
	symbol text PRIMARY KEY,
	interval text NOT NULL,
	start timestamptz NOT NULL,
	end timestamptz NOT NULL,
	open double precision NOT NULL,
	high double precision NOT NULL,
	low double precision NOT NULL,
	close double precision NOT NULL,
	volume double precision NOT NULL
);

CREATE TABLE IF NOT EXISTS public.indicators (
	symbol text PRIMARY KEY,
	lastTs timestamptz NOT NULL,
	ema50 double precision,
	ema200 double precision,
	rsi14 double precision,
	macd double precision,
	macdSignal double precision,
	score double precision,
	label text
);
```

If you later want full historical candles per symbol, add a composite unique key and adjust the route to upsert on it:

```
ALTER TABLE public.candles DROP CONSTRAINT IF EXISTS candles_pkey;
ALTER TABLE public.candles ADD CONSTRAINT candles_pkey PRIMARY KEY (symbol, start, interval);
-- or keep another PK and add UNIQUE(symbol, start, interval)

ALTER TABLE public.indicators DROP CONSTRAINT IF EXISTS indicators_pkey;
ALTER TABLE public.indicators ADD CONSTRAINT indicators_symbol_lastTs_uniq UNIQUE (symbol, lastTs);
```

### Quick test

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/get-prices-supabase -Method GET | ConvertTo-Json -Depth 7
```

If Next.js picked another port (e.g., 3001), replace it in the URL above.

## Supabase Edge Function: ingest-hyperliquid

Run the ingestion inside Supabase (Deno Edge) without running locally.

### Files

- `supabase/functions/ingest-hyperliquid/index.ts` (this repo)

### Deploy (PowerShell)

```powershell
# Install CLI if needed (optional)
# iwr https://supabase.com/cli/install/windows | iex

supabase login
supabase link --project-ref <your-project-ref>

# Set secrets (never commit these)
supabase secrets set SUPABASE_URL="https://<ref>.supabase.co"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
supabase secrets set SUPABASE_SCHEMA="public"
supabase secrets set SUPABASE_CANDLES_TABLE="candles"
supabase secrets set SUPABASE_INDICATORS_TABLE="indicators"
supabase secrets set SUPABASE_CANDLES_TIME_TYPE="timestamp"

# Optional
# supabase secrets set SUPABASE_INDICATORS_TIME_TYPE="timestamp"

# Deploy. Use --no-verify-jwt to make it callable without a JWT (or configure auth as needed)
supabase functions deploy ingest-hyperliquid --no-verify-jwt

# Invoke on-demand
supabase functions invoke ingest-hyperliquid --no-verify-jwt

# Or call via HTTPS endpoint shown by the CLI (GET supports ?interval=4h&n=50&limit=100)
```

### Notes

- Candles are upserted on `symbol` only (last-only strategy).
- Indicators are computed on the fetched window (default `n=50`, `interval=4h`).
- You can pass query params to the function: `interval`, `n`, `limit`.
- To store full history later, add a composite unique constraint and adjust onConflict keys.
