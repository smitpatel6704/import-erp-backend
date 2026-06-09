import { db } from '../db.ts';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createId } from '@paralleldrive/cuid2';

const router = Router();

// GET /api/invoices/[id]
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const invoice = await db.query<any[]>(`
      SELECT i.*, 
             c.id as companyId, c.name as companyName,
             s.id as shipmentId, s.shipmentNumber, s.status as shipmentStatus
      FROM Invoice i
      LEFT JOIN Company c ON i.companyId = c.id
      LEFT JOIN Shipment s ON i.shipmentId = s.id
      WHERE i.id = ?
    `, [id]);

    if (!invoice || invoice.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const items = await db.query<any[]>(`
      SELECT * FROM InvoiceItem WHERE invoiceId = ?
    `, [id]);

    const row = invoice[0];
    const formattedInvoice = {
      ...row,
      isActive: Boolean(row.isActive),
      company: row.companyId ? { id: row.companyId, name: row.companyName } : null,
      shipment: row.shipmentId ? {
        id: row.shipmentId,
        shipmentNumber: row.shipmentNumber,
        status: row.shipmentStatus
      } : null,
      items: items
    };

    return res.json({ data: formattedInvoice });
  } catch (error) {
    console.error('Invoice GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// PUT /api/invoices/[id]
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const body = req.body;
    const updates: string[] = [];
    const values: any[] = [];

    const settableFields = [
      'invoiceType', 'status', 'subtotal', 'taxAmount', 'totalAmount',
      'currency', 'paidAmount', 'companyId', 'shipmentId', 'notes', 'terms', 'isActive'
    ];

    for (const field of settableFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    const dateFields = ['issueDate', 'dueDate'];
    for (const field of dateFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field] ? new Date(body[field]) : null);
      }
    }

    updates.push(`updatedAt = ?`);
    values.push(new Date());

    if (updates.length > 0) {
      const sql = `UPDATE Invoice SET ${updates.join(', ')} WHERE id = ?`;
      values.push(id);
      await db.execute(sql, values);
    }

    const updatedInvoice = await db.query<any[]>(`SELECT * FROM Invoice WHERE id = ?`, [id]);
    return res.json({ data: updatedInvoice[0] });
  } catch (error) {
    console.error('Invoice PUT error:', error);
    return res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// DELETE /api/invoices/[id]
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await db.execute(`UPDATE Invoice SET isActive = 0 WHERE id = ?`, [id]);
    const updatedInvoice = await db.query<any[]>(`SELECT * FROM Invoice WHERE id = ?`, [id]);
    return res.json({ data: updatedInvoice[0] });
  } catch (error) {
    console.error('Invoice DELETE error:', error);
    return res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// GET /api/invoices - List invoices with filtering, sorting, pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt((req.query.page as string) || '1');
    const limit = parseInt((req.query.limit as string) || '20');
    const search = (req.query.search as string) || '';
    const status = (req.query.status as string) || '';
    const invoiceType = (req.query.invoiceType as string) || '';
    const companyId = (req.query.companyId as string) || '';
    const shipmentId = (req.query.shipmentId as string) || '';
    const isActive = req.query.isActive as string | undefined;
    const sortBy = (req.query.sortBy as string) || 'createdAt';
    const sortOrder = (req.query.sortOrder as string) || 'desc';

    const skip = (page - 1) * limit;

    let whereClause = '1=1';
    const params: any[] = [];

    if (search) {
      whereClause += ` AND (i.invoiceNumber LIKE ? OR i.notes LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
    if (status) {
      whereClause += ` AND i.status = ?`;
      params.push(status);
    }
    if (invoiceType) {
      whereClause += ` AND i.invoiceType = ?`;
      params.push(invoiceType);
    }
    if (companyId) {
      whereClause += ` AND i.companyId = ?`;
      params.push(companyId);
    }
    if (shipmentId) {
      whereClause += ` AND i.shipmentId = ?`;
      params.push(shipmentId);
    }
    if (isActive !== undefined && isActive !== '') {
      whereClause += ` AND i.isActive = ?`;
      params.push(isActive === 'true' ? 1 : 0);
    }

    const allowedSortColumns = ['invoiceNumber', 'invoiceType', 'status', 'issueDate', 'dueDate', 'totalAmount', 'createdAt'];
    const safeSortBy = allowedSortColumns.includes(sortBy) ? `i.${sortBy}` : 'i.createdAt';
    const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT i.*, 
             c.id as rel_companyId, c.name as companyName,
             s.id as rel_shipmentId, s.shipmentNumber,
             (SELECT COUNT(*) FROM InvoiceItem ii WHERE ii.invoiceId = i.id) as itemsCount
      FROM Invoice i
      LEFT JOIN Company c ON i.companyId = c.id
      LEFT JOIN Shipment s ON i.shipmentId = s.id
      WHERE ${whereClause}
      ORDER BY ${safeSortBy} ${safeSortOrder}
      LIMIT ? OFFSET ?
    `;

    const countSql = `SELECT COUNT(*) as total FROM Invoice i WHERE ${whereClause}`;
    const sqlParams = [...params, limit, skip];

    const [invoices, countResult] = await Promise.all([
      db.query<any[]>(sql, sqlParams),
      db.query<any[]>(countSql, params)
    ]);

    const formattedInvoices = invoices.map(row => {
      return {
        ...row,
        isActive: Boolean(row.isActive),
        company: row.rel_companyId ? { id: row.rel_companyId, name: row.companyName } : null,
        shipment: row.rel_shipmentId ? { id: row.rel_shipmentId, shipmentNumber: row.shipmentNumber } : null,
        _count: { items: Number(row.itemsCount) }
      };
    });

    const total = Number(countResult[0]?.total || 0);

    return res.json({
      data: formattedInvoices,
      pagination: { total, page, limit }
    });
  } catch (error) {
    console.error('Invoices GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// POST /api/invoices - Create a new invoice
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const id = createId();

    const lastInvoice = await db.query<any[]>(`
      SELECT invoiceNumber FROM Invoice 
      ORDER BY createdAt DESC LIMIT 1
    `);
    
    const nextNum = lastInvoice && lastInvoice.length > 0
      ? parseInt(lastInvoice[0].invoiceNumber.split('-').pop() || '0') + 1
      : 1;
    const invoiceNumber = `INV-2025-${String(nextNum).padStart(4, '0')}`;

    await db.execute(`
      INSERT INTO Invoice (
        id, invoiceNumber, invoiceType, status, issueDate, dueDate, 
        subtotal, taxAmount, totalAmount, currency, paidAmount, 
        companyId, shipmentId, notes, terms, isActive, 
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      invoiceNumber,
      body.invoiceType || 'commercial',
      body.status || 'draft',
      body.issueDate ? new Date(body.issueDate) : new Date(),
      body.dueDate ? new Date(body.dueDate) : null,
      body.subtotal || 0,
      body.taxAmount || 0,
      body.totalAmount || 0,
      body.currency || 'USD',
      body.paidAmount || 0,
      body.companyId || null,
      body.shipmentId || null,
      body.notes || null,
      body.terms || null,
      body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1,
      new Date(),
      new Date()
    ]);

    if (body.items && Array.isArray(body.items) && body.items.length > 0) {
      for (const item of body.items) {
        const itemId = createId();
        await db.execute(`
          INSERT INTO InvoiceItem (
            id, invoiceId, description, quantity, unitPrice, 
            discount, taxRate, total
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          itemId,
          id,
          item.description,
          item.quantity || 1,
          item.unitPrice || 0,
          item.discount || 0,
          item.taxRate || 0,
          item.total || 0
        ]);
      }
    }

    const invoice = await db.query<any[]>(`
      SELECT i.*, 
             c.id as rel_companyId, c.name as companyName,
             s.id as rel_shipmentId, s.shipmentNumber
      FROM Invoice i
      LEFT JOIN Company c ON i.companyId = c.id
      LEFT JOIN Shipment s ON i.shipmentId = s.id
      WHERE i.id = ?
    `, [id]);

    const items = await db.query<any[]>(`SELECT * FROM InvoiceItem WHERE invoiceId = ?`, [id]);

    const row = invoice[0];
    const formattedInvoice = {
      ...row,
      isActive: Boolean(row.isActive),
      company: row.rel_companyId ? { id: row.rel_companyId, name: row.companyName } : null,
      shipment: row.rel_shipmentId ? { id: row.rel_shipmentId, shipmentNumber: row.shipmentNumber } : null,
      items: items
    };

    return res.status(201).json({ data: formattedInvoice });
  } catch (error) {
    console.error('Invoices POST error:', error);
    return res.status(500).json({ error: 'Failed to create invoice' });
  }
});

export default router;
