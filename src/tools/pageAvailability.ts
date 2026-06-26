// Generic, standards-first availability signal for a fetched web page.
//
// This is page METADATA extraction (like title/links), not domain routing: it answers
// "does this page indicate the item is purchasable right now?" using web standards
// (schema.org Offer.availability), structural buy-control state (a disabled add-to-cart/
// add-to-bag control), and a small cross-domain vocabulary of stock-status phrases. It is
// the same kind of generic status classification the read layer already does for "blocked"
// (captcha/cloudflare/403) in readStatusFromToolResult — not a product/brand keyword list.
//
// It runs over the RAW html (web.read strips <script> before text extraction, which would
// otherwise drop the schema.org JSON-LD), so the strongest machine-readable signal survives.

export type PageAvailabilityStatus = "in_stock" | "out_of_stock" | "unknown";

export type PageAvailability = {
  status: PageAvailabilityStatus;
  signals: string[];
};

// schema.org Offer.availability values that mean "cannot buy right now".
const SCHEMA_OUT = /schema\.org\/(OutOfStock|SoldOut|Discontinued|BackOrder)\b|"availability"\s*:\s*"[^"]*\b(OutOfStock|SoldOut|Discontinued|BackOrder)\b/i;
const SCHEMA_IN = /schema\.org\/(InStock|InStoreOnly|OnlineOnly|LimitedAvailability|PreOrder|PreSale)\b|"availability"\s*:\s*"[^"]*\b(InStock|InStoreOnly|OnlineOnly|LimitedAvailability|PreOrder|PreSale)\b/i;

// A buy control rendered in a disabled state (both attribute orders) — strong "cannot buy".
const DISABLED_BUY_CONTROL =
  /disabled[^>]{0,60}(add[-_ ]?to[-_ ]?(cart|bag)|addtocart|addtobag|buy[-_ ]?now|buynow)|(add[-_ ]?to[-_ ]?(cart|bag)|addtocart|addtobag|buy[-_ ]?now|buynow)[^>]{0,120}\bdisabled\b/i;

// Cross-domain stock-status phrases (EN + RU). Visible body text survives html->text, so
// these catch pages that carry no schema.org markup.
const OUT_PHRASES = [
  "out of stock",
  "out-of-stock",
  "sold out",
  "no longer available",
  "currently unavailable",
  "temporarily unavailable",
  "not available for purchase",
  "this item is unavailable",
  "нет в наличии",
  "нет на складе",
  "снят с продажи",
  "снято с продажи",
  "распродан",
  "товара нет",
  "товар закончился",
  "недоступен для заказа",
  "нет в продаже",
];

const IN_PHRASES = [
  "add to cart",
  "add to bag",
  "in stock",
  "buy now",
  "в наличии",
  "купить",
  "добавить в корзину",
  "оформить заказ",
];

const PRICE = /(?:[$£€₽]|usd|eur|gbp|руб|\bр\.)\s?\d|\d[\d.,\s]{2,}\s?(?:[$£€₽]|usd|eur|gbp|руб|грн)/i;

export function extractPageAvailability(html: string, contentType = ""): PageAvailability {
  if (!html || (contentType && !/html|xml|text\/plain|json/i.test(contentType))) {
    return { status: "unknown", signals: [] };
  }
  const signals: string[] = [];
  const lower = html.toLowerCase();

  // 1) Machine-readable schema.org availability is the most authoritative.
  const schemaOut = SCHEMA_OUT.test(html);
  const schemaIn = SCHEMA_IN.test(html);
  if (schemaOut) signals.push("schema.org: OutOfStock/SoldOut/Discontinued");
  if (schemaIn) signals.push("schema.org: InStock/PreOrder");

  // 2) A disabled buy control is a strong structural "cannot buy".
  const disabledBuy = DISABLED_BUY_CONTROL.test(html);
  if (disabledBuy) signals.push("buy control is disabled");

  // 3) Visible stock-status phrases.
  const outPhrase = OUT_PHRASES.find((p) => lower.includes(p));
  if (outPhrase) signals.push(`phrase: "${outPhrase}"`);
  const inPhrase = IN_PHRASES.find((p) => lower.includes(p));
  const hasPrice = PRICE.test(html);

  // Resolve. Negative signals win over positive ones: if a page shows out-of-stock markup
  // or a disabled buy button, it is not safely presentable as buyable even if an "add to
  // cart" label is still rendered in the DOM.
  if (schemaOut || disabledBuy || (outPhrase && !schemaIn)) {
    return { status: "out_of_stock", signals };
  }
  if (schemaIn || (inPhrase && hasPrice)) {
    if (inPhrase) signals.push(`phrase: "${inPhrase}"`);
    if (hasPrice) signals.push("price present");
    return { status: "in_stock", signals };
  }
  return { status: "unknown", signals };
}
