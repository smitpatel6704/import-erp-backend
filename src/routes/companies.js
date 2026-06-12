import { db } from '../db.js';
import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
const router = Router();
// GET /api/companies/[id]
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const companies = await db.query('SELECT * FROM Company WHERE id = ?', [id]);
        const company = companies[0];
        if (!company) {
            return res.status(404).json({ error: 'Company not found' });
        }
        // include shipments, invoices, products
        company.shipments = await db.query('SELECT * FROM Shipment WHERE companyId = ? ORDER BY createdAt DESC LIMIT 10', [id]);
        company.invoices = await db.query('SELECT * FROM Invoice WHERE companyId = ? ORDER BY createdAt DESC LIMIT 10', [id]);
        company.products = await db.query('SELECT * FROM Product WHERE companyId = ? ORDER BY createdAt DESC LIMIT 10', [id]);
        const shipmentsCount = await db.query('SELECT COUNT(*) as c FROM Shipment WHERE companyId = ?', [id]);
        const invoicesCount = await db.query('SELECT COUNT(*) as c FROM Invoice WHERE companyId = ?', [id]);
        const productsCount = await db.query('SELECT COUNT(*) as c FROM Product WHERE companyId = ?', [id]);
        const transactionsCount = await db.query('SELECT COUNT(*) as c FROM Transaction WHERE companyId = ?', [id]);
        company._count = {
            shipments: shipmentsCount[0].c,
            invoices: invoicesCount[0].c,
            products: productsCount[0].c,
            transactions: transactionsCount[0].c,
        };
        return res.json({ data: company });
    }
    catch (error) {
        console.error('Company GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch company' });
    }
});
// PUT /api/companies/[id]
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const body = req.body;
        const updates = [];
        const values = [];
        const fields = [
            'name', 'contactPerson', 'mobile', 'email', 'officeAddress',
            'gstNumber', 'iecCode', 'panNumber', 'bankName', 'bankAccount',
            'bankIfsc', 'billingAddress', 'shippingAddress', 'creditLimit', 'companyType',
            'taxNumber', 'bankDetails', 'isActive'
        ];
        for (const field of fields) {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(field === 'isActive' ? (body[field] ? 1 : 0) : body[field]);
            }
        }
        if (body.customFields !== undefined) {
            updates.push('customFields = ?');
            values.push(JSON.stringify(body.customFields || []));
        }
        if (updates.length > 0) {
            updates.push('updatedAt = ?');
            values.push(new Date());
            values.push(id);
            await db.execute(`UPDATE Company SET ${updates.join(', ')} WHERE id = ?`, values);
        }
        const companies = await db.query('SELECT * FROM Company WHERE id = ?', [id]);
        return res.json({ data: companies[0] });
    }
    catch (error) {
        console.error('Company PUT error:', error);
        return res.status(500).json({ error: 'Failed to update company' });
    }
});
// DELETE /api/companies/[id] - Soft delete
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE Company SET isActive = 0, updatedAt = ? WHERE id = ?', [new Date(), id]);
        const companies = await db.query('SELECT * FROM Company WHERE id = ?', [id]);
        return res.json({ data: companies[0] });
    }
    catch (error) {
        console.error('Company DELETE error:', error);
        return res.status(500).json({ error: 'Failed to delete company' });
    }
});
// GET /api/companies
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1');
        const limit = parseInt(req.query.limit || '20');
        const search = req.query.search || '';
        const isActive = req.query.isActive;
        const companyType = req.query.companyType || req.query.type || '';
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'desc';
        const skip = (page - 1) * limit;
        let whereClause = '1=1';
        const params = [];
        if (search) {
            whereClause += ' AND (name LIKE ? OR contactPerson LIKE ? OR email LIKE ? OR gstNumber LIKE ? OR iecCode LIKE ?)';
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam, searchParam, searchParam);
        }
        if (isActive !== undefined && isActive !== '') {
            whereClause += ' AND isActive = ?';
            params.push(isActive === 'true' ? 1 : 0);
        }
        if (companyType) {
            whereClause += ' AND companyType = ?';
            params.push(companyType);
        }
        const countRows = await db.query(`SELECT COUNT(*) as c FROM Company WHERE ${whereClause}`, params);
        const total = countRows[0].c;
        const allowedSort = ['createdAt', 'updatedAt', 'name', 'creditLimit'].includes(sortBy) ? sortBy : 'createdAt';
        const allowedDir = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const companies = await db.query(`SELECT * FROM Company WHERE ${whereClause} ORDER BY ${allowedSort} ${allowedDir} LIMIT ? OFFSET ?`, [...params, limit, skip]);
        for (const c of companies) {
            const shipmentsCount = await db.query('SELECT COUNT(*) as c FROM Shipment WHERE companyId = ?', [c.id]);
            const invoicesCount = await db.query('SELECT COUNT(*) as c FROM Invoice WHERE companyId = ?', [c.id]);
            const productsCount = await db.query('SELECT COUNT(*) as c FROM Product WHERE companyId = ?', [c.id]);
            c._count = {
                shipments: shipmentsCount[0].c,
                invoices: invoicesCount[0].c,
                products: productsCount[0].c
            };
        }
        // In the frontend, the component probably expects the structure we used in the other migrated files:
        return res.json({ data: companies, pagination: { total, page, limit } });
    }
    catch (error) {
        console.error('Companies GET error:', error);
        return res.status(500).json({ error: 'Failed to fetch companies' });
    }
});
// POST /api/companies
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const id = createId();
        await db.execute(`
      INSERT INTO Company (
        id, name, contactPerson, mobile, email, officeAddress, gstNumber, 
        iecCode, panNumber, bankName, bankAccount, bankIfsc, billingAddress, 
        shippingAddress, creditLimit, companyType, taxNumber, bankDetails, customFields,
        isActive, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            id, body.name || null, body.contactPerson || null, body.mobile || null, body.email || null, body.officeAddress || null,
            body.gstNumber || null, body.iecCode || null, body.panNumber || null, body.bankName || null, body.bankAccount || null,
            body.bankIfsc || null, body.billingAddress || null, body.shippingAddress || null, body.creditLimit || 0,
            body.companyType || body.type || 'importer', body.taxNumber || null,
            body.bankDetails || null, JSON.stringify(body.customFields || body.otherDetails || []),
            body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1, new Date(), new Date()
        ]);
        const companies = await db.query('SELECT * FROM Company WHERE id = ?', [id]);
        return res.status(201).json({ data: companies[0] });
    }
    catch (error) {
        console.error('Companies POST error:', error);
        return res.status(500).json({ error: 'Failed to create company' });
    }
});
export default router;
