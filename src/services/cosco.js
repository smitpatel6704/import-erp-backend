import axios from 'axios';
import { Buffer } from 'node:buffer';

const COSCO_BASE_URL = 'https://elines.coscoshipping.com/scct/scct_customer_ex/public/cargoTracking';
const COSCO_TRACKING_PAGE = 'https://elines.coscoshipping.com/ebusiness/cargoTracking';
const COSCO_XOR_KEY = process.env.COSCO_XOR_KEY || 'b3Ay6#9f1a@%&2^6';
const COSCO_TIMEOUT_MS = 30000;
const COSCO_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const clean = (value) => typeof value === 'string' ? value.trim() : value;
const normalizedKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const firstValue = (objects, keys) => {
    const wanted = new Set(keys.map(normalizedKey));
    for (const object of objects) {
        for (const [key, value] of Object.entries(object || {})) {
            if (wanted.has(normalizedKey(key)) && value !== null && value !== undefined && clean(value) !== '')
                return clean(value);
        }
    }
    return null;
};
const allObjects = (value, result = []) => {
    if (!value || typeof value !== 'object') return result;
    if (!Array.isArray(value)) result.push(value);
    Object.values(value).forEach((child) => {
        if (child && typeof child === 'object') allObjects(child, result);
    });
    return result;
};
const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const randomNumber = (length = 16) => Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');

export function decodeCoscoPayload(encodedData, key = COSCO_XOR_KEY) {
    if (!encodedData || typeof encodedData !== 'string') return encodedData;
    const source = Buffer.from(encodedData, 'base64');
    const keyBuffer = Buffer.from(key, 'utf8');
    const output = Buffer.alloc(source.length);
    for (let index = 0; index < source.length; index++)
        output[index] = source[index] ^ keyBuffer[index % keyBuffer.length];
    const decoded = output.toString('utf8');
    try {
        return JSON.parse(decoded);
    } catch {
        throw new Error('COSCO returned an unreadable tracking response');
    }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function callCosco(endpoint, payload) {
    const timestamp = Date.now().toString();
    const response = await axios.post(`${COSCO_BASE_URL}/${endpoint}`, payload, {
        timeout: COSCO_TIMEOUT_MS,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Origin: 'https://elines.coscoshipping.com',
            Referer: COSCO_TRACKING_PAGE,
            'User-Agent': COSCO_USER_AGENT,
            'SCCT-Random': randomNumber(),
            'SCCT-Timestamp': timestamp,
            'X-Client-Timestamp': timestamp,
        },
    });
    return decodeCoscoPayload(response.data);
}

async function callCoscoWithRetry(endpoint, payload) {
    try {
        return await callCosco(endpoint, payload);
    } catch (error) {
        if (error?.response?.status !== 403) throw error;
        // COSCO intermittently rate-limits simultaneous public tracking calls.
        await wait(250);
        return callCosco(endpoint, payload);
    }
}

export function parseCoscoTracking(responses, reference) {
    const objects = allObjects(responses);
    const summary = objects.find((item) => item.por || item.fnd || item.porCountryCode || item.fndCountryCode) || {};
    const sailingSchedules = objects.filter((item) => item.vesselName && (item.polPort || item.podPort));
    const firstSailing = sailingSchedules[0] || {};
    const finalSailing = sailingSchedules.at(-1) || {};
    const originLocation = objects.find((item) => ['POR', 'FPOL'].includes(String(item.locationType || '').toUpperCase())) || {};
    const destinationLocation = [...objects].reverse().find((item) => ['FND', 'LPOD'].includes(String(item.locationType || '').toUpperCase())) || {};
    const eventObjects = objects.filter((item) => firstValue([item], [
        'eventDescription', 'eventDesc', 'eventName', 'eventType', 'activity', 'statusDescription', 'latestEvent',
    ]));
    const datedEvents = eventObjects.map((item) => ({
        item,
        date: parseDate(firstValue([item], ['eventTime', 'eventDate', 'actualEventDateTime', 'latestEventTime', 'actualTime', 'actualDate', 'dateTime', 'time', 'date'])),
    })).sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
    const latest = datedEvents[0]?.item || {};
    const status = firstValue([latest, ...objects], [
        'eventDescription', 'eventDesc', 'eventName', 'activity', 'statusDescription', 'latestEvent', 'status', 'currentStatus',
    ]) || 'Tracking details available';
    const location = firstValue([latest, ...objects], [
        'locationName', 'location', 'eventLocation', 'portName', 'placeOfActivity',
    ]);
    const containersByNumber = new Map();
    for (const item of objects) {
        const containerNumber = String(firstValue([item], ['containerNumber', 'containerNo', 'cntrNo', 'equipmentNumber']) || '').toUpperCase();
        if (!/^[A-Z]{4}\d{7}$/.test(containerNumber)) continue;
        const sizeType = String(firstValue([item], ['containerSizeType', 'containerType', 'cntrType', 'sizeType', 'equipmentSizeType', 'isoCode']) || '');
        containersByNumber.set(containerNumber, {
            containerNumber,
            containerSize: /45/.test(sizeType) ? '45FT' : /40/.test(sizeType) ? '40FT' : /20/.test(sizeType) ? '20FT' : '',
            // Keep the carrier's ISO equipment code (for example 20GP) in the API response.
            containerType: sizeType,
            containerTypeLabel: /RF|REEFER|RH/i.test(sizeType) ? 'Reefer' : /HC|HQ|HIGH/i.test(sizeType) ? 'High Cube' : 'Dry Container',
        });
    }
    const eventDate = datedEvents[0]?.date;
    const lastEvent = [status, location, eventDate?.toISOString()].filter(Boolean).join(' • ');
    return {
        status,
        location,
        eta: parseDate(firstValue([finalSailing, destinationLocation, ...objects], ['eta', 'estimatedTime', 'estimatedArrivalTime', 'estimatedArrivalDate', 'podEta'])),
        etd: parseDate(firstValue([firstSailing, originLocation, ...objects], ['etd', 'estimatedTime', 'estimatedDepartureTime', 'estimatedDepartureDate', 'polEtd'])),
        origin: firstValue([summary, firstSailing, originLocation, ...objects], ['por', 'polPort', 'city', 'portOfLoadingName', 'polName', 'originPort', 'placeOfReceiptName', 'fromLocation']),
        originCountry: firstValue([originLocation, summary, ...objects], ['countryName', 'originCountry', 'polCountryName', 'placeOfReceiptCountry', 'porCountryCode']),
        destination: firstValue([summary, finalSailing, destinationLocation, ...objects], ['fnd', 'podPort', 'city', 'portOfDischargeName', 'podName', 'destinationPort', 'placeOfDeliveryName', 'toLocation']),
        vesselName: firstValue([latest, finalSailing, ...objects], ['vesselName', 'vessel', 'shipName']),
        voyageNumber: firstValue([latest, finalSailing, ...objects], ['voyageNumber', 'voyageNo', 'voyage']),
        bookingNumber: firstValue(objects, ['bookingNumber', 'bookingNo']),
        containers: [...containersByNumber.values()],
        lastEvent,
        rawDetails: JSON.stringify(responses).slice(0, 12000),
        error: null,
        url: COSCO_TRACKING_PAGE,
        reference,
    };
}

export async function fetchCoscoTracking(blNumber) {
    const reference = String(blNumber || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{6,30}$/.test(reference)) throw new Error('Invalid COSCO B/L number');
    const payload = {
        businessNumber: reference,
        businessNumberType: 'blNumber',
        eventStage: 'OCEAN',
        notFilterResult: false,
    };
    const endpoints = ['detail', 'fullChainInfo', 'transportDetail', 'bookingInfo', 'sailingSchedule'];
    const responses = {};
    const failures = [];
    let firstFailure = null;
    // Avoid sending a burst of five requests; COSCO's public gateway can reject bursts with 403.
    for (const endpoint of endpoints) {
        try {
            responses[endpoint] = await callCoscoWithRetry(endpoint, payload);
        } catch (error) {
            firstFailure ||= error;
            failures.push(`${endpoint}: ${error?.response?.status || error?.message || 'failed'}`);
        }
    }
    if (!Object.keys(responses).length) {
        const error = new Error(`COSCO rejected all tracking requests (${failures.join(', ')})`);
        error.cause = firstFailure;
        throw error;
    }
    const parsed = parseCoscoTracking(responses, reference);
    if (failures.length) parsed.rawDetails = [parsed.rawDetails, `Partial endpoint failures: ${failures.join(', ')}`].filter(Boolean).join('\n').slice(0, 12000);
    if (!parsed.containers.length && !parsed.vesselName && !parsed.origin && !parsed.destination && parsed.status === 'Tracking details available') {
        parsed.status = 'No results found';
        parsed.error = `COSCO did not find tracking details for ${reference}`;
        parsed.lastEvent = parsed.error;
    }
    return parsed;
}
