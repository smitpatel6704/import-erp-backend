import { db } from '../db.js';
import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
const router = Router();
// GET /api/products/[id]
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const product = await db.query(`
      SELECT p.*, 
             c.id as companyId, c.name as companyName
      FROM Product p
      LEFT JOIN Company c ON p.companyId = c.id
      WHERE p.id = ?
    `, [id]);
        if (!product || product.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        const shipmentItems = await db.query(`
      SELECT si.*, 
             s.id as shipmentId, s.shipmentNumber, s.status as shipmentStatus
      FROM ShipmentItem si
      JOIN Shipment s ON si.shipmentId = s.id
      WHERE si.productId = ?
      ORDER BY si.id DESC
      LIMIT 20
    `, [id]);
        const formattedShipmentItems = shipmentItems.map(item => ({
            ...item,
            shipment: {
                id: item.shipmentId,
                shipmentNumber: item.shipmentNumber,
                status: item.shipmentStatus
            }
        }));
        const row = product[0];
        const formattedProduct = {
            ...row,
            isActive: Boolean(row.isActive),
            company: row.companyId ? { id: row.companyId, name: row.companyName } : null,
            shipmentItems: formattedShipmentItems
        };
        return res.json({ data: formattedProduct });
    }
    catch (error) {
        console.error('Product GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch product' });
    }
});
// PUT /api/products/[id]
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const body = req.body;
        const updates = [];
        const values = [];
        const settableFields = [
            'name', 'category', 'hsCode', 'sku', 'brandName',
            'unitType', 'countryOfOrigin', 'companyId', 'isActive'
        ];
        for (const field of settableFields) {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(body[field]);
            }
        }
        updates.push(`updatedAt = ?`);
        values.push(new Date());
        if (updates.length > 0) {
            const sql = `UPDATE Product SET ${updates.join(', ')} WHERE id = ?`;
            values.push(id);
            await db.execute(sql, values);
        }
        const updatedProduct = await db.query(`SELECT * FROM Product WHERE id = ?`, [id]);
        return res.json({ data: updatedProduct[0] });
    }
    catch (error) {
        console.error('Product PUT error:', error);
        return res.status(500).json({ error: 'Failed to update product' });
    }
});
// DELETE /api/products/[id]
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute(`UPDATE Product SET isActive = 0 WHERE id = ?`, [id]);
        const updatedProduct = await db.query(`SELECT * FROM Product WHERE id = ?`, [id]);
        return res.json({ data: updatedProduct[0] });
    }
    catch (error) {
        console.error('Product DELETE error:', error);
        return res.status(500).json({ error: 'Failed to delete product' });
    }
});
// GET /api/products - List products with filtering, sorting, pagination
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1');
        const limit = parseInt(req.query.limit || '20');
        const search = req.query.search || '';
        const category = req.query.category || '';
        const countryOfOrigin = req.query.countryOfOrigin || '';
        const companyId = req.query.companyId || '';
        const isActive = req.query.isActive;
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'desc';
        const skip = (page - 1) * limit;
        let whereClause = '1=1';
        const params = [];
        if (search) {
            whereClause += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.hsCode LIKE ? OR p.brandName LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (category) {
            whereClause += ` AND p.category = ?`;
            params.push(category);
        }
        if (countryOfOrigin) {
            whereClause += ` AND p.countryOfOrigin = ?`;
            params.push(countryOfOrigin);
        }
        if (companyId) {
            whereClause += ` AND p.companyId = ?`;
            params.push(companyId);
        }
        if (isActive !== undefined && isActive !== '') {
            whereClause += ` AND p.isActive = ?`;
            params.push(isActive === 'true' ? 1 : 0);
        }
        const allowedSortColumns = ['name', 'category', 'hsCode', 'sku', 'brandName', 'createdAt'];
        const safeSortBy = allowedSortColumns.includes(sortBy) ? `p.${sortBy}` : 'p.createdAt';
        const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        const sql = `
      SELECT p.*, 
             c.id as rel_companyId, c.name as companyName,
             (SELECT COUNT(*) FROM ShipmentItem si WHERE si.productId = p.id) as shipmentItemsCount
      FROM Product p
      LEFT JOIN Company c ON p.companyId = c.id
      WHERE ${whereClause}
      ORDER BY ${safeSortBy} ${safeSortOrder}
      LIMIT ? OFFSET ?
    `;
        const countSql = `SELECT COUNT(*) as total FROM Product p WHERE ${whereClause}`;
        const sqlParams = [...params, limit, skip];
        const [products, countResult] = await Promise.all([
            db.query(sql, sqlParams),
            db.query(countSql, params)
        ]);
        const formattedProducts = products.map(row => {
            return {
                ...row,
                isActive: Boolean(row.isActive),
                company: row.rel_companyId ? { id: row.rel_companyId, name: row.companyName } : null,
                _count: { shipmentItems: Number(row.shipmentItemsCount) }
            };
        });
        const total = Number(countResult[0]?.total || 0);
        return res.json({
            data: formattedProducts,
            pagination: { total, page, limit }
        });
    }
    catch (error) {
        console.error('Products GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch products' });
    }
});
// POST /api/products - Create a new product
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const id = createId();
        await db.execute(`
      INSERT INTO Product (
        id, name, category, hsCode, sku, brandName, 
        unitType, countryOfOrigin, companyId, isActive, 
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            id,
            body.name,
            body.category || null,
            body.hsCode || null,
            body.sku || null,
            body.brandName || null,
            body.unitType || 'PCS',
            body.countryOfOrigin || null,
            body.companyId || null,
            body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1,
            new Date(),
            new Date()
        ]);
        const product = await db.query(`
      SELECT p.*, 
             c.id as rel_companyId, c.name as companyName
      FROM Product p
      LEFT JOIN Company c ON p.companyId = c.id
      WHERE p.id = ?
    `, [id]);
        const row = product[0];
        const formattedProduct = {
            ...row,
            isActive: Boolean(row.isActive),
            company: row.rel_companyId ? { id: row.rel_companyId, name: row.companyName } : null
        };
        return res.status(201).json({ data: formattedProduct });
    }
    catch (error) {
        console.error('Products POST error:', error);
        return res.status(500).json({ error: 'Failed to create product' });
    }
});
export default router;
