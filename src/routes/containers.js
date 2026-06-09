import { Router } from 'express';
import { db } from '../db.js';
import { createId } from '@paralleldrive/cuid2';
const router = Router();
// GET /api/containers/[id]
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const containers = await db.query(`
      SELECT c.*, 
             s.id as shipment_id, s.shipmentNumber as shipment_shipmentNumber, s.status as shipment_status, 
             s.originPort as shipment_originPort, s.destinationPort as shipment_destinationPort,
             comp.id as company_id, comp.name as company_name
      FROM Container c
      LEFT JOIN Shipment s ON c.shipmentId = s.id
      LEFT JOIN Company comp ON s.companyId = comp.id
      WHERE c.id = ?
    `, [id]);
        if (!containers || containers.length === 0) {
            return res.status(404).json({ error: 'Container not found' });
        }
        const c = containers[0];
        const container = {
            ...c,
            shipment: c.shipment_id ? {
                id: c.shipment_id,
                shipmentNumber: c.shipment_shipmentNumber,
                status: c.shipment_status,
                originPort: c.shipment_originPort,
                destinationPort: c.shipment_destinationPort,
                company: c.company_id ? { id: c.company_id, name: c.company_name } : null
            } : null,
            expenses: []
        };
        return res.json({ data: container });
    }
    catch (error) {
        console.error('Container GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch container' });
    }
});
// PUT /api/containers/[id]
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const body = req.body;
        await db.execute(`
      UPDATE Container SET
        containerNumber = ?, containerType = ?, containerSize = ?, sealNumber = ?,
        stuffingType = ?, weightCapacity = ?, currentWeight = ?, status = ?,
        currentLocation = ?, latitude = ?, longitude = ?, isActive = ?, updatedAt = NOW()
      WHERE id = ?
    `, [
            body.containerNumber, body.containerType, body.containerSize, body.sealNumber,
            body.stuffingType, body.weightCapacity, body.currentWeight, body.status,
            body.currentLocation, body.latitude, body.longitude, body.isActive, id
        ]);
        const updated = await db.query('SELECT * FROM Container WHERE id = ?', [id]);
        return res.json({ data: updated[0] });
    }
    catch (error) {
        console.error('Container PUT error:', error);
        return res.status(500).json({ error: 'Failed to update container' });
    }
});
// DELETE /api/containers/[id]
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE Container SET isActive = 0 WHERE id = ?', [id]);
        return res.json({ success: true });
    }
    catch (error) {
        console.error('Container DELETE error:', error);
        return res.status(500).json({ error: 'Failed to delete container' });
    }
});
// GET /api/containers - List containers with filtering, sorting, pagination
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '20', 10);
        const search = req.query.search || '';
        const status = req.query.status || '';
        const containerType = req.query.containerType || '';
        const containerSize = req.query.containerSize || '';
        const shipmentId = req.query.shipmentId || '';
        const isActive = req.query.isActive;
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'desc';
        const skip = (page - 1) * limit;
        let whereClause = '1=1';
        const params = [];
        const countParams = [];
        if (search) {
            whereClause += ' AND (c.containerNumber LIKE ? OR c.sealNumber LIKE ? OR c.currentLocation LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
            countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (status) {
            whereClause += ' AND c.status = ?';
            params.push(status);
            countParams.push(status);
        }
        if (containerType) {
            whereClause += ' AND c.containerType = ?';
            params.push(containerType);
            countParams.push(containerType);
        }
        if (containerSize) {
            whereClause += ' AND c.containerSize = ?';
            params.push(containerSize);
            countParams.push(containerSize);
        }
        if (shipmentId) {
            whereClause += ' AND c.shipmentId = ?';
            params.push(shipmentId);
            countParams.push(shipmentId);
        }
        if (isActive !== undefined && isActive !== '') {
            whereClause += ' AND c.isActive = ?';
            params.push(isActive === 'true' ? 1 : 0);
            countParams.push(isActive === 'true' ? 1 : 0);
        }
        params.push(limit, skip);
        const allowedSortColumns = ['createdAt', 'containerNumber', 'status', 'updatedAt'];
        const safeSortBy = allowedSortColumns.includes(sortBy) ? `c.${sortBy}` : 'c.createdAt';
        const safeSortOrder = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const query = `
      SELECT c.*, 
             s.id as shipment_id, s.shipmentNumber as shipment_shipmentNumber, s.status as shipment_status, 
             s.originPort as shipment_originPort, s.destinationPort as shipment_destinationPort,
             comp.id as company_id, comp.name as company_name
      FROM Container c
      LEFT JOIN Shipment s ON c.shipmentId = s.id
      LEFT JOIN Company comp ON s.companyId = comp.id
      WHERE ${whereClause}
      ORDER BY ${safeSortBy} ${safeSortOrder}
      LIMIT ? OFFSET ?
    `;
        const countQuery = `SELECT COUNT(*) as total FROM Container c WHERE ${whereClause}`;
        const [rows, countRows] = await Promise.all([
            db.query(query, params),
            db.query(countQuery, countParams)
        ]);
        const formattedContainers = rows.map(c => ({
            ...c,
            isActive: c.isActive === 1,
            shipment: c.shipment_id ? {
                id: c.shipment_id,
                shipmentNumber: c.shipment_shipmentNumber,
                status: c.shipment_status,
                originPort: c.shipment_originPort,
                destinationPort: c.shipment_destinationPort,
                company: c.company_id ? { id: c.company_id, name: c.company_name } : null
            } : null,
            _count: { expenses: 0 }
        }));
        return res.json({
            data: formattedContainers,
            pagination: {
                total: countRows[0].total,
                page,
                limit,
                totalPages: Math.ceil(countRows[0].total / limit)
            }
        });
    }
    catch (error) {
        console.error('Containers GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch containers' });
    }
});
// POST /api/containers - Create a new container
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const id = createId();
        await db.execute(`
      INSERT INTO Container (
        id, containerNumber, containerType, containerSize, sealNumber, stuffingType,
        weightCapacity, currentWeight, status, currentLocation, latitude, longitude,
        shipmentId, isActive
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            id, body.containerNumber, body.containerType || 'standard', body.containerSize || '20ft',
            body.sealNumber || null, body.stuffingType || null, body.weightCapacity || 0,
            body.currentWeight || 0, body.status || 'at_pol', body.currentLocation || null,
            body.latitude || null, body.longitude || null, body.shipmentId,
            body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1
        ]);
        const newContainer = await db.query('SELECT * FROM Container WHERE id = ?', [id]);
        return res.status(201).json({ data: newContainer[0] });
    }
    catch (error) {
        console.error('Containers POST error:', error);
        return res.status(500).json({ error: 'Failed to create container' });
    }
});
export default router;
