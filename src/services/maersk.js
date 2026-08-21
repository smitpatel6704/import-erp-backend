import { chromium } from 'playwright-core';

const DEFAULT_API_BASE_URL = 'https://api.maersk.com';
const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

let tokenCache = {
    accessToken: null,
    expiresAt: 0,
};

const apiBaseUrl = () =>
    String(
        process.env.MAERSK_API_BASE_URL ||
        DEFAULT_API_BASE_URL
    ).replace(/\/+$/, '');

const consumerKey = () =>
    String(
        process.env.MAERSK_CONSUMER_KEY || ''
    ).trim();

const consumerSecret = () =>
    String(
        process.env.MAERSK_CONSUMER_SECRET || ''
    ).trim();

export class MaerskApiError extends Error {
    constructor(
        message,
        status = 502,
        details = null
    ) {
        super(message);

        this.name = 'MaerskApiError';
        this.status = status;
        this.details = details;
    }
}

const responseBody = async (response) => {
    const text = await response.text();

    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const errorMessage = (
    body,
    fallback
) => {
    if (typeof body === 'string') {
        return (
            body.slice(0, 500) ||
            fallback
        );
    }

    return (
        body?.error_description ||
        body?.error?.[0]?.message ||
        body?.message ||
        body?.errorMessage ||
        fallback
    );
};

const requireConsumerKey = () => {
    const key = consumerKey();

    if (!key) {
        throw new MaerskApiError(
            'MAERSK_CONSUMER_KEY is not configured',
            503
        );
    }

    return key;
};

export const maerskConfigurationStatus = () => ({
    apiBaseUrl: apiBaseUrl(),

    referenceDataConfigured:
        Boolean(
            consumerKey()
        ),

    trackAndTraceConfigured:
        Boolean(
            consumerKey() &&
            consumerSecret()
        ),
});

export async function getMaerskAccessToken() {
    const key =
        requireConsumerKey();

    const secret =
        consumerSecret();

    if (!secret) {
        throw new MaerskApiError(
            'MAERSK_CONSUMER_SECRET is required for Ocean Track & Trace',
            503
        );
    }

    if (
        tokenCache.accessToken &&
        Date.now() <
            tokenCache.expiresAt
    ) {
        return tokenCache.accessToken;
    }

    const response =
        await fetch(
            `${apiBaseUrl()}/customer-identity/oauth/v2/access_token`,
            {
                method: 'POST',

                headers: {
                    accept:
                        'application/json',

                    'content-type':
                        'application/x-www-form-urlencoded',

                    'Consumer-Key':
                        key,
                },

                body:
                    new URLSearchParams({
                        client_id:
                            key,

                        client_secret:
                            secret,

                        grant_type:
                            'client_credentials',
                    }),
            }
        );

    const body =
        await responseBody(
            response
        );

    if (
        !response.ok ||
        !body?.access_token
    ) {
        throw new MaerskApiError(
            `Maersk OAuth failed: ${errorMessage(
                body,
                `HTTP ${response.status}`
            )}`,
            response.status || 502,
            body
        );
    }

    const expiresInSeconds =
        Math.max(
            Number(
                body.expires_in
            ) || 3600,
            120
        );

    tokenCache = {
        accessToken:
            body.access_token,

        expiresAt:
            Date.now() +
            expiresInSeconds *
                1000 -
            TOKEN_EXPIRY_SAFETY_MS,
    };

    return tokenCache.accessToken;
}

async function maerskRequest(
    path,
    {
        query = {},
        oauth = false,
    } = {}
) {
    const key =
        requireConsumerKey();

    const url =
        new URL(
            `${apiBaseUrl()}${path}`
        );

    for (
        const [
            name,
            value,
        ] of Object.entries(
            query
        )
    ) {
        if (
            value === undefined ||
            value === null ||
            value === '' ||
            (
                Array.isArray(
                    value
                ) &&
                value.length === 0
            )
        ) {
            continue;
        }

        url.searchParams.set(
            name,
            Array.isArray(value)
                ? value.join(',')
                : String(value)
        );
    }

    const headers = {
        accept:
            'application/json',

        'Consumer-Key':
            key,
    };

    if (oauth) {
        headers.Authorization =
            `Bearer ${await getMaerskAccessToken()}`;

        headers['API-Version'] =
            '1';
    }

    const response =
        await fetch(
            url,
            {
                headers,
            }
        );

    const body =
        await responseBody(
            response
        );

    if (!response.ok) {
        throw new MaerskApiError(
            `Maersk API failed: ${errorMessage(
                body,
                `HTTP ${response.status}`
            )}`,
            response.status || 502,
            body
        );
    }

    return {
        data: body,

        pagination: {
            currentPage:
                response.headers.get(
                    'Current-Page'
                ),

            nextPage:
                response.headers.get(
                    'Next-Page'
                ),

            previousPage:
                response.headers.get(
                    'Previous-Page'
                ) ||
                response.headers.get(
                    'Prev-Page'
                ),

            lastPage:
                response.headers.get(
                    'Last-Page'
                ),

            totalCount:
                response.headers.get(
                    'Total-Count'
                ),
        },
    };
}

export async function fetchMaerskTrackingEvents(
    query
) {
    return maerskRequest(
        '/track-and-trace-private/events',
        {
            query: {
                ...query,

                limit:
                    query.limit ||
                    100,

                sort:
                    query.sort ||
                    'eventDateTime:ASC',
            },

            oauth: true,
        }
    );
}

export async function fetchMaerskVessels(
    filters = {}
) {
    return maerskRequest(
        '/reference-data/vessels',
        {
            query: {
                vesselIMONumbers:
                    filters.vesselIMONumbers,

                carrierVesselCodes:
                    filters.carrierVesselCodes,

                vesselNames:
                    filters.vesselNames,

                vesselFlagCodes:
                    filters.vesselFlagCodes,
            },
        }
    );
}

export async function fetchMaerskLocations(
    filters = {}
) {
    return maerskRequest(
        '/reference-data/locations',
        {
            query: {
                locationType:
                    filters.locationType,

                countryCode:
                    filters.countryCode,

                countryName:
                    filters.countryName,

                cityName:
                    filters.cityName,

                UNRegionCode:
                    filters.UNRegionCode,

                UNLocationCode:
                    filters.UNLocationCode,

                vesselOperatorCarrierCode:
                    filters.vesselOperatorCarrierCode,

                sort:
                    filters.sort,

                limit:
                    filters.limit,

                page:
                    filters.page,
            },
        }
    );
}

/*
|--------------------------------------------------------------------------
| Playwright / Vercel configuration
|--------------------------------------------------------------------------
*/

const isServerless = () =>
    Boolean(
        process.env.VERCEL ||
        process.env.AWS_LAMBDA_FUNCTION_NAME
    );

const localChromeExecutablePath = () =>
    process.env.CHROME_EXECUTABLE_PATH ||
    (
        process.platform ===
        'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : undefined
    );

/**
 * Scrape Maersk public tracking page using Playwright.
 *
 * Supports:
 * - BL number
 * - Container number
 * - Booking number
 *
 * Local:
 * Uses installed Google Chrome.
 *
 * Vercel:
 * Uses @sparticuz/chromium.
 */
export async function scrapeMaerskPublicTracking(
    trackingNo
) {
    console.log(
        `[Maersk Scraper] Starting tracking for ${trackingNo}...`
    );

    const trackingUrl =
        `https://www.maersk.com/tracking/${encodeURIComponent(
            trackingNo
        )}`;

    const serverless =
        isServerless();

    let executablePath =
        localChromeExecutablePath();

    let browserArgs = [
        '--disable-blink-features=AutomationControlled',
    ];

    /*
    |--------------------------------------------------------------------------
    | Vercel / Linux Chromium
    |--------------------------------------------------------------------------
    */

    if (
        serverless ||
        process.platform ===
            'linux'
    ) {
        console.log(
            '[Maersk Scraper] Loading serverless Chromium...'
        );

        const {
            default:
                serverlessChromium,
        } = await import(
            '@sparticuz/chromium'
        );

        executablePath =
            await serverlessChromium.executablePath();

        browserArgs = [
            ...serverlessChromium.args,

            '--disable-blink-features=AutomationControlled',

            '--disable-dev-shm-usage',
        ];
    }

    if (!executablePath) {
        throw new Error(
            'Chrome/Chromium executable path could not be resolved.'
        );
    }

    console.log(
        `[Maersk Scraper] Environment: ${
            serverless
                ? 'Vercel/Serverless'
                : 'Local'
        }`
    );

    console.log(
        `[Maersk Scraper] Chromium executable: ${executablePath}`
    );

    /*
    |--------------------------------------------------------------------------
    | Launch browser
    |--------------------------------------------------------------------------
    */

    const browser =
        await chromium.launch({
            /*
             * Vercel must always be headless.
             *
             * Local can be changed using:
             *
             * MAERSK_SCRAPER_HEADLESS=false
             */
            headless:
                serverless
                    ? true
                    : process.env
                          .MAERSK_SCRAPER_HEADLESS !==
                      'false',

            executablePath,

            args:
                browserArgs,
        });

    try {
        /*
        |--------------------------------------------------------------------------
        | Browser context
        |--------------------------------------------------------------------------
        */

        const context =
            await browser.newContext({
                userAgent:
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/137.0.0.0 Safari/537.36',

                viewport: {
                    width: 1280,
                    height: 720,
                },

                locale:
                    'en-US',

                javaScriptEnabled:
                    true,

                ignoreHTTPSErrors:
                    true,
            });

        const page =
            await context.newPage();

        /*
        |--------------------------------------------------------------------------
        | Reduce Vercel bandwidth + memory
        |--------------------------------------------------------------------------
        |
        | We only need page text.
        |
        | Images, fonts and videos are not required.
        |
        */

        await page.route(
            '**/*',
            async (route) => {
                const request =
                    route.request();

                const resourceType =
                    request.resourceType();

                if (
                    resourceType ===
                        'image' ||
                    resourceType ===
                        'font' ||
                    resourceType ===
                        'media'
                ) {
                    await route.abort();

                    return;
                }

                await route.continue();
            }
        );

        /*
        |--------------------------------------------------------------------------
        | Basic webdriver hiding
        |--------------------------------------------------------------------------
        */

        await page.addInitScript(
            () => {
                Object.defineProperty(
                    navigator,
                    'webdriver',
                    {
                        get:
                            () =>
                                undefined,
                    }
                );
            }
        );

        /*
        |--------------------------------------------------------------------------
        | Default timeouts
        |--------------------------------------------------------------------------
        */

        page.setDefaultTimeout(
            45000
        );

        page.setDefaultNavigationTimeout(
            60000
        );

        const clean = (
            value = ''
        ) =>
            String(value)
                .replace(
                    /\s+/g,
                    ' '
                )
                .trim();

        const toDate = (
            dateText = ''
        ) => {
            const date =
                new Date(
                    dateText
                );

            return Number.isNaN(
                date.getTime()
            )
                ? null
                : date;
        };

        /*
        |--------------------------------------------------------------------------
        | Navigate
        |--------------------------------------------------------------------------
        */

        console.log(
            `[Maersk Scraper] Navigating to ${trackingUrl}...`
        );

        await page.goto(
            trackingUrl,
            {
                waitUntil:
                    'domcontentloaded',

                timeout:
                    60000,
            }
        );

        /*
        |--------------------------------------------------------------------------
        | Cookie consent
        |--------------------------------------------------------------------------
        */

        try {
            await page
                .getByRole(
                    'button',
                    {
                        name:
                            /allow all/i,
                    }
                )
                .click({
                    timeout:
                        5000,
                });
        } catch {
            // Cookie banner may not appear.
        }

        /*
        |--------------------------------------------------------------------------
        | Wait for tracking result
        |--------------------------------------------------------------------------
        */

        console.log(
            '[Maersk Scraper] Waiting for tracking results...'
        );

        await page.waitForFunction(
            () => {
                const text =
                    document
                        .body
                        ?.innerText ||
                    '';

                return (
                    /Bill of Lading number\s+[A-Z0-9]{9}/i.test(
                        text
                    ) ||
                    /[A-Z]{4}\d{7}\s*\|/i.test(
                        text
                    ) ||
                    text.includes(
                        "couldn't find"
                    ) ||
                    text.includes(
                        'No results found'
                    )
                );
            },
            {
                timeout:
                    45000,
            }
        );

        /*
         * Short buffer because Maersk may still be
         * rendering timeline elements.
         */
        await page.waitForTimeout(
            1000
        );

        console.log(
            '[Maersk Scraper] Extracting page text...'
        );

        const text =
            await page
                .locator('body')
                .innerText();

        /*
        |--------------------------------------------------------------------------
        | No result
        |--------------------------------------------------------------------------
        */

        if (
            text.includes(
                'No results found'
            ) ||
            text.includes(
                "couldn't find"
            )
        ) {
            return {
                status:
                    'No results found',

                location:
                    null,

                eta:
                    null,

                etd:
                    null,

                origin:
                    null,

                originCountry:
                    null,

                destination:
                    null,

                vesselName:
                    null,

                voyageNumber:
                    null,

                containers:
                    [],

                lastEvent:
                    'No results found on Maersk public tracking.',

                rawDetails:
                    null,

                error:
                    'No results found on Maersk public tracking',

                url:
                    trackingUrl,
            };
        }

        /*
        |--------------------------------------------------------------------------
        | Normalize page text
        |--------------------------------------------------------------------------
        */

        const flatText =
            text
                .replace(
                    /\s+/g,
                    ' '
                )
                .trim();

        const getMatch = (
            regex
        ) =>
            (
                flatText.match(
                    regex
                )?.[1] ||
                ''
            ).trim();

        /*
        |--------------------------------------------------------------------------
        | Main tracking data
        |--------------------------------------------------------------------------
        */

        const billOfLading =
            getMatch(
                /Bill of Lading number\s+([A-Z0-9]{9})/i
            );

        const originPort =
            getMatch(
                /From\s+(\S+)\s+To/i
            );

        const destinationPort =
            getMatch(
                /To\s+(\S+)\s+(?:[A-Z]{4}\d{7}|Last updated)/i
            );

        const containerNumber =
            getMatch(
                /([A-Z]{4}\d{7})\s*\|/i
            );

        const rawContainerType =
            getMatch(
                /[A-Z]{4}\d{7}\s*\|\s*(.*?)\s+Last updated/i
            );

        /*
        |--------------------------------------------------------------------------
        | Timeline
        |--------------------------------------------------------------------------
        */

        const vesselEventRegex =
            /(Vessel arrival|Vessel departure|Feeder arrival|Feeder departure|Load on|Discharge)\s*(?:\()?([A-Z\s\/0-9-]+?)(?:\))?\s+(\d{2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2})/gi;

        const events = [
            ...flatText.matchAll(
                vesselEventRegex
            ),
        ].map(
            (match) => ({
                event:
                    clean(
                        match[1]
                    ),

                vessel:
                    clean(
                        match[2]
                    ),

                dateText:
                    clean(
                        match[3]
                    ),
            })
        );

        const arrivals =
            events.filter(
                (event) =>
                    /arrival/i.test(
                        event.event
                    )
            );

        const departures =
            events.filter(
                (event) =>
                    /departure/i.test(
                        event.event
                    )
            );

        const finalArrival =
            arrivals[
                arrivals.length -
                    1
            ];

        const firstDeparture =
            departures[0];

        const latestDeparture =
            departures[
                departures.length -
                    1
            ];

        const latestTimelineEvent =
            events
                .map(
                    (
                        event,
                        index
                    ) => ({
                        event,

                        index,

                        timestamp:
                            toDate(
                                event.dateText
                            )
                                ?.getTime() ||
                            0,
                    })
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        a.timestamp -
                            b.timestamp ||
                        a.index -
                            b.index
                )
                .at(-1)
                ?.event;

        /*
        |--------------------------------------------------------------------------
        | ETA / ETD
        |--------------------------------------------------------------------------
        */

        const etaText =
            getMatch(
                /Estimated arrival date\s+([\s\S]*?)\s+(?:Latest event|Note:)/i
            ) ||
            finalArrival
                ?.dateText ||
            '';

        const etdText =
            firstDeparture
                ?.dateText ||
            '';

        /*
        |--------------------------------------------------------------------------
        | Vessel
        |--------------------------------------------------------------------------
        */

        const vesselName =
            latestDeparture
                ?.vessel
                ?.split('/')[0]
                ?.trim() ||
            finalArrival
                ?.vessel
                ?.split('/')[0]
                ?.trim() ||
            firstDeparture
                ?.vessel
                ?.split('/')[0]
                ?.trim() ||
            null;

        const voyageNumber =
            latestDeparture
                ?.vessel
                ?.split('/')[1]
                ?.trim() ||
            finalArrival
                ?.vessel
                ?.split('/')[1]
                ?.trim() ||
            firstDeparture
                ?.vessel
                ?.split('/')[1]
                ?.trim() ||
            null;

        /*
        |--------------------------------------------------------------------------
        | Latest event
        |--------------------------------------------------------------------------
        */

        const latestEvent =
            getMatch(
                /Last updated:.*?(?:ago|Date)\s+(.*?)\s+Note:/i
            ) ||
            getMatch(
                /Latest event\s+(.*?)\s+Note:/i
            ) ||
            (
                latestTimelineEvent
                    ? `${latestTimelineEvent.event} · ${latestTimelineEvent.vessel} · ${latestTimelineEvent.dateText}`
                    : ''
            );

        /*
        |--------------------------------------------------------------------------
        | Container size + type
        |--------------------------------------------------------------------------
        */

        let containerSize =
            '';

        let containerType =
            rawContainerType ||
            '';

        if (
            /40/i.test(
                rawContainerType
            )
        ) {
            containerSize =
                '40FT';
        } else if (
            /20/i.test(
                rawContainerType
            )
        ) {
            containerSize =
                '20FT';
        } else if (
            /45/i.test(
                rawContainerType
            )
        ) {
            containerSize =
                '45FT';
        }

        if (
            /dry/i.test(
                rawContainerType
            )
        ) {
            containerType =
                'Dry Container';
        } else if (
            /reefer/i.test(
                rawContainerType
            )
        ) {
            containerType =
                'Reefer Container';
        } else if (
            /open/i.test(
                rawContainerType
            )
        ) {
            containerType =
                'Open Top Container';
        } else if (
            /flat/i.test(
                rawContainerType
            )
        ) {
            containerType =
                'Flat Rack Container';
        }

        /*
        |--------------------------------------------------------------------------
        | Raw details
        |--------------------------------------------------------------------------
        */

        const timeline =
            events.map(
                (event) =>
                    [
                        event.event,
                        event.vessel,
                        event.dateText,
                    ]
                        .filter(
                            Boolean
                        )
                        .join(
                            ' - '
                        )
            );

        const rawDetails = [
            `Bill of Lading: ${
                billOfLading ||
                trackingNo
            }`,

            `From: ${
                originPort ||
                '-'
            }`,

            `To: ${
                destinationPort ||
                '-'
            }`,

            `Container: ${
                containerNumber ||
                '-'
            }${
                rawContainerType
                    ? ` | ${rawContainerType}`
                    : ''
            }`,

            `ETA: ${
                etaText ||
                '-'
            }`,

            `ETD: ${
                etdText ||
                '-'
            }`,

            `Latest event: ${
                latestEvent ||
                '-'
            }`,

            '',

            'Timeline:',

            ...timeline,
        ].join('\n');

        /*
        |--------------------------------------------------------------------------
        | Return
        |--------------------------------------------------------------------------
        */

        return {
            status:
                latestEvent ||
                'Tracking details available',

            location:
                destinationPort ||
                null,

            eta:
                toDate(
                    etaText
                ),

            etd:
                toDate(
                    etdText
                ),

            origin:
                originPort ||
                null,

            originCountry:
                null,

            destination:
                destinationPort ||
                null,

            vesselName,

            voyageNumber,

            containers:
                containerNumber
                    ? [
                          {
                              containerNumber,

                              containerSize,

                              containerType,
                          },
                      ]
                    : [],

            lastEvent:
                latestEvent
                    ? `Latest event: ${latestEvent}`
                    : null,

            rawDetails:
                rawDetails.slice(
                    0,
                    12000
                ),

            error:
                null,

            url:
                trackingUrl,
        };
    } catch (error) {
        console.error(
            '[Maersk Scraper] Error:',
            error
        );

        throw error;
    } finally {
        console.log(
            '[Maersk Scraper] Closing browser.'
        );

        await browser
            .close()
            .catch(() => {});
    }
}