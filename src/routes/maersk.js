import { Router } from 'express';
import {
    fetchMaerskLocations,
    fetchMaerskVessels,
    maerskConfigurationStatus,
    MaerskApiError,
} from '../services/maersk.js';

const router = Router();

const listValue = (value) => {
    if (Array.isArray(value))
        return value;
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
};

const sendMaerskError = (res, error) => {
    console.error('Maersk API error:', error);
    const status = error instanceof MaerskApiError && error.status < 500
        ? error.status
        : error instanceof MaerskApiError && error.status === 503
            ? 503
            : 502;
    return res.status(status).json({ error: error.message || 'Maersk API request failed' });
};

router.get('/status', (_req, res) => {
    return res.json({ data: maerskConfigurationStatus() });
});

router.get('/vessels', async (req, res) => {
    try {
        const result = await fetchMaerskVessels({
            vesselIMONumbers: listValue(req.query.vesselIMONumbers),
            carrierVesselCodes: listValue(req.query.carrierVesselCodes),
            vesselNames: listValue(req.query.vesselNames),
            vesselFlagCodes: listValue(req.query.vesselFlagCodes),
        });
        return res.json(result);
    }
    catch (error) {
        return sendMaerskError(res, error);
    }
});

router.get('/locations', async (req, res) => {
    try {
        const result = await fetchMaerskLocations(req.query);
        return res.json(result);
    }
    catch (error) {
        return sendMaerskError(res, error);
    }
});

export default router;
