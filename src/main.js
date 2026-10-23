import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { Actor, log } from 'apify';
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

const HOTEL_SEARCH_PATH = '/g/hotel-unified-bff/v1/hotelsearch';
const AUTOSUGGEST_PATH = '/g/autosuggest-search/api/v1/search-hotel';
const API_PAGE_SIZE = 35;
const MAX_RETRIES = 3;
const LOCATION_MAX_ATTEMPTS = 8;
const MAX_RESTARTS = 3;
const MAX_ROTATIONS = 16;
const MAX_SEARCH_POLLS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 8_000;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const SKYSCANNER_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*skyscanner\.[a-z.]{2,}$/i;
const DEFAULT_HOSTS = ['www.skyscanner.com', 'www.skyscanner.net'];

const PROFILE_LADDER = Object.freeze([
    { browser: 'okhttp5', http3: false },
    { browser: 'okhttp3', http3: false },
    { browser: 'chrome142', http3: true },
    { browser: 'ios18', http3: true },
    { browser: 'chrome', http3: false },
    { browser: 'firefox144', http3: false },
    { browser: 'okhttp4', http3: false },
    { browser: 'chrome131', http3: false },
]);

export const SORT_TYPES = Object.freeze({
    best: 'SORT_TYPE_BEST_DESC',
    price_low: 'SORT_TYPE_PRICE_ASC',
    price_high: 'SORT_TYPE_PRICE_DESC',
    rating: 'SORT_TYPE_RATING_DESC',
    stars_high: 'SORT_TYPE_STARS_DESC',
    stars_low: 'SORT_TYPE_STARS_ASC',
    distance: 'SORT_TYPE_DISTANCE_ASC',
});

const MARKET_DEFAULTS = Object.freeze({
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
});

const TLD_MARKETS = Object.freeze({
    'co.uk': 'UK',
    com: 'US',
    net: 'UK',
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
});

const wait = (milliseconds) =>
    new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });

function backoffMs(attempt) {
    return Math.min(MAX_BACKOFF_MS, 750 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
}

function retryAfterMs(response) {
    const value = response?.headers?.get?.('retry-after');
    if (!value) return undefined;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_BACKOFF_MS);

    const date = Date.parse(value);
    if (Number.isNaN(date)) return undefined;
    return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
}

export function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeText(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function tryParseSkyscannerUrl(value) {
    try {
        return validateSkyscannerUrl(value);
    } catch {
        return undefined;
    }
}

function inferMarket(hostname) {
    const suffix = hostname.split('.').slice(-2).join('.');
    return TLD_MARKETS[suffix] || TLD_MARKETS[hostname.split('.').at(-1)] || 'US';
}

function formatUtcDate(date) {
    return date.toISOString().slice(0, 10);
}

function parseUtcDate(value, name) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${name} must use YYYY-MM-DD format.`);
    }

    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error(`${name} is not a valid calendar date.`);
    }

    return date;
}

export function normalizeStayDates(checkinValue, checkoutValue, now = new Date()) {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    let checkinDate = checkinValue ? parseUtcDate(checkinValue, 'checkin') : undefined;
    let checkoutDate = checkoutValue ? parseUtcDate(checkoutValue, 'checkout') : undefined;

    if (!checkinDate && !checkoutDate) {
        checkinDate = new Date(tomorrow);
        checkoutDate = new Date(tomorrow);
        checkoutDate.setUTCDate(checkoutDate.getUTCDate() + 1);
    } else if (!checkinDate) {
        checkinDate = new Date(checkoutDate);
        checkinDate.setUTCDate(checkinDate.getUTCDate() - 1);
    } else if (!checkoutDate) {
        checkoutDate = new Date(checkinDate);
        checkoutDate.setUTCDate(checkoutDate.getUTCDate() + 1);
    }

    if (checkoutDate <= checkinDate) throw new Error('checkout must be after checkin.');

    const stayLength = Math.round((checkoutDate - checkinDate) / MS_PER_DAY);
    if (checkinDate < tomorrow) {
        const adjustedCheckout = new Date(tomorrow);
        adjustedCheckout.setUTCDate(adjustedCheckout.getUTCDate() + stayLength);
        return {
            checkin: formatUtcDate(tomorrow),
            checkout: formatUtcDate(adjustedCheckout),
            adjusted: true,
        };
    }

    return { checkin: formatUtcDate(checkinDate), checkout: formatUtcDate(checkoutDate), adjusted: false };
}

function synchronizeSearchUrl(searchUrl, { checkin, checkout, adults, rooms }) {
    const url = new URL(searchUrl);
    url.searchParams.set('checkin', checkin);
    url.searchParams.set('checkout', checkout);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('rooms', String(rooms));
    return url.toString();
}

function createHttpError(label, status, responseText) {
    const preview = String(responseText || '')
        .replaceAll(/\s+/g, ' ')
        .slice(0, 200);
    const error = new Error(`${label} failed with HTTP ${status}: ${preview || 'empty response'}`);
    error.httpStatus = status;
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

function isRetryableStatus(status) {
    return status === 403 || status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function isBlockPayload(json) {
    if (!json || typeof json !== 'object') return false;
    if (String(json.reason || '').toLowerCase() === 'blocked') return true;
    const redirect = String(json.redirect_to || json.redirectTo || '');
    return /\/sttc\/px\/|captcha|perimeterx/i.test(redirect);
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

function createClient({ browser, http3 }, proxyUrl) {
    return new Impit({
        browser,
        timeout: REQUEST_TIMEOUT_MS,
        cookieJar: new CookieJar(),
        ...(http3 ? { http3: true } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
    });
}

class SessionManager {
    constructor({ proxyConfiguration, hosts }) {
        this.proxyConfiguration = proxyConfiguration;
        this.hosts = hosts;
        this.proxy = undefined;
        this.comboIndex = 0;
        this.hostIndex = 0;
        this.rotations = 0;
        this.session = undefined;
    }

    async init() {
        this.proxy = await createProxyConfiguration(this.proxyConfiguration);
        await this.openSession();
    }

    get current() {
        return this.session;
    }

    get host() {
        return this.session.host;
    }

    async openSession() {
        const combo = PROFILE_LADDER[this.comboIndex % PROFILE_LADDER.length];
        const host = this.hosts[this.hostIndex % this.hosts.length];
        const sessionId = `skyscanner${randomUUID().replaceAll('-', '').slice(0, 14)}`;
        const proxyUrl = this.proxy ? await this.proxy.newUrl(sessionId) : undefined;
        const client = createClient(combo, proxyUrl);

        this.session = { ...combo, host, client };
        log.debug(
            `Session opened: ${combo.browser}${combo.http3 ? ' with HTTP/3' : ''} on ${host}${proxyUrl ? ' through a fresh proxy session' : ''}.`,
        );
    }

    async rotate(reason) {
        if (this.rotations >= MAX_ROTATIONS) return false;

        for (let step = 0; step < PROFILE_LADDER.length * this.hosts.length && this.rotations < MAX_ROTATIONS; step++) {
            this.rotations++;
            this.hostIndex++;
            if (this.hostIndex >= this.hosts.length) {
                this.hostIndex = 0;
                this.comboIndex++;
            }

            try {
                await this.openSession();
                log.debug(
                    `Switched request session after ${reason}. Now using ${this.session.browser} on ${this.session.host}.`,
                );
                return true;
            } catch (error) {
                log.debug(
                    `Session profile ${PROFILE_LADDER[this.comboIndex % PROFILE_LADDER.length].browser} is unavailable: ${error.message}`,
                );
            }
        }

        return false;
    }
}

async function requestJson(sessionManager, { path, method = 'GET', headers, body, label, maxAttempts = MAX_RETRIES }) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const session = sessionManager.current;
        const url = `https://${session.host}${path}`;
        let response;
        let responseText;

        try {
            response = await session.client.fetch(url, {
                method,
                timeout: REQUEST_TIMEOUT_MS,
                headers: headers(session.host),
                body,
                ...(session.http3 ? { forceHttp3: true } : {}),
            });
            responseText = await response.text();
        } catch (error) {
            lastError = createRetryableError(`${label} request failed: ${error.message}`);
            if (attempt === maxAttempts) break;
            log.debug(`Retry ${attempt}/${maxAttempts} for ${label}: ${error.message}.`);
            if (!(await sessionManager.rotate('a transport error'))) break;
            await wait(backoffMs(attempt));
            continue;
        }

        let json;
        try {
            json = responseText ? JSON.parse(responseText) : undefined;
        } catch {
            json = undefined;
        }

        if (response.ok && json !== undefined && !isBlockPayload(json)) {
            return json;
        }

        if (response.ok && isBlockPayload(json)) {
            lastError = createRetryableError(`${label} was blocked by the site's bot protection.`);
        } else if (response.ok) {
            lastError = createRetryableError(`${label} returned a response that was not JSON.`);
        } else if (isRetryableStatus(response.status)) {
            lastError = createRetryableError(createHttpError(label, response.status, responseText).message);
        } else {
            throw createHttpError(label, response.status, responseText);
        }

        if (attempt === maxAttempts) break;

        let failureReason = `HTTP ${response.status}`;
        if (response.ok) {
            failureReason = isBlockPayload(json) ? 'bot protection block' : 'non-JSON response';
        }
        log.debug(`Retry ${attempt}/${maxAttempts} for ${label}: ${failureReason}.`);

        if (!(await sessionManager.rotate(failureReason))) break;

        const delay = retryAfterMs(response) ?? backoffMs(attempt);
        await wait(delay);
    }

    throw lastError || createRetryableError(`${label} failed after ${maxAttempts} attempts.`);
}

function searchHeaders(host, entityId) {
    return {
        'content-type': 'text/plain;charset=UTF-8',
        'x-user-agent': 'D;Web',
        traffic_source: 'Unknown',
        app_name: 'web',
        origin: `https://${host}`,
        referer: `https://${host}/hotels/search?entity_id=${entityId}`,
        'Skyscanner-Correlation-ID': randomUUID(),
    };
}

function autosuggestHeaders(host) {
    return {
        referer: `https://${host}/hotels`,
        'x-user-agent': 'D;Web',
        app_name: 'web',
        'Skyscanner-Correlation-ID': randomUUID(),
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

async function resolveLocation(sessionManager, location, market, locale) {
    const value = String(location).trim();
    if (!value) throw new Error('Location cannot be empty.');

    if (/^\d+$/.test(value)) return { entityId: value, locationName: undefined };

    const urlEntityId = getEntityIdFromUrl(value);
    if (urlEntityId) return { entityId: urlEntityId, locationName: undefined };

    if (tryParseSkyscannerUrl(value)) {
        throw new Error('The supplied Skyscanner URL must contain entity_id, ci-, or ai- destination information.');
    }

    const path = `${AUTOSUGGEST_PATH}/${market}/${locale}/${encodeURIComponent(value)}?rf=map&vrows=10`;
    const data = await requestJson(sessionManager, {
        path,
        headers: autosuggestHeaders,
        label: `Location lookup for "${value}"`,
        maxAttempts: LOCATION_MAX_ATTEMPTS,
    });

    const place = findAutosuggestEntity(data);
    if (!place?.entityId) {
        throw new Error(`No Skyscanner destination was found for location: ${value}`);
    }

    return { entityId: place.entityId, locationName: place.name };
}

function selectHosts(inputHost) {
    const hosts = [];
    if (inputHost && SKYSCANNER_HOST_PATTERN.test(inputHost)) hosts.push(inputHost);
    for (const host of DEFAULT_HOSTS) {
        if (!hosts.includes(host)) hosts.push(host);
    }
    return hosts;
}

async function resolveSearchContext(sessionManager, input) {
    const suppliedUrl = normalizeText(input.url);
    const suppliedLocation = normalizeText(input.location);

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
        const locationUrl = tryParseSkyscannerUrl(suppliedLocation);
        const marketHint = normalizeText(input.market) || (locationUrl ? inferMarket(locationUrl.hostname) : 'US');
        const marketDefaults = MARKET_DEFAULTS[marketHint] || MARKET_DEFAULTS.US;
        const resolved = await resolveLocation(
            sessionManager,
            suppliedLocation,
            marketHint,
            normalizeText(input.locale) || marketDefaults.locale,
        );
        entityId = resolved.entityId;
        locationName = resolved.locationName;
        if (locationUrl) {
            searchUrl = suppliedLocation;
            urlObject = locationUrl;
        }
    } else {
        throw new Error('Provide a Skyscanner search URL or a location.');
    }

    const query = urlObject?.searchParams;
    const stayDates = normalizeStayDates(
        input.checkin || query?.get('checkin'),
        input.checkout || query?.get('checkout'),
    );
    const { checkin, checkout } = stayDates;

    const adults = Math.min(normalizePositiveInteger(input.adults || query?.get('adults'), 2), 16);
    const rooms = Math.min(normalizePositiveInteger(input.rooms || query?.get('rooms'), 1), 8);
    const childrenAges = [];

    const market =
        normalizeText(input.market) || query?.get('market') || (urlObject ? inferMarket(urlObject.hostname) : 'US');
    const marketDefaults = MARKET_DEFAULTS[market] || MARKET_DEFAULTS.US;
    const locale = normalizeText(input.locale) || query?.get('locale') || marketDefaults.locale;
    const currency = normalizeText(input.currency) || query?.get('currency') || marketDefaults.currency;

    if (!searchUrl) {
        const searchParams = new URLSearchParams({
            entity_id: entityId,
            checkin,
            checkout,
            adults: String(adults),
            rooms: String(rooms),
            market,
            locale,
            currency,
        });
        searchUrl = `https://www.skyscanner.com/hotels/search?${searchParams}`;
    }

    searchUrl = synchronizeSearchUrl(searchUrl, { checkin, checkout, adults, rooms });
    if (stayDates.adjusted) {
        log.warning(`Adjusted the stay dates to ${checkin} through ${checkout} so they are bookable.`);
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

async function fetchSearchPage(sessionManager, context, payload, label) {
    return requestJson(sessionManager, {
        path: HOTEL_SEARCH_PATH,
        method: 'POST',
        headers: (host) => searchHeaders(host, context.entityId),
        body: JSON.stringify(payload),
        label,
    });
}

async function fetchSearchPageWithPolling(sessionManager, context, payload, label) {
    let data = await fetchSearchPage(sessionManager, context, payload, label);
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
            sessionManager,
            context,
            { ...payload, sessionToken: data.sessionToken },
            `${label} poll ${poll}`,
        );
    }

    if (!Array.isArray(data?.hotels)) {
        const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : 'none';
        throw createRetryableError(
            `The hotel search response is missing its hotels array. Response keys: ${keys}. Check API_DISCOVERY.md for the current response shape.`,
        );
    }

    if (data.searchStatus === 'SEARCH_STATUS_FAILED') {
        throw createRetryableError('Skyscanner marked the hotel search as failed.');
    }

    if (data.searchStatus !== 'SEARCH_STATUS_COMPLETED' && data.hotels.length === 0) {
        throw createRetryableError(`The hotel search did not complete after ${MAX_SEARCH_POLLS} polls.`);
    }

    return data;
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

function getInputHost(input) {
    const suppliedUrl = normalizeText(input.url);
    if (!suppliedUrl) return undefined;

    try {
        return new URL(suppliedUrl).hostname;
    } catch {
        return undefined;
    }
}

async function run() {
    const input = (await Actor.getInput()) || {};
    const {
        sortBy = 'best',
        results_wanted: resultsWantedRaw = 20,
        max_pages: maxPagesRaw = 5,
        proxyConfiguration,
    } = input;

    const resultsWanted = normalizePositiveInteger(resultsWantedRaw, 20);
    const maxPages = normalizePositiveInteger(maxPagesRaw, 5);
    const sortType = SORT_TYPES[sortBy];
    if (!sortType) throw new Error(`Unsupported sortBy value: ${sortBy}`);

    const inputHost = getInputHost(input);
    const sessionManager = new SessionManager({
        proxyConfiguration,
        hosts: selectHosts(inputHost),
    });
    await sessionManager.init();

    const context = await resolveSearchContext(sessionManager, input);

    log.info(
        `Start run | target=${resultsWanted} | max_pages=${maxPages} | entity=${context.entityId} | sort=${sortBy} | host=${sessionManager.host}`,
    );

    const seen = new Set();
    const completedPages = new Set();
    let saved = 0;
    let restarts = 0;
    let nextPage = 0;
    let offset = 0;
    let sessionToken;
    let stopReason = 'max_pages';

    while (saved < resultsWanted && nextPage < maxPages) {
        const payload = buildSearchPayload(context, offset, sortType, sessionToken);

        try {
            const data = await fetchSearchPageWithPolling(
                sessionManager,
                context,
                payload,
                `Hotel search page ${nextPage + 1}`,
            );

            sessionToken = data.sessionToken || sessionToken;
            completedPages.add(nextPage);

            if (data.hotels.length === 0) {
                stopReason = 'no_more_hotels';
                break;
            }

            const batch = [];
            for (const hotel of data.hotels) {
                if (saved + batch.length >= resultsWanted) break;
                if (!hotel || typeof hotel !== 'object') continue;
                const hotelId = String(hotel.id || '');
                if (!hotelId || seen.has(hotelId)) continue;
                seen.add(hotelId);
                try {
                    batch.push(mapHotel(hotel, context, data, nextPage + 1));
                } catch (error) {
                    log.debug(`Skipped hotel ${hotelId} because it could not be mapped: ${error.message}`);
                }
            }

            if (batch.length > 0) {
                await Actor.pushData(batch);
                saved += batch.length;
                log.info(`Saved ${batch.length} hotels. Total: ${saved}/${resultsWanted}.`);
            }

            if (saved >= resultsWanted) {
                stopReason = 'result_limit';
                break;
            }

            const totalHotels = Number(data.searchSummary?.hotelTotal);
            if (Number.isSafeInteger(totalHotels) && totalHotels > 0 && offset + data.hotels.length >= totalHotels) {
                stopReason = 'last_page';
                break;
            }

            offset += data.hotels.length;
            nextPage++;
        } catch (error) {
            if (!isRetryableError(error) || restarts >= MAX_RESTARTS) throw error;

            restarts++;
            log.debug(
                `Page ${nextPage + 1} could not be completed (${error.message}). Restarting the search (${restarts}/${MAX_RESTARTS}).`,
            );

            await wait(1_500 + restarts * 1_000);
            if (!(await sessionManager.rotate('a failed search page'))) throw error;

            nextPage = 0;
            offset = 0;
            sessionToken = undefined;
        }
    }

    if (saved >= resultsWanted) stopReason = 'result_limit';
    if (saved === 0) {
        log.warning('The run finished, but no hotels matched the supplied search. Check the destination and dates.');
    }
    log.info(`Done | saved=${saved} | pages=${completedPages.size} | restarts=${restarts} | stop_reason=${stopReason}`);
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
    await Actor.init();

    try {
        await run();
        await Actor.exit();
    } catch (error) {
        log.exception(
            error,
            'Run failed. Read API_DISCOVERY.md, then inspect the failing request before changing the actor.',
        );
        throw error;
    }
}
