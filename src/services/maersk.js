import { chromium } from 'playwright-core';

const DEFAULT_API_BASE_URL = 'https://api.maersk.com';
const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

let tokenCache = {
    accessToken: null,
    expiresAt: 0,
};

const apiBaseUrl = () => String(process.env.MAERSK_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
const consumerKey = () => String(process.env.MAERSK_CONSUMER_KEY || '').trim();
const consumerSecret = () => String(process.env.MAERSK_CONSUMER_SECRET || '').trim();

export class MaerskApiError extends Error {
    constructor(message, status = 502, details = null) {
        super(message);
        this.name = 'MaerskApiError';
        this.status = status;
        this.details = details;
    }
}

const responseBody = async (response) => {
    const text = await response.text();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
};

const errorMessage = (body, fallback) => {
    if (typeof body === 'string')
        return body.slice(0, 500) || fallback;
    return body?.error_description ||
        body?.error?.[0]?.message ||
        body?.message ||
        body?.errorMessage ||
        fallback;
};

const requireConsumerKey = () => {
    const key = consumerKey();
    if (!key) {
        throw new MaerskApiError('MAERSK_CONSUMER_KEY is not configured', 503);
    }
    return key;
};

export const maerskConfigurationStatus = () => ({
    apiBaseUrl: apiBaseUrl(),
    referenceDataConfigured: Boolean(consumerKey()),
    trackAndTraceConfigured: Boolean(consumerKey() && consumerSecret()),
});

export async function getMaerskAccessToken() {
    const key = requireConsumerKey();
    const secret = consumerSecret();
    if (!secret) {
        throw new MaerskApiError('MAERSK_CONSUMER_SECRET is required for Ocean Track & Trace', 503);
    }
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
        return tokenCache.accessToken;
    }

    const response = await fetch(`${apiBaseUrl()}/customer-identity/oauth/v2/access_token`, {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            'Consumer-Key': key,
        },
        body: new URLSearchParams({
            client_id: key,
            client_secret: secret,
            grant_type: 'client_credentials',
        }),
    });
    const body = await responseBody(response);
    if (!response.ok || !body?.access_token) {
        throw new MaerskApiError(
            `Maersk OAuth failed: ${errorMessage(body, `HTTP ${response.status}`)}`,
            response.status || 502,
            body,
        );
    }

    const expiresInSeconds = Math.max(Number(body.expires_in) || 3600, 120);
    tokenCache = {
        accessToken: body.access_token,
        expiresAt: Date.now() + (expiresInSeconds * 1000) - TOKEN_EXPIRY_SAFETY_MS,
    };
    return tokenCache.accessToken;
}

async function maerskRequest(path, { query = {}, oauth = false } = {}) {
    const key = requireConsumerKey();
    const url = new URL(`${apiBaseUrl()}${path}`);
    for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0))
            continue;
        url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }

    const headers = {
        accept: 'application/json',
        'Consumer-Key': key,
    };
    if (oauth) {
        headers.Authorization = `Bearer ${await getMaerskAccessToken()}`;
        headers['API-Version'] = '1';
    }

    const response = await fetch(url, { headers });
    const body = await responseBody(response);
    if (!response.ok) {
        throw new MaerskApiError(
            `Maersk API failed: ${errorMessage(body, `HTTP ${response.status}`)}`,
            response.status || 502,
            body,
        );
    }
    return {
        data: body,
        pagination: {
            currentPage: response.headers.get('Current-Page'),
            nextPage: response.headers.get('Next-Page'),
            previousPage: response.headers.get('Previous-Page') || response.headers.get('Prev-Page'),
            lastPage: response.headers.get('Last-Page'),
            totalCount: response.headers.get('Total-Count'),
        },
    };
}

export async function fetchMaerskTrackingEvents(query) {
    return maerskRequest('/track-and-trace-private/events', {
        query: {
            ...query,
            limit: query.limit || 100,
            sort: query.sort || 'eventDateTime:ASC',
        },
        oauth: true,
    });
}

export async function fetchMaerskVessels(filters = {}) {
    return maerskRequest('/reference-data/vessels', {
        query: {
            vesselIMONumbers: filters.vesselIMONumbers,
            carrierVesselCodes: filters.carrierVesselCodes,
            vesselNames: filters.vesselNames,
            vesselFlagCodes: filters.vesselFlagCodes,
        },
    });
}

export async function fetchMaerskLocations(filters = {}) {
    return maerskRequest('/reference-data/locations', {
        query: {
            locationType: filters.locationType,
            countryCode: filters.countryCode,
            countryName: filters.countryName,
            cityName: filters.cityName,
            UNRegionCode: filters.UNRegionCode,
            UNLocationCode: filters.UNLocationCode,
            vesselOperatorCarrierCode: filters.vesselOperatorCarrierCode,
            sort: filters.sort,
            limit: filters.limit,
            page: filters.page,
        },
    });
}

const isServerless = () => Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const localChromeExecutablePath = () => process.env.CHROME_EXECUTABLE_PATH ||
    (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined);

/**
 * Scrape Maersk public tracking page using Playwright.
 * Accepts a BL number, container number, or booking number.
 * Returns the standard tracking result format.
 */
export async function scrapeMaerskPublicTracking(trackingNo) {
    const trackingUrl = `https://www.maersk.com/tracking/${encodeURIComponent(trackingNo)}`;

    let executablePath = localChromeExecutablePath();
    let additionalArgs = [];
    if (isServerless() || process.platform === 'linux') {
        const { default: serverlessChromium } = await import('@sparticuz/chromium');
        executablePath = await serverlessChromium.executablePath();
        additionalArgs = serverlessChromium.args;
    }

    const browser = await chromium.launch({
        headless: process.env.MAERSK_SCRAPER_HEADLESS !== 'false',
        executablePath,
        args: [
            ...additionalArgs,
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ],
    });

    try {
        const context = await browser.newContext({
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            viewport: null,
        });

        const page = await context.newPage();

        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        const clean = (v = '') => String(v).replace(/\s+/g, ' ').trim();
        const toDate = (dateText = '') => {
            const d = new Date(dateText);
            return Number.isNaN(d.getTime()) ? null : d;
        };

        await page.goto(trackingUrl, {
            waitUntil: 'networkidle',
            timeout: 120000,
        });

        // Dismiss cookie consent banner if it appears
        try {
            await page.getByRole('button', { name: /allow all/i }).click({ timeout: 8000 });
        } catch { /* Cookie banner may not appear */ }

        await page.waitForFunction(
            () => {
                const text = document.body.innerText;
                return text.includes('Bill of Lading number') || text.includes('No results found');
            },
            { timeout: 90000 },
        );

        await page.waitForTimeout(3000);

        const text = await page.locator('body').innerText();

        // No results
        if (text.includes('No results found') && !text.includes('Bill of Lading number')) {
            return {
                status: 'No results found',
                location: null,
                eta: null,
                etd: null,
                origin: null,
                originCountry: null,
                destination: null,
                vesselName: null,
                voyageNumber: null,
                containers: [],
                lastEvent: 'No results found on Maersk public tracking.',
                rawDetails: null,
                error: 'No results found on Maersk public tracking',
                url: trackingUrl,
            };
        }

        // ── Parse page text ───────────────────────────────────────────────
        const flatText = text.replace(/\s+/g, ' ').trim();
        const getMatch = (regex) => (flatText.match(regex)?.[1] || '').trim();

        const billOfLading = getMatch(/Bill of Lading number\s+([A-Z0-9]+)/i);
        const originPort = getMatch(/From\s+(\S+)\s+To/i);
        const destinationPort = getMatch(/To\s+(\S+)\s+(?:[A-Z]{4}\d{7}|Last updated)/i);
        const containerNumber = getMatch(/([A-Z]{4}\d{7})\s*\|/i);
        const rawContainerType = getMatch(/[A-Z]{4}\d{7}\s*\|\s*(.*?)\s+Last updated/i);

        // ── Timeline events ───────────────────────────────────────────────
        const vesselEventRegex =
            /(Vessel arrival|Vessel departure|Feeder arrival|Feeder departure|Load on|Discharge)\s*(?:\()?([A-Z\s\/0-9-]+?)(?:\))?\s+(\d{2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2})/gi;

        const events = [...flatText.matchAll(vesselEventRegex)].map((m) => ({
            event: clean(m[1]),
            vessel: clean(m[2]),
            dateText: clean(m[3]),
        }));

        const arrivals = events.filter((e) => /arrival/i.test(e.event));
        const departures = events.filter((e) => /departure/i.test(e.event));

        const finalArrival = arrivals[arrivals.length - 1];
        const firstDeparture = departures[0];
        const latestDeparture = departures[departures.length - 1];

        const etaText =
            getMatch(/Estimated arrival date\s+([\s\S]*?)\s+(?:Latest event|Note:)/i) ||
            finalArrival?.dateText ||
            '';
        const etdText = firstDeparture?.dateText || '';

        const vesselName =
            latestDeparture?.vessel?.split('/')[0]?.trim() ||
            finalArrival?.vessel?.split('/')[0]?.trim() ||
            firstDeparture?.vessel?.split('/')[0]?.trim() ||
            null;

        const voyageNumber =
            latestDeparture?.vessel?.split('/')[1]?.trim() ||
            finalArrival?.vessel?.split('/')[1]?.trim() ||
            firstDeparture?.vessel?.split('/')[1]?.trim() ||
            null;

        const latestEvent =
            getMatch(/Last updated:.*?(?:ago|Date)\s+(.*?)\s+Note:/i) ||
            getMatch(/Latest event\s+(.*?)\s+Note:/i) ||
            (latestDeparture
                ? `${latestDeparture.event} \u00b7 ${latestDeparture.vessel} \u00b7 ${latestDeparture.dateText}`
                : '');

        // ── Container size & type ─────────────────────────────────────────
        let containerSize = '';
        let containerType = rawContainerType || '';

        if (/40/i.test(rawContainerType)) containerSize = '40FT';
        else if (/20/i.test(rawContainerType)) containerSize = '20FT';
        else if (/45/i.test(rawContainerType)) containerSize = '45FT';

        if (/dry/i.test(rawContainerType)) containerType = 'Dry Container';
        else if (/reefer/i.test(rawContainerType)) containerType = 'Reefer Container';
        else if (/open/i.test(rawContainerType)) containerType = 'Open Top Container';
        else if (/flat/i.test(rawContainerType)) containerType = 'Flat Rack Container';

        // ── Build raw details ─────────────────────────────────────────────
        const timeline = events.map((e) =>
            [e.event, e.vessel, e.dateText].filter(Boolean).join(' - '),
        );

        const rawDetails = [
            `Bill of Lading: ${billOfLading || trackingNo}`,
            `From: ${originPort || '-'}`,
            `To: ${destinationPort || '-'}`,
            `Container: ${containerNumber || '-'}${rawContainerType ? ` | ${rawContainerType}` : ''}`,
            `ETA: ${etaText || '-'}`,
            `ETD: ${etdText || '-'}`,
            `Latest event: ${latestEvent || '-'}`,
            '',
            'Timeline:',
            ...timeline,
        ].join('\n');

        return {
            status: latestEvent || 'Tracking details available',
            location: destinationPort || null,
            eta: toDate(etaText),
            etd: toDate(etdText),
            origin: originPort || null,
            originCountry: null,
            destination: destinationPort || null,
            vesselName,
            voyageNumber,
            containers: containerNumber
                ? [{ containerNumber, containerSize, containerType }]
                : [],
            lastEvent: latestEvent ? `Latest event: ${latestEvent}` : null,
            rawDetails: rawDetails.slice(0, 12000),
            error: null,
            url: trackingUrl,
        };
    } finally {
        await browser.close();
    }
}
