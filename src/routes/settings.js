import { Router } from 'express';
import { db } from '../db.js';
import { createId } from '@paralleldrive/cuid2';
const router = Router();
const BRAND_LOGO_KEYS = {
    light: 'brand_logo_light',
    dark: 'brand_logo_dark',
    collapsed: 'brand_logo_collapsed',
};
const MAX_LOGO_DATA_URL_LENGTH = 3 * 1024 * 1024;
const SYSTEM_SHIPPING_LINES = new Set(['evergreen', 'hapaglloyd', 'maersk', 'msc']);
const normalizeLogoMode = (mode) => (mode === 'collapsed' ? 'collapsed' : mode === 'dark' ? 'dark' : 'light');
const normalizeShippingLine = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const isSupportedLogoDataUrl = (value) => {
    if (!value) return true;
    if (typeof value !== 'string') return false;
    if (value.length > MAX_LOGO_DATA_URL_LENGTH) return false;
    return /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/i.test(value);
};

// GET /api/settings/brand-logos
router.get('/brand-logos', async (_req, res) => {
    try {
        const rows = await db.query(
            'SELECT "key", "value" FROM "AppSetting" WHERE "key" IN (?, ?, ?)',
            [BRAND_LOGO_KEYS.light, BRAND_LOGO_KEYS.dark, BRAND_LOGO_KEYS.collapsed],
        );
        const logos = { light: '', dark: '', collapsed: '' };
        rows.forEach((row) => {
            if (row.key === BRAND_LOGO_KEYS.light) logos.light = row.value || '';
            if (row.key === BRAND_LOGO_KEYS.dark) logos.dark = row.value || '';
            if (row.key === BRAND_LOGO_KEYS.collapsed) logos.collapsed = row.value || '';
        });
        return res.json({ data: logos });
    }
    catch (error) {
        console.error('Settings brand logos GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch brand logos' });
    }
});

// PUT /api/settings/brand-logos
router.put('/brand-logos', async (req, res) => {
    try {
        const mode = normalizeLogoMode(req.body?.mode);
        const logoDataUrl = String(req.body?.logoDataUrl || '');
        if (!isSupportedLogoDataUrl(logoDataUrl)) {
            return res.status(400).json({ error: 'Unsupported logo format or logo is too large' });
        }
        const key = BRAND_LOGO_KEYS[mode];
        if (!logoDataUrl) {
            await db.execute('DELETE FROM "AppSetting" WHERE "key" = ?', [key]);
            return res.json({ data: { mode, logoDataUrl: '' } });
        }
        await db.execute(`
            INSERT INTO "AppSetting" ("key", "value", "updatedBy", "updatedAt")
            VALUES (?, ?, ?, NOW())
            ON CONFLICT ("key") DO UPDATE
            SET "value" = EXCLUDED."value",
                "updatedBy" = EXCLUDED."updatedBy",
                "updatedAt" = NOW()
        `, [key, logoDataUrl, req.user?.id || null]);
        return res.json({ data: { mode, logoDataUrl } });
    }
    catch (error) {
        console.error('Settings brand logos PUT error:', error);
        return res.status(500).json({ error: 'Failed to save brand logo' });
    }
});

// DELETE /api/settings/brand-logos/:mode
router.delete('/brand-logos/:mode', async (req, res) => {
    try {
        const mode = normalizeLogoMode(req.params.mode);
        await db.execute('DELETE FROM "AppSetting" WHERE "key" = ?', [BRAND_LOGO_KEYS[mode]]);
        return res.json({ data: { mode, logoDataUrl: '' } });
    }
    catch (error) {
        console.error('Settings brand logos DELETE error:', error);
        return res.status(500).json({ error: 'Failed to delete brand logo' });
    }
});

// GET /api/settings/workflow
router.get('/workflow', async (_req, res) => {
    try {
        const [row] = await db.query(
            'SELECT "value" FROM "AppSetting" WHERE "key" = ?',
            ['workflow_automations']
        );
        let settings = {
            autoAssignTracking: true,
            requireDocumentsForClearance: true,
            notifyOnStatusChange: true,
            notifyOnDelay: true
        };
        if (row && row.value) {
            try {
                settings = { ...settings, ...JSON.parse(row.value) };
            } catch (e) {
                console.error('Failed to parse workflow_automations setting:', e);
            }
        }
        return res.json({ data: settings });
    }
    catch (error) {
        console.error('Settings workflow GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch workflow settings' });
    }
});

// PUT /api/settings/workflow
router.put('/workflow', async (req, res) => {
    try {
        const settings = req.body || {};
        const value = JSON.stringify(settings);
        
        await db.execute(`
            INSERT INTO "AppSetting" ("key", "value", "updatedBy", "updatedAt")
            VALUES (?, ?, ?, NOW())
            ON CONFLICT ("key") DO UPDATE
            SET "value" = EXCLUDED."value",
                "updatedBy" = EXCLUDED."updatedBy",
                "updatedAt" = NOW()
        `, ['workflow_automations', value, req.user?.id || null]);
        
        return res.json({ data: settings });
    }
    catch (error) {
        console.error('Settings workflow PUT error:', error);
        return res.status(500).json({ error: 'Failed to save workflow settings' });
    }
});


// GET /api/settings/options?category=shipping_line
router.get('/options', async (req, res) => {
    try {
        const { category } = req.query;
        let query = 'SELECT * FROM SettingOption WHERE isActive = 1';
        const params = [];
        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }
        query += ' ORDER BY label ASC';
        const options = await db.query(query, params);
        return res.json({ data: options });
    }
    catch (error) {
        console.error('Settings options GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch options' });
    }
});
// POST /api/settings/options
router.post('/options', async (req, res) => {
    try {
        const { category, value, label } = req.body;
        if (!category || !value || !label) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const id = createId();
        await db.execute('INSERT INTO SettingOption (id, category, value, label) VALUES (?, ?, ?, ?)', [id, category, value, label]);
        const options = await db.query('SELECT * FROM SettingOption WHERE id = ?', [id]);
        return res.status(201).json({ data: options[0] });
    }
    catch (error) {
        console.error('Settings options POST error:', error);
        return res.status(500).json({ error: 'Failed to create option' });
    }
});
router.delete('/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [option] = await db.query('SELECT category, value FROM SettingOption WHERE id = ?', [id]);
        if (option && option.category === 'shipping_line') {
            if (SYSTEM_SHIPPING_LINES.has(normalizeShippingLine(option.value))) {
                return res.status(403).json({ error: `${option.value} is a system-required shipping line and cannot be deleted.` });
            }
        }
        await db.execute('DELETE FROM SettingOption WHERE id = ?', [id]);
        return res.json({ success: true });
    }
    catch (error) {
        console.error('Settings options DELETE error:', error);
        return res.status(500).json({ error: 'Failed to delete option' });
    }
});
export default router;
