## Selected listing source

- Endpoint: `https://www.skyscanner.com/g/hotel-unified-bff/v1/hotelsearch`
- Method: `POST`
- Authentication: No API key or stored session is required for the request
- Runtime client: one Impit client per proxy session, rotated on block signals
- Runtime browser: not required
- Pagination: `offset`, `limit`, and the returned `sessionToken`
- Page size: 35 hotel records

The public hotel search URL is a JavaScript application shell, so it is not used as the production data source. During discovery, browser network inspection was used only to observe the JSON request made by the site. The actor replays that request directly over HTTP at runtime.

### Request body

```json
{
    "priceType": "PRICE_TYPE_PER_NIGHT",
    "entityId": "27537542",
    "requestContext": { "debug": false },
    "travellerContext": {
        "market": "US",
        "locale": "en-US",
        "currency": "USD",
        "checkinDate": "2026-09-01",
        "checkoutDate": "2026-09-02",
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

The first response can be `SEARCH_STATUS_TRIGGERED`. In that case, the actor polls with the returned session token until the search completes. Subsequent pages reuse the same token and increase `offset` by 35.

### Headers confirmed during discovery

- `content-type: text/plain;charset=UTF-8`
- `x-user-agent: D;Web`
- `Skyscanner-Correlation-ID`: a fresh UUID for each request
- `traffic_source: Unknown`
- `app_name: web`
- `referer`: the supplied or generated public search URL

No browser cookies, authorization token, or hard-coded session value is stored in the project.

## Request-pattern fixes applied from live testing

Live replay tests (2026-08) reproduced the cloud failure and confirmed the working browser flow:

- The hotel BFF POST works with the browser-faithful header set below, with or without cookies, and does **not** need a page warm-up. A page warm-up must be avoided: loading `/hotels` or `/hotels/search` triggers the PerimeterX page challenge, sets the `_pxhd` cookie, and a later BFF POST carrying that cookie returns `403 {"reason":"blocked",...}`.
- The autosuggest request was failing on Apify cloud with the previous headers (`platform: desktop`, `pagetype: hotels-home`, `accept: application/json`). Removing those two custom headers and sending the browser-faithful header set turns the same request from `403 blocked` into `200` JSON consistently.
- The autosuggest endpoint returns a **top-level JSON array** of place objects (`entity_id`, `entity_name`, `type`), not an object with a `places` key. The resolver now accepts the array shape (and keeps the older object shapes for compatibility) and ranks city/district results ahead of airports.
- The BFF payload market code must be a valid Skyscanner market: `GB` is rejected with `400 Market (GB) is invalid`; the correct code for the UK market is `UK`. `inferMarket` maps `skyscanner.co.uk` to `UK`, and locale/currency defaults are derived from the inferred market.

### Runtime request headers (corrected)

Hotel BFF POST:

- `content-type: text/plain;charset=UTF-8`
- `accept: application/json, text/plain, */*`
- `accept-language`: derived from the resolved locale (e.g. `en-US,en;q=0.9`)
- `x-user-agent: D;Web`
- `Skyscanner-Correlation-ID`: a fresh UUID for each request
- `traffic_source: Unknown`
- `app_name: web`
- `origin: https://www.skyscanner.com`
- `referer`: the supplied or generated public search URL
- `sec-fetch-site: same-origin`
- `sec-fetch-mode: cors`
- `sec-fetch-dest: empty`

Autosuggest GET (location-name resolution only):

- `accept: application/json, text/plain, */*`
- `accept-language`: derived from the resolved locale
- `referer: https://www.skyscanner.com/hotels`
- `x-user-agent: D;Web`
- `app_name: web`
- `sec-fetch-site: same-origin`
- `sec-fetch-mode: cors`
- `sec-fetch-dest: empty`
- `Skyscanner-Correlation-ID`: a fresh UUID

A session cookie jar is attached to the Impit client so the `__Secure-session_id` cookie issued by the BFF is replayed across polls and pages, matching browser session behavior. No page/browser cookies are ever fetched.

### Proxy session rotation for PerimeterX IP blocks

A clean IP returns `200` from the hotel BFF, but a proxy IP already flagged by PerimeterX keeps returning `403 {"reason":"blocked","redirect_to":"/sttc/px/captcha-v2/index.html?url=Lw==&uuid=..."}` on every retry. Retrying on the same IP cannot recover from this, so the actor treats `403`/`429` (and transport errors) as block signals and **rotates to a fresh proxy session** before the next retry. Each rotation:

- builds a new Impit client with a new session-suffixed proxy URL (a new residential IP when Apify proxy is configured),
- attaches a fresh cookie jar (replaying the blocked `_pxhd` cookie does not help, so it is not carried over),
- is bounded per run (`MAX_PROXY_ROTATIONS`, currently 6) so a fully blocked environment fails fast instead of burning through IPs.

Retries are still bounded (`MAX_RETRIES`, currently 3) per request, so the worst case is a few attempts across several distinct IPs before a clear error is raised.

## Candidate matrix

| Candidate                                      | Direct result                                                                  | Decision                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Public hotel search page                       | HTTP 200 JavaScript shell with no listing records                              | Rejected as a data source                                                      |
| Browser network request to the listing service | HTTP 200 JSON with hotel records, totals, prices, images, ratings, and filters | Selected                                                                       |
| Direct Impit replay of the listing request     | HTTP 200 JSON, with both immediate and token-poll completion observed          | Selected for runtime                                                           |
| Internal location autosuggest request          | Useful when accessible, but returned a bot challenge in the local environment  | Optional free-text resolver; numeric IDs and destination URLs remain supported |
| Official partner API                           | Requires credentials outside this actor                                        | Rejected                                                                       |

## Verification evidence

- The supplied New York search URL returned hotel listing JSON through direct Impit replay.
- The response included a large hotel total and ten or more rich hotel records in direct discovery tests.
- Session-token polling completed searches that initially returned `SEARCH_STATUS_TRIGGERED`.
- Offset pagination returned later listing pages using the same search session.
- The tested sort modes were best, price ascending, price descending, rating, stars descending, stars ascending, and distance.
- Hotel records exposed identifiers, names, star levels, distances, detail URLs, image data, review summaries, cheapest prices, taxes, discounts, partner offers, and map coordinates when available.

## Runtime request strategy

- Create an Impit client with the Chrome profile, a session-suffixed proxy URL, and a session cookie jar; keep it for the initial search, polling, location resolution, and pagination.
- Retry timeouts, connection resets, HTTP 403/429, server errors, and non-JSON 200 responses with bounded backoff, rotating to a fresh proxy session on 403/429 and connection errors.
- If the initial search stays `SEARCH_STATUS_TRIGGERED` past the poll limit or returns `SEARCH_STATUS_FAILED`, restart the search from scratch with a fresh session, up to a bounded number of attempts, instead of silently returning an empty result.
- Push each completed page batch immediately and deduplicate by hotel ID.
- Recursively omit nulls, empty strings, empty arrays, and empty objects before saving records.
- Fail with a descriptive message for invalid URLs, missing dates, blocked location lookup, non-JSON responses, or missing hotel arrays.
