import 'dotenv/config';
import { JustTCG } from 'justtcg-js';
import { URLSearchParams } from 'node:url';
import cron from 'node-cron';
import { connect } from 'node:http2';

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    'Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET.'
  );
}

let token = null;
let tokenExpiresAt = 0;

// Requests a Shopify access token using Client ID and Secret.
// Caches the token and automatically refreshes it before it expires (tokens last 24 hrs)
async function getToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;

  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);

  const { access_token, expires_in } = await response.json();
  token = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  return token;
}

// Reusable helper function that sends GraphQL queries and mutations to Shopify's Admin API.
// Automatically attaches the access token to every request.
// Also accepts an optional variables object for parameterized queries.
async function graphql(query, variables = {}) {
  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/api/2025-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await getToken(),
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status}`);
  }

  const { data, errors } = await response.json();
  if (errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  }
  return data;
}

// Beginning of functions that will handle the syncing logic between JustTCG and Shopify

// Fetches all product variants from Shopify via GraphQL.
// Returns an array of variant edges containing id, price, inventory,
// selectedOptions, product id, and metafields.
async function getShopifyVariants() {
  const query = `
    query getVariants($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        edges {
          node {
            id
            inventoryQuantity
            price
            product {
              id
            }
            selectedOptions {
              name
              value
            }
            metafields(first: 10) {
              edges {
                node {
                  key
                  value
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }  
      }
    }
  `;

  let allEdges = []; // Accumulates all of the page results into an empty array
  let cursor = null; // Starts empty, page 1 starts from the beginning
  let hasNextPage = true; // Purely just gets us into the loop the first time, the primer.

  // Next, the loop keeps going as long as Shopify says there's more to fetch.
  // Loop will stop once we've looked through every page.
  while (hasNextPage) {
    const data = await graphql(query, { cursor });
    const connection = data.productVariants;

    allEdges = allEdges.concat(connection.edges);
    // Merging two arrays into one. Glues every fetch of 250 together into the running total.

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;

  }
  
  console.log(`Fetched ${allEdges.length} variants`);
  // Using this log to confirm pagination pulled the full variant count, not just the 250 cap.
  return allEdges;
}

// Function that calls JustTCG with tcgplayer_id and finds the matching variant by
// comparing 'printing' and 'condition' and returns the matched price
async function getJustTCGPrice(tcgplayerid, printing, condition) {
    try {
        const client = new JustTCG({ apiKey: process.env.JUSTTCG_API_KEY });
        const { data } = await client.v1.cards.get({ tcgplayerId: tcgplayerid });

        const match = data[0].variants.find(
            (variant) => variant.printing.trim() === printing.trim() && variant.condition.trim() === condition.trim()
        );
        

        if (!match) {
            console.log(`No matching variant found for tcgplayerId: ${tcgplayerid}, printing: ${printing}, condition: ${condition}. Available variants:`, JSON.stringify(data[0].variants.map(v => ({ printing: v.printing, condition: v.condition }))));
            return null
        }

        return match.price;

    } catch (error) {
        console.error(`JustTCG API error for tcgplayerId ${tcgplayerid}:`, error);
        return null;
    }
}

// Writes data back to Shopify and updates prices
async function updateShopifyPrice(productId, variantId, price) {
    try {
        const mutation = `
            mutation updatePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                    productVariants {
                        id
                        price
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;

        const variables = {
            productId: productId,
            variants: [{ id: variantId, price: String(price) }]
        };

        await graphql(mutation, variables);
        console.log(`Successfully updated variant ${variantId} to $${price}`);

    } catch (error) {
        console.error(`Error updating variant ${variantId}:`, error);
        return null;
    }
}

// Setting a delay between each JustTCG call, as to not hit rate limits
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function that orchestrates each part of the syncing steps that are written above. The meat and potatoes.
async function main() {
    const variants = await getShopifyVariants();

    for (const edge of variants) {
        const variant = edge.node;

        // Skip variants with no TCGPlayerID set
        if (variant.metafields.edges.length === 0) continue;

        // Skip variants with an inventory number of 0
        if (variant.inventoryQuantity === 0) continue;

        // Grab the TCGPlayerId from the metafield
        const tcgplayerId = variant.metafields.edges[0].node.value;

        // Grab printing and condition from selectedOptions
        const printing = variant.selectedOptions.find(
        (option) => option.name === "Card attributes"
        )?.value;

        const condition = variant.selectedOptions.find(
        (option) => option.name === "Condition"
        )?.value;

        const newPrice = await getJustTCGPrice(tcgplayerId, printing, condition);
        const productId = variant.product.id;

        // Once above info is gathered, wait 1 second between the next call
        await sleep(1000);

        // Update the price if we got one back and it's different from current
        if (newPrice && newPrice !== parseFloat(variant.price)) {
            await updateShopifyPrice(productId, variant.id, newPrice);
        }
    }
}

// Run immediately on startup
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// Then, schedule to run every 12 hours
cron.schedule('0 */12 * * *', () => {
    console.log('Running scheduled price sync...');
    main().catch((error) => {
        console.error(error);
    });
});