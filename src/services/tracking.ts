import { createId } from '@paralleldrive/cuid2';
import { chromium } from 'playwright-core';
import { db } from '../db.ts';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MSC_TRACKING_PAGE = 'https://www.msc.com/en/track-a-shipment';
const MSC_TRACKING_API = 'https://www.msc.com/api/feature/tools/TrackingInfo';
const MSC_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';

type ShipmentTrackingRow = {
  id: string;
  blNumber: string | null;
  shippingLine: string | null;
  status: string;
  destinationPort: string | null;
  eta: Date | string | null;
  carrierTrackingLastCheckedAt?: Date | string | null;
  carrierTrackingStatus?: string | null;
  carrierTrackingLocation?: string | null;
  carrierTrackingLastEvent?: string | null;
  carrierTrackingRawDetails?: string | null;
};

type TrackingResult = {
  status: string;
  location: string | null;
  eta: Date | null;
  lastEvent: string | null;
  rawDetails: string | null;
  error: string | null;
  url: string | null;
};

const trackingColumns = [
  ['carrierTrackingStatus', 'VARCHAR(255) NULL'],
  ['carrierTrackingLocation', 'VARCHAR(255) NULL'],
  ['carrierTrackingEta', 'TIMESTAMP NULL'],
  ['carrierTrackingLastEvent', 'VARCHAR(512) NULL'],
  ['carrierTrackingLastCheckedAt', 'TIMESTAMP NULL'],
  ['carrierTrackingNextCheckAt', 'TIMESTAMP NULL'],
  ['carrierTrackingError', 'VARCHAR(512) NULL'],
  ['carrierTrackingUrl', 'VARCHAR(1024) NULL'],
  ['carrierTrackingRawDetails', 'TEXT NULL'],
] as const;

export const trackingCarrierLabel = (shippingLine?: string | null) => {
  const line = shippingLine?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
  if (line.includes('maersk') || line.includes('mersk')) return 'Maersk';
  if (line.includes('msc') || line.includes('mediterraneanshipping')) return 'MSC';
  return null;
};

export const trackingUrlForShipment = (shipment: Pick<ShipmentTrackingRow, 'blNumber' | 'shippingLine'>) => {
  const blNumber = shipment.blNumber?.trim();
  const carrier = trackingCarrierLabel(shipment.shippingLine);
  if (!blNumber || !carrier) return null;

  const encodedBlNumber = encodeURIComponent(blNumber);
  if (carrier === 'Maersk') return `https://www.maersk.com/tracking/${encodedBlNumber}`;
  if (carrier === 'MSC') return `https://www.msc.com/track-a-shipment?trackingNumber=${encodedBlNumber}`;
  return null;
};

const statusLabel = (status: string) =>
  status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const chromeExecutablePath = () =>
  process.env.CHROME_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const maerskScraperHeadless = () => process.env.MAERSK_SCRAPER_HEADLESS === 'true';
const MAERSK_SCRAPER_TIMEOUT_MS = 25000;

export const maerskScraperMode = () => (maerskScraperHeadless() ? 'headless' : 'visible');

const cleanText = (value: string) =>
  value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

const inferStatusFromTrackingText = (text: string) => {
  const normalized = text.toLowerCase();
  if (normalized.includes('no results found')) return 'No results found';
  if (normalized.includes('delivered')) return 'Delivered';
  if (normalized.includes('vessel arrival') || normalized.includes('arrived')) return 'Arrived';
  if (normalized.includes('vessel departure') || normalized.includes('departed')) return 'Vessel Departed';
  if (normalized.includes('in transit')) return 'In Transit';
  if (normalized.includes('gate out')) return 'Gate Out';
  if (normalized.includes('gate in')) return 'Gate In';
  if (normalized.includes('loaded')) return 'Loaded';
  if (normalized.includes('discharged')) return 'Discharged';
  return 'Tracking details available';
};

const formatDate = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const eventLabel = (activity?: string) => {
  const map: Record<string, string> = {
    'GATE-OUT': 'Gate out',
    'GATE-IN': 'Gate in',
    LOAD: 'Load',
    DEPARTURE: 'Vessel departure',
    ARRIVAL: 'Vessel arrival',
    DISCHARG: 'Discharge',
    DISCHARGE: 'Discharge',
  };
  return map[activity || ''] || activity?.replace(/-/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase()) || 'Event';
};

const eventLocation = (location: any) =>
  [location?.city, location?.country].filter(Boolean).join(', ') || location?.terminal || null;

const getSetCookieHeaders = (headers: Headers): string[] => {
  const anyHeaders = headers as any;
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const raw = anyHeaders.raw?.();
  if (raw?.['set-cookie']) return raw['set-cookie'];
  const single = headers.get('set-cookie');
  return single ? [single] : [];
};

const cookieHeaderFromSetCookie = (setCookies: string[]) =>
  setCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');

const mscPayloadVariants = (trackingNumber: string) => [
  { trackingNumber, trackingMode: '0' },
  { trackingNumber },
  { trackingNumber, trackingType: 'Container' },
  { TrackingNumber: trackingNumber },
  { SearchText: trackingNumber },
  { SearchText: trackingNumber, SearchType: 'Container' },
  { searchText: trackingNumber, searchType: 'Container' },
  { trackingNo: trackingNumber },
  { containerNumber: trackingNumber },
];

const parseMscDate = (value?: string | null) => {
  if (!value) return null;
  const [day, month, year] = value.split('/').map((part) => Number(part));
  if (!day || !month || !year) return null;
  return new Date(year, month - 1, day);
};

const formatMscEventDate = (value?: string | null) => {
  const date = parseMscDate(value);
  if (!date) return value || null;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

function parseMaerskApiTracking(data: any, url: string): TrackingResult {
  const container = data?.containers?.[0];
  const locations = container?.locations || [];
  const events = locations.flatMap((location: any) =>
    (location.events || []).map((event: any) => ({
      ...event,
      location,
      eventDate: event.event_time ? new Date(event.event_time) : null,
    }))
  );
  const latestEvent = events
    .filter((event: any) => event.eventDate && !Number.isNaN(event.eventDate.getTime()))
    .sort((a: any, b: any) => b.eventDate.getTime() - a.eventDate.getTime())[0] || events[events.length - 1];
  const latestLabel = eventLabel(latestEvent?.activity);
  const latestLocation = eventLocation(latestEvent?.location);
  const origin = data?.origin?.city || data?.origin?.terminal || null;
  const destination = data?.destination?.city || data?.destination?.terminal || null;
  const status = latestLabel === 'Discharge' && destination ? `Arrived at ${destination}` : latestLabel;
  const lastEvent = latestEvent
    ? `${latestLabel}${latestLocation ? ` • ${latestLocation}` : ''}${latestEvent.event_time ? ` • ${formatDate(latestEvent.event_time)}` : ''}`
    : null;

  const timeline = locations.flatMap((location: any) =>
    (location.events || []).map((event: any) => {
      const vessel = event.vessel_name || event.vessel || event.transport_name;
      const voyage = event.voyage_num || event.voyage_number;
      const vesselPart = vessel ? ` on ${vessel}${voyage ? ` / ${voyage}` : ''}` : '';
      return [
        eventLocation(location) || location.terminal || 'Unknown location',
        `${eventLabel(event.activity)}${vesselPart}`,
        formatDate(event.event_time),
      ].filter(Boolean).join(' - ');
    })
  );

  const rawDetails = [
    `Bill of Lading: ${data?.tpdoc_num || ''}`,
    `From: ${origin || '-'}`,
    `To: ${destination || '-'}`,
    `Container: ${container?.container_num || '-'}${container ? ` | ${container.container_size || ''}' ${container.container_type || ''}` : ''}`,
    `Last updated: ${formatDate(data?.last_update_time) || '-'}`,
    `Latest event: ${lastEvent || '-'}`,
    '',
    'Timeline:',
    ...timeline,
  ].join('\n');

  return {
    status,
    location: latestLocation,
    eta: null,
    lastEvent,
    rawDetails: rawDetails.slice(0, 12000),
    error: null,
    url,
  };
}

function parseMaerskRenderedText(rawText: string, url: string): TrackingResult {
  const status = inferStatusFromTrackingText(rawText);
  const hasNoResults = status === 'No results found';
  const lines = rawText.split('\n');
  const containerLine = lines.find((line) => /^[A-Z]{4}\d{7}/.test(line));
  const latestEventIndex = lines.findIndex((line) => line.toLowerCase().includes('latest event'));
  const latestEvent = latestEventIndex >= 0
    ? [lines[latestEventIndex + 1], lines[latestEventIndex + 2]].filter(Boolean).join(' • ')
    : null;
  const arrivedLine = lines.find((line) => /^Arrived at /i.test(line));
  const lastEvent = hasNoResults
    ? lines.slice(lines.findIndex((line) => line.toLowerCase().includes('no results found')), 4).join(' ')
    : latestEvent || arrivedLine || lines.find((line) => /arrival|departure|loaded|discharged|gate|delivered|transit/i.test(line)) || status;

  return {
    status: arrivedLine || status,
    location: arrivedLine?.replace(/^Arrived at /i, '') || null,
    eta: null,
    lastEvent: lastEvent || status,
    rawDetails: [
      containerLine ? `Container: ${containerLine}` : null,
      rawText,
    ].filter(Boolean).join('\n').slice(0, 12000),
    error: hasNoResults ? 'No public Maersk tracking result found' : null,
    url,
  };
}

function parseMscApiTracking(data: any, trackingNumber: string, url: string): TrackingResult {
  const payload = data?.Data || data?.data || data;
  const billOfLading = payload?.BillOfLadings?.[0] || payload?.billOfLadings?.[0] || payload?.BillOfLading || {};
  const general = billOfLading?.GeneralTrackingInfo || billOfLading?.generalTrackingInfo || {};
  const container = billOfLading?.ContainersInfo?.[0] || billOfLading?.containersInfo?.[0] || {};
  const events = (container?.Events || container?.events || [])
    .slice()
    .sort((a: any, b: any) => Number(a?.Order ?? a?.order ?? 0) - Number(b?.Order ?? b?.order ?? 0));
  const latestEvent = events[events.length - 1];
  const containerNumber = container?.ContainerNumber || container?.containerNumber || payload?.TrackingNumber || trackingNumber;
  const containerType = container?.ContainerType || container?.containerType || '';
  const latestLocation = latestEvent?.Location || latestEvent?.location || container?.LatestMove || container?.latestMove || null;
  const latestDescription = latestEvent?.Description || latestEvent?.description || (container?.Delivered ? 'Delivered' : 'Tracking details available');
  const latestDate = latestEvent?.Date || latestEvent?.date || null;
  const eta = parseMscDate(container?.PodEtaDate || general?.FinalPodEtaDate);
  const billNumber = billOfLading?.BillOfLadingNumber || billOfLading?.billOfLadingNumber || '';
  const from = general?.ShippedFrom || general?.PortOfLoad || '';
  const to = general?.ShippedTo || general?.PortOfDischarge || '';
  const status = container?.Delivered || billOfLading?.Delivered ? 'Delivered' : latestDescription;
  const lastEvent = [
    latestDescription,
    latestLocation,
    formatMscEventDate(latestDate),
  ].filter(Boolean).join(' • ');

  const timeline = events.map((event: any) => {
    const details = Array.isArray(event?.Detail || event?.detail)
      ? (event.Detail || event.detail).filter(Boolean).join(' / ')
      : event?.Detail || event?.detail || '';
    const equipment = event?.EquipmentHandling?.Name || event?.equipmentHandling?.name || '';
    return [
      event?.Location || event?.location || 'Unknown location',
      event?.Description || event?.description || 'Event',
      details,
      equipment,
      formatMscEventDate(event?.Date || event?.date),
    ].filter(Boolean).join(' - ');
  });

  const rawDetails = [
    `Tracking Number: ${payload?.TrackingNumber || trackingNumber}`,
    billNumber ? `Bill of Lading: ${billNumber}` : null,
    `From: ${from || '-'}`,
    `To: ${to || '-'}`,
    `Container: ${containerNumber || '-'}${containerType ? ` | ${containerType}` : ''}`,
    eta ? `ETA: ${formatDate(eta.toISOString())}` : null,
    `Latest event: ${lastEvent || '-'}`,
    payload?.TrackingResultsLabel || null,
    '',
    'Timeline:',
    ...timeline,
  ].filter((line) => line !== null).join('\n');

  return {
    status,
    location: latestLocation,
    eta,
    lastEvent: lastEvent || null,
    rawDetails: rawDetails.slice(0, 12000),
    error: null,
    url,
  };
}

async function getMscSessionCookies() {
  const res = await fetch(MSC_TRACKING_PAGE, {
    method: 'GET',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent': MSC_USER_AGENT,
    },
  });
  return cookieHeaderFromSetCookie(getSetCookieHeaders(res.headers));
}

async function fetchMscTracking(trackingNumber: string, url: string): Promise<TrackingResult> {
  const cookie = await getMscSessionCookies();
  let lastError = '';

  for (const payload of mscPayloadVariants(trackingNumber)) {
    const res = await fetch(MSC_TRACKING_API, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        origin: 'https://www.msc.com',
        referer: MSC_TRACKING_PAGE,
        'x-requested-with': 'XMLHttpRequest',
        ...(cookie ? { cookie } : {}),
        'user-agent': MSC_USER_AGENT,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    lastError = `MSC API ${res.status}: ${text.slice(0, 300)}`;
    if (!res.ok || !text.trim().startsWith('{')) continue;

    const json = JSON.parse(text);
    if (json?.IsSuccess === false || json?.isSuccess === false) {
      lastError = json?.Message || json?.message || lastError;
      continue;
    }

    const hasResults = json?.Data?.BillOfLadings?.length || json?.data?.billOfLadings?.length;
    if (hasResults) {
      return parseMscApiTracking(json, trackingNumber, url);
    }
  }

  return {
    status: 'No results found',
    location: null,
    eta: null,
    lastEvent: 'MSC tracking did not return shipment details.',
    rawDetails: lastError || null,
    error: 'MSC tracking did not return shipment details',
    url,
  };
}

async function scrapeMaerskTrackingPage(url: string): Promise<TrackingResult> {
  const browser = await chromium.launch({
    headless: maerskScraperHeadless(),
    executablePath: chromeExecutablePath(),
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    const apiTracking = { body: '' };

    page.on('response', async (response) => {
      const resUrl = response.url();
      if (
        !resUrl.includes('tracking') &&
        !resUrl.includes('shipment') &&
        !resUrl.includes('synergy')
      ) {
        return;
      }

      try {
        const text = await response.text();
        const trimmed = text.trim();
        if (!trimmed.startsWith('{')) return;
        if (
          trimmed.includes('containers') ||
          trimmed.includes('container_num') ||
          trimmed.includes('tpdoc_num')
        ) {
          apiTracking.body = trimmed;
          console.log('TRACKING API FOUND:', resUrl);
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: MAERSK_SCRAPER_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('Bill of Lading number') ||
        document.body.innerText.includes('Estimated arrival date') ||
        document.body.innerText.includes('Latest event') ||
        document.body.innerText.includes("couldn't find"),
      { timeout: MAERSK_SCRAPER_TIMEOUT_MS }
    ).catch(() => {});
    await page.waitForTimeout(1500);

    if (apiTracking.body.trim().startsWith('{')) {
      return parseMaerskApiTracking(JSON.parse(apiTracking.body), url);
    }

    const rawText = cleanText(await page.locator('body').innerText({ timeout: 10000 }));
    return parseMaerskRenderedText(rawText, url);
  } finally {
    await browser.close();
  }
}

export async function ensureShipmentTrackingColumns() {
  const existing = await db.query<Array<{ COLUMN_NAME: string }>>(
    `SELECT column_name AS "COLUMN_NAME"
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'Shipment'`
  );
  const existingNames = new Set(existing.map((row) => row.COLUMN_NAME));

  for (const [column, definition] of trackingColumns) {
    if (!existingNames.has(column)) {
      await db.execute(`ALTER TABLE Shipment ADD COLUMN ${column} ${definition}`);
    }
  }
}

export async function fetchCarrierTracking(shipment: ShipmentTrackingRow): Promise<TrackingResult> {
  const carrier = trackingCarrierLabel(shipment.shippingLine);
  const url = trackingUrlForShipment(shipment);

  if (!carrier || !shipment.blNumber) {
    return {
      status: statusLabel(shipment.status),
      location: shipment.destinationPort,
      eta: shipment.eta ? new Date(shipment.eta) : null,
      lastEvent: 'Tracking needs a supported shipping line and BL number.',
      rawDetails: null,
      error: 'Missing carrier or BL number',
      url,
    };
  }

  if (carrier === 'Maersk' && url) {
    try {
      return await scrapeMaerskTrackingPage(url);
    } catch (error) {
      return {
        status: statusLabel(shipment.status),
        location: shipment.destinationPort,
        eta: shipment.eta ? new Date(shipment.eta) : null,
        lastEvent: `Maersk tracking page scrape failed: ${String(error)}`,
        rawDetails: null,
        error: 'Maersk tracking page scrape failed',
        url,
      };
    }
  }

  if (carrier === 'MSC' && shipment.blNumber && url) {
    try {
      return await fetchMscTracking(shipment.blNumber, url);
    } catch (error) {
      return {
        status: statusLabel(shipment.status),
        location: shipment.destinationPort,
        eta: shipment.eta ? new Date(shipment.eta) : null,
        lastEvent: `MSC tracking API failed: ${String(error)}`,
        rawDetails: null,
        error: 'MSC tracking API failed',
        url,
      };
    }
  }

  return {
    status: statusLabel(shipment.status),
    location: shipment.destinationPort,
    eta: shipment.eta ? new Date(shipment.eta) : null,
    lastEvent: `${carrier} daily tracking check completed. Carrier API credentials are not configured yet.`,
    rawDetails: null,
    error: `${carrier} API credentials not configured`,
    url,
  };
}

export async function syncShipmentTracking(id: string, force = false) {
  await ensureShipmentTrackingColumns();

  const shipments = await db.query<ShipmentTrackingRow[]>('SELECT * FROM Shipment WHERE id = ?', [id]);
  const shipment = shipments[0];
  if (!shipment) return null;

  const lastChecked = shipment.carrierTrackingLastCheckedAt
    ? new Date(shipment.carrierTrackingLastCheckedAt).getTime()
    : 0;
  if (!force && lastChecked && Date.now() - lastChecked < ONE_DAY_MS) {
    return shipment;
  }

  const result = await fetchCarrierTracking(shipment);
  if (
    result.status === 'No results found' &&
    shipment.carrierTrackingRawDetails &&
    shipment.carrierTrackingStatus &&
    shipment.carrierTrackingStatus !== 'No results found'
  ) {
    result.status = shipment.carrierTrackingStatus;
    result.location = shipment.carrierTrackingLocation || result.location;
    result.lastEvent = shipment.carrierTrackingLastEvent || result.lastEvent;
    result.rawDetails = shipment.carrierTrackingRawDetails;
    result.error = 'Maersk scrape returned no result; kept previous tracking details';
  }
  const now = new Date();
  const nextCheck = new Date(now.getTime() + ONE_DAY_MS);

  await db.execute(
    `UPDATE Shipment
     SET carrierTrackingStatus = ?,
         carrierTrackingLocation = ?,
         carrierTrackingEta = ?,
         carrierTrackingLastEvent = ?,
         carrierTrackingLastCheckedAt = ?,
         carrierTrackingNextCheckAt = ?,
         carrierTrackingError = ?,
         carrierTrackingUrl = ?,
         carrierTrackingRawDetails = ?,
         updatedAt = ?
     WHERE id = ?`,
    [
      result.status,
      result.location,
      result.eta,
      result.lastEvent,
      now,
      nextCheck,
      result.error,
      result.url,
      result.rawDetails,
      now,
      id,
    ]
  );

  const eventId = createId();
  await db.execute(
    `INSERT INTO TimelineEvent (id, shipmentId, event, description, location, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      id,
      'Carrier Tracking Checked',
      result.lastEvent || `Carrier status: ${result.status}`,
      result.location,
      now,
    ]
  );

  const updated = await db.query<ShipmentTrackingRow[]>('SELECT * FROM Shipment WHERE id = ?', [id]);
  return updated[0] || null;
}

export async function syncDueShipmentTrackings() {
  await ensureShipmentTrackingColumns();

  const dueShipments = await db.query<ShipmentTrackingRow[]>(
    `SELECT *
     FROM Shipment
     WHERE isActive = 1
       AND blNumber IS NOT NULL
       AND blNumber <> ''
       AND shippingLine IS NOT NULL
       AND shippingLine <> ''
       AND status NOT IN ('delivered', 'closed')
       AND (
         carrierTrackingLastCheckedAt IS NULL
         OR carrierTrackingLastCheckedAt <= NOW() - INTERVAL '1 day'
       )
     LIMIT 50`
  );

  for (const shipment of dueShipments) {
    await syncShipmentTracking(shipment.id);
  }

  return dueShipments.length;
}

export function startShipmentTrackingScheduler() {
  void syncDueShipmentTrackings().catch((error) => {
    console.error('Initial shipment tracking sync failed:', error);
  });

  setInterval(() => {
    void syncDueShipmentTrackings().catch((error) => {
      console.error('Scheduled shipment tracking sync failed:', error);
    });
  }, 60 * 60 * 1000);
}
