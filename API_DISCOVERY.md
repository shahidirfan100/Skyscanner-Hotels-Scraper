## Current data source

- Hotel search endpoint: `https://{host}/g/hotel-unified-bff/v1/hotelsearch`
- Location endpoint: `https://{host}/g/autosuggest-search/api/v1/search-hotel/{market}/{locale}/{term}?rf=map&vrows=10`
- Method: `POST` for hotel search, `GET` for location lookup
- Authentication: no API key, login, or stored session
- Runtime client: Impit, one client per request session
- Browser runtime: not required
- Pagination: `offset` plus the returned `sessionToken`
- Page size: 35 hotels
- Hosts that serve the endpoint: `www.skyscanner.com` and `www.skyscanner.net`

The public hotel search page is a JavaScript shell with no listing records. Do not use it as a data source. Loading the page can also trigger a PerimeterX challenge and set a `_pxhd` cookie that makes later search requests return `403 {"reason":"blocked"}`. The Actor never loads the page. It calls the search endpoint directly.

## Request body

```json
{
    "priceType": "PRICE_TYPE_PER_NIGHT",
    "entityId": "27537542",
    "requestContext": { "debug": false },
    "travellerContext": {
        "market": "US",
        "locale": "en-US",
        "currency": "USD",
        "checkinDate": "2026-12-10",
        "checkoutDate": "2026-12-11",
        "adults": 2,
        "childrenAges": [],
        "rooms": 1
    },
    "offset": 0,
    "limit": 35,
    "sortType": "SORT_TYPE_BEST_DESC",
    "cugSegments": [],
    "partnersPerHotel": -1,
    "imagesPerHotel": 5,
    "offersPerPartner": 1
}
```

The first response can be `SEARCH_STATUS_TRIGGERED` with an empty `hotels` array. Poll with the returned `sessionToken` until the status is `SEARCH_STATUS_COMPLETED` or hotels appear. Subsequent pages reuse the same token and increase `offset` by 35.

## Request headers

Hotel search:

- `content-type: text/plain;charset=UTF-8`
- `x-user-agent: D;Web`
- `traffic_source: Unknown`
- `app_name: web`
- `origin: https://{host}`
- `referer: https://{host}/hotels/search`
- `Skyscanner-Correlation-ID`: a fresh UUID for each request
- Impit supplies the matching `user-agent`, `accept`, `accept-language`, and `sec-fetch-*` headers and the TLS fingerprint.

Location lookup:

- `referer: https://{host}/hotels`
- `x-user-agent: D;Web`
- `app_name: web`
- `Skyscanner-Correlation-ID`: a fresh UUID for each request
- Impit supplies the remaining browser headers and the TLS fingerprint.

Do not manually set `user-agent`, `accept`, `accept-language`, `sec-ch-ua*`, or `sec-fetch-*`. The impersonated profile must stay coherent. Removing `x-user-agent: D;Web` caused a `403` in direct testing, so keep it.

## Profile and host evidence

Direct requests were tested on 2026-10-23 from one IP. Results change as the site updates its bot protection, so retest before changing the ladder.

### First matrix on `www.skyscanner.com`

| Profile      | Hotel search                   | Location lookup |
| ------------ | ------------------------------ | --------------- |
| `chrome`     | 403 blocked                    | 403 blocked     |
| `chrome142`  | 403 blocked                    | 403 blocked     |
| `chrome136`  | 403 blocked                    | 403 blocked     |
| `chrome131`  | 403 blocked                    | 403 blocked     |
| `firefox`    | 403 blocked                    | 403 blocked     |
| `firefox144` | 403 blocked                    | 403 blocked     |
| `ios18`      | 403 blocked                    | 200, 7 places   |
| `okhttp5`    | 200, `SEARCH_STATUS_TRIGGERED` | 200, 7 places   |
| `okhttp4`    | 403 blocked                    | 403 blocked     |

### Follow-up matrix

| Combination                       | Result                                               |
| --------------------------------- | ---------------------------------------------------- |
| `okhttp5` on `.com`               | 200, 35 hotels, total 704, `SEARCH_STATUS_COMPLETED` |
| `okhttp3` on `.com`               | 200, 35 hotels, total 704, `SEARCH_STATUS_COMPLETED` |
| `okhttp` on `.com`                | 403 blocked                                          |
| `ios18` on `.com`                 | 403 blocked                                          |
| `okhttp5` with HTTP/3 on `.com`   | 403 blocked                                          |
| `chrome142` with HTTP/3 on `.com` | 200, 35 hotels                                       |
| `ios18` with HTTP/3 on `.com`     | 200, 35 hotels                                       |
| `okhttp5` on `.net`               | 200, 35 hotels, total 704                            |
| `okhttp5` without `x-user-agent`  | 403 blocked                                          |

### Pagination check on `www.skyscanner.net` with `okhttp5`

| Offset | Status | Hotels | First hotel ID |
| ------ | ------ | ------ | -------------- |
| 0      | 200    | 35     | 223884535      |
| 35     | 200    | 35     | 178962217      |
| 70     | 200    | 35     | 200609987      |
| 105    | 200    | 35     | 46963199       |

The first four pages returned distinct hotels. Pagination works with the same client, the same `sessionToken`, and an offset that increases by 35.

### What the evidence means

- `okhttp5` and `okhttp3` are the strongest profiles for the hotel search endpoint. They behave like an Android client and passed where desktop and iOS profiles were blocked.
- `ios18` and `okhttp5` both work for location lookup.
- HTTP/3 changes the outcome for some desktop and iOS profiles. It is worth trying when HTTP/2 is blocked.
- The `.net` host served the same data and stayed usable for four consecutive pages while `.com` profiles were blocked.
- Removing `x-user-agent` caused a block, so endpoint-specific headers are required.
- After a burst of requests, every profile and both hosts returned 403. The block is tied to the IP and reputation, not only to the profile. Production runs need residential proxy rotation.

## Runtime recovery strategy

The Actor keeps a profile and host ladder. It starts with `okhttp5` on the input host or `.com`, then tries the same profile on `.net`, then moves to `okhttp3`, `chrome142` with HTTP/3, `ios18` with HTTP/3, `chrome`, `firefox144`, `okhttp4`, and `chrome131`.

On a block, timeout, connection reset, 429, 5xx, non-JSON 200, or a missing hotels array:

1. Open a new proxy session with a new session ID.
2. Create a new Impit client with the next profile and host.
3. Attach a fresh cookie jar. A blocked `_pxhd` cookie is not carried over.
4. Retry the request with bounded exponential backoff and jitter.
5. Honor `Retry-After` for 429 responses.
6. After the per-request retry budget, restart the search on a fresh session from offset 0 and keep the hotels already saved.

The rotation budget is bounded so a fully blocked environment fails with a clear error instead of running forever.

## Session token behavior

- The first search response returns `sessionToken`.
- Use the same token for polls and later pages in the same session.
- If the session rotates and the token is rejected, restart from offset 0. Deduplication by hotel ID prevents duplicate records.
- Do not hardcode a token. Do not reuse a token from a different session after a block.

## Location lookup behavior

- A numeric value is used as an entity ID without a lookup.
- A Skyscanner URL is parsed for `entity_id`, `ci-`, or `ai-`.
- A free-text value calls the autosuggest endpoint.
- The response is a top-level JSON array of place objects with `entity_id`, `entity_name`, and `type`. Older object shapes with `places` or `result` are also accepted.
- City results rank ahead of districts, islands, and airports.
- If the lookup is blocked, the Actor rotates the profile and host. Numeric IDs and destination URLs avoid the lookup entirely.

## Market, locale, and dates

- `.com` defaults to market `US`, locale `en-US`, and currency `USD`.
- `.net` and `.co.uk` default to market `UK`, locale `en-GB`, and currency `GBP`.
- `GB` is rejected by the endpoint with `400 Market (GB) is invalid`. Use `UK`.
- A URL query value or an explicit input value overrides the host default.
- Missing dates default to tomorrow and the day after.
- Past check-in dates shift forward to tomorrow, preserving the stay length.
- The endpoint requires bookable future dates.

## Failure diagnosis

Read this file before changing the request. Then check the failing response and the request that produced it.

| Symptom                                                            | Likely cause                             | Fix                                                                |
| ------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| `403 {"reason":"blocked","redirect_to":"/sttc/px/captcha-v2/..."}` | Profile or IP blocked by PerimeterX      | Rotate to a fresh proxy session and the next profile or host.      |
| `429`                                                              | Rate limited                             | Honor `Retry-After`, then rotate.                                  |
| `400 Market (XX) is invalid`                                       | Invalid market code                      | Use `UK` for the United Kingdom, not `GB`.                         |
| `400` with a date message                                          | Missing, malformed, or past date         | Send a future `YYYY-MM-DD` check-in and a later check-out.         |
| `404`                                                              | Endpoint missing on this host            | Try the other host. If both fail, the path changed.                |
| `200` with HTML or a non-JSON body                                 | Challenge page or changed response       | Rotate. If every profile fails, inspect the endpoint in a browser. |
| `200` without a `hotels` array                                     | Response shape changed                   | Log the response keys, update `mapHotel`, and update this file.    |
| Search stays `SEARCH_STATUS_TRIGGERED`                             | Search still running                     | Poll with the same `sessionToken`, up to 8 polls.                  |
| Search returns `SEARCH_STATUS_FAILED`                              | Search failed server-side                | Rotate and restart the search.                                     |
| Empty dataset with a successful run                                | No hotels match the destination or dates | Check the entity ID and dates. Do not invent records.              |

Before changing code, verify:

1. The endpoint path and method.
2. The full request body, including `entityId`, dates, market, locale, currency, offset, limit, sort type, and `sessionToken`.
3. The endpoint-specific headers. Do not override Impit browser headers.
4. The profile and host combination.
5. The proxy session. A flagged IP stays blocked across profiles.
6. The response status, body shape, and top-level keys.

## Candidate matrix

| Candidate                         | Result                                                           | Decision                           |
| --------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Public hotel search page          | JavaScript shell, no hotel records, can set a challenge cookie   | Rejected                           |
| Hotel search endpoint over HTTP/2 | 200 JSON with hotel records, prices, images, ratings, and offers | Selected                           |
| Hotel search endpoint over HTTP/3 | 200 JSON with some desktop and iOS profiles                      | Selected as a fallback combination |
| Location autosuggest endpoint     | 200 JSON array with place entities                               | Selected for free-text locations   |
| Official partner API              | Requires credentials outside this Actor                          | Rejected                           |

## Verification evidence

- `okhttp5` and `okhttp3` returned 35 hotels with total 704 for New York.
- `okhttp5` on `.net` returned four distinct pages with offsets 0, 35, 70, and 105.
- `ios18` and `okhttp5` returned a top-level array of 7 places for New York when Chrome was blocked.
- `chrome142` and `ios18` with HTTP/3 returned 35 hotels when their HTTP/2 requests were blocked.
- A local run saved 20 New York hotels after rotating from `okhttp5` to `okhttp3`.
- A larger local run saved page 1, then hit an IP-wide block on every profile and host. This confirms that production needs residential proxy rotation.

## Response fields used by the Actor

Hotel records expose identifiers, names, star levels, distances, detail URLs, image data, review summaries, cheapest prices, taxes, discounts, partner offers, and map coordinates when available. The mapper reads:

- `hotel.id`, `hotel.name`, `hotel.stars`, `hotel.detailsPageUrl`
- `hotel.distance`, `hotel.reviewSummary`, `hotel.images`
- `hotel.cheapestPrice.pricePerNight` and `hotel.cheapestPrice.priceTotal`
- `hotel.partnerOffers[].partner` and `hotel.partnerOffers[].offers[]`
- `searchData.mapContent.mapMarkers[]` for coordinates
- `searchData.searchSummary.hotelTotal` and `searchData.searchSummary.searchTarget.entity.name`

If a field disappears, add a safe fallback and update this file. Do not add a broad `data || fallback` chain that hides a malformed response.
