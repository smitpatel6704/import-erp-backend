import { Router } from 'express';
import { db } from '../db.js';
import { createId } from '@paralleldrive/cuid2';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import os from 'os';
import { PDFDocument } from 'pdf-lib';
import { createNotification, notificationRecipients } from '../services/notifications.js';
import {
    readDocumentFileBuffer,
    storeDocumentBuffer,
    storeUploadedDocumentFile,
} from '../services/document-files.js';
const router = Router();
// Configure Multer for local storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = process.env.VERCEL
            ? path.join(os.tmpdir(), 'uploads')
            : path.resolve(process.cwd(), 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${file.fieldname}-${Date.now()}-${randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`);
    }
});
const allowedUploadTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (allowedUploadTypes.has(file.mimetype))
            return cb(null, true);
        return cb(new Error('Only PDF and image uploads are allowed'));
    },
});
const uploadDocumentFile = (req, res, next) => {
    upload.single('file')(req, res, (error) => {
        if (!error)
            return next();
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? 'File must be 5MB or smaller'
            : error.message || 'Invalid upload';
        return res.status(400).json({ error: message });
    });
};
router.get('/pending', async (req, res) => {
    try {
        const shipmentId = req.query.shipmentId || '';
        const params = [];
        let shipmentFilter = '';
        if (shipmentId) {
            shipmentFilter = 'AND s.id = ?';
            params.push(shipmentId);
        }
        const rows = await db.query(`
          SELECT s.id as shipmentId, s.shipmentNumber, s.eta,
                 dc.id as checklistId, dc.name, dc.shipmentStage, dc.isRequired,
                 sd.id as documentId, COALESCE(sd.status, 'pending') as status,
                 sd.rejectedReason, sd.expiryDate
          FROM Shipment s
          CROSS JOIN DocumentChecklist dc
          LEFT JOIN ShipmentDocument sd ON sd.shipmentId = s.id AND sd.checklistId = dc.id
          WHERE s.isActive = 1 AND dc.isActive = 1
            AND (sd.id IS NULL OR sd.status IN ('pending', 'rejected', 'expired'))
            ${shipmentFilter}
          ORDER BY s.eta ASC NULLS LAST, s.shipmentNumber, dc.name
        `, params);
        return res.json({ data: rows });
    }
    catch (error) {
        return res.status(500).json({ error: String(error) });
    }
});
router.get('/shipment/:id/bundles', async (req, res) => {
    try {
        const rows = await db.query('SELECT * FROM DocumentBundle WHERE shipmentId = ? ORDER BY createdAt DESC', [req.params.id]);
        return res.json({ data: rows });
    }
    catch (error) {
        return res.status(500).json({ error: String(error) });
    }
});
router.post('/shipment/:id/merge', async (req, res) => {
    try {
        const { id: shipmentId } = req.params;
        const documentIds = Array.isArray(req.body.documentIds) ? req.body.documentIds : [];
        if (!documentIds.length)
            return res.status(400).json({ error: 'documentIds in the required merge order are required' });
        const placeholders = documentIds.map(() => '?').join(',');
        const rows = await db.query(`
          SELECT id, fileUrl, fileType FROM ShipmentDocument
          WHERE shipmentId = ? AND id IN (${placeholders})
        `, [shipmentId, ...documentIds]);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const merged = await PDFDocument.create();
        for (const documentId of documentIds) {
            const document = byId.get(documentId);
            if (!document?.fileUrl || !document.fileUrl.toLowerCase().endsWith('.pdf'))
                return res.status(400).json({ error: `Document ${documentId} is missing or is not a PDF` });
            const buffer = await readDocumentFileBuffer(document.fileUrl);
            if (!buffer)
                return res.status(400).json({ error: `Document file ${documentId} is unavailable` });
            const source = await PDFDocument.load(buffer);
            const pages = await merged.copyPages(source, source.getPageIndices());
            pages.forEach((page) => merged.addPage(page));
        }
        const bundleId = createId();
        const filename = `bundle-${shipmentId}-${Date.now()}.pdf`;
        const uploadDir = process.env.VERCEL
            ? path.join(os.tmpdir(), 'uploads')
            : path.resolve(process.cwd(), 'uploads');
        fs.mkdirSync(uploadDir, { recursive: true });
        const mergedBytes = await merged.save();
        const mergedBuffer = Buffer.from(mergedBytes);
        fs.writeFileSync(path.join(uploadDir, filename), mergedBuffer);
        const fileUrl = `/uploads/${filename}`;
        await storeDocumentBuffer({
            fileUrl,
            fileName: filename,
            fileType: 'application/pdf',
            buffer: mergedBuffer,
        });
        await db.execute(`
          INSERT INTO DocumentBundle (id, shipmentId, name, fileUrl, documentIds, createdBy, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            bundleId, shipmentId, req.body.name || 'Merged shipment documents',
            fileUrl, JSON.stringify(documentIds), req.body.createdBy || null, new Date()
        ]);
        return res.status(201).json({ data: { id: bundleId, shipmentId, fileUrl, documentIds } });
    }
    catch (error) {
        console.error('Document merge error:', error);
        return res.status(500).json({ error: 'Failed to merge documents' });
    }
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
router.post('/shipment/:id/upload', uploadDocumentFile, async (req, res) => {
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
        await storeUploadedDocumentFile(req.file, fileUrl);
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
        const [document] = await db.query(`
          SELECT sd.shipmentId, dc.name, s.shipmentNumber
          FROM ShipmentDocument sd
          JOIN DocumentChecklist dc ON sd.checklistId = dc.id
          JOIN Shipment s ON sd.shipmentId = s.id
          WHERE sd.id = ?
        `, [id]);
        if (document) {
            const rejected = status === 'rejected' || status === 'query';
            await createNotification({
                title: rejected ? 'Document query raised' : 'Document approved',
                message: `${document.name} for ${document.shipmentNumber} was marked ${status}.`,
                category: 'document',
                type: rejected ? 'warning' : 'success',
                priority: rejected ? 'high' : 'normal',
                actionUrl: `/shipments/${document.shipmentId}/documents`,
                emailEnabled: rejected,
                recipients: await notificationRecipients(document.shipmentId),
            });
        }
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
        const [pendingRequired] = await db.query(`
          SELECT COUNT(*) as count
          FROM Shipment s
          CROSS JOIN DocumentChecklist dc
          LEFT JOIN ShipmentDocument sd ON sd.shipmentId = s.id AND sd.checklistId = dc.id
          WHERE s.isActive = 1 AND dc.isActive = 1 AND dc.isRequired = 1
            AND (sd.id IS NULL OR sd.status IN ('pending', 'rejected', 'expired'))
        `);
        // Fallback if no records yet
        const result = {
            total: stats?.total || 0,
            uploaded: stats?.uploaded || 0,
            pending: pendingRequired?.count || stats?.pending || 0,
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
