import { createId } from '@paralleldrive/cuid2';
import { chromium as playwrightChromium } from 'playwright-core';
import { db } from '../db.js';
import { createNotification, notificationRecipients } from './notifications.js';
import {
    fetchMaerskTrackingEvents,
    MaerskApiError,
} from './maersk.js';
import { evergreenTrackingUrl, fetchEvergreenTracking } from './evergreen.js';
const TRACKING_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MSC_TRACKING_PAGE = 'https://www.msc.com/en/track-a-shipment';
const MSC_TRACKING_API = 'https://www.msc.com/api/feature/tools/TrackingInfo';
const MSC_USER_AGENT = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const MAERSK_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
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
];
export const trackingCarrierLabel = (shippingLine) => {
    const line = shippingLine?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
    if (line.includes('maersk') || line.includes('mersk'))
        return 'Maersk';
    if (line.includes('msc') || line.includes('mediterraneanshipping'))
        return 'MSC';
    if (line.includes('evergreen') || line.includes('shipmentlink'))
        return 'Evergreen';
    return null;
};
const normalizeTrackingReference = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');
const isContainerNumber = (value) => /^[A-Z]{4}\d{7}$/.test(value);
const isMaerskDocumentNumber = (value) => /^[A-Z0-9]{9}$/.test(value);
const referenceFromTrackingUrl = (url) => {
    const pathname = new URL(url).pathname;
    return normalizeTrackingReference(decodeURIComponent(pathname.split('/').filter(Boolean).pop() || ''));
};
const trackingReferencesForShipment = (shipment, carrier) => {
    const containerNumbers = [
        ...(shipment.containerNumbers || []),
        shipment.containerNumber,
    ];
    const references = carrier === 'Maersk'
        ? [
            shipment.trackingNumber,
            shipment.blNumber,
            shipment.bookingNumber,
            ...containerNumbers,
        ]
        : [
            shipment.trackingNumber,
            shipment.blNumber,
            ...containerNumbers,
            shipment.bookingNumber,
        ];
    return [...new Set(references.map(normalizeTrackingReference).filter(Boolean))];
};
const validTrackingReferencesForShipment = (shipment, carrier) => {
    const references = trackingReferencesForShipment(shipment, carrier);
    if (carrier === 'Maersk') {
        return references.filter((reference) => isContainerNumber(reference) || isMaerskDocumentNumber(reference));
    }
    return references;
};
const trackingReferenceForShipment = (shipment, carrier) => validTrackingReferencesForShipment(shipment, carrier)[0] || null;
export const trackingUrlForShipment = (shipment) => {
    const carrier = trackingCarrierLabel(shipment.shippingLine);
    const trackingReference = carrier ? trackingReferenceForShipment(shipment, carrier) : null;
    if (!trackingReference || !carrier)
        return null;
    const encodedTrackingReference = encodeURIComponent(trackingReference);
    if (carrier === 'Maersk')
        return `https://www.maersk.com/tracking/${encodedTrackingReference}`;
    if (carrier === 'MSC')
        return `https://www.msc.com/track-a-shipment?trackingNumber=${encodedTrackingReference}`;
    if (carrier === 'Evergreen')
        return evergreenTrackingUrl();
    return null;
};
const statusLabel = (status) => status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
const shipmentStatusOrder = [
    'draft',
    'booking_confirmed',
    'at_pol',
    'vessel_departed',
    'in_transit',
    'at_pod',
    'customs_clearance',
    'duty_paid',
    'in_transport',
    'offloaded',
    'delivered',
    'closed',
];
const shipmentStatusFromCarrier = (result) => {
    const value = `${result?.status || ''} ${result?.lastEvent || ''}`.toLowerCase();
    if (/delivered|empty received/.test(value))
        return 'delivered';
    if (/transship/.test(value))
        return 'in_transit';
    if (/arrived|arrival|discharg|import to consignee/.test(value))
        return 'at_pod';
    if (/in transit/.test(value))
        return 'in_transit';
    if (/depart|loaded on vessel|container departure|export loaded/.test(value))
        return 'vessel_departed';
    if (/gate in|export received|received at cy|loaded/.test(value))
        return 'at_pol';
    return null;
};
const progressiveShipmentStatus = (currentStatus, carrierStatus) => {
    if (!carrierStatus)
        return currentStatus;
    const currentIndex = shipmentStatusOrder.indexOf(currentStatus);
    const carrierIndex = shipmentStatusOrder.indexOf(carrierStatus);
    if (carrierIndex < 0 || (currentIndex >= 0 && carrierIndex <= currentIndex))
        return currentStatus;
    return carrierStatus;
};
const localChromeExecutablePath = () => process.env.CHROME_EXECUTABLE_PATH ||
    (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined);
const isServerless = () => Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const deploymentRuntimeLabel = () => process.env.VERCEL ? 'Vercel serverless' : process.env.AWS_LAMBDA_FUNCTION_NAME ? 'AWS Lambda' : 'local server';
const maerskScraperHeadless = () => isServerless() || process.env.MAERSK_SCRAPER_HEADLESS === 'true';
export const maerskScraperMode = () => (maerskScraperHeadless() ? 'headless' : 'visible');
const maerskBrowserOptions = async () => {
    if (isServerless() || process.platform === 'linux') {
        const { default: serverlessChromium } = await import('@sparticuz/chromium');
        return {
            headless: true,
            executablePath: await serverlessChromium.executablePath(),
            args: [
                ...serverlessChromium.args,
                '--disable-blink-features=AutomationControlled',
            ],
        };
    }
    return {
        headless: maerskScraperHeadless(),
        executablePath: localChromeExecutablePath(),
        args: ['--disable-blink-features=AutomationControlled'],
    };
};
const cleanText = (value) => value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
const inferStatusFromTrackingText = (text) => {
    const normalized = text.toLowerCase();
    if (normalized.includes('no results found') || normalized.includes("couldn't find"))
        return 'No results found';
    if (normalized.includes('delivered'))
        return 'Delivered';
    if (normalized.includes('vessel arrival') || normalized.includes('arrived'))
        return 'Arrived';
    if (normalized.includes('vessel departure') || normalized.includes('departed'))
        return 'Vessel Departed';
    if (normalized.includes('in transit'))
        return 'In Transit';
    if (normalized.includes('gate out'))
        return 'Gate Out';
    if (normalized.includes('gate in'))
        return 'Gate In';
    if (normalized.includes('loaded'))
        return 'Loaded';
    if (normalized.includes('discharged'))
        return 'Discharged';
    return 'Tracking details available';
};
const cleanMaerskValue = (value = '') => String(value).replace(/\s+/g, ' ').trim();
const maerskDateFromText = (dateText = '') => {
    const date = new Date(cleanMaerskValue(dateText));
    return Number.isNaN(date.getTime()) ? null : date;
};
const maerskContainerDetails = (rawContainerType = '') => {
    let containerSize = '';
    let containerType = cleanMaerskValue(rawContainerType);
    if (/40/i.test(rawContainerType))
        containerSize = '40FT';
    else if (/20/i.test(rawContainerType))
        containerSize = '20FT';
    else if (/45/i.test(rawContainerType))
        containerSize = '45FT';
    if (/dry/i.test(rawContainerType))
        containerType = 'Dry Container';
    else if (/reefer/i.test(rawContainerType))
        containerType = 'Reefer Container';
    else if (/open/i.test(rawContainerType))
        containerType = 'Open Top Container';
    else if (/flat/i.test(rawContainerType))
        containerType = 'Flat Rack Container';
    return { containerSize, containerType };
};
const isMaerskTrackingLandingText = (text) => {
    const normalized = text.toLowerCase();
    return normalized.includes('shipment & container tracking') &&
        normalized.includes('select your booking type') &&
        normalized.includes('container number is made of 4 letters and 7 digits') &&
        !/[a-z]{4}\d{7}\s*\|/.test(normalized) &&
        !/\bfrom\s+[a-z]/.test(normalized) &&
        !normalized.includes('latest event') &&
        !normalized.includes('estimated arrival date') &&
        !normalized.includes('no results found') &&
        !normalized.includes("couldn't find");
};
const formatDate = (value) => {
    if (!value)
        return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return value;
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};
const eventLabel = (activity) => {
    const map = {
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
const eventLocation = (location) => [location?.city, location?.country].filter(Boolean).join(', ') || location?.terminal || null;
const dcsaEventLocation = (event) => {
    const transportCall = event?.transportCall || {};
    const location = event?.eventLocation || transportCall.location || {};
    return location.locationName ||
        location.UNLocationCode ||
        transportCall.otherFacility ||
        transportCall.UNLocationCode ||
        null;
};
const dcsaEventCode = (event) => event?.equipmentEventTypeCode ||
    event?.transportEventTypeCode ||
    event?.shipmentEventTypeCode ||
    'EVENT';
const dcsaEventLabel = (event) => {
    const code = dcsaEventCode(event);
    const labels = {
        ARRI: 'Arrived',
        DEPA: 'Departed',
        LOAD: 'Loaded',
        DISC: 'Discharged',
        GTIN: 'Gate in',
        GTOT: 'Gate out',
        STUF: 'Stuffed',
        STRP: 'Stripped',
        PICK: 'Picked up',
        DROP: 'Dropped off',
        RSEA: 'Resealed',
        RMVD: 'Removed',
        INSP: 'Inspected',
        RECE: 'Received',
        DRFT: 'Drafted',
        APPR: 'Approved',
        ISSU: 'Issued',
        CONF: 'Confirmed',
        CMPL: 'Completed',
        RELS: 'Released',
    };
    return labels[code] || code.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
};
const dcsaEventDate = (event) => {
    const date = new Date(event?.eventDateTime || event?.eventCreatedDateTime || '');
    return Number.isNaN(date.getTime()) ? null : date;
};
const dcsaTrackingQueriesForShipment = (shipment) => {
    const candidates = [];
    const add = (name, value) => {
        const normalized = normalizeTrackingReference(value);
        if (!normalized)
            return;
        if (name === 'equipmentReference' && !isContainerNumber(normalized))
            return;
        if (name !== 'equipmentReference' && !isMaerskDocumentNumber(normalized))
            return;
        const key = `${name}:${normalized}`;
        if (!candidates.some((candidate) => candidate.key === key))
            candidates.push({ key, query: { [name]: normalized }, reference: normalized });
    };

    add(isContainerNumber(normalizeTrackingReference(shipment.trackingNumber))
        ? 'equipmentReference'
        : 'transportDocumentReference', shipment.trackingNumber);
    if (isMaerskDocumentNumber(normalizeTrackingReference(shipment.trackingNumber)))
        add('carrierBookingReference', shipment.trackingNumber);
    add('transportDocumentReference', shipment.blNumber);
    add('carrierBookingReference', shipment.bookingNumber);
    for (const containerNumber of [
        ...(shipment.containerNumbers || []),
        shipment.containerNumber,
    ]) {
        add('equipmentReference', containerNumber);
    }
    return candidates;
};
const getSetCookieHeaders = (headers) => {
    const anyHeaders = headers;
    if (typeof anyHeaders.getSetCookie === 'function')
        return anyHeaders.getSetCookie();
    const raw = anyHeaders.raw?.();
    if (raw?.['set-cookie'])
        return raw['set-cookie'];
    const single = headers.get('set-cookie');
    return single ? [single] : [];
};
const cookieHeaderFromSetCookie = (setCookies) => setCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
const mscPayloadVariants = (trackingNumber) => [
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
const parseMscDate = (value) => {
    if (!value)
        return null;
    const [day, month, year] = value.split('/').map((part) => Number(part));
    if (!day || !month || !year)
        return null;
    return new Date(year, month - 1, day);
};
const formatMscEventDate = (value) => {
    const date = parseMscDate(value);
    if (!date)
        return value || null;
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
};
function parseMaerskApiTracking(data, url) {
    const carrierContainers = data?.containers || [];
    const container = carrierContainers[0];
    const locations = container?.locations || [];
    const events = locations.flatMap((location) => (location.events || []).map((event) => ({
        ...event,
        location,
        eventDate: event.event_time ? new Date(event.event_time) : null,
    })));
    const latestEvent = events
        .filter((event) => event.eventDate && !Number.isNaN(event.eventDate.getTime()))
        .sort((a, b) => b.eventDate.getTime() - a.eventDate.getTime())[0] || events[events.length - 1];
    const latestLabel = eventLabel(latestEvent?.activity);
    const latestLocation = eventLocation(latestEvent?.location);
    const origin = data?.origin?.city || data?.origin?.terminal || null;
    const destination = data?.destination?.city || data?.destination?.terminal || null;
    const originCountry = data?.origin?.country || null;
    const departureEvent = events.find((event) => String(event.activity || '').includes('DEPARTURE'));
    const arrivalEvents = events.filter((event) => String(event.activity || '').includes('ARRIVAL'));
    const arrivalEvent = arrivalEvents[arrivalEvents.length - 1];
    const transportEvent = [...events].reverse().find((event) => event.vessel_name || event.vessel || event.transport_name);
    const vesselName = transportEvent?.vessel_name || transportEvent?.vessel || transportEvent?.transport_name || null;
    const voyageNumber = transportEvent?.voyage_num || transportEvent?.voyage_number || null;
    const status = latestLabel === 'Discharge' && destination ? `Arrived at ${destination}` : latestLabel;
    const lastEvent = latestEvent
        ? `${latestLabel}${latestLocation ? ` • ${latestLocation}` : ''}${latestEvent.event_time ? ` • ${formatDate(latestEvent.event_time)}` : ''}`
        : null;
    const timeline = locations.flatMap((location) => (location.events || []).map((event) => {
        const vessel = event.vessel_name || event.vessel || event.transport_name;
        const voyage = event.voyage_num || event.voyage_number;
        const vesselPart = vessel ? ` on ${vessel}${voyage ? ` / ${voyage}` : ''}` : '';
        return [
            eventLocation(location) || location.terminal || 'Unknown location',
            `${eventLabel(event.activity)}${vesselPart}`,
            formatDate(event.event_time),
        ].filter(Boolean).join(' - ');
    }));
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
        eta: arrivalEvent?.event_time ? new Date(arrivalEvent.event_time) : null,
        etd: departureEvent?.event_time ? new Date(departureEvent.event_time) : null,
        origin,
        originCountry,
        destination,
        vesselName,
        voyageNumber,
        containers: carrierContainers.map((item) => ({
            containerNumber: item?.container_num || '',
            containerSize: item?.container_size ? `${item.container_size}FT` : '',
            containerType: item?.container_type || '',
        })).filter((item) => item.containerNumber),
        lastEvent,
        rawDetails: rawDetails.slice(0, 12000),
        error: null,
        url,
    };
}
export function parseMaerskDcsaTracking(data, url, reference = '') {
    const events = (Array.isArray(data) ? data : data?.events || [])
        .map((event) => ({ ...event, parsedDate: dcsaEventDate(event) }))
        .filter((event) => event.parsedDate)
        .sort((a, b) => a.parsedDate.getTime() - b.parsedDate.getTime());
    if (!events.length) {
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
            lastEvent: 'Maersk Ocean Track & Trace returned no shipment events.',
            rawDetails: reference ? `Reference: ${reference}` : null,
            error: 'No Maersk tracking events found',
            url,
        };
    }

    const actualEvents = events.filter((event) => event.eventClassifierCode === 'ACT');
    const latestEvent = actualEvents[actualEvents.length - 1] || events[events.length - 1];
    const arrivalEvents = events.filter((event) =>
        event.transportEventTypeCode === 'ARRI' ||
        event.equipmentEventTypeCode === 'DISC');
    const departureEvents = events.filter((event) =>
        event.transportEventTypeCode === 'DEPA' ||
        event.equipmentEventTypeCode === 'LOAD');
    const estimatedArrival = [...arrivalEvents].reverse().find((event) =>
        ['EST', 'PLN'].includes(event.eventClassifierCode) &&
        event.parsedDate.getTime() >= Date.now() - (24 * 60 * 60 * 1000));
    const firstLocation = events.map(dcsaEventLocation).find(Boolean) || null;
    const lastLocation = [...events].reverse().map(dcsaEventLocation).find(Boolean) || null;
    const vesselEvent = [...events].reverse().find((event) => event?.transportCall?.vessel?.vesselName);
    const transportCall = vesselEvent?.transportCall || {};
    const latestLocation = dcsaEventLocation(latestEvent);
    const latestLabel = dcsaEventLabel(latestEvent);
    const classifier = latestEvent.eventClassifierCode === 'ACT'
        ? ''
        : latestEvent.eventClassifierCode === 'EST'
            ? ' (estimated)'
            : latestEvent.eventClassifierCode === 'PLN'
                ? ' (planned)'
                : '';
    const lastEvent = `${latestLabel}${classifier}${latestLocation ? ` • ${latestLocation}` : ''} • ${formatDate(latestEvent.parsedDate)}`;
    const containers = [...new Map(events
        .filter((event) => event.equipmentReference)
        .map((event) => [event.equipmentReference, {
            containerNumber: event.equipmentReference,
            containerSize: '',
            containerType: event.ISOEquipmentCode || '',
        }])).values()];
    const timeline = events.map((event) => {
        const vessel = event?.transportCall?.vessel?.vesselName;
        const voyage = event?.transportCall?.exportVoyageNumber ||
            event?.transportCall?.importVoyageNumber ||
            event?.transportCall?.carrierVoyageNumber;
        return [
            dcsaEventLocation(event) || 'Unknown location',
            `${dcsaEventLabel(event)}${event.eventClassifierCode ? ` (${event.eventClassifierCode})` : ''}`,
            vessel ? `${vessel}${voyage ? ` / ${voyage}` : ''}` : null,
            formatDate(event.parsedDate),
        ].filter(Boolean).join(' - ');
    });

    return {
        status: latestLabel,
        location: latestLocation,
        eta: estimatedArrival?.parsedDate || null,
        etd: departureEvents[0]?.parsedDate || null,
        origin: firstLocation,
        originCountry: null,
        destination: lastLocation,
        vesselName: transportCall?.vessel?.vesselName || null,
        voyageNumber: transportCall.exportVoyageNumber ||
            transportCall.importVoyageNumber ||
            transportCall.carrierVoyageNumber ||
            null,
        containers,
        lastEvent,
        rawDetails: [
            `Reference: ${reference || '-'}`,
            `Events: ${events.length}`,
            `Latest event: ${lastEvent}`,
            estimatedArrival ? `Estimated arrival: ${formatDate(estimatedArrival.parsedDate)}` : null,
            '',
            'Timeline:',
            ...timeline,
        ].filter((line) => line !== null).join('\n').slice(0, 12000),
        error: null,
        url,
    };
}
export async function fetchMaerskTracking(shipment, url) {
    const queries = dcsaTrackingQueriesForShipment(shipment);
    console.log("queries", queries)
    let lastResult = null;
    let lastError = null;
    for (const candidate of queries) {
        try {
            const response = await fetchMaerskTrackingEvents(candidate.query);
            const result = parseMaerskDcsaTracking(response.data, url, candidate.reference);
            if (!result.error)
                return result;
            lastResult = result;
        }
        catch (error) {
            console.log("error", error)
            lastError = error;
            if (error instanceof MaerskApiError && ![404].includes(error.status))
                throw error;
        }
    }
    if (lastResult)
        return lastResult;
    if (lastError)
        throw lastError;
    return parseMaerskDcsaTracking([], url);
}
function parseMaerskRenderedText(rawText, url, reference = '') {
    const text = cleanText(rawText);
    const status = inferStatusFromTrackingText(text);
    const hasNoResults = status === 'No results found';
    const hasOnlyLandingText = isMaerskTrackingLandingText(text);
    const getMatch = (regex) => cleanMaerskValue(text.match(regex)?.[1] || '');
    if (hasNoResults && !text.includes('Bill of Lading number')) {
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
            rawDetails: text.slice(0, 12000),
            error: 'No public Maersk tracking result found',
            url,
        };
    }
    if (hasOnlyLandingText) {
        return {
            status: 'Tracking form did not return details',
            location: null,
            eta: null,
            etd: null,
            origin: null,
            originCountry: null,
            destination: null,
            vesselName: null,
            voyageNumber: null,
            containers: [],
            lastEvent: 'Maersk showed the tracking form but no shipment result.',
            rawDetails: text.slice(0, 12000),
            error: 'Maersk tracking form did not return shipment details',
            url,
        };
    }

    const billOfLading = getMatch(/Bill of Lading number\s+([A-Z0-9]+)/i);
    const origin = getMatch(/Bill of Lading number\s+[A-Z0-9]+\s+From\s+([^\n]+?)\s+To/i);
    const destination = getMatch(/To\s+([^\n]+?)\s+(?:[A-Z]{4}\d{7}|Last updated|Estimated arrival date)/i);
    const containerNumber = getMatch(/([A-Z]{4}\d{7})\s*\|/i);
    const rawContainerType = getMatch(/[A-Z]{4}\d{7}\s*\|\s*([^\n]+)/i);
    const vesselEventRegex = /(Vessel arrival|Vessel departure|Feeder arrival|Feeder departure|Load on|Discharge)\s+\(([^)]+)\)\s+([0-9]{2}\s+[A-Za-z]{3}\s+[0-9]{4}\s+[0-9]{2}:[0-9]{2})/gi;
    const events = [...text.matchAll(vesselEventRegex)].map((match) => ({
        event: cleanMaerskValue(match[1]),
        vessel: cleanMaerskValue(match[2]),
        dateText: cleanMaerskValue(match[3]),
    }));
    const arrivals = events.filter((event) => /arrival/i.test(event.event));
    const departures = events.filter((event) => /departure/i.test(event.event));
    const finalArrival = arrivals[arrivals.length - 1];
    const firstDeparture = departures[0];
    const latestDeparture = departures[departures.length - 1];
    const etaText = getMatch(/Estimated arrival date\s+([\s\S]*?)\s+Latest event/i) || finalArrival?.dateText || '';
    const etdText = firstDeparture?.dateText || '';
    const vesselName = latestDeparture?.vessel?.split('/')[0]?.trim() ||
        finalArrival?.vessel?.split('/')[0]?.trim() ||
        firstDeparture?.vessel?.split('/')[0]?.trim() ||
        null;
    const voyageNumber = latestDeparture?.vessel?.split('/')[1]?.trim() ||
        finalArrival?.vessel?.split('/')[1]?.trim() ||
        firstDeparture?.vessel?.split('/')[1]?.trim() ||
        null;
    const latestEvent = getMatch(/Latest event\s+([\s\S]*?)\s+Note:/i) ||
        (latestDeparture ? `${latestDeparture.event} • ${latestDeparture.vessel} • ${latestDeparture.dateText}` : '');
    const { containerSize, containerType } = maerskContainerDetails(rawContainerType);
    const eta = maerskDateFromText(etaText);
    const etd = maerskDateFromText(etdText);
    const timeline = events.map((event) => [
        event.event,
        event.vessel,
        event.dateText,
    ].filter(Boolean).join(' - '));
    const hasShipmentData = Boolean(billOfLading || origin || destination || containerNumber || etaText || latestEvent || events.length);
    return {
        status: latestEvent || status,
        location: destination || null,
        eta,
        etd,
        origin: origin || null,
        originCountry: null,
        destination: destination || null,
        vesselName,
        voyageNumber,
        containers: containerNumber
            ? [{ containerNumber, containerSize, containerType }]
            : [],
        lastEvent: latestEvent || status,
        rawDetails: [
            `Bill of Lading: ${billOfLading || reference || '-'}`,
            `From: ${origin || '-'}`,
            `To: ${destination || '-'}`,
            `Container: ${containerNumber || '-'}${rawContainerType ? ` | ${rawContainerType}` : ''}`,
            `Estimated arrival date: ${etaText || '-'}`,
            `First departure: ${etdText || '-'}`,
            `Latest event: ${latestEvent || '-'}`,
            '',
            'Timeline:',
            ...timeline,
            '',
            text,
        ].join('\n').slice(0, 12000),
        error: hasShipmentData ? null : 'Maersk tracking did not return shipment details',
        url,
    };
}
function parseMscApiTracking(data, trackingNumber, url) {
    const payload = data?.Data || data?.data || data;
    const billOfLading = payload?.BillOfLadings?.[0] || payload?.billOfLadings?.[0] || payload?.BillOfLading || {};
    const general = billOfLading?.GeneralTrackingInfo || billOfLading?.generalTrackingInfo || {};
    const carrierContainers = billOfLading?.ContainersInfo || billOfLading?.containersInfo || [];
    const container = carrierContainers[0] || {};
    const events = (container?.Events || container?.events || [])
        .slice()
        .sort((a, b) => Number(a?.Order ?? a?.order ?? 0) - Number(b?.Order ?? b?.order ?? 0));
    const latestEvent = events[events.length - 1];
    const vesselEvent = [...events].reverse().find((event) => {
        const description = event?.Description || event?.description || '';
        return /loaded on vessel|discharged from vessel/i.test(description);
    });
    const vesselDetails = vesselEvent?.Detail || vesselEvent?.detail;
    const vesselDetailValue = Array.isArray(vesselDetails)
        ? vesselDetails.find((detail) => String(detail).includes('/')) || vesselDetails.filter(Boolean).join(' / ')
        : vesselDetails || '';
    const vesselMatch = String(vesselDetailValue).match(/^(.+?)\s*\/\s*([A-Z0-9-]+)$/i);
    const containerNumber = container?.ContainerNumber || container?.containerNumber || payload?.TrackingNumber || trackingNumber;
    const containerType = container?.ContainerType || container?.containerType || '';
    const latestLocation = latestEvent?.Location || latestEvent?.location || container?.LatestMove || container?.latestMove || null;
    const latestDescription = latestEvent?.Description || latestEvent?.description || (container?.Delivered ? 'Delivered' : 'Tracking details available');
    const latestDate = latestEvent?.Date || latestEvent?.date || null;
    const departureEvent = events.find((event) => /loaded on vessel|export.*vessel/i.test(event?.Description || event?.description || ''));
    const arrivalEvent = [...events].reverse().find((event) => /discharged from vessel|import.*discharge/i.test(event?.Description || event?.description || ''));
    const eta = parseMscDate(container?.PodEtaDate || general?.FinalPodEtaDate || arrivalEvent?.Date || arrivalEvent?.date);
    const billNumber = billOfLading?.BillOfLadingNumber || billOfLading?.billOfLadingNumber || '';
    const from = general?.ShippedFrom || general?.PortOfLoad || '';
    const to = general?.ShippedTo || general?.PortOfDischarge || '';
    const vesselName = general?.VesselName || general?.vesselName || container?.VesselName || container?.vesselName || vesselMatch?.[1]?.trim() || null;
    const voyageNumber = general?.VoyageNumber || general?.voyageNumber || container?.VoyageNumber || container?.voyageNumber || vesselMatch?.[2]?.trim() || null;
    const status = container?.Delivered || billOfLading?.Delivered ? 'Delivered' : latestDescription;
    const lastEvent = [
        latestDescription,
        latestLocation,
        formatMscEventDate(latestDate),
    ].filter(Boolean).join(' • ');
    const timeline = events.map((event) => {
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
        etd: parseMscDate(general?.PolDepartureDate || general?.polDepartureDate || departureEvent?.Date || departureEvent?.date),
        origin: from || null,
        originCountry: from.includes(',') ? from.split(',').pop().trim() : null,
        destination: to || null,
        vesselName,
        voyageNumber,
        containers: carrierContainers.map((item) => ({
            containerNumber: item?.ContainerNumber || item?.containerNumber || '',
            containerSize: '',
            containerType: item?.ContainerType || item?.containerType || '',
        })).filter((item) => item.containerNumber),
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
export async function fetchMscTracking(trackingNumber, url) {
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
        if (!res.ok || !text.trim().startsWith('{'))
            continue;
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
export async function scrapeMaerskTrackingPage(url) {
    const reference = referenceFromTrackingUrl(url);
    const browser = await playwrightChromium.launch(await maerskBrowserOptions());
    try {
        const context = await browser.newContext({
            userAgent: MAERSK_USER_AGENT,
            viewport: null,
        });
        const page = await context.newPage();
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
        });

        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 120000,
        });

        try {
            await page.getByRole('button', { name: /allow all/i }).click({ timeout: 8000 });
        }
        catch {
            // Cookie banner is not always shown.
        }

        await page.waitForFunction((trackingReference) => {
            const text = document.body.innerText;
            const hasResult = Boolean(trackingReference) && text.includes(trackingReference) &&
                (text.includes('Estimated arrival date') ||
                    text.includes('Latest event') ||
                    text.includes('Last updated'));
            return hasResult ||
                text.includes('No results found') ||
                text.includes('Latest event') ||
                text.includes('Estimated arrival date');
        }, reference, { timeout: 90000 });
        await page.waitForTimeout(3000);

        return parseMaerskRenderedText(await page.locator('body').innerText({ timeout: 10000 }), url, reference);
    }
    finally {
        await browser.close();
    }
}
export async function ensureShipmentTrackingColumns() {
    const existing = await db.query(`SELECT column_name AS "COLUMN_NAME"
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'Shipment'`);
    const existingNames = new Set(existing.map((row) => row.COLUMN_NAME));
    for (const [column, definition] of trackingColumns) {
        if (!existingNames.has(column)) {
            await db.execute(`ALTER TABLE Shipment ADD COLUMN ${column} ${definition}`);
        }
    }
}
export async function fetchCarrierTracking(shipment, options = {}) {
    console.log("log1", shipment)
    const carrier = trackingCarrierLabel(shipment.shippingLine);
    const trackingReference = carrier ? trackingReferenceForShipment(shipment, carrier) : null;
    const url = trackingUrlForShipment(shipment);
    console.log("log2", carrier, trackingReference, url)
    if (!carrier) {
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
    if (!trackingReference) {
        const suppliedReferences = trackingReferencesForShipment(shipment, carrier);
        const invalidMaerskReference = carrier === 'Maersk' && suppliedReferences.length > 0;
        const message = invalidMaerskReference
            ? 'Maersk tracking requires a 9-character booking/BL number or an 11-character container number.'
            : 'Tracking needs a BL, booking, or container number.';
        return {
            status: statusLabel(shipment.status),
            location: shipment.destinationPort,
            eta: shipment.eta ? new Date(shipment.eta) : null,
            lastEvent: message,
            rawDetails: invalidMaerskReference
                ? `Rejected Maersk reference: ${suppliedReferences.join(', ')}`
                : null,
            error: message,
            url: null,
        };
    }
    if (carrier === 'Maersk' && url) {
        try {
            if (!options.forceMaerskScraperFallback) {
                try {
                    return await fetchMaerskTracking(shipment, url);
                } catch (apiError) {
                    console.warn('Maersk API failed or not configured, falling back to scraper...', apiError.message || apiError);
                }
            }
            return await scrapeMaerskTrackingPage(url);
        }
        catch (error) {
            console.log("error", error)
            const message = String(error?.message || error);
            return {
                status: statusLabel(shipment.status),
                location: shipment.destinationPort,
                eta: shipment.eta ? new Date(shipment.eta) : null,
                lastEvent: `Maersk public tracking failed on ${deploymentRuntimeLabel()}: ${message}`,
                rawDetails: error?.stack || message,
                error: 'Maersk public tracking failed',
                url,
            };
        }
    }
    if (carrier === 'MSC' && url) {
        try {
            return await fetchMscTracking(trackingReference, url);
        }
        catch (error) {
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
    if (carrier === 'Evergreen' && url) {
        try {
            return await fetchEvergreenTracking(trackingReference);
        }
        catch (error) {
            const message = String(error?.message || error);
            return {
                status: statusLabel(shipment.status),
                location: shipment.destinationPort,
                eta: shipment.eta ? new Date(shipment.eta) : null,
                lastEvent: `Evergreen tracking failed: ${message}`,
                rawDetails: error?.stack || message,
                error: 'Evergreen tracking failed',
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
export async function syncShipmentTracking(id, force = false) {
    await ensureShipmentTrackingColumns();
    const shipments = await db.query('SELECT * FROM Shipment WHERE id = ?', [id]);
    const shipment = shipments[0];
    if (!shipment)
        return null;
    const containers = await db.query(
        'SELECT containerNumber FROM Container WHERE shipmentId = ? AND isActive = 1 ORDER BY createdAt DESC',
        [id],
    );
    shipment.containerNumbers = containers.map((container) => container.containerNumber).filter(Boolean);
    const lastChecked = shipment.carrierTrackingLastCheckedAt
        ? new Date(shipment.carrierTrackingLastCheckedAt).getTime()
        : 0;
    if (!force && lastChecked && Date.now() - lastChecked < TRACKING_INTERVAL_MS) {
        return shipment;
    }
    const result = await fetchCarrierTracking(shipment);
    console.log("log3", result)
    if (result.status === 'No results found' &&
        shipment.carrierTrackingRawDetails &&
        shipment.carrierTrackingStatus &&
        shipment.carrierTrackingStatus !== 'No results found') {
        result.status = shipment.carrierTrackingStatus;
        result.location = shipment.carrierTrackingLocation || result.location;
        result.lastEvent = shipment.carrierTrackingLastEvent || result.lastEvent;
        result.rawDetails = shipment.carrierTrackingRawDetails;
        result.error = `${trackingCarrierLabel(shipment.shippingLine) || 'Carrier'} tracking returned no result; kept previous tracking details`;
    }
    const now = new Date();
    const nextCheck = new Date(now.getTime() + TRACKING_INTERVAL_MS);
    const nextStatus = result.error
        ? shipment.status
        : progressiveShipmentStatus(shipment.status, shipmentStatusFromCarrier(result));
    const statusChanged = nextStatus !== shipment.status;
    await db.execute(`UPDATE Shipment
     SET status = ?,
         carrierTrackingStatus = ?,
         carrierTrackingLocation = ?,
         carrierTrackingEta = ?,
         carrierTrackingLastEvent = ?,
         carrierTrackingLastCheckedAt = ?,
         carrierTrackingNextCheckAt = ?,
         carrierTrackingError = ?,
         carrierTrackingUrl = ?,
         carrierTrackingRawDetails = ?,
         updatedAt = ?
     WHERE id = ?`, [
        nextStatus,
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
    ]);
    const eventId = createId();
    await db.execute(`INSERT INTO TimelineEvent (id, shipmentId, event, description, location, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`, [
        eventId,
        id,
        'Carrier Tracking Checked',
        result.lastEvent || `Carrier status: ${result.status}`,
        result.location,
        now,
    ]);
    if (statusChanged) {
        await createNotification({
            title: 'Shipment status updated',
            message: `${shipment.shipmentNumber} changed from ${statusLabel(shipment.status)} to ${statusLabel(nextStatus)}. ${result.lastEvent || ''}`.trim(),
            category: 'shipment',
            type: ['at_pod', 'delivered'].includes(nextStatus) ? 'warning' : 'info',
            priority: ['at_pod', 'delivered'].includes(nextStatus) ? 'high' : 'normal',
            actionUrl: `/shipments/${id}`,
            emailEnabled: true,
            recipients: await notificationRecipients(id, { includeCompanyContacts: false }),
            dedupeKey: `tracking-status:${id}:${nextStatus}`,
        }).catch((error) => {
            console.error(`Tracking status notification failed for ${id}:`, error);
        });
        const statusEventId = createId();
        await db.execute(`INSERT INTO TimelineEvent (id, shipmentId, event, description, location, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`, [
            statusEventId,
            id,
            'Shipment Status Updated',
            `Carrier tracking changed status from ${statusLabel(shipment.status)} to ${statusLabel(nextStatus)}.`,
            result.location,
            now,
        ]);
    }
    const updated = await db.query('SELECT * FROM Shipment WHERE id = ?', [id]);
    return updated[0] || null;
}
export async function syncDueShipmentTrackings(carrier = null) {
    await ensureShipmentTrackingColumns();
    const carrierFilter = carrier === 'MSC'
        ? `AND (
            shippingLine LIKE '%msc%'
            OR shippingLine LIKE '%mediterranean shipping%'
          )`
        : carrier === 'Maersk'
            ? `AND (
                shippingLine LIKE '%maersk%'
                OR shippingLine LIKE '%mersk%'
              )`
            : carrier === 'Evergreen'
                ? `AND (
                shippingLine LIKE '%evergreen%'
                OR shippingLine LIKE '%shipmentlink%'
              )`
                : '';
    const dueShipments = await db.query(`SELECT *
     FROM Shipment
     WHERE isActive = 1
       AND (
         (blNumber IS NOT NULL AND blNumber <> '')
         OR (bookingNumber IS NOT NULL AND bookingNumber <> '')
         OR EXISTS (
           SELECT 1
           FROM Container
           WHERE Container.shipmentId = Shipment.id
             AND Container.isActive = 1
             AND Container.containerNumber IS NOT NULL
             AND Container.containerNumber <> ''
         )
       )
       AND shippingLine IS NOT NULL
       AND shippingLine <> ''
       AND (
         shippingLine LIKE '%maersk%'
         OR shippingLine LIKE '%mersk%'
         OR shippingLine LIKE '%msc%'
         OR shippingLine LIKE '%mediterranean shipping%'
         OR shippingLine LIKE '%evergreen%'
         OR shippingLine LIKE '%shipmentlink%'
       )
       AND status NOT IN ('delivered', 'closed')
       ${carrierFilter}
       AND (
         carrierTrackingLastCheckedAt IS NULL
         OR carrierTrackingLastCheckedAt <= NOW() - INTERVAL '6 hours'
       )`);
    for (const shipment of dueShipments) {
        try {
            await syncShipmentTracking(shipment.id);
        }
        catch (error) {
            console.error(`Scheduled tracking failed for shipment ${shipment.id}:`, error);
        }
    }
    return dueShipments.length;
}
export function startShipmentTrackingScheduler() {
    void syncDueShipmentTrackings().catch((error) => {
        console.error('Initial carrier tracking sync failed:', error);
    });
    setInterval(() => {
        void syncDueShipmentTrackings().catch((error) => {
            console.error('Scheduled carrier tracking sync failed:', error);
        });
    }, TRACKING_INTERVAL_MS);
}
