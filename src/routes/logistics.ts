import { db } from '../db';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createId } from '@paralleldrive/cuid2';

const router = Router();

// GET /api/logistics/[id]
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const logistics = await db.query<any[]>(`
      SELECT l.*, 
             s.id as rel_shipmentId, s.shipmentNumber, s.status as shipmentStatus, s.destinationPort,
             c.id as companyId, c.name as companyName
      FROM Logistics l
      LEFT JOIN Shipment s ON l.shipmentId = s.id
      LEFT JOIN Company c ON s.companyId = c.id
      WHERE l.id = ?
    `, [id]);

    if (!logistics || logistics.length === 0) {
      return res.status(404).json({ error: 'Logistics record not found' });
    }

    const row = logistics[0];
    const formattedLogistics = {
      ...row,
      isActive: Boolean(row.isActive),
      shipment: row.rel_shipmentId ? {
        id: row.rel_shipmentId,
        shipmentNumber: row.shipmentNumber,
        status: row.shipmentStatus,
        destinationPort: row.destinationPort,
        company: row.companyId ? { id: row.companyId, name: row.companyName } : null
      } : null
    };

    return res.json({ data: formattedLogistics });
  } catch (error) {
    console.error('Logistics GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch logistics record' });
  }
});

// PUT /api/logistics/[id]
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const body = req.body;
    const updates: string[] = [];
    const values: any[] = [];

    const settableFields = [
      'type', 'driverName', 'driverPhone', 'vehicleNumber', 'transportVendor',
      'routeFrom', 'routeTo', 'podStatus', 'storageDays', 'status', 'notes', 'isActive'
    ];

    for (const field of settableFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    const dateFields = ['dispatchDate', 'deliveryDate', 'warehouseEntry', 'offloadDate'];
    for (const field of dateFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field] ? new Date(body[field]) : null);
      }
    }

    updates.push(`updatedAt = ?`);
    values.push(new Date());

    if (updates.length > 0) {
      const sql = `UPDATE Logistics SET ${updates.join(', ')} WHERE id = ?`;
      values.push(id);
      await db.execute(sql, values);
    }

    const updatedLogistics = await db.query<any[]>(`SELECT * FROM Logistics WHERE id = ?`, [id]);
    return res.json({ data: updatedLogistics[0] });
  } catch (error) {
    console.error('Logistics PUT error:', error);
    return res.status(500).json({ error: 'Failed to update logistics record' });
  }
});

// DELETE /api/logistics/[id]
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await db.execute(`UPDATE Logistics SET isActive = 0 WHERE id = ?`, [id]);
    const updatedLogistics = await db.query<any[]>(`SELECT * FROM Logistics WHERE id = ?`, [id]);
    return res.json({ data: updatedLogistics[0] });
  } catch (error) {
    console.error('Logistics DELETE error:', error);
    return res.status(500).json({ error: 'Failed to delete logistics record' });
  }
});

// GET /api/logistics - List logistics records with filtering, sorting, pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt((req.query.page as string) || '1');
    const limit = parseInt((req.query.limit as string) || '20');
    const type = (req.query.type as string) || '';
    const status = (req.query.status as string) || '';
    const shipmentId = (req.query.shipmentId as string) || '';
    const isActive = req.query.isActive as string | undefined;
    const sortBy = (req.query.sortBy as string) || 'createdAt';
    const sortOrder = (req.query.sortOrder as string) || 'desc';

    const skip = (page - 1) * limit;

    let whereClause = '1=1';
    const params: any[] = [];

    if (type) {
      whereClause += ` AND l.type = ?`;
      params.push(type);
    }
    if (status) {
      whereClause += ` AND l.status = ?`;
      params.push(status);
    }
    if (shipmentId) {
      whereClause += ` AND l.shipmentId = ?`;
      params.push(shipmentId);
    }
    if (isActive !== undefined && isActive !== '') {
      whereClause += ` AND l.isActive = ?`;
      params.push(isActive === 'true' ? 1 : 0);
    }

    const allowedSortColumns = ['type', 'driverName', 'vehicleNumber', 'dispatchDate', 'deliveryDate', 'status', 'createdAt'];
    const safeSortBy = allowedSortColumns.includes(sortBy) ? `l.${sortBy}` : 'l.createdAt';
    const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT l.*, 
             s.id as rel_shipmentId, s.shipmentNumber, s.status as shipmentStatus, s.destinationPort,
             c.id as companyId, c.name as companyName
      FROM Logistics l
      LEFT JOIN Shipment s ON l.shipmentId = s.id
      LEFT JOIN Company c ON s.companyId = c.id
      WHERE ${whereClause}
      ORDER BY ${safeSortBy} ${safeSortOrder}
      LIMIT ? OFFSET ?
    `;

    const countSql = `SELECT COUNT(*) as total FROM Logistics l WHERE ${whereClause}`;
    const sqlParams = [...params, limit, skip];

    const [logistics, countResult] = await Promise.all([
      db.query<any[]>(sql, sqlParams),
      db.query<any[]>(countSql, params)
    ]);

    const formattedLogistics = logistics.map(row => {
      return {
        ...row,
        isActive: Boolean(row.isActive),
        shipment: row.rel_shipmentId ? {
          id: row.rel_shipmentId,
          shipmentNumber: row.shipmentNumber,
          status: row.shipmentStatus,
          destinationPort: row.destinationPort,
          company: row.companyId ? { id: row.companyId, name: row.companyName } : null
        } : null
      };
    });

    const total = Number(countResult[0]?.total || 0);

    return res.json({
      data: formattedLogistics,
      pagination: { total, page, limit }
    });
  } catch (error) {
    console.error('Logistics GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch logistics records' });
  }
});

// POST /api/logistics - Create a logistics record
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const id = createId();

    await db.execute(`
      INSERT INTO Logistics (
        id, shipmentId, type, driverName, driverPhone, vehicleNumber, 
        transportVendor, routeFrom, routeTo, dispatchDate, deliveryDate, 
        podStatus, warehouseEntry, offloadDate, storageDays, status, 
        notes, isActive, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      body.shipmentId,
      body.type || 'transport',
      body.driverName || null,
      body.driverPhone || null,
      body.vehicleNumber || null,
      body.transportVendor || null,
      body.routeFrom || null,
      body.routeTo || null,
      body.dispatchDate ? new Date(body.dispatchDate) : null,
      body.deliveryDate ? new Date(body.deliveryDate) : null,
      body.podStatus || 'pending',
      body.warehouseEntry ? new Date(body.warehouseEntry) : null,
      body.offloadDate ? new Date(body.offloadDate) : null,
      body.storageDays || 0,
      body.status || 'scheduled',
      body.notes || null,
      body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1,
      new Date(),
      new Date()
    ]);

    const logistics = await db.query<any[]>(`
      SELECT l.*, 
             s.id as rel_shipmentId, s.shipmentNumber
      FROM Logistics l
      LEFT JOIN Shipment s ON l.shipmentId = s.id
      WHERE l.id = ?
    `, [id]);

    const row = logistics[0];
    const formattedLogistics = {
      ...row,
      isActive: Boolean(row.isActive),
      shipment: row.rel_shipmentId ? { id: row.rel_shipmentId, shipmentNumber: row.shipmentNumber } : null
    };

    return res.status(201).json({ data: formattedLogistics });
  } catch (error) {
    console.error('Logistics POST error:', error);
    return res.status(500).json({ error: 'Failed to create logistics record' });
  }
});

export default router;
