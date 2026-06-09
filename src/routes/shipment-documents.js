import { Router } from 'express';
import { db } from '../db.js';
import { createId } from '@paralleldrive/cuid2';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
const router = Router();
// Configure Multer for local storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});
// ============================================
// CHECKLIST DEFINITIONS (Settings)
// ============================================
router.get('/checklist-types', async (req, res) => {
    try {
        const types = await db.query('SELECT * FROM DocumentChecklist ORDER BY createdAt DESC');
        return res.json({ data: types });
    }
    catch (err) {
        console.error('Checklist types GET error:', err);
        return res.status(500).json({ error: 'Failed to fetch checklist types' });
    }
});
router.post('/checklist-types', async (req, res) => {
    try {
        const { name, isRequired, shipmentStage, expiryRequired, allowedFileTypes, isActive } = req.body;
        const id = createId();
        await db.execute(`
      INSERT INTO DocumentChecklist (id, name, isRequired, shipmentStage, expiryRequired, allowedFileTypes, isActive, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [id, name, isRequired ? 1 : 0, shipmentStage, expiryRequired ? 1 : 0, allowedFileTypes, isActive !== false ? 1 : 0]);
        const [result] = await db.query('SELECT * FROM DocumentChecklist WHERE id = ?', [id]);
        return res.status(201).json({ data: result });
    }
    catch (err) {
        console.error('Checklist types POST error:', err);
        return res.status(500).json({ error: 'Failed to create checklist type' });
    }
});
router.put('/checklist-types/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, isRequired, shipmentStage, expiryRequired, allowedFileTypes, isActive } = req.body;
        await db.execute(`
      UPDATE DocumentChecklist 
      SET name = ?, isRequired = ?, shipmentStage = ?, expiryRequired = ?, allowedFileTypes = ?, isActive = ?, updatedAt = NOW()
      WHERE id = ?
    `, [name, isRequired ? 1 : 0, shipmentStage, expiryRequired ? 1 : 0, allowedFileTypes, isActive ? 1 : 0, id]);
        const [result] = await db.query('SELECT * FROM DocumentChecklist WHERE id = ?', [id]);
        return res.json({ data: result });
    }
    catch (err) {
        console.error('Checklist types PUT error:', err);
        return res.status(500).json({ error: 'Failed to update checklist type' });
    }
});
router.delete('/checklist-types/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.execute('DELETE FROM DocumentChecklist WHERE id = ?', [id]);
        return res.json({ success: true });
    }
    catch (err) {
        console.error('Checklist types DELETE error:', err);
        return res.status(500).json({ error: 'Failed to delete checklist type' });
    }
});
// ============================================
// SHIPMENT-WISE CHECKLIST
// ============================================
router.get('/shipment/:id/checklist', async (req, res) => {
    try {
        const { id: shipmentId } = req.params;
        // Get all active checklist definitions
        const definitions = await db.query('SELECT * FROM DocumentChecklist WHERE isActive = 1');
        // Get already uploaded/linked documents for this shipment
        const documents = await db.query(`
      SELECT sd.*, dc.name as checklistName, dc.isRequired
      FROM ShipmentDocument sd
      JOIN DocumentChecklist dc ON sd.checklistId = dc.id
      WHERE sd.shipmentId = ?
    `, [shipmentId]);
        // Merge: For each definition, find if a document exists
        const checklist = definitions.map(def => {
            const doc = documents.find(d => d.checklistId === def.id);
            return {
                checklistId: def.id,
                name: def.name,
                isRequired: Boolean(def.isRequired),
                shipmentStage: def.shipmentStage,
                expiryRequired: Boolean(def.expiryRequired),
                allowedFileTypes: def.allowedFileTypes,
                document: doc || null,
                status: doc ? doc.status : 'pending'
            };
        });
        return res.json({ data: checklist });
    }
    catch (err) {
        console.error('Shipment checklist GET error:', err);
        return res.status(500).json({ error: 'Failed to fetch shipment checklist' });
    }
});
router.post('/shipment/:id/upload', upload.single('file'), async (req, res) => {
    try {
        const { id: shipmentId } = req.params;
        const { checklistId, expiryDate, remarks } = req.body;
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        // Create a local URL for the file
        // Note: In production, you'd use a full URL like https://api.yourdomain.com/uploads/...
        const fileUrl = `/uploads/${req.file.filename}`;
        const fileType = req.file.mimetype;
        const fileSize = req.file.size;
        // Check if record already exists
        const existing = await db.query('SELECT id FROM ShipmentDocument WHERE shipmentId = ? AND checklistId = ?', [shipmentId, checklistId]);
        if (existing && existing.length > 0) {
            // Update existing
            const docId = existing[0].id;
            await db.execute(`
        UPDATE ShipmentDocument 
        SET fileUrl = ?, fileType = ?, fileSize = ?, status = 'uploaded', uploadedAt = NOW(), expiryDate = ?, remarks = ?, updatedAt = NOW()
        WHERE id = ?
      `, [fileUrl, fileType, fileSize, expiryDate ? new Date(expiryDate) : null, remarks, docId]);
        }
        else {
            // Create new
            const id = createId();
            await db.execute(`
        INSERT INTO ShipmentDocument (id, shipmentId, checklistId, fileUrl, fileType, fileSize, status, uploadedAt, expiryDate, remarks, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 'uploaded', NOW(), ?, ?, NOW(), NOW())
      `, [id, shipmentId, checklistId, fileUrl, fileType, fileSize, expiryDate ? new Date(expiryDate) : null, remarks]);
        }
        return res.json({ success: true, fileUrl });
    }
    catch (err) {
        console.error('Document upload POST error:', err);
        return res.status(500).json({ error: 'Failed to upload document' });
    }
});
router.patch('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, rejectedReason, remarks } = req.body; // status: verified, rejected
        const updates = ['status = ?', 'updatedAt = NOW()'];
        const params = [status];
        if (status === 'verified') {
            updates.push('verifiedAt = NOW()');
        }
        if (rejectedReason) {
            updates.push('rejectedReason = ?');
            params.push(rejectedReason);
        }
        if (remarks) {
            updates.push('remarks = ?');
            params.push(remarks);
        }
        params.push(id);
        await db.execute(`UPDATE ShipmentDocument SET ${updates.join(', ')} WHERE id = ?`, params);
        return res.json({ success: true });
    }
    catch (err) {
        console.error('Document status PATCH error:', err);
        return res.status(500).json({ error: 'Failed to update document status' });
    }
});
// ============================================
// GLOBAL STATS
// ============================================
router.get('/stats', async (req, res) => {
    try {
        const [stats] = await db.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) as uploaded,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) as verified,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
      FROM ShipmentDocument
    `);
        // Fallback if no records yet
        const result = {
            total: stats?.total || 0,
            uploaded: stats?.uploaded || 0,
            pending: stats?.pending || 0,
            verified: stats?.verified || 0,
            rejected: stats?.rejected || 0,
            expired: stats?.expired || 0
        };
        return res.json({ data: result });
    }
    catch (err) {
        console.error('Document stats GET error:', err);
        return res.status(500).json({ error: 'Failed to fetch document stats' });
    }
});
export default router;
