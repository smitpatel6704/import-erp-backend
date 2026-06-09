import { Router } from 'express';
import { db } from '../db.js';
import { createId } from '@paralleldrive/cuid2';
const router = Router();
// GET /api/exporter-companies
router.get('/', async (req, res) => {
    try {
        const companies = await db.query('SELECT * FROM ExporterCompany WHERE isActive = 1 ORDER BY name ASC');
        return res.json({ data: companies });
    }
    catch (error) {
        console.error('Exporter companies GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch exporter companies' });
    }
});
// POST /api/exporter-companies
router.post('/', async (req, res) => {
    try {
        const { name, contactPerson, mobile, email, address, country } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        const id = createId();
        await db.execute('INSERT INTO ExporterCompany (id, name, contactPerson, mobile, email, address, country) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, name, contactPerson || null, mobile || null, email || null, address || null, country || null]);
        const company = await db.query('SELECT * FROM ExporterCompany WHERE id = ?', [id]);
        return res.status(201).json({ data: company[0] });
    }
    catch (error) {
        console.error('Exporter company POST error:', error);
        return res.status(500).json({ error: 'Failed to create exporter company' });
    }
});
// PUT /api/exporter-companies/:id
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body;
        const updates = [];
        const values = [];
        const fields = ['name', 'contactPerson', 'mobile', 'email', 'address', 'country', 'isActive'];
        for (const field of fields) {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(body[field]);
            }
        }
        if (updates.length > 0) {
            values.push(id);
            await db.execute(`UPDATE ExporterCompany SET ${updates.join(', ')} WHERE id = ?`, values);
        }
        const company = await db.query('SELECT * FROM ExporterCompany WHERE id = ?', [id]);
        return res.json({ data: company[0] });
    }
    catch (error) {
        console.error('Exporter company PUT error:', error);
        return res.status(500).json({ error: 'Failed to update exporter company' });
    }
});
// DELETE /api/exporter-companies/:id
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.execute('UPDATE ExporterCompany SET isActive = 0 WHERE id = ?', [id]);
        return res.json({ success: true });
    }
    catch (error) {
        console.error('Exporter company DELETE error:', error);
        return res.status(500).json({ error: 'Failed to delete exporter company' });
    }
});
export default router;
