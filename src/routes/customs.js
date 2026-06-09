import { db } from '../db.js';
import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
const router = Router();
// GET /api/customs/[id]
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const customs = await db.query(`
      SELECT c.*, 
             s.id as rel_shipmentId, s.shipmentNumber, s.status as shipmentStatus, 
             s.originCountry, s.destinationPort,
             comp.id as companyId, comp.name as companyName
      FROM CustomsClearance c
      LEFT JOIN Shipment s ON c.shipmentId = s.id
      LEFT JOIN Company comp ON s.companyId = comp.id
      WHERE c.id = ?
    `, [id]);
        if (!customs || customs.length === 0) {
            return res.status(404).json({ error: 'Customs record not found' });
        }
        const row = customs[0];
        const formattedCustoms = {
            ...row,
            isActive: Boolean(row.isActive),
            shipment: row.rel_shipmentId ? {
                id: row.rel_shipmentId,
                shipmentNumber: row.shipmentNumber,
                status: row.shipmentStatus,
                originCountry: row.originCountry,
                destinationPort: row.destinationPort,
                company: row.companyId ? { id: row.companyId, name: row.companyName } : null
            } : null
        };
        return res.json({ data: formattedCustoms });
    }
    catch (error) {
        console.error('Customs GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch customs record' });
    }
});
// PUT /api/customs/[id]
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const body = req.body;
        const updates = [];
        const values = [];
        const settableFields = [
            'chaName', 'chaContact', 'assessmentValue', 'dutyAmount',
            'dutyStatus', 'clearanceStatus', 'customsRemarks', 'isActive'
        ];
        for (const field of settableFields) {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(body[field]);
            }
        }
        const dateFields = ['assessmentDate', 'paymentDate', 'clearanceDate'];
        for (const field of dateFields) {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(body[field] ? new Date(body[field]) : null);
            }
        }
        updates.push(`updatedAt = ?`);
        values.push(new Date());
        if (updates.length > 0) {
            const sql = `UPDATE CustomsClearance SET ${updates.join(', ')} WHERE id = ?`;
            values.push(id);
            await db.execute(sql, values);
        }
        const updatedCustoms = await db.query(`SELECT * FROM CustomsClearance WHERE id = ?`, [id]);
        return res.json({ data: updatedCustoms[0] });
    }
    catch (error) {
        console.error('Customs PUT error:', error);
        return res.status(500).json({ error: 'Failed to update customs record' });
    }
});
// DELETE /api/customs/[id]
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute(`UPDATE CustomsClearance SET isActive = 0 WHERE id = ?`, [id]);
        const updatedCustoms = await db.query(`SELECT * FROM CustomsClearance WHERE id = ?`, [id]);
        return res.json({ data: updatedCustoms[0] });
    }
    catch (error) {
        console.error('Customs DELETE error:', error);
        return res.status(500).json({ error: 'Failed to delete customs record' });
    }
});
// GET /api/customs - List customs clearance records with filtering, sorting, pagination
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1');
        const limit = parseInt(req.query.limit || '20');
        const dutyStatus = req.query.dutyStatus || '';
        const clearanceStatus = req.query.clearanceStatus || '';
        const shipmentId = req.query.shipmentId || '';
        const isActive = req.query.isActive;
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'desc';
        const skip = (page - 1) * limit;
        let whereClause = '1=1';
        const params = [];
        if (dutyStatus) {
            whereClause += ` AND c.dutyStatus = ?`;
            params.push(dutyStatus);
        }
        if (clearanceStatus) {
            whereClause += ` AND c.clearanceStatus = ?`;
            params.push(clearanceStatus);
        }
        if (shipmentId) {
            whereClause += ` AND c.shipmentId = ?`;
            params.push(shipmentId);
        }
        if (isActive !== undefined && isActive !== '') {
            whereClause += ` AND c.isActive = ?`;
            params.push(isActive === 'true' ? 1 : 0);
        }
        const allowedSortColumns = ['chaName', 'assessmentValue', 'dutyAmount', 'assessmentDate', 'paymentDate', 'clearanceDate', 'createdAt'];
        const safeSortBy = allowedSortColumns.includes(sortBy) ? `c.${sortBy}` : 'c.createdAt';
        const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        const sql = `
      SELECT c.*, 
             s.id as rel_shipmentId, s.shipmentNumber, s.status as shipmentStatus, 
             s.originCountry, s.destinationPort,
             comp.id as companyId, comp.name as companyName
      FROM CustomsClearance c
      LEFT JOIN Shipment s ON c.shipmentId = s.id
      LEFT JOIN Company comp ON s.companyId = comp.id
      WHERE ${whereClause}
      ORDER BY ${safeSortBy} ${safeSortOrder}
      LIMIT ? OFFSET ?
    `;
        const countSql = `SELECT COUNT(*) as total FROM CustomsClearance c WHERE ${whereClause}`;
        const sqlParams = [...params, limit, skip];
        const [customs, countResult] = await Promise.all([
            db.query(sql, sqlParams),
            db.query(countSql, params)
        ]);
        const formattedCustoms = customs.map(row => {
            return {
                ...row,
                isActive: Boolean(row.isActive),
                shipment: row.rel_shipmentId ? {
                    id: row.rel_shipmentId,
                    shipmentNumber: row.shipmentNumber,
                    status: row.shipmentStatus,
                    originCountry: row.originCountry,
                    destinationPort: row.destinationPort,
                    company: row.companyId ? { id: row.companyId, name: row.companyName } : null
                } : null
            };
        });
        const total = Number(countResult[0]?.total || 0);
        return res.json({
            data: formattedCustoms,
            pagination: { total, page, limit }
        });
    }
    catch (error) {
        console.error('Customs GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch customs records' });
    }
});
// POST /api/customs - Create a customs clearance record
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const id = createId();
        await db.execute(`
      INSERT INTO CustomsClearance (
        id, shipmentId, chaName, chaContact, assessmentValue, dutyAmount, 
        dutyStatus, clearanceStatus, customsRemarks, assessmentDate, 
        paymentDate, clearanceDate, isActive, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            id,
            body.shipmentId,
            body.chaName || null,
            body.chaContact || null,
            body.assessmentValue || 0,
            body.dutyAmount || 0,
            body.dutyStatus || 'pending',
            body.clearanceStatus || 'document_submission',
            body.customsRemarks || null,
            body.assessmentDate ? new Date(body.assessmentDate) : null,
            body.paymentDate ? new Date(body.paymentDate) : null,
            body.clearanceDate ? new Date(body.clearanceDate) : null,
            body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1,
            new Date(),
            new Date()
        ]);
        const customs = await db.query(`
      SELECT c.*, 
             s.id as rel_shipmentId, s.shipmentNumber
      FROM CustomsClearance c
      LEFT JOIN Shipment s ON c.shipmentId = s.id
      WHERE c.id = ?
    `, [id]);
        const row = customs[0];
        const formattedCustoms = {
            ...row,
            isActive: Boolean(row.isActive),
            shipment: row.rel_shipmentId ? { id: row.rel_shipmentId, shipmentNumber: row.shipmentNumber } : null
        };
        return res.status(201).json({ data: formattedCustoms });
    }
    catch (error) {
        console.error('Customs POST error:', error);
        return res.status(500).json({ error: 'Failed to create customs record' });
    }
});
export default router;
