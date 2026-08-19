# TCG Price Sync Service

An automated service that keeps the [Quick Search Games](https://quicksearchgames.com) Shopify storefront's product prices continuously aligned with real-time trading-card market data from the JustTCG API.

## Why it exists

Quick Search Games is a Pokémon TCG business with a large, constantly changing inventory. Card prices move daily with the market, and updating them by hand across a growing catalog was slow, tedious, and always out of date. This service replaces that manual repricing workflow entirely! It runs on a schedule, pulls current market prices, and writes them back to the storefront automatically, so pricing stays current without anyone touching a spreadsheet.

## Tech stack

- **Runtime:** Node.js
- **APIs:** Shopify Admin GraphQL API, JustTCG API (via justtcg-js SDK)
- **Scheduling:** node-cron
- **Deployment:** Railway (continuous deployment on push)

## How it works

The service runs as a three-phase batch pipeline:

1. **Collect** — Retrieves every product variant from the Shopify store using the Admin GraphQL API, paging through the full catalog via cursor-based pagination.
2. **Price** — Matches those variants against current market data from the JustTCG API, fetched in batches of up to 100 cards per request.
3. **Update** — Writes the new prices back to Shopify through the `productVariantsBulkUpdate` GraphQL mutation.

A `node-cron` schedule triggers the full pipeline every 6 hours.

### Design note: batching

An earlier version made one JustTCG API call per card. As the catalog grew, that approach was slow and pushed against the API's rate limits. Refactoring the per-card requests into batched POST calls of up to 100 cards reduced JustTCG API usage by roughly 99%, keeping the service comfortably within rate limits as the inventory scales.

## Project structure

```
src/            # Pipeline entry point for Shopify/JustTCG clients
.env.example    # Template for required environment variables
package.json    # Dependencies and scripts
```

## Running locally

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/JesPressPlay/quicksearch-price-sync.git
   cd quicksearch-price-sync
   npm install
   ```
2. Copy the environment template and fill in your credentials:
   ```bash
   cp .env.example .env
   ```
   Required variables:
   - `SHOPIFY_SHOP` - Shopify store domain (e.g. your-store.myshopify.com)
   - `SHOPIFY_CLIENT_ID` — Shopify app client ID
   - `SHOPIFY_CLIENT_SECRET` — Shopify app client secret
   - `JUSTTCG_API_KEY` — JustTCG API key
3. Run the service:
   ```bash
   npm start
   ```

## Deployment

Deployed on Railway with continuous deployment — every push to `main` triggers a new deploy. The `node-cron` schedule runs the sync automatically in the deployed environment.

## Status

Live and in production, actively keeping the Quick Search Games storefront priced against current market data.
