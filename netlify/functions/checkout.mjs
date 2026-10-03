// Creates a Square checkout page for the cart and returns its URL.
// Prices live here, not in the browser, so nobody can change what they pay.
//
// Settings (set in the host's environment variables, never in this file):
//   SQUARE_ACCESS_TOKEN  required. From developer.squareup.com > your app > Credentials.
//   SQUARE_SANDBOX       optional. Set to "true" to use Square's test sandbox instead of real cards.
//   SQUARE_LOCATION_ID   optional. Defaults to the first active location on the account.

const PRODUCTS = {
  char:  { name: 'Coastal Char (4 oz)', cents: 800 },
  roast: { name: 'Coastal Roast (4 oz)', cents: 800 },
  pack:  { name: 'Cookout pack (1 Char + 1 Roast)', cents: 1400 }
};
const FREE_SHIP_CENTS = 3000;
const SHIPPING_CENTS = 600;
const MAX_QTY = 50;
const SQUARE_VERSION = '2024-10-17';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function square(path, token, base, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json'
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data.errors || []).map(e => e.detail || e.code).join('; ');
    throw new Error('Square ' + res.status + (detail ? ': ' + detail : ''));
  }
  return data;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });

  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) return json(503, { error: 'Card checkout is not set up yet' });
  const base = process.env.SQUARE_SANDBOX === 'true'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

  let input;
  try { input = await req.json(); } catch { return json(400, { error: 'Bad request' }); }

  const items = input && typeof input.items === 'object' ? input.items : {};
  const lineItems = [];
  let subtotal = 0;
  for (const key of Object.keys(PRODUCTS)) {
    const qty = Math.floor(Number(items[key]) || 0);
    if (qty <= 0) continue;
    if (qty > MAX_QTY) return json(400, { error: 'That is a lot of jars. Email us for big orders.' });
    lineItems.push({
      name: PRODUCTS[key].name,
      quantity: String(qty),
      base_price_money: { amount: PRODUCTS[key].cents, currency: 'USD' }
    });
    subtotal += qty * PRODUCTS[key].cents;
  }
  if (!lineItems.length) return json(400, { error: 'Your cart is empty' });

  const pickup = input.delivery === 'pickup';
  const origin = new URL(req.url).origin;

  try {
    let locationId = process.env.SQUARE_LOCATION_ID;
    if (!locationId) {
      const { locations = [] } = await square('/v2/locations', token, base);
      const active = locations.find(l => l.status === 'ACTIVE') || locations[0];
      if (!active) throw new Error('No Square location found');
      locationId = active.id;
    }

    const checkoutOptions = {
      redirect_url: origin + '/?order=thanks',
      ask_for_shipping_address: !pickup,
      allow_tipping: false
    };
    if (!pickup && subtotal < FREE_SHIP_CENTS) {
      checkoutOptions.shipping_fee = { name: 'Shipping', charge: { amount: SHIPPING_CENTS, currency: 'USD' } };
    }

    const { payment_link } = await square('/v2/online-checkout/payment-links', token, base, {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: { location_id: locationId, line_items: lineItems },
        checkout_options: checkoutOptions,
        payment_note: pickup ? 'PICKUP in Orange County' : 'Ship to customer'
      })
    });
    return json(200, { url: payment_link.url });
  } catch (err) {
    console.error(err);
    return json(502, { error: 'Could not start checkout' });
  }
};

export const config = { path: '/api/checkout' };
