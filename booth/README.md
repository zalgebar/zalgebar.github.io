# Booth slide deck

Full-screen product slideshow at `zalgebar.com/booth`. Edit `products.json` to change what's shown.

```json
{
  "defaultSeconds": 8,
  "discount": {
    "sats": "10%"
  },
  "rounding": {
    "usd": { "direction": "up", "digits": 2 },
    "sats": { "direction": "up", "digits": 3 }
  },
  "products": [
    {
      "name": "Product name",
      "description": "Short description.",
      "image": "https://example.com/photo.jpg",
      "usd": 15,
      "seconds": 12
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `defaultSeconds` | no | How long each slide stays up. Default 8. |
| `discount.usd` / `discount.sats` | no | Discount on every product's dollar or sats price. See below. |
| `rounding.usd` / `rounding.sats` | no | How a calculated or discounted price is rounded. See below. |
| `name` | yes | Large title. |
| `description` | no | A line or two. Line breaks (`\n`) are kept. |
| `image` | no | URL of the photo, either full (`https://…`) or relative to this folder (`images/candle.jpg`). A placeholder is shown if it's missing or fails to load. |
| `usd` | one of these | Dollar price. The sats price is calculated from it. |
| `sats` | one of these | Bitcoin price in sats. The dollar price is calculated from it. |
| `seconds` | no | Overrides `defaultSeconds` for this product only. |
| `discount` / `rounding` | no | Same format as the catalog-wide blocks, for this product only. See [Per-product discount and rounding](#per-product-discount-and-rounding). |

If both `usd` and `sats` are set, neither is calculated from the other (a discount still applies).

## Discount

`discount.sats` lowers the sats price of every product; `discount.usd` lowers the dollar price. Use either or both.

- `"10%"`: percentage off.
- `5` (or `"5"`, `"1,000"`): fixed amount off, in that currency ($5 off, or 1,000 sats off).

The other currency is always calculated from the undiscounted price, so a sats discount doesn't lower the dollar price. The discount is applied before rounding. Nothing on the slides marks the price as discounted.

Example with 1 BTC = $77,000, `"sats": "10%"`, and sats rounding `down` to 2 digits: a $30 product is 38,961 sats, then 35,065 after the discount, then 35,000 after rounding.

## Rounding

`rounding.usd` applies when a dollar price is calculated from `sats` or discounted; `rounding.sats` applies when a sats price is calculated from `usd` or discounted. A price you entered with no discount on it is shown exactly as entered.

- `direction`: `"up"`, `"down"`, or `"nearest"`.
- `digits`: how many significant digits to keep (leave out to keep full precision: cents for dollars, whole sats).

| Calculated | `up`, 2 digits | `up`, 3 digits | `down`, 2 digits | `nearest`, 3 digits |
| --- | --- | --- | --- | --- |
| 19,469 sats | 20,000 | 19,500 | 19,000 | 19,500 |
| $16.18 | $17 | $16.20 | $16 | $16.20 |
| $123.45 | $130 | $124 | $120 | $123 |

Without a `rounding` block, dollars round to the nearest cent and sats to the nearest whole sat.

## Per-product discount and rounding

A product can have its own `discount` and `rounding`, written the same way as the top-level blocks. They work per currency: whatever the product sets for `usd` or `sats` replaces the catalog-wide setting for that product only, and anything it leaves out still follows the catalog. The top-level blocks are optional, so you can also set these only on individual products.

```json
{
  "name": "Dehydrated Sourdough Starter",
  "usd": 25,
  "discount": { "sats": 0 },
  "rounding": { "sats": { "direction": "nearest", "digits": 3 } }
}
```

- `"sats": false` (or `0`, `"0%"`, `null`) turns the catalog's sats discount off for this product.
- `"sats": "20%"` gives this product a bigger discount than the rest of the catalog.
- `"discount": false` turns off both the `usd` and `sats` discounts for this product.
- A product's `rounding.sats` replaces the whole catalog `rounding.sats` entry (both `direction` and `digits`).
- `"rounding": { "sats": false }` turns rounding off for sats (whole sats only); `"rounding": false` turns it off for both (cents and whole sats).

`false` works the same way in the top-level blocks, e.g. `"discount": false` or `"discount": { "usd": false }`. A price of `false` (`"usd": false`) is treated as not set.

The BTC/USD rate comes from mempool.space once per page load. Refresh the page to update it.

Controls: swipe or drag left/right, the arrow buttons, arrow keys, or trackpad swipe. Tap or click anywhere (or press Space) to pause or resume. The bar stops and turns gray while paused. Press `F` for full screen on a laptop. On an iPad, use Share > Add to Home Screen to open it without the browser bars.
