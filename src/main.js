import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { Actor, log } from 'apify';
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

const API_ENDPOINT = 'https://www.skyscanner.com/g/hotel-unified-bff/v1/hotelsearch';
const AUTOSUGGEST_ENDPOINT = 'https://www.skyscanner.com/g/autosuggest-search/api/v1/search-hotel';
const API_PAGE_SIZE = 35;
const MAX_RETRIES = 3;
const MAX_INITIAL_SEARCH_ATTEMPTS = 3;
const MAX_PROXY_ROTATIONS = 6;
const MAX_SEARCH_POLLS = 8;
const LOCATION_FALLBACK_BROWSER = 'ios18';
const REQUEST_TIMEOUT_MS = 30_000;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const SKYSCANNER_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*skyscanner\.[a-z.]{2,}$/i;
const SKYSCANNER_ORIGIN = 'https://www.skyscanner.com';
const AUTOSUGGEST_REFERER = 'https://www.skyscanner.com/hotels';

export const SORT_TYPES = Object.freeze({
    best: 'SORT_TYPE_BEST_DESC',
    price_low: 'SORT_TYPE_PRICE_ASC',
    price_high: 'SORT_TYPE_PRICE_DESC',
    rating: 'SORT_TYPE_RATING_DESC',
    stars_high: 'SORT_TYPE_STARS_DESC',
    stars_low: 'SORT_TYPE_STARS_ASC',
    distance: 'SORT_TYPE_DISTANCE_ASC',
});

const wait = (milliseconds) =>
    new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });

export function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanValue(value) {
    if (value === null || value === undefined || value === '') return undefined;

    if (Array.isArray(value)) {
        const cleaned = value.map(cleanValue).filter((item) => item !== undefined);
        return cleaned.length > 0 ? cleaned : undefined;
    }

    if (typeof value === 'object') {
        const cleaned = Object.fromEntries(
            Object.entries(value)
                .map(([key, item]) => [key, cleanValue(item)])
                .filter(([, item]) => item !== undefined),
        );
        return Object.keys(cleaned).length > 0 ? cleaned : undefined;
    }

    return value;
}

export function cleanRecord(record) {
    return cleanValue(record) || {};
}

function browserFetchHeaders(extra) {
    return {
        'Skyscanner-Correlation-ID': randomUUID(),
        ...extra.headers,
    };
}

function getEntityIdFromUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }

    if (url.protocol !== 'https:' || !SKYSCANNER_HOST_PATTERN.test(url.hostname)) return undefined;

    const queryEntityId = url.searchParams.get('entity_id') || url.searchParams.get('entityId');
    if (queryEntityId && /^\d+$/.test(queryEntityId)) return queryEntityId;

    const pathMatch = url.pathname.match(/(?:^|\/)(?:ci|ai)-(\d+)(?:\/|$)/i);
    return pathMatch?.[1];
}

function validateSkyscannerUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`Invalid Skyscanner URL: ${value}`);
    }

    if (url.protocol !== 'https:' || !SKYSCANNER_HOST_PATTERN.test(url.hostname)) {
        throw new Error(`Unsupported URL: ${value}. Use a public HTTPS Skyscanner hotel search URL.`);
    }

    return url;
}

export function normalizeDate(value, name) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${name} must use YYYY-MM-DD format.`);
    }

    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error(`${name} is not a valid calendar date.`);
    }

    return value;
}

function formatUtcDate(date) {
    return date.toISOString().slice(0, 10);
}

function synchronizeSearchUrl(searchUrl, { checkin, checkout, adults, rooms }) {
    const url = new URL(searchUrl);
    url.searchParams.set('checkin', checkin);
    url.searchParams.set('checkout', checkout);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('rooms', String(rooms));
    return url.toString();
}

export function normalizeStayDates(checkinValue, checkoutValue, now = new Date()) {
    const checkin = normalizeDate(checkinValue, 'checkin');
    const checkout = normalizeDate(checkoutValue, 'checkout');
    if (checkout <= checkin) throw new Error('checkout must be after checkin.');

    const checkinDate = new Date(`${checkin}T00:00:00Z`);
    const checkoutDate = new Date(`${checkout}T00:00:00Z`);
    const stayLength = Math.round((checkoutDate - checkinDate) / MS_PER_DAY);
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const firstBookableDate = new Date(today);
    firstBookableDate.setUTCDate(firstBookableDate.getUTCDate() + 1);

    if (checkinDate < firstBookableDate) {
        const adjustedCheckout = new Date(firstBookableDate);
        adjustedCheckout.setUTCDate(adjustedCheckout.getUTCDate() + stayLength);
        return {
            checkin: formatUtcDate(firstBookableDate),
            checkout: formatUtcDate(adjustedCheckout),
            adjusted: true,
        };
    }

    return { checkin, checkout, adjusted: false };
}

const MARKET_DEFAULTS = {
    US: { locale: 'en-US', currency: 'USD' },
    UK: { locale: 'en-GB', currency: 'GBP' },
    PK: { locale: 'en-PK', currency: 'PKR' },
    AU: { locale: 'en-AU', currency: 'AUD' },
    CA: { locale: 'en-CA', currency: 'CAD' },
    DE: { locale: 'de-DE', currency: 'EUR' },
    ES: { locale: 'es-ES', currency: 'EUR' },
    FR: { locale: 'fr-FR', currency: 'EUR' },
    IN: { locale: 'en-IN', currency: 'INR' },
    JP: { locale: 'ja-JP', currency: 'JPY' },
    NL: { locale: 'nl-NL', currency: 'EUR' },
    SG: { locale: 'en-SG', currency: 'SGD' },
};

function inferMarket(hostname) {
    const tldMarket = {
        'co.uk': 'UK',
        com: 'US',
        pk: 'PK',
        au: 'AU',
        ca: 'CA',
        de: 'DE',
        es: 'ES',
        fr: 'FR',
        in: 'IN',
        jp: 'JP',
        nl: 'NL',
        sg: 'SG',
    };

    const suffix = hostname.split('.').slice(-2).join('.');
    return tldMarket[suffix] || tldMarket[hostname.split('.').at(-1)] || 'US';
}

async function loadInput() {
    const runtimeInput = await Actor.getInput();
    if (runtimeInput && Object.keys(runtimeInput).length > 0) return runtimeInput;

    try {
        return JSON.parse(await readFile(new URL('../INPUT.json', import.meta.url), 'utf8'));
    } catch (error) {
        throw new Error(`No runtime input was supplied and INPUT.json could not be loaded: ${error.message}`);
    }
}

async function createProxyConfiguration(proxyConfiguration) {
    if (!proxyConfiguration) return undefined;

    const hasCustomProxyUrls = Array.isArray(proxyConfiguration.proxyUrls) && proxyConfiguration.proxyUrls.length > 0;
    const wantsApifyProxy = Boolean(proxyConfiguration.useApifyProxy);

    if (!hasCustomProxyUrls && (!wantsApifyProxy || !Actor.isAtHome())) {
        if (wantsApifyProxy) log.info('Local run detected; continuing without Apify Proxy.');
        return undefined;
    }

    return Actor.createProxyConfiguration({ ...proxyConfiguration });
}

async function createClient(proxy, sessionIndex, browser = 'chrome') {
    const sessionSuffix = `${sessionIndex}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const proxyUrl = proxy ? await proxy.newUrl(`skyscanner${sessionSuffix}`) : undefined;

    return new Impit({
        browser,
        ignoreTlsErrors: true,
        timeout: REQUEST_TIMEOUT_MS,
        cookieJar: new CookieJar(),
        ...(proxyUrl && { proxyUrl }),
    });
}

class ClientManager {
    constructor(proxyConfiguration) {
        this.proxyConfiguration = proxyConfiguration;
        this.proxy = null;
        this.rotations = 0;
        this.maxRotations = MAX_PROXY_ROTATIONS;
        this.client = null;
        this.browser = 'chrome';
    }

    async init() {
        this.proxy = await createProxyConfiguration(this.proxyConfiguration);
        this.client = await createClient(this.proxy, 0, this.browser);
    }

    async rotate(reason, browser = this.browser) {
        if (this.rotations >= this.maxRotations) return false;
        this.rotations++;
        this.browser = browser;
        const context = this.proxy ? `proxy session ${this.rotations}/${this.maxRotations}` : 'fresh client';
        log.debug(`Rotating to ${context} after ${reason}.`);
        this.client = await createClient(this.proxy, this.rotations, this.browser);
        return true;
    }
}

function createHttpError(label, status, responseText) {
    const preview = responseText.replaceAll(/\s+/g, ' ').slice(0, 240);
    const error = new Error(`${label} failed with HTTP ${status}: ${preview || 'empty response'}`);
    error.httpStatus = status;
    error.retryable = status === 403 || status === 429 || status >= 500;
    return error;
}

function createRetryableError(message) {
    const error = new Error(message);
    error.retryable = true;
    return error;
}

function isRetryableError(error) {
    return error?.retryable === true;
}

async function fetchJsonWithRetry(clientManager, url, request, label, options = {}) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        let response;
        let responseText;
        try {
            response = await clientManager.client.fetch(url, {
                method: request.method || 'GET',
                timeout: REQUEST_TIMEOUT_MS,
                headers: request.headers,
                body: request.body,
            });
            responseText = await response.text();
        } catch (error) {
            lastError = createRetryableError(`${label} request failed: ${error.message}`);
            if (attempt === MAX_RETRIES) break;
            const fallbackBrowser = options.browserFallbacks?.[attempt - 1];
            const rotated = await clientManager.rotate(`request error: ${error.message}`, fallbackBrowser);
            if (!rotated) break;
            log.debug(`Request retry ${attempt}/${MAX_RETRIES}: ${label} failed: ${error.message}`);
            await wait(attempt * 1_000 + Math.floor(Math.random() * 400));
            continue;
        }

        if (response.ok) {
            try {
                return JSON.parse(responseText);
            } catch (error) {
                lastError = createRetryableError(`${label} returned invalid JSON: ${error.message}`);
                if (attempt === MAX_RETRIES) break;
                const fallbackBrowser = options.browserFallbacks?.[attempt - 1];
                const rotated = await clientManager.rotate(`${label} returned non-JSON content`, fallbackBrowser);
                if (!rotated) break;
                log.debug(`Request retry ${attempt}/${MAX_RETRIES}: ${label} returned non-JSON content.`);
                await wait(attempt * 1_500 + Math.floor(Math.random() * 500));
                continue;
            }
        }

        if (![403, 429].includes(response.status) && response.status < 500) {
            throw createHttpError(label, response.status, responseText);
        }

        lastError = createHttpError(label, response.status, responseText);
        if (attempt === MAX_RETRIES) break;

        const fallbackBrowser = options.browserFallbacks?.[attempt - 1];
        const rotated = await clientManager.rotate(`HTTP ${response.status}`, fallbackBrowser);
        if (!rotated) break;
        log.debug(`Request retry ${attempt}/${MAX_RETRIES}: ${label} returned HTTP ${response.status}.`);
        await wait(attempt * 1_500 + Math.floor(Math.random() * 500));
    }

    throw lastError || new Error(`${label} failed after ${MAX_RETRIES} attempts.`);
}

function apiHeaders(context) {
    return {
        'content-type': 'text/plain;charset=UTF-8',
        ...browserFetchHeaders({
            headers: {
                'x-user-agent': 'D;Web',
                traffic_source: 'Unknown',
                app_name: 'web',
                origin: SKYSCANNER_ORIGIN,
                referer: context.searchUrl,
            },
        }),
    };
}

function findAutosuggestEntity(data) {
    let candidates;
    if (Array.isArray(data)) {
        candidates = data;
    } else if (Array.isArray(data?.places)) {
        candidates = data.places;
    } else if (Array.isArray(data?.result)) {
        candidates = data.result;
    } else {
        candidates = [];
    }

    const ranked = candidates
        .map((candidate) => {
            const entityId = candidate?.entityId || candidate?.entity_id || candidate?.GeoId;
            if (!entityId) return undefined;
            return {
                entityId: String(entityId),
                name: candidate?.entity_name || candidate?.name || candidate?.PlaceName || candidate?.CityName,
                type: String(candidate?.type || candidate?.class || ''),
            };
        })
        .filter(Boolean);

    if (ranked.length === 0) return undefined;

    const typeRank = (type) => {
        const value = type.toLowerCase();
        if (value.includes('city')) return 0;
        if (value.includes('district') || value.includes('island')) return 1;
        if (value.includes('airport')) return 2;
        return 3;
    };

    ranked.sort((a, b) => typeRank(a.type) - typeRank(b.type) || (a.name || '').length - (b.name || '').length);
    return ranked[0];
}

async function resolveLocation(clientManager, location, market, locale) {
    const value = String(location).trim();
    if (!value) throw new Error('Location cannot be empty.');

    if (/^\d+$/.test(value)) return { entityId: value, locationName: undefined };

    const urlEntityId = getEntityIdFromUrl(value);
    if (urlEntityId) return { entityId: urlEntityId, locationName: undefined };

    const encodedLocation = encodeURIComponent(value);
    const autosuggestUrl = `${AUTOSUGGEST_ENDPOINT}/${market}/${locale}/${encodedLocation}?rf=map&vrows=10`;
    const data = await fetchJsonWithRetry(
        clientManager,
        autosuggestUrl,
        {
            headers: browserFetchHeaders({
                headers: {
                    referer: AUTOSUGGEST_REFERER,
                    'x-user-agent': 'D;Web',
                    app_name: 'web',
                },
            }),
        },
        `Location lookup for "${value}"`,
        { browserFallbacks: [LOCATION_FALLBACK_BROWSER, LOCATION_FALLBACK_BROWSER] },
    );

    const place = findAutosuggestEntity(data);
    if (!place?.entityId) {
        throw new Error(`No Skyscanner destination was found for location: ${value}`);
    }

    return { entityId: place.entityId, locationName: place.name };
}

async function resolveSearchContext(clientManager, input) {
    const suppliedUrl = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;
    const suppliedLocation =
        typeof input.location === 'string' && input.location.trim() ? input.location.trim() : undefined;

    let searchUrl;
    let entityId;
    let locationName;
    let urlObject;

    if (suppliedUrl) {
        urlObject = validateSkyscannerUrl(suppliedUrl);
        entityId = getEntityIdFromUrl(suppliedUrl);
        if (!entityId) {
            throw new Error('The supplied URL must contain entity_id, ci-, or ai- destination information.');
        }
        searchUrl = suppliedUrl;
    } else if (suppliedLocation) {
        const resolved = await resolveLocation(
            clientManager,
            suppliedLocation,
            input.market || 'US',
            input.locale || 'en-US',
        );
        entityId = resolved.entityId;
        locationName = resolved.locationName;
        if (getEntityIdFromUrl(suppliedLocation)) searchUrl = suppliedLocation;
    } else {
        throw new Error('Provide either url or location.');
    }

    const query = urlObject?.searchParams;
    const requestedCheckin = input.checkin || query?.get('checkin');
    const requestedCheckout = input.checkout || query?.get('checkout');
    const stayDates = normalizeStayDates(requestedCheckin, requestedCheckout);
    const { checkin, checkout } = stayDates;

    const adults = normalizePositiveInteger(input.adults || query?.get('adults'), 1);
    const rooms = normalizePositiveInteger(input.rooms || query?.get('rooms'), 1);
    const childrenAges = Array.isArray(input.childrenAges)
        ? input.childrenAges.filter((age) => Number.isSafeInteger(Number(age)) && Number(age) >= 0).map(Number)
        : [];
    const market = input.market || query?.get('market') || (urlObject ? inferMarket(urlObject.hostname) : 'US');
    const marketDefaults = MARKET_DEFAULTS[market] || MARKET_DEFAULTS.US;
    const locale = input.locale || query?.get('locale') || marketDefaults.locale;
    const currency = input.currency || query?.get('currency') || marketDefaults.currency;

    if (!searchUrl) {
        const searchParams = new URLSearchParams({
            entity_id: entityId,
            checkin,
            checkout,
            adults: String(adults),
            rooms: String(rooms),
        });
        searchUrl = `https://www.skyscanner.com/hotels/search?${searchParams}`;
    }

    searchUrl = synchronizeSearchUrl(searchUrl, { checkin, checkout, adults, rooms });
    if (stayDates.adjusted) {
        log.warning(`Adjusted stale stay dates to ${checkin} through ${checkout}.`);
    }

    return {
        entityId,
        locationName,
        searchUrl,
        checkin,
        checkout,
        adults,
        rooms,
        childrenAges,
        market,
        locale,
        currency,
    };
}

function buildSearchPayload(context, offset, sortType, sessionToken) {
    return cleanRecord({
        priceType: 'PRICE_TYPE_PER_NIGHT',
        entityId: context.entityId,
        requestContext: { debug: false },
        travellerContext: {
            market: context.market,
            locale: context.locale,
            currency: context.currency,
            checkinDate: context.checkin,
            checkoutDate: context.checkout,
            adults: context.adults,
            childrenAges: context.childrenAges,
            rooms: context.rooms,
        },
        offset,
        limit: API_PAGE_SIZE,
        sortType,
        cugSegments: [],
        partnersPerHotel: -1,
        imagesPerHotel: 5,
        offersPerPartner: 1,
        sessionToken,
    });
}

async function fetchSearchPage(clientManager, context, payload, label) {
    return fetchJsonWithRetry(
        clientManager,
        API_ENDPOINT,
        {
            method: 'POST',
            headers: apiHeaders(context),
            body: JSON.stringify(payload),
        },
        label,
    );
}

async function fetchSearchPageWithStatusRecovery(clientManager, context, payload, label) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const data = await fetchSearchPage(clientManager, context, payload, label);
        if (data.searchStatus !== 'SEARCH_STATUS_FAILED') return data;

        const error = createRetryableError(`${label} was marked failed by Skyscanner.`);
        if (attempt === MAX_RETRIES) throw error;

        const rotated = await clientManager.rotate(`${label} returned SEARCH_STATUS_FAILED`);
        if (!rotated) throw error;
        log.debug(`Request retry ${attempt}/${MAX_RETRIES}: ${error.message}`);
        await wait(attempt * 1_500 + Math.floor(Math.random() * 500));
    }
    throw createRetryableError(`${label} failed after ${MAX_RETRIES} attempts.`);
}

async function fetchInitialSearchOnce(clientManager, context, payload) {
    let data = await fetchSearchPage(clientManager, context, payload, 'Hotel search');
    let poll = 0;

    while (
        data?.searchStatus !== 'SEARCH_STATUS_COMPLETED' &&
        Array.isArray(data?.hotels) &&
        data.hotels.length === 0 &&
        data.sessionToken &&
        poll < MAX_SEARCH_POLLS
    ) {
        poll++;
        await wait(750 + poll * 250);
        data = await fetchSearchPage(
            clientManager,
            context,
            { ...payload, sessionToken: data.sessionToken },
            `Hotel search poll ${poll}`,
        );
    }

    if (!Array.isArray(data?.hotels)) {
        const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : 'none';
        throw new Error(`Skyscanner listing response is missing the hotels array. Response keys: ${keys}`);
    }

    if (data.searchStatus === 'SEARCH_STATUS_FAILED') {
        throw createRetryableError('Skyscanner marked the hotel search as failed.');
    }

    if (data.searchStatus !== 'SEARCH_STATUS_COMPLETED' && data.hotels.length === 0) {
        throw createRetryableError(`Skyscanner hotel search did not complete after ${MAX_SEARCH_POLLS} polls.`);
    }

    return data;
}

async function fetchInitialSearch(clientManager, context, payload) {
    for (let attempt = 1; attempt <= MAX_INITIAL_SEARCH_ATTEMPTS; attempt++) {
        try {
            return await fetchInitialSearchOnce(clientManager, context, payload);
        } catch (error) {
            if (!isRetryableError(error) || attempt === MAX_INITIAL_SEARCH_ATTEMPTS) throw error;

            const rotated = await clientManager.rotate(`initial search recovery: ${error.message}`);
            if (!rotated) throw error;
            log.debug(
                `Initial search attempt ${attempt}/${MAX_INITIAL_SEARCH_ATTEMPTS} failed: ${error.message}. Retrying with a fresh session.`,
            );
            await wait(1_000 + attempt * 750);
        }
    }
    throw createRetryableError('Skyscanner initial hotel search failed after multiple attempts.');
}

function getCanonicalHotelUrl(value) {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    } catch {
        return undefined;
    }
}

function mapPartnerOffers(partnerOffers) {
    if (!Array.isArray(partnerOffers)) return undefined;

    const offers = partnerOffers.flatMap((partnerGroup) => {
        const partner = partnerGroup?.partner;
        if (!Array.isArray(partnerGroup?.offers)) return [];

        return partnerGroup.offers.map((offer) => {
            const pricePerNight = offer.offerPrice?.pricePerNight;
            const priceTotal = offer.offerPrice?.priceTotal;
            const features = Array.isArray(offer.features)
                ? offer.features.map((feature) =>
                      cleanRecord({
                          title: feature.title,
                          type: feature.featureType,
                          value: feature.value,
                      }),
                  )
                : undefined;

            return cleanRecord({
                partnerId: partner?.id,
                partnerName: partner?.name,
                partnerLogo: partner?.logo,
                offerId: offer.id,
                offerUrl: offer.url,
                pricePerNight: pricePerNight?.displayPrice,
                pricePerNightWithoutDiscount: pricePerNight?.displayPriceWithoutDiscount,
                pricePerNightWithTaxes: pricePerNight?.priceWithAllTaxes,
                totalPrice: priceTotal?.displayPrice,
                totalPriceWithoutDiscount: priceTotal?.displayPriceWithoutDiscount,
                totalPriceWithTaxes: priceTotal?.priceWithAllTaxes,
                roomType: offer.roomType,
                roomName: offer.roomName,
                features,
            });
        });
    });

    return offers.length > 0 ? offers : undefined;
}

export function mapHotel(hotel, context, searchData, page) {
    const nightlyPrice = hotel.cheapestPrice?.pricePerNight;
    const totalPrice = hotel.cheapestPrice?.priceTotal;
    const review = hotel.reviewSummary;
    const mapMarker = searchData.mapContent?.mapMarkers?.find((marker) => String(marker.id) === String(hotel.id));
    const imageUrls = Array.isArray(hotel.images)
        ? hotel.images.map((image) => image?.url).filter((url) => typeof url === 'string' && url)
        : [];

    return cleanRecord({
        hotelId: hotel.id,
        hotelName: hotel.name,
        starRating: hotel.stars?.level,
        starLabel: hotel.stars?.label,
        detailsPageUrl: hotel.detailsPageUrl,
        canonicalHotelUrl: getCanonicalHotelUrl(hotel.detailsPageUrl),
        distanceDescription: hotel.distance?.distanceDescription,
        distanceEntity: hotel.distance?.entity,
        latitude: mapMarker?.coordinates?.latitude,
        longitude: mapMarker?.coordinates?.longitude,
        reviewScore: review?.score,
        reviewScoreDescription: review?.scoreDescription,
        reviewCount: review?.reviewCount,
        ratingProvider: review?.ratingProvider,
        scoreImageUrl: review?.scoreImageUrl,
        imageUrls,
        pricePerNight: nightlyPrice?.displayPrice,
        pricePerNightWithoutDiscount: nightlyPrice?.displayPriceWithoutDiscount,
        pricePerNightWithTaxes: nightlyPrice?.priceWithAllTaxes,
        totalPrice: totalPrice?.displayPrice,
        totalPriceWithoutDiscount: totalPrice?.displayPriceWithoutDiscount,
        totalPriceWithTaxes: totalPrice?.priceWithAllTaxes,
        partnerOffers: mapPartnerOffers(hotel.partnerOffers),
        inbound: hotel.inbound,
        sourcePage: page,
        sourceUrl: context.searchUrl,
        entityId: context.entityId,
        location: context.locationName || searchData.searchSummary?.searchTarget?.entity?.name,
        market: context.market,
        locale: context.locale,
        currency: context.currency,
        checkin: context.checkin,
        checkout: context.checkout,
        adults: context.adults,
        rooms: context.rooms,
        scrapedAt: new Date().toISOString(),
    });
}

async function run() {
    const input = await loadInput();
    const {
        url,
        location,
        sortBy = 'best',
        checkin,
        checkout,
        adults,
        childrenAges,
        rooms,
        market,
        locale,
        currency,
        results_wanted: resultsWantedRaw = 20,
        max_pages: maxPagesRaw = 5,
        proxyConfiguration,
    } = input;

    const resultsWanted = normalizePositiveInteger(resultsWantedRaw, 20);
    const maxPages = normalizePositiveInteger(maxPagesRaw, 5);
    const sortType = SORT_TYPES[sortBy];
    if (!sortType) throw new Error(`Unsupported sortBy value: ${sortBy}`);

    const clientManager = new ClientManager(proxyConfiguration);
    await clientManager.init();
    const context = await resolveSearchContext(clientManager, {
        url,
        location,
        checkin,
        checkout,
        adults,
        childrenAges,
        rooms,
        market,
        locale,
        currency,
    });

    log.info(
        `Start run | target=${resultsWanted} | max_pages=${maxPages} | entity=${context.entityId} | sort=${sortBy}`,
    );

    const seen = new Set();
    let saved = 0;
    let pagesProcessed = 0;
    let stopReason = 'max_pages';
    let sessionToken;

    for (let page = 0; page < maxPages && saved < resultsWanted; page++) {
        const offset = page * API_PAGE_SIZE;
        const payload = buildSearchPayload(context, offset, sortType, sessionToken);
        const data =
            page === 0
                ? await fetchInitialSearch(clientManager, context, payload)
                : await fetchSearchPageWithStatusRecovery(
                      clientManager,
                      context,
                      payload,
                      `Hotel search page ${page + 1}`,
                  );
        pagesProcessed++;
        sessionToken = data.sessionToken || sessionToken;

        if (data.hotels.length === 0) {
            stopReason = 'no_more_hotels';
            break;
        }

        const batch = [];
        for (const hotel of data.hotels) {
            if (saved + batch.length >= resultsWanted) break;
            const hotelId = String(hotel.id || '');
            if (!hotelId || seen.has(hotelId)) continue;
            seen.add(hotelId);
            batch.push(mapHotel(hotel, context, data, page + 1));
        }

        if (batch.length > 0) {
            await Actor.pushData(batch);
            saved += batch.length;
            log.info(`Saved ${batch.length} hotels. Total: ${saved}/${resultsWanted}.`);
        }

        const totalHotels = Number(data.searchSummary?.hotelTotal);
        if (Number.isSafeInteger(totalHotels) && totalHotels > 0 && offset + data.hotels.length >= totalHotels) {
            stopReason = 'last_page';
            break;
        }

        if (page + 1 >= maxPages) stopReason = 'max_pages';
    }

    if (saved >= resultsWanted) stopReason = 'result_limit';
    if (saved === 0) log.warning('The run completed successfully, but no hotels matched the supplied search.');
    log.info(`Done | saved=${saved} | pages=${pagesProcessed} | stop_reason=${stopReason}`);
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
    await Actor.init();

    try {
        await run();
        await Actor.exit();
    } catch (error) {
        log.exception(error, 'Run failed.');
        throw error;
    }
}
