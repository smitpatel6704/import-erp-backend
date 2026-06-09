import { db } from '../db';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createId } from '@paralleldrive/cuid2';

const router = Router();

// GET /api/expenses/[id]
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const expense = await db.query<any[]>(`
      SELECT e.*, 
             s.id as rel_shipmentId, s.shipmentNumber,
             c.id as companyId, c.name as companyName,
             cont.id as rel_containerId, cont.containerNumber
      FROM Expense e
      LEFT JOIN Shipment s ON e.shipmentId = s.id
      LEFT JOIN Company c ON s.companyId = c.id
      LEFT JOIN Container cont ON e.containerId = cont.id
      WHERE e.id = ?
    `, [id]);

    if (!expense || expense.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    const row = expense[0];
    const formattedExpense = {
      ...row,
      isActive: Boolean(row.isActive),
      shipment: row.rel_shipmentId ? {
        id: row.rel_shipmentId,
        shipmentNumber: row.shipmentNumber,
        company: row.companyId ? { id: row.companyId, name: row.companyName } : null
      } : null,
      container: row.rel_containerId ? {
        id: row.rel_containerId,
        containerNumber: row.containerNumber
      } : null
    };

    return res.json({ data: formattedExpense });
  } catch (error) {
    console.error('Expense GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch expense' });
  }
});

// PUT /api/expenses/[id]
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const body = req.body;
    const updates: string[] = [];
    const values: any[] = [];

    const settableFields = [
      'category', 'description', 'amount', 'currency', 'exchangeRate',
      'vendorName', 'paymentStatus', 'shipmentId', 'containerId', 'invoiceNumber', 'isActive'
    ];

    for (const field of settableFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    const amountBase = body.amount !== undefined && body.exchangeRate !== undefined
      ? body.amount * body.exchangeRate
      : undefined;

    if (body.amountBase !== undefined) {
      updates.push(`amountBase = ?`);
      values.push(body.amountBase);
    } else if (amountBase !== undefined) {
      updates.push(`amountBase = ?`);
      values.push(amountBase);
    }

    const dateFields = ['paymentDate', 'dueDate'];
    for (const field of dateFields) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field] ? new Date(body[field]) : null);
      }
    }

    updates.push(`updatedAt = ?`);
    values.push(new Date());

    if (updates.length > 0) {
      const sql = `UPDATE Expense SET ${updates.join(', ')} WHERE id = ?`;
      values.push(id);
      await db.execute(sql, values);
    }

    const updatedExpense = await db.query<any[]>(`SELECT * FROM Expense WHERE id = ?`, [id]);
    return res.json({ data: updatedExpense[0] });
  } catch (error) {
    console.error('Expense PUT error:', error);
    return res.status(500).json({ error: 'Failed to update expense' });
  }
});

// DELETE /api/expenses/[id]
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await db.execute(`UPDATE Expense SET isActive = 0 WHERE id = ?`, [id]);
    const updatedExpense = await db.query<any[]>(`SELECT * FROM Expense WHERE id = ?`, [id]);
    return res.json({ data: updatedExpense[0] });
  } catch (error) {
    console.error('Expense DELETE error:', error);
    return res.status(500).json({ error: 'Failed to delete expense' });
  }
});

// GET /api/expenses - List expenses with filtering, sorting, pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt((req.query.page as string) || '1');
    const limit = parseInt((req.query.limit as string) || '20');
    const search = (req.query.search as string) || '';
    const category = (req.query.category as string) || '';
    const paymentStatus = (req.query.paymentStatus as string) || '';
    const shipmentId = (req.query.shipmentId as string) || '';
    const containerId = (req.query.containerId as string) || '';
    const isActive = req.query.isActive as string | undefined;
    const sortBy = (req.query.sortBy as string) || 'createdAt';
    const sortOrder = (req.query.sortOrder as string) || 'desc';

    const skip = (page - 1) * limit;

    let whereClause = '1=1';
    const params: any[] = [];

    if (search) {
      whereClause += ` AND (e.description LIKE ? OR e.vendorName LIKE ? OR e.invoiceNumber LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category) {
      if (category.includes(',')) {
        const categories = category.split(',');
        const placeholders = categories.map(() => '?').join(',');
        whereClause += ` AND e.category IN (${placeholders})`;
        params.push(...categories);
      } else {
        whereClause += ` AND e.category = ?`;
        params.push(category);
      }
    }
    if (paymentStatus) {
      whereClause += ` AND e.paymentStatus = ?`;
      params.push(paymentStatus);
    }
    if (shipmentId) {
      whereClause += ` AND e.shipmentId = ?`;
      params.push(shipmentId);
    }
    if (containerId) {
      whereClause += ` AND e.containerId = ?`;
      params.push(containerId);
    }
    if (isActive !== undefined && isActive !== '') {
      whereClause += ` AND e.isActive = ?`;
      params.push(isActive === 'true' ? 1 : 0);
    }

    const allowedSortColumns = ['category', 'amount', 'vendorName', 'paymentStatus', 'paymentDate', 'dueDate', 'createdAt'];
    const safeSortBy = allowedSortColumns.includes(sortBy) ? `e.${sortBy}` : 'e.createdAt';
    const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT e.*, 
             s.id as rel_shipmentId, s.shipmentNumber,
             c.id as companyId, c.name as companyName,
             cont.id as rel_containerId, cont.containerNumber
      FROM Expense e
      LEFT JOIN Shipment s ON e.shipmentId = s.id
      LEFT JOIN Company c ON s.companyId = c.id
      LEFT JOIN Container cont ON e.containerId = cont.id
      WHERE ${whereClause}
      ORDER BY ${safeSortBy} ${safeSortOrder}
      LIMIT ? OFFSET ?
    `;

    const countSql = `SELECT COUNT(*) as total FROM Expense e WHERE ${whereClause}`;
    const sqlParams = [...params, limit, skip];

    const [expenses, countResult] = await Promise.all([
      db.query<any[]>(sql, sqlParams),
      db.query<any[]>(countSql, params)
    ]);

    const formattedExpenses = expenses.map(row => {
      return {
        ...row,
        isActive: Boolean(row.isActive),
        shipment: row.rel_shipmentId ? {
          id: row.rel_shipmentId,
          shipmentNumber: row.shipmentNumber,
          company: row.companyId ? { id: row.companyId, name: row.companyName } : null
        } : null,
        container: row.rel_containerId ? {
          id: row.rel_containerId,
          containerNumber: row.containerNumber
        } : null
      };
    });

    const total = Number(countResult[0]?.total || 0);

    return res.json({
      data: formattedExpenses,
      pagination: { total, page, limit }
    });
  } catch (error) {
    console.error('Expenses GET error:', error);
    return res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// POST /api/expenses - Create a new expense
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const id = createId();

    const amountBase = body.amountBase !== undefined 
      ? body.amountBase 
      : (body.amount || 0) * (body.exchangeRate || 1);

    await db.execute(`
      INSERT INTO Expense (
        id, category, description, amount, currency, exchangeRate, 
        amountBase, vendorName, paymentStatus, paymentDate, dueDate, 
        shipmentId, containerId, invoiceNumber, isActive, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      body.category,
      body.description || null,
      body.amount,
      body.currency || 'USD',
      body.exchangeRate || 1,
      amountBase,
      body.vendorName || null,
      body.paymentStatus || 'pending',
      body.paymentDate ? new Date(body.paymentDate) : null,
      body.dueDate ? new Date(body.dueDate) : null,
      body.shipmentId || null,
      body.containerId || null,
      body.invoiceNumber || null,
      body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1,
      new Date(),
      new Date()
    ]);

    const expense = await db.query<any[]>(`
      SELECT e.*, 
             s.id as rel_shipmentId, s.shipmentNumber,
             cont.id as rel_containerId, cont.containerNumber
      FROM Expense e
      LEFT JOIN Shipment s ON e.shipmentId = s.id
      LEFT JOIN Container cont ON e.containerId = cont.id
      WHERE e.id = ?
    `, [id]);

    const row = expense[0];
    const formattedExpense = {
      ...row,
      isActive: Boolean(row.isActive),
      shipment: row.rel_shipmentId ? { id: row.rel_shipmentId, shipmentNumber: row.shipmentNumber } : null,
      container: row.rel_containerId ? { id: row.rel_containerId, containerNumber: row.containerNumber } : null
    };

    return res.status(201).json({ data: formattedExpense });
  } catch (error) {
    console.error('Expenses POST error:', error);
    return res.status(500).json({ error: 'Failed to create expense' });
  }
});

export default router;
