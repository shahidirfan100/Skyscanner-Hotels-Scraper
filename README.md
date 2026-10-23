## What does Skyscanner Hotels Scraper do?

Skyscanner Hotels Scraper collects hotel listings from a Skyscanner hotel search and saves one clean record per hotel. Each record includes the hotel name, star rating, guest rating, image URLs, nightly and total prices, booking partner offers, map coordinates, and the public hotel page.

Use it for price research, destination comparisons, travel planning, accommodation directories, competitor monitoring, and scheduled market snapshots. The Actor leaves out fields that a hotel does not publish instead of saving them as nulls.

## Features

- Search from a Skyscanner URL, a city name, a numeric destination ID, or a destination URL.
- Set check-in, check-out, adults, rooms, market, locale, and currency.
- Sort by best match, price, guest rating, stars, or distance.
- Control the number of hotels saved and how many result pages are requested.
- Receive nightly prices, taxes, discounts, image URLs, ratings, map coordinates, and partner offers when published.
- Deduplicate hotels by hotel ID across pages.
- Save each page as soon as it arrives, so a later request cannot erase earlier progress.
- Switch request profiles and proxy sessions automatically when the site blocks a request.
- Work with Apify Proxy or your own proxy URLs.

## How to use

1. Open the Actor input form.
2. Paste a public Skyscanner hotel search URL, or leave the URL empty and enter a location.
3. Set dates and traveller details. If you leave the dates empty, the Actor uses tomorrow and the day after.
4. Choose a hotel limit and a page limit.
5. Start the run and open the default dataset when it finishes.

When you supply `url`, the Actor uses it first. When the URL is empty, the Actor resolves `location` and creates a search from your dates and traveller details. A numeric destination ID is the most reliable location format. New York is `27537542`.

## Input parameters

| Field                | Type    | Default     | Description                                                                                     |
| -------------------- | ------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `url`                | String  | None        | Public Skyscanner hotel search URL. Takes priority over `location`.                             |
| `location`           | String  | `27537542`  | City name, numeric destination ID, or Skyscanner destination URL. Used when `url` is empty.     |
| `checkin`            | String  | Tomorrow    | Check-in date in `YYYY-MM-DD` format.                                                           |
| `checkout`           | String  | Day after   | Check-out date in `YYYY-MM-DD` format. Must be after check-in.                                  |
| `adults`             | Integer | `2`         | Number of adult travellers.                                                                     |
| `rooms`              | Integer | `1`         | Number of rooms.                                                                                |
| `market`             | String  | From URL    | Two-letter market used for availability and prices, for example `US` or `UK`. Defaults to `US`. |
| `locale`             | String  | From market | Locale for labels and translated content. Defaults to the market locale.                        |
| `currency`           | String  | From market | Three-letter price currency. Defaults to the market currency.                                   |
| `sortBy`             | String  | `best`      | `best`, `price_low`, `price_high`, `rating`, `stars_high`, `stars_low`, or `distance`.          |
| `results_wanted`     | Integer | `20`        | Maximum unique hotels saved across the run.                                                     |
| `max_pages`          | Integer | `5`         | Maximum result pages requested. Each page contains up to 35 hotels.                             |
| `proxyConfiguration` | Object  | Apify Proxy | Proxy settings for production runs. Residential proxies are recommended.                        |

## Usage examples

### Search URL with dates

```json
{
    "url": "https://www.skyscanner.com/hotels/search?entity_id=27537542&checkin=2026-12-10&checkout=2026-12-11&adults=2&rooms=1",
    "results_wanted": 20,
    "max_pages": 1
}
```

### Destination by numeric ID

```json
{
    "location": "27537542",
    "checkin": "2026-12-10",
    "checkout": "2026-12-11",
    "adults": 2,
    "rooms": 1,
    "sortBy": "price_low",
    "results_wanted": 50,
    "max_pages": 2
}
```

### Default dates and rating sort

```json
{
    "location": "27537542",
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
| `pricePerNight` and `pricePerNightWithTaxes`           | Nightly prices.                          |
| `totalPrice` and `totalPriceWithTaxes`                 | Stay totals.                             |
| `partnerOffers`                                        | Booking partner offers.                  |
| `latitude`, `longitude`                                | Map coordinates when available.          |
| `entityId`, `location`, `market`, `currency`           | Search context.                          |
| `sourcePage`, `sourceUrl`, `scrapedAt`                 | Collection metadata.                     |

### Sample output

This sample comes from a real run for New York with the default dates.

```json
{
    "hotelId": "226351436",
    "hotelName": "West Village Eurohostel",
    "starRating": 2,
    "starLabel": "2 stars",
    "detailsPageUrl": "https://www.skyscanner.com/hotels/united-states/new-york-hotels/west-village-eurohostel/ht-226351436",
    "canonicalHotelUrl": "https://www.skyscanner.com/hotels/united-states/new-york-hotels/west-village-eurohostel/ht-226351436",
    "distanceDescription": "Manhattan, New York",
    "latitude": 40.73818,
    "longitude": -74.00946,
    "reviewScore": 4,
    "reviewScoreDescription": "Very Good",
    "reviewCount": 56,
    "imageUrls": ["https://content.skyscnr.com/available/2759652058/2759652058_WxH.jpg"],
    "pricePerNight": 338,
    "pricePerNightWithTaxes": 341.97,
    "totalPrice": 338,
    "totalPriceWithTaxes": 341.97,
    "entityId": "27537542",
    "location": "New York",
    "currency": "USD",
    "checkin": "2026-10-24",
    "checkout": "2026-10-25",
    "sourcePage": 1,
    "scrapedAt": "2026-10-23T11:35:35.801Z"
}
```

## Tips for reliable runs

- Keep Apify Proxy enabled with residential proxies for scheduled or higher-volume runs. Skyscanner blocks some networks after a few requests.
- Use a numeric destination ID or a search URL with `entity_id` when you need the most predictable start.
- Leave dates empty to use tomorrow and the day after, or set both dates explicitly.
- Start with `max_pages` at 1 while you test, then raise it together with `results_wanted`.
- Use `price_low` for budget comparisons and `rating` for highly rated properties.
- If a free-text city lookup is blocked, use the numeric destination ID or a destination URL instead.

## Integrations and automation

Use the dataset with Google Sheets, Make, Zapier, webhooks, cloud storage, dashboards, or a custom application. Schedule recurring runs for price snapshots, destination monitoring, or hotel directory updates. Export the dataset as JSON, CSV, Excel, XML, or RSS.

## Frequently asked questions

### Can I use both `url` and `location`?

Yes. The URL is the primary input. The Actor uses the location only when the URL is empty.

### Do I need to provide dates?

No. If you leave both dates empty, the Actor uses tomorrow and the day after. If you provide only one date, the Actor adds one day to complete the stay.

### Why are fewer hotels returned than requested?

The destination may have fewer available hotels, the page limit may have been reached, or duplicate hotel IDs may have been removed. Check the final log line for the stop reason.

### Are null values included?

No. The Actor removes nulls, empty strings, empty arrays, and empty objects before saving each item.

### Can I scrape several destinations in one run?

This version accepts one search target per run. Create separate scheduled runs for separate destinations so each dataset stays easy to read.

### What happens when Skyscanner blocks a request?

The Actor switches to another request profile and a fresh proxy session, then retries. If a result page still fails after the retry budget, the Actor restarts the search on a new session and keeps the hotels it already saved.

## Related Actors

- [Agoda Hotels Scraper](https://apify.com/shahidirfan/agoda-hotels-scraper) for Agoda property, pricing, availability, and review data.
- [Tripadvisor Reviews Scraper](https://apify.com/shahidirfan/tripadvisor-reviews-scraper) for Tripadvisor hotel review collection.
- [Tiket Hotel Reviews Scraper](https://apify.com/shahidirfan/tiket-hotel-reviews-scraper) for structured guest feedback from Tiket hotel pages.

## Legal notice

This Actor collects publicly accessible information. You are responsible for complying with applicable laws, privacy requirements, contractual obligations, and the target website's terms. Use reasonable limits and retain only the information you need.

## Support

If a valid search stops returning expected results, include the run ID, input shape, and a short description when requesting support. Do not share passwords, proxy credentials, tokens, or other secrets.
