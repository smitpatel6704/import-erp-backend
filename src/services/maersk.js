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
