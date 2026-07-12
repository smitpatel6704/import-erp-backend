import axios from "axios";

const HAPAG_TRACKING_URL = "https://tracking.api.hlag.cloud/api/tracking/events";

const normalizeHapagReference = (value) =>
    String(value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "")
        .replace(/[^A-Z0-9-]/g, "");

export async function fetchHapagTracking(trackingNumber) {
    const reference = normalizeHapagReference(trackingNumber);
    if (!reference) {
        return {
            status: 'No results found',
            location: null,
            eta: null,
            lastEvent: 'Hapag-Lloyd tracking needs a booking, BL, or container reference.',
            rawDetails: null,
            error: "Hapag-Lloyd tracking needs a booking, BL, or container reference"
        };
    }

    try {
        const { data } = await axios.get(
            HAPAG_TRACKING_URL,
            {
                params: { reference },
                headers: {
                    Accept: "application/json",
                    "x-token": "public",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
                },
                timeout: 30000,
                validateStatus: (status) => status >= 200 && status < 500
            }
        );

        if (data?.status === 422 || data?.error || data?.message) {
            return {
                status: 'No results found',
                location: null,
                eta: null,
                lastEvent: data?.message || data?.error || `Hapag-Lloyd rejected reference ${reference}`,
                rawDetails: null,
                error: data?.message || data?.error || `Hapag-Lloyd rejected reference ${reference}`
            };
        }

        if (!data || !data.groups || data.groups.length === 0) {
             return {
                 status: 'No results found',
                 location: null,
                 eta: null,
                 lastEvent: 'No results found on Hapag-Lloyd tracking for ' + reference,
                 rawDetails: null,
                 error: 'No results found on Hapag-Lloyd tracking for ' + reference
             };
        }

        let firstEta = null;
        let lastEventDescription = '';
        let lastEventDate = '';
        let lastEventLocation = '';
        let vesselName = '';
        let originPort = '';
        let destinationPort = '';
        let etd = '';
        
        const containers = [];
        const allEvents = [];

        data.groups.forEach((group) => {
            let cSize = '20FT';
            let cType = 'Dry Container';
            if (group.events?.[0]?.containerType) {
                const typeCode = group.events[0].containerType.toUpperCase();
                if (typeCode.startsWith('4')) cSize = '40FT';
                else if (typeCode.startsWith('2')) cSize = '20FT';
                if (typeCode.includes('RF') || typeCode.includes('RE')) cType = 'Reefer Container';
                else if (typeCode.includes('OT')) cType = 'Open Top Container';
            }

            if (group.containerNumber) {
                containers.push({
                    containerNumber: group.containerNumber,
                    size: cSize, 
                    type: cType,
                    containerGoods: ''
                });
            }

            // Collect Events
            if (Array.isArray(group.events)) {
                group.events.forEach((event) => {
                    const eDate = `${event.eventDate} ${event.eventTime || ''}`.trim();
                    const classifier = String(event.eventClassifierCode || '').toUpperCase();
                    allEvents.push({
                        event: event.eventDescription,
                        location: event.eventLocation,
                        dateText: eDate,
                        vessel: event.eventTransport || '',
                        isActual: classifier === 'ACT' || classifier === 'ACTUAL'
                    });
                });
            }
        });

        // Sort events chronologically based on dateText
        allEvents.sort((a, b) => new Date(a.dateText) - new Date(b.dateText));

        if (allEvents.length > 0) {
            // Origin Port: first 'Gated in' or 'Loaded' or simply first event location
            const firstEvent = allEvents[0];
            originPort = firstEvent.location || '';
            etd = firstEvent.dateText.split(' ')[0] || '';

            // Destination Port: last 'Discharged' or 'Arrival' or last event location
            const lastEvent = allEvents[allEvents.length - 1];
            destinationPort = lastEvent.location || '';
            
            // ETA: look for Planned Arrival or Discharge
            const plannedEta = data.groups
                ?.flatMap((group) => group.events || [])
                .find((event) =>
                    ['PLN', 'EST', 'PLANNED', 'ESTIMATED'].includes(String(event.eventClassifierCode || '').toUpperCase()) &&
                    /arrival|discharge|delivered/i.test(event.eventDescription || ''));
            if (plannedEta) {
                firstEta = `${plannedEta.eventDate} ${plannedEta.eventTime || ''}`.trim();
            } else {
                firstEta = lastEvent.dateText.split(' ')[0] || '';
            }

            // Vessel name: first actual vessel transport
            const vesselEvent = allEvents.find(e => e.vessel && !e.vessel.toLowerCase().includes("truck") && !e.vessel.toLowerCase().includes("train"));
            if (vesselEvent) {
                vesselName = vesselEvent.vessel;
            }

            // Last actual event
            const actualEvents = allEvents.filter(e => e.isActual);
            if (actualEvents.length > 0) {
                const latest = actualEvents[actualEvents.length - 1];
                lastEventDescription = latest.event;
                lastEventDate = latest.dateText;
                lastEventLocation = latest.location;
            }
        }

        const result = {
            trackingNo: reference,
            vesselName: vesselName, 
            originPort: originPort,
            destinationPort: destinationPort,
            etd: etd,
            eta: firstEta,
            priority: 'Normal',
            status: lastEventDescription || 'Tracking details available',
            location: lastEventLocation || null,
            lastEvent: lastEventDescription
                ? `${lastEventDescription}${lastEventDate ? ` • ${lastEventDate}` : ''}`
                : null,
            rawDetails: [
                `Reference: ${reference}`,
                `From: ${originPort || '-'}`,
                `To: ${destinationPort || '-'}`,
                `Latest event: ${lastEventDescription || '-'}${lastEventDate ? ` • ${lastEventDate}` : ''}`,
                '',
                'Timeline:',
                ...allEvents.map((event) => [event.event, event.location, event.dateText, event.vessel]
                    .filter(Boolean).join(' - ')),
            ].join('\n').slice(0, 12000),
            error: null,

            originCountry: '',
            goodsDescription: '',
            notes: lastEventDescription ? `Latest event: ${lastEventDescription} at ${lastEventDate}` : '',
            containers,
            raw: {
                etaText: firstEta,
                latestEvent: lastEventDescription,
                events: allEvents.map(e => ({
                    event: e.event,
                    location: e.location,
                    dateText: e.dateText,
                    vessel: e.vessel
                })),
                source: data
            }
        };

        return result;

    } catch (error) {
        console.error("Hapag tracking error:", error.message);
        return {
            status: 'No results found',
            location: null,
            eta: null,
            lastEvent: error.response?.data?.message || error.message,
            rawDetails: null,
            error: error.response?.data?.message || error.message
        };
    }
}
