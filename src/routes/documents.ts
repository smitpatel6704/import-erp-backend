import { db } from '../db.ts';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createId } from '@paralleldrive/cuid2';

const router = Router();

// GET /api/documents/[id]
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const document = await db.query<any[]>(`
      SELECT d.*, 
             s.id as shipmentId, s.shipmentNumber, s.status as shipmentStatus,
             c.id as companyId, c.name as companyName
      FROM Document d
      LEFT JOIN Shipment s ON d.shipmentId = s.id
      LEFT JOIN Company c ON s.companyId = c.id
      WHERE d.id = ?
    `, [id]);

    if (!document || document.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const row = document[0];
    const formattedDocument = {
      ...row,
      shipment: row.shipmentId ? {
        id: row.shipmentId,
        shipmentNumber: row.shipmentNumber,
        status: row.shipmentStatus,
        company: row.companyId ? { id: row.companyId, name: row.companyName } : null
      } : null
    };

    return res.json({ data: formattedDocument });
  } catch (error) {
    console.error('Document GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// PUT /api/documents/[id]
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const body = req.body;

    const updates: string[] = [];
    const values: any[] = [];

    const settableFields = [
      'name', 'documentType', 'fileUrl', 'fileType', 'fileSize',
      'shipmentId', 'uploadedBy', 'tags', 'isVerified', 'isActive'
    ];

    for (const field of settableFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    if (body.expiryDate !== undefined) {
      updates.push(`expiryDate = ?`);
      values.push(body.expiryDate ? new Date(body.expiryDate) : null);
    }

    updates.push(`updatedAt = ?`);
    values.push(new Date());

    if (updates.length > 0) {
      const sql = `UPDATE Document SET ${updates.join(', ')} WHERE id = ?`;
      values.push(id);
      await db.execute(sql, values);
    }

    const updatedDocument = await db.query<any[]>(`SELECT * FROM Document WHERE id = ?`, [id]);
    return res.json({ data: updatedDocument[0] });
  } catch (error) {
    console.error('Document PUT error:', error);
    return res.status(500).json({ error: 'Failed to update document' });
  }
});

// DELETE /api/documents/[id]
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await db.execute(`UPDATE Document SET isActive = 0 WHERE id = ?`, [id]);
    const updatedDocument = await db.query<any[]>(`SELECT * FROM Document WHERE id = ?`, [id]);
    return res.json({ data: updatedDocument[0] });
  } catch (error) {
    console.error('Document DELETE error:', error);
    return res.status(500).json({ error: 'Failed to delete document' });
  }
});

// GET /api/documents - List documents with filtering, sorting, pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt((req.query.page as string) || '1');
    const limit = parseInt((req.query.limit as string) || '20');
    const search = (req.query.search as string) || '';
    const documentType = (req.query.documentType as string) || '';
    const shipmentId = (req.query.shipmentId as string) || '';
    const isVerified = req.query.isVerified as string | undefined;
    const isActive = req.query.isActive as string | undefined;
    const sortBy = (req.query.sortBy as string) || 'createdAt';
    const sortOrder = (req.query.sortOrder as string) || 'desc';

    const skip = (page - 1) * limit;

    let whereClause = '1=1';
    const params: any[] = [];

    if (search) {
      whereClause += ` AND (d.name LIKE ? OR d.tags LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
    if (documentType) {
      whereClause += ` AND d.documentType = ?`;
      params.push(documentType);
    }
    if (shipmentId) {
      whereClause += ` AND d.shipmentId = ?`;
      params.push(shipmentId);
    }
    if (isVerified !== undefined && isVerified !== '') {
      whereClause += ` AND d.isVerified = ?`;
      params.push(isVerified === 'true' ? 1 : 0);
    }
    if (isActive !== undefined && isActive !== '') {
      whereClause += ` AND d.isActive = ?`;
      params.push(isActive === 'true' ? 1 : 0);
    }

    const allowedSortColumns = ['name', 'documentType', 'fileSize', 'expiryDate', 'createdAt', 'updatedAt'];
    const safeSortBy = allowedSortColumns.includes(sortBy) ? `d.${sortBy}` : 'd.createdAt';
    const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT d.*, 
             s.id as rel_shipmentId, s.shipmentNumber, s.status as shipmentStatus,
             c.id as companyId, c.name as companyName
      FROM Document d
      LEFT JOIN Shipment s ON d.shipmentId = s.id
      LEFT JOIN Company c ON s.companyId = c.id
      WHERE ${whereClause}
      ORDER BY ${safeSortBy} ${safeSortOrder}
      LIMIT ? OFFSET ?
    `;

    const countSql = `SELECT COUNT(*) as total FROM Document d WHERE ${whereClause}`;

    // Fix: Limit and Offset as numbers, pool.query handles number interpolation
    const sqlParams = [...params, limit, skip];
    
    const [documents, countResult] = await Promise.all([
      db.query<any[]>(sql, sqlParams),
      db.query<any[]>(countSql, params)
    ]);

    const formattedDocuments = documents.map(row => {
      return {
        ...row,
        isActive: Boolean(row.isActive),
        isVerified: Boolean(row.isVerified),
        shipment: row.rel_shipmentId ? {
          id: row.rel_shipmentId,
          shipmentNumber: row.shipmentNumber,
          status: row.shipmentStatus,
          company: row.companyId ? { id: row.companyId, name: row.companyName } : null
        } : null
      };
    });

    const total = Number(countResult[0]?.total || 0);

    return res.json({
      data: formattedDocuments,
      pagination: { total, page, limit }
    });
  } catch (error) {
    console.error('Documents GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// POST /api/documents - Create a new document
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const id = createId();

    await db.execute(`
      INSERT INTO Document (
        id, name, documentType, fileUrl, fileType, fileSize, 
        shipmentId, expiryDate, uploadedBy, tags, isVerified, isActive, 
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      body.name,
      body.documentType,
      body.fileUrl,
      body.fileType || null,
      body.fileSize || null,
      body.shipmentId || null,
      body.expiryDate ? new Date(body.expiryDate) : null,
      body.uploadedBy || null,
      body.tags || null,
      body.isVerified ? 1 : 0,
      body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1,
      new Date(),
      new Date()
    ]);

    const document = await db.query<any[]>(`
      SELECT d.*, 
             s.id as rel_shipmentId, s.shipmentNumber
      FROM Document d
      LEFT JOIN Shipment s ON d.shipmentId = s.id
      WHERE d.id = ?
    `, [id]);

    const row = document[0];
    const formattedDocument = {
      ...row,
      isActive: Boolean(row.isActive),
      isVerified: Boolean(row.isVerified),
      shipment: row.rel_shipmentId ? { id: row.rel_shipmentId, shipmentNumber: row.shipmentNumber } : null
    };

    return res.status(201).json({ data: formattedDocument });
  } catch (error) {
    console.error('Documents POST error:', error);
    return res.status(500).json({ error: 'Failed to create document' });
  }
});

export default router;
