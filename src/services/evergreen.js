import * as cheerio from 'cheerio';
import axios from 'axios';

const EVERGREEN_TRACKING_URL = 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do';
const EVERGREEN_TIMEOUT_MS = 30000;
const CONTAINER_PATTERN = /^[A-Z]{4}\d{7}$/;

const normalizeReference = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');
const cleanCell = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const parseEvergreenDate = (value) => {
    const match = cleanCell(value).match(/^([A-Z]{3})-(\d{1,2})-(\d{4})$/i);
    if (!match)
        return null;
    const month = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    }[match[1].toUpperCase()];
    if (month === undefined)
        return null;
    return new Date(Date.UTC(Number(match[3]), month, Number(match[2]), 12));
};

const splitVesselVoyage = (value) => {
    const cleaned = cleanCell(value).replace(/\s*\([^)]*\)\s*$/, '');
    const match = cleaned.match(/^(.+?)\s+([A-Z0-9-]+)$/i);
    return {
        vesselName: match?.[1]?.trim() || cleaned || null,
        voyageNumber: match?.[2]?.trim() || null,
    };
};

const containerSize = (value) => {
    const match = cleanCell(value).match(/^(\d{2})/);
    return match ? `${match[1]}FT` : '';
};

const containerType = (value) => {
    const normalized = cleanCell(value).toUpperCase();
    if (normalized.includes('SH') || normalized.includes('HC'))
        return 'High Cube';
    if (normalized.includes('RF') || normalized.includes('RH'))
        return 'Reefer';
    return normalized ? 'Dry Container' : '';
};

const rowCells = ($, row) => $(row)
    .children('th,td')
    .map((_, cell) => cleanCell($(cell).text()))
    .get()
    .filter(Boolean);

export function parseEvergreenTrackingHtml(html, reference, url = EVERGREEN_TRACKING_URL) {
    const $ = cheerio.load(html);
    const bodyText = cleanCell($('body').text());
    const etaMatch = bodyText.match(/Estimated Date of Arrival\s*:\s*([A-Z]{3}-\d{1,2}-\d{4})/i);
    const eta = parseEvergreenDate(etaMatch?.[1]);
    let vesselVoyage = '';
    let headers = [];
    const records = [];

    $('tr').each((_, row) => {
        const cells = rowCells($, row);
        if (cells[0] === 'Vessel Voyage on B/L' && cells[1])
            vesselVoyage = cells[1];
        if (cells.includes('Container No.') && cells.includes('Container Moves')) {
            headers = cells;
            return;
        }
        if (!headers.length || cells.length < 4 || !CONTAINER_PATTERN.test(cells[0]))
            return;
        const record = {};
        headers.forEach((header, index) => {
            record[header] = cells[index] || '';
        });
        if (!records.some((item) =>
            item['Container No.'] === record['Container No.'] &&
            item.Date === record.Date &&
            item['Container Moves'] === record['Container Moves'])) {
            records.push(record);
        }
    });

    const noResult = /no data found|not found|invalid (container|b\/l)|please check/i.test(bodyText);
    if (!records.length) {
        return {
            status: 'No results found',
            location: null,
            eta,
            etd: null,
            origin: null,
            originCountry: null,
            destination: null,
            vesselName: splitVesselVoyage(vesselVoyage).vesselName,
            voyageNumber: splitVesselVoyage(vesselVoyage).voyageNumber,
            containers: [],
            lastEvent: noResult
                ? `Evergreen did not find tracking details for ${reference}.`
                : 'Evergreen tracking returned an unrecognized response.',
            rawDetails: bodyText.slice(0, 12000),
            error: noResult ? 'No Evergreen tracking result found' : 'Unable to parse Evergreen tracking response',
            url,
        };
    }

    const latest = records
        .map((record) => ({ record, date: parseEvergreenDate(record.Date) }))
        .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))[0].record;
    const latestVesselVoyage = latest['Vessel Voyage'] || vesselVoyage;
    const { vesselName, voyageNumber } = splitVesselVoyage(latestVesselVoyage);
    const status = latest['Container Moves'] || 'Tracking details available';
    const location = latest.Location || null;
    const lastEvent = [
        status,
        location,
        latest.Date,
        latestVesselVoyage,
    ].filter(Boolean).join(' • ');
    const timeline = records.map((record) => [
        record.Date,
        record['Container Moves'],
        record.Location,
        record['Vessel Voyage'],
    ].filter(Boolean).join(' - '));

    return {
        status,
        location,
        eta,
        etd: null,
        origin: null,
        originCountry: null,
        destination: null,
        vesselName,
        voyageNumber,
        containers: records.map((record) => ({
            containerNumber: record['Container No.'],
            containerSize: containerSize(record['Size/Type']),
            containerType: containerType(record['Size/Type']),
        })),
        lastEvent,
        rawDetails: [
            `Reference: ${reference}`,
            etaMatch?.[1] ? `ETA: ${etaMatch[1]}` : null,
            `Latest event: ${lastEvent}`,
            latest.Method ? `Method: ${latest.Method}` : null,
            latest.VGM ? `VGM: ${latest.VGM}` : null,
            '',
            'Timeline:',
            ...timeline,
        ].filter((line) => line !== null).join('\n').slice(0, 12000),
        error: null,
        url,
    };
}

export async function fetchEvergreenTracking(reference) {
    const normalized = normalizeReference(reference);
    const isContainer = CONTAINER_PATTERN.test(normalized);
    const form = new URLSearchParams({
        TYPE: isContainer ? 'CNTR' : 'BL',
        BL: isContainer ? '' : normalized,
        CNTR: isContainer ? normalized : '',
        PRINT: 'YES',
    });
    const response = await axios.post(EVERGREEN_TRACKING_URL, form, {
        headers: {
            accept: 'text/html,application/xhtml+xml',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0',
            Referer: EVERGREEN_TRACKING_URL,
        },
        timeout: EVERGREEN_TIMEOUT_MS,
        responseType: 'text',
        validateStatus: () => true,
    });
    const html = String(response.data || '');
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Evergreen tracking returned HTTP ${response.status}: ${cleanCell(html).slice(0, 300)}`);
    }
    return parseEvergreenTrackingHtml(html, normalized);
}

export const evergreenTrackingUrl = () => EVERGREEN_TRACKING_URL;
