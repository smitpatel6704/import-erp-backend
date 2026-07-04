import axios from "axios";

export async function fetchHapagTracking(trackingNumber) {
    try {
        const { data } = await axios.get(
            `https://tracking.api.hlag.cloud/api/tracking/events?reference=${encodeURIComponent(trackingNumber)}`,
            {
                headers: {
                    Accept: "application/json",
                    "x-token": "public",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
                }
            }
        );

        if (!data || !data.groups || data.groups.length === 0) {
             return {
                 ok: false,
                 trackingNo: trackingNumber,
                 error: 'No results found on Hapag-Lloyd tracking for ' + trackingNumber
             };
        }

        let firstEta = null;
        let lastEventDescription = '';
        let lastEventDate = '';
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
                    allEvents.push({
                        event: event.eventDescription,
                        location: event.eventLocation,
                        dateText: eDate,
                        vessel: event.eventTransport || '',
                        isActual: event.eventClassifierCode !== 'Planned'
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
            const plannedEta = data.groups?.[0]?.events?.find(e => e.eventClassifierCode === "Planned" && (e.eventDescription?.toLowerCase().includes("arrival") || e.eventDescription?.toLowerCase().includes("discharge") || e.eventDescription?.toLowerCase().includes("delivered")));
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
            } else {
                lastEventDescription = lastEvent.event;
                lastEventDate = lastEvent.dateText;
            }
        }

        const result = {
            ok: true,
            trackingNo: trackingNumber,
            vesselName: vesselName, 
            originPort: originPort,
            destinationPort: destinationPort,
            etd: etd,
            eta: firstEta,
            priority: 'Normal',
            status: 'Draft',
            shipmentValue: 0,
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
            ok: false,
            trackingNo: trackingNumber,
            error: error.response?.data?.message || error.message
        };
    }
}
