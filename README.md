## What does Skyscanner Hotels Scraper do?

Skyscanner Hotels Scraper collects hotel listings from a public Skyscanner hotel search and saves them as clean, structured dataset items. Each item represents one unique hotel, including the name, star rating, guest rating, image URLs, normalized prices, available partner offers, destination, and public hotel page.

Use it for hotel price research, destination comparisons, travel planning, accommodation directories, competitor monitoring, and scheduled market snapshots. Empty values are removed before saving, so unavailable fields are omitted instead of being stored as nulls.

## Features

- Search from one Skyscanner URL or a destination.
- Accept a full search URL, a numeric destination ID, a Skyscanner destination URL, or a location name.
- Keep URL input as the priority when both URL and location are supplied.
- Set check-in, check-out, travellers, children ages, rooms, market, locale, and currency.
- Sort by best match, price, guest rating, stars, or distance.
- Control the total number of listings and the maximum number of pages.
- Return prices, taxes, discounts, image URLs, ratings, map coordinates, and partner offers when published.
- Deduplicate listings by hotel ID.
- Push page results as they become available for safer long runs.
- Use Apify Proxy or custom proxy URLs for production runs.

## How to use

1. Open the Actor input form.
2. Paste a public Skyscanner hotel search URL, or clear the URL and enter a location.
3. Set dates and traveller details if they are not already present in the URL.
4. Choose a result limit and page limit.
5. Start the run and open the default dataset when it finishes.

When `url` is supplied, it is used first. When it is empty, `location` is resolved and a search is created using the supplied dates and traveller details. A numeric destination ID or a Skyscanner destination URL is the most reliable location format. Free-text locations may need proxy access if the destination service applies a challenge.

## Input parameters

| Field                | Type    | Default           | Description                                                                            |
| -------------------- | ------- | ----------------- | -------------------------------------------------------------------------------------- |
| `url`                | String  | Sample search URL | Public Skyscanner hotel search URL. Takes priority over `location`.                    |
| `location`           | String  | `New York`        | City name, numeric destination ID, or Skyscanner destination URL.                      |
| `checkin`            | String  | `2026-09-01`      | Check-in date in `YYYY-MM-DD` format.                                                  |
| `checkout`           | String  | `2026-09-02`      | Check-out date in `YYYY-MM-DD` format. Must be after check-in.                         |
| `adults`             | Integer | `2`               | Number of adult travellers.                                                            |
| `rooms`              | Integer | `1`               | Number of rooms.                                                                       |
| `market`             | String  | `US`              | Two-letter market used for availability and prices.                                    |
| `locale`             | String  | `en-US`           | Locale for labels and translated content.                                              |
| `currency`           | String  | `USD`             | Three-letter price currency.                                                           |
| `sortBy`             | String  | `best`            | `best`, `price_low`, `price_high`, `rating`, `stars_high`, `stars_low`, or `distance`. |
| `results_wanted`     | Integer | `20`              | Maximum unique hotels saved across the run.                                            |
| `max_pages`          | Integer | `5`               | Maximum listing pages requested. Each page contains up to 35 hotels.                   |
| `proxyConfiguration` | Object  | Apify Proxy       | Proxy settings for reliable production runs.                                           |

## Usage examples

### Basic search URL

```json
{
    "url": "https://www.skyscanner.com/hotels/search?entity_id=27537542&checkin=2026-09-01&checkout=2026-09-02&adults=2&rooms=1",
    "results_wanted": 20,
    "max_pages": 1
}
```

### Destination by numeric ID

```json
{
    "location": "27537542",
    "checkin": "2026-09-01",
    "checkout": "2026-09-02",
    "adults": 2,
    "rooms": 1,
    "sortBy": "price_low",
    "results_wanted": 50,
    "max_pages": 2
}
```

### Destination URL and rating sort

```json
{
    "location": "https://www.skyscanner.com/hotels/search?entity_id=27537542",
    "checkin": "2026-09-01",
    "checkout": "2026-09-02",
    "sortBy": "rating",
    "results_wanted": 35,
    "max_pages": 1
}
```

## Output data

The default dataset contains one item per unique hotel. Common fields include:

| Field                                                  | Description                              |
| ------------------------------------------------------ | ---------------------------------------- |
| `hotelId`                                              | Skyscanner hotel identifier.             |
| `hotelName`                                            | Public hotel name.                       |
| `starRating` and `starLabel`                           | Published star classification.           |
| `detailsPageUrl` and `canonicalHotelUrl`               | Public hotel detail links.               |
| `reviewScore`, `reviewScoreDescription`, `reviewCount` | Guest rating information when available. |
| `imageUrls`                                            | Direct image URLs for the listing.       |
| `pricePerNight` and `pricePerNightWithTaxes`           | Normalized nightly prices.               |
| `totalPrice` and `totalPriceWithTaxes`                 | Normalized stay totals.                  |
| `partnerOffers`                                        | Available booking partner offers.        |
| `latitude`, `longitude`                                | Map coordinates when available.          |
| `entityId`, `location`, `market`, `currency`           | Search context.                          |
| `sourcePage`, `sourceUrl`, `scrapedAt`                 | Collection metadata.                     |

### Sample output

```json
{
    "hotelId": "204222293",
    "hotelName": "DoubleTree by Hilton New York Downtown",
    "starRating": 4,
    "starLabel": "4 stars",
    "detailsPageUrl": "https://www.skyscanner.com/hotels/.../ht-204222293",
    "reviewScore": 4.2,
    "reviewCount": 1516,
    "imageUrls": ["https://content.skyscnr.com/..."],
    "pricePerNight": "$188",
    "pricePerNightWithTaxes": "$219",
    "entityId": "27537542",
    "location": "New York",
    "currency": "USD",
    "checkin": "2026-09-01",
    "checkout": "2026-09-02",
    "sourcePage": 1,
    "scrapedAt": "2026-08-20T07:15:17.658Z"
}
```

Fields that are not published for a listing are left out of that item.

## Tips for reliable runs

- Start with a URL containing `entity_id`, dates, adults, and rooms.
- Keep `max_pages` modest while testing, then increase it with `results_wanted`.
- Use `price_low` for budget comparisons and `rating` for highly rated properties.
- Keep proxy access enabled for scheduled or higher-volume runs.
- If free-text location lookup is challenged, use the destination URL or numeric ID instead.
- The result limit applies to the complete run, while page limits control how far pagination can continue.

## Integrations and automation

Use the dataset with Google Sheets, Make, Zapier, webhooks, cloud storage, dashboards, or a custom application. Schedule recurring runs for price snapshots, destination monitoring, or hotel directory updates. The dataset can be exported as JSON, CSV, Excel, XML, or RSS.

## Frequently asked questions

### Can I use both `url` and `location`?

Yes. The URL is intentionally the primary input. Location is used only when URL is empty.

### Do I need to provide dates?

Yes. Dates can come from the search URL or from `checkin` and `checkout`. Separate input fields override URL query values.

### Why are fewer hotels returned than requested?

The search may have fewer available listings, the page limit may have been reached, or duplicate hotel IDs may have been removed.

### Are null values included?

No. Nulls, empty strings, empty arrays, and empty objects are removed recursively before items are saved.

### Can I scrape several destinations in one run?

This version accepts one search target per run. Create separate scheduled runs for separate destinations so each dataset remains easy to interpret.

## Related Actors

- [Agoda Hotels Scraper](https://apify.com/shahidirfan/agoda-hotels-scraper) for Agoda property, pricing, availability, and review data.
- [Tripadvisor Reviews Scraper](https://apify.com/shahidirfan/tripadvisor-reviews-scraper) for Tripadvisor hotel review collection.
- [Tiket Hotel Reviews Scraper](https://apify.com/shahidirfan/tiket-hotel-reviews-scraper) for structured guest feedback from Tiket hotel pages.

## Legal notice

This Actor collects publicly accessible information. You are responsible for complying with applicable laws, privacy requirements, contractual obligations, and the target website's terms. Use reasonable limits and retain only the information you need.

## Support

If a valid search stops returning expected results, include the run ID, input shape, and a short description when requesting support. Do not share passwords, proxy credentials, tokens, or other secrets.
