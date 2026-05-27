import 'dotenv/config';
import { JustTCG } from 'justtcg-js';
import { URLSearchParams } from 'node:url';

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

// Get all Shopify Variants
async function getShopifyVariants() {
      const query = `
    {
      productVariants(first: 250) {
        edges {
          node {
            id
            price
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
      }
    }
  `;
  const data = await graphql(query);
  return data.productVariants.edges;
}

// Function that calls JustTCG with tcgplayer_id and finds the matching variant by
// comparing 'printing' and 'condition' and returns the matched price
async function getJustTCGPrice(tcgplayerid, printing, condition) {
    try {
        const client = new JustTCG({ apiKey: process.env.JUSTTCG_API_KEY });
        const { data } = await client.v1.cards.get({ tcgplayerId: tcgplayerid });

        const match = data[0].variants.find(
            (variant) => variant.printing === printing && variant.condition === condition
        );

        if (!match) {
            console.log(`No matching variant found for tcgplayerId: ${tcgplayerid}, printing: ${printing}, condition: ${condition}`);
            return null;
        }

        return match.price;

    } catch (error) {
        console.error(`JustTCG API error for tcgplayerId ${tcgplayerid}:`, error);
        return null;
    }
}

// Writes data back to Shopify and updates prices
async function updateShopifyPrice(variantId, price) {
    try {
        const variables = {
            input: {
                id: variantId,
                price: String(price)
            }
        };
        const mutation = `
        mutation updatePrice($input: ProductVariantInput!) {
            productVariantUpdate(input: $input) {
                productVariant {
                    id
                    price
                }
            }
        }
        `

        await graphql(mutation, variables);

        console.log(`Successfully updated variant ${variantId} to $${price}`);

    } catch (error) {
        console.error(`Error in updating variant ${variantId} to $${price}`);
        return null;
    }
}

// Delay between each JustTCG call
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function that orchestrates each part of the syncing steps that are written above
async function main() {
    const variants = await getShopifyVariants();

    for (const edge of variants) {
        const variant = edge.node;

        // Skip variants with no TCGPlayerID set
        if (variant.metafields.edges.length === 0) continue;

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

        await sleep(500);
        
        // Update the price if we got one back and it's different from current
        if (newPrice && newPrice !== parseFloat(variant.price)) {
            await updateShopifyPrice(variant.id, newPrice);
        }
    }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});