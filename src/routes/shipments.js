import { db } from '../db.js';
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createId } from '@paralleldrive/cuid2';
import { createNotification, notificationRecipients } from '../services/notifications.js';
import { isJobEnabled } from '../services/job-settings.js';
import {
    fetchCarrierTracking,
    syncShipmentTracking,
    trackingCarrierLabel,
} from '../services/tracking.js';
const router = Router();
const execFileAsync = promisify(execFile);
const merskScriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../mersk.js');

const normalizeInvoiceNumber = (value) => String(value || '').trim();

const auditFieldLabels = {
    companyId: 'Importer Name',
    exporterCompanyId: 'Exporter Name',
    bookingNumber: 'Booking Number',
    blNumber: 'BL Number',
    shippingLine: 'Shipping Line',
    freightForwarder: 'Freight Forwarder',
    vesselName: 'Vessel Name',
    voyageNumber: 'Voyage Number',
    originCountry: 'Origin Country',
    originPort: 'Origin Port',
    destinationPort: 'Destination Port',
    warehouseLocation: 'Warehouse Location',
    deliveryAddress: 'Delivery Address',
    priority: 'Priority',
    status: 'Status',
    currency: 'Currency',
    goodsDescription: 'Goods Description',
    internalNotes: 'Internal Notes',
    notes: 'Notes',
    etd: 'ETD',
    eta: 'ETA',
    actualArrival: 'Actual Arrival',
};

const auditValue = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    if (value instanceof Date) return value.toISOString();
    return String(value);
};

const shipmentAuditDetails = (before, after, body) => {
    const changes = Object.keys(auditFieldLabels).flatMap((field) => {
        if (body[field] === undefined) return [];
        const oldValue = field === 'companyId'
            ? before.importerName
            : field === 'exporterCompanyId'
                ? before.exporterName
                : before[field];
        const newValue = field === 'companyId'
            ? after.company?.name
            : field === 'exporterCompanyId'
                ? after.exporterCompany?.name
                : after[field];
        if (auditValue(oldValue) === auditValue(newValue)) return [];
        return [`${auditFieldLabels[field]}: "${auditValue(oldValue)}" → "${auditValue(newValue)}"`];
    });
    const shipmentNumber = after.shipmentNumber || before.shipmentNumber || before.blNumber || after.id;
    return changes.length
        ? `Updated Shipment ${shipmentNumber} — Changes: ${changes.join('; ')}.`
        : `Updated Shipment ${shipmentNumber}`;
};

const upsertShipmentInvoice = async (shipmentId, body) => {
    const invoiceNumber = normalizeInvoiceNumber(body.invoiceNumber);
    if (!invoiceNumber)
        return null;
    const [duplicateInvoice] = await db.query(`
      SELECT id, shipmentId FROM Invoice
      WHERE invoiceNumber = ? AND isActive = 1 AND (shipmentId IS NULL OR shipmentId <> ?)
    `, [invoiceNumber, shipmentId]);
    if (duplicateInvoice) {
        const error = new Error(`Invoice number already exists`);
        error.status = 409;
        throw error;
    }
    const [existingInvoice] = await db.query(`
      SELECT id FROM Invoice
      WHERE shipmentId = ? AND isActive = 1
      ORDER BY createdAt DESC
      LIMIT 1
    `, [shipmentId]);
    const values = [
        invoiceNumber,
        body.currency || 'USD',
        0,
        body.companyId || null,
        body.notes || null,
        new Date(),
    ];
    if (existingInvoice) {
        await db.execute(`
          UPDATE Invoice
          SET invoiceNumber = ?, currency = ?, totalAmount = ?, companyId = ?, notes = ?, updatedAt = ?
          WHERE id = ?
        `, [...values, existingInvoice.id]);
        return existingInvoice.id;
    }
    const invoiceId = createId();
    await db.execute(`
      INSERT INTO Invoice (
        id, invoiceNumber, invoiceType, status, issueDate, subtotal, taxAmount,
        totalAmount, currency, paidAmount, companyId, shipmentId, notes,
        isActive, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        invoiceId, invoiceNumber, 'commercial', 'draft', new Date(), 0, 0,
        0, body.currency || 'USD', 0, body.companyId || null,
        shipmentId, body.notes || null, 1, new Date(), new Date()
    ]);
    return invoiceId;
};

const syncShipmentRequiredDocuments = async (shipmentId, checklistIds) => {
    if (!Array.isArray(checklistIds))
        return;
    const nextIds = [...new Set(checklistIds.map((id) => String(id || '').trim()).filter(Boolean))];
    const existingRows = await db.query('SELECT id, checklistId FROM ShipmentDocument WHERE shipmentId = ?', [shipmentId]);
    const existingIds = existingRows.map((row) => row.checklistId);
    const nextIdSet = new Set(nextIds);
    const existingIdSet = new Set(existingIds);
    const removeRows = existingRows.filter((row) => !nextIdSet.has(row.checklistId));
    if (removeRows.length) {
        const placeholders = removeRows.map(() => '?').join(',');
        await db.execute(`DELETE FROM ShipmentDocument WHERE shipmentId = ? AND checklistId IN (${placeholders})`, [
            shipmentId,
            ...removeRows.map((row) => row.checklistId),
        ]);
    }
    for (const checklistId of nextIds) {
        if (existingIdSet.has(checklistId))
            continue;
        await db.execute(`
          INSERT INTO ShipmentDocument (
            id, shipmentId, checklistId, status, createdAt, updatedAt
          ) VALUES (?, ?, ?, 'pending', ?, ?)
        `, [createId(), shipmentId, checklistId, new Date(), new Date()]);
    }
};

const lookupMerskTracking = async (trackingNumber) => {
    // Validate: alphanumeric + hyphens only to prevent command injection/SSRF
    if (!/^[A-Za-z0-9-]+$/.test(trackingNumber)) {
        throw new Error('Invalid tracking number format');
    }
    const { stdout } = await execFileAsync(process.execPath, [merskScriptPath, trackingNumber], {
        timeout: 280000,
        maxBuffer: 1024 * 1024 * 5,
    });
    return JSON.parse(stdout);
};
// GET /api/shipments/notification-users
router.get('/notification-users', async (_req, res) => {
    try {
        const users = await db.query(`
          SELECT id, name, email, role, department
          FROM User
          WHERE isActive = 1
          ORDER BY name ASC
        `);
        return res.json({ data: users });
    }
    catch (error) {
        console.error('Shipment notification users error:', error);
        return res.status(500).json({ error: 'Failed to load notification users' });
    }
});
// POST /api/shipments/tracking/lookup
router.post('/tracking/lookup', async (req, res) => {
    try {
        const trackingNumber = String(req.body.trackingNumber || req.body.blNumber || '').trim().toUpperCase();
        const shippingLine = String(req.body.shippingLine || '').trim();
        if (!trackingNumber || !shippingLine)
            return res.status(400).json({ error: 'Tracking number and shipping line are required' });
        const carrier = trackingCarrierLabel(shippingLine);
        if (!carrier)
            return res.status(400).json({ error: 'Only Maersk, MSC, Evergreen, Hapag-Lloyd, and COSCO tracking are supported' });
        if (carrier === 'Maersk') {
            const result = await lookupMerskTracking(trackingNumber);
            return res.json({ data: result });
        }
        const result = await fetchCarrierTracking({
            id: 'lookup',
            trackingNumber,
            blNumber: req.body.blNumber,
            bookingNumber: req.body.bookingNumber,
            containerNumber: req.body.containerNumber,
            shippingLine,
            status: 'draft',
            destinationPort: null,
            eta: null,
        }, {
            forceMaerskScraperFallback: false,
        });
        return res.json({ data: result });
    }
    catch (error) {
        console.error('Shipment tracking lookup error:', error);
        return res.status(502).json({ error: `Carrier tracking failed: ${String(error)}` });
    }
});
// GET /api/shipments/[id]
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const shipments = await db.query('SELECT * FROM Shipment WHERE id = ?', [id]);
        if (!shipments.length)
            return res.status(404).json({ error: 'Shipment not found' });
        const shipment = shipments[0];
        const companies = await db.query('SELECT * FROM Company WHERE id = ?', [shipment.companyId]);
        shipment.company = companies[0] || null;
        const exporters = await db.query('SELECT * FROM ExporterCompany WHERE id = ?', [shipment.exporterCompanyId]);
        shipment.exporterCompany = exporters[0] || null;
        shipment.containers = await db.query('SELECT * FROM Container WHERE shipmentId = ? AND isActive = 1 ORDER BY createdAt DESC', [id]);
        shipment.documents = await db.query('SELECT * FROM Document WHERE shipmentId = ? AND isActive = 1 ORDER BY createdAt DESC', [id]);
        shipment.expenses = await db.query('SELECT * FROM Expense WHERE shipmentId = ? AND isActive = 1 ORDER BY createdAt DESC', [id]);
        shipment.invoices = await db.query('SELECT * FROM Invoice WHERE shipmentId = ? AND isActive = 1 ORDER BY createdAt DESC', [id]);
        shipment.customsClearance = await db.query('SELECT * FROM CustomsClearance WHERE shipmentId = ?', [id]);
        shipment.logistics = await db.query('SELECT * FROM Logistics WHERE shipmentId = ? AND isActive = 1 ORDER BY createdAt DESC', [id]);
        shipment.timelineEvents = await db.query('SELECT * FROM TimelineEvent WHERE shipmentId = ? ORDER BY timestamp DESC', [id]);
        const items = await db.query('SELECT * FROM ShipmentItem WHERE shipmentId = ?', [id]);
        for (const item of items) {
            if (item.productId) {
                const prods = await db.query('SELECT id, name, sku FROM Product WHERE id = ?', [item.productId]);
                item.product = prods[0] || null;
            }
        }
        shipment.shipmentItems = items;
        return res.json({ data: shipment });
    }
    catch (error) {
        console.error('Shipment GET error:', error);
        return res.status(500).json({ error: String(error) });
    }
});
// PUT /api/shipments/[id]
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const body = req.body;
        const oldShipments = await db.query(`
          SELECT s.*, c.name AS importerName, e.name AS exporterName
          FROM Shipment s
          LEFT JOIN Company c ON s.companyId = c.id
          LEFT JOIN ExporterCompany e ON s.exporterCompanyId = e.id
          WHERE s.id = ?
        `, [id]);
        const oldShipment = oldShipments[0];
        if (!oldShipment)
            return res.status(404).json({ error: 'Shipment not found' });
        if (body.blNumber) {
            const [duplicateBl] = await db.query('SELECT shipmentNumber FROM Shipment WHERE blNumber = ? AND id <> ? AND isActive = 1', [body.blNumber, id]);
            if (duplicateBl)
                return res.status(409).json({ error: `BL number already exists in ${duplicateBl.shipmentNumber}` });
        }
        if (body.bookingNumber) {
            const [duplicateBooking] = await db.query('SELECT shipmentNumber FROM Shipment WHERE bookingNumber = ? AND id <> ? AND isActive = 1', [body.bookingNumber, id]);
            if (duplicateBooking)
                return res.status(409).json({ error: `Booking number already exists in ${duplicateBooking.shipmentNumber}` });
        }
        const updates = [];
        const values = [];
        const settableFields = [
            'bookingNumber', 'blNumber', 'shippingLine', 'freightForwarder', 'vesselName',
            'voyageNumber', 'originCountry', 'originPort', 'destinationPort', 'warehouseLocation',
            'deliveryAddress', 'priority', 'status', 'currency', 'companyId',
            'tags', 'internalNotes', 'goodsDescription', 'notes', 'exporterCompanyId', 'isActive'
        ];
        for (const field of settableFields) {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                if (field === 'companyId' && body[field] === '') {
                    values.push(null);
                }
                else {
                    values.push(body[field]);
                }
            }
        }
        if (body.notificationUserIds !== undefined) {
            updates.push('notificationUserIds = ?::jsonb');
            values.push(JSON.stringify(Array.isArray(body.notificationUserIds) ? body.notificationUserIds : []));
        }
        if (body.etd) {
            updates.push('etd = ?');
            values.push(new Date(body.etd));
        }
        if (body.eta) {
            updates.push('eta = ?');
            values.push(new Date(body.eta));
        }
        if (body.actualArrival) {
            updates.push('actualArrival = ?');
            values.push(new Date(body.actualArrival));
        }
        if (updates.length > 0) {
            updates.push('updatedAt = ?');
            values.push(new Date());
            values.push(id);
            await db.execute(`UPDATE Shipment SET ${updates.join(', ')} WHERE id = ?`, values);
        }
        await upsertShipmentInvoice(id, body);
        await syncShipmentRequiredDocuments(id, body.requiredDocumentIds);
        const updatedShipments = await db.query('SELECT * FROM Shipment WHERE id = ?', [id]);
        const shipment = updatedShipments[0];
        shipment.invoiceNumber = normalizeInvoiceNumber(body.invoiceNumber) || null;
        if (shipment && shipment.companyId) {
            const comps = await db.query('SELECT id, name FROM Company WHERE id = ?', [shipment.companyId]);
            shipment.company = comps[0] || null;
        }
        if (shipment && shipment.exporterCompanyId) {
            const exps = await db.query('SELECT id, name FROM ExporterCompany WHERE id = ?', [shipment.exporterCompanyId]);
            shipment.exporterCompany = exps[0] || null;
        }
        const workflowEnabled = await isJobEnabled('workflow_automations');
        if (workflowEnabled && body.status && oldShipment && oldShipment.status !== body.status) {
            const statusLabels = {
                draft: 'Shipment Created', booking_confirmed: 'Booking Confirmed', at_pol: 'Container Arrived at POL',
                vessel_departed: 'Vessel Departed', in_transit: 'In Transit', at_pod: 'Arrived at POD',
                customs_clearance: 'Customs Clearance', duty_paid: 'Duty Paid', in_transport: 'Dispatched for Transport',
                offloaded: 'Offloaded at Warehouse', delivered: 'Delivered', closed: 'Shipment Closed',
            };
            const tlId = createId();
            await db.execute(`INSERT INTO TimelineEvent (id, shipmentId, event, description, location, timestamp) VALUES (?, ?, ?, ?, ?, ?)`, [tlId, id, statusLabels[body.status] || `Status Updated: ${body.status}`, `Shipment status changed from ${oldShipment.status} to ${body.status}`, body.destinationPort || null, new Date()]);
            const isHighPriority = ['at_pod', 'customs_clearance', 'delivered'].includes(body.status);
            
            let notifyOnStatusChange = true;
            const [row] = await db.query('SELECT "value" FROM "AppSetting" WHERE "key" = ?', ['workflow_automations']);
            if (row && row.value) {
                try {
                    const settings = JSON.parse(row.value);
                    if (typeof settings.notifyOnStatusChange !== 'undefined') {
                        notifyOnStatusChange = !!settings.notifyOnStatusChange;
                    }
                } catch(e) {}
            }

            await createNotification({
                title: statusLabels[body.status] || 'Shipment updated',
                message: `${shipment.shipmentNumber} changed from ${oldShipment.status} to ${body.status}.`,
                category: 'shipment',
                type: isHighPriority ? 'warning' : 'info',
                priority: isHighPriority ? 'high' : shipment.priority,
                actionUrl: `/shipments/${id}`,
                emailEnabled: notifyOnStatusChange,
                recipients: await notificationRecipients(id),
            });
        }
        const trackingIdentityChanged = oldShipment &&
            (oldShipment.bookingNumber !== shipment.bookingNumber ||
                oldShipment.blNumber !== shipment.blNumber ||
                oldShipment.shippingLine !== shipment.shippingLine);
        if (workflowEnabled && trackingIdentityChanged &&
            trackingCarrierLabel(shipment.shippingLine) &&
            (shipment.blNumber || shipment.bookingNumber)) {
            Object.assign(shipment, await syncShipmentTracking(id, true));
        }
        return res.json({
            data: shipment,
            auditDetails: shipmentAuditDetails(oldShipment, shipment, body),
        });
    }
    catch (error) {
        console.error('Shipment PUT error:', error);
        return res.status(error.status || 500).json({ error: error.message || String(error) });
    }
});
// DELETE /api/shipments/[id]
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const existing = await db.query('SELECT id FROM Shipment WHERE id = ?', [id]);
        if (!existing.length)
            return res.status(404).json({ error: 'Shipment not found' });
        await db.execute('UPDATE Shipment SET isActive = 0, updatedAt = ? WHERE id = ?', [new Date(), id]);
        const shipments = await db.query('SELECT * FROM Shipment WHERE id = ?', [id]);
        return res.json({ data: shipments[0] });
    }
    catch (error) {
        console.error('Shipment DELETE error:', error);
        return res.status(500).json({ error: String(error) });
    }
});
// GET /api/shipments
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '1');
        const limit = parseInt(req.query.limit || '20');
        const search = req.query.search || '';
        const status = req.query.status || '';
        const priority = req.query.priority || '';
        const companyId = req.query.companyId || '';
        const shippingLine = req.query.shippingLine || '';
        const originCountry = req.query.originCountry || '';
        const originPort = req.query.originPort || '';
        const destinationPort = req.query.destinationPort || '';
        const isActive = req.query.isActive;
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'desc';
        const skip = (page - 1) * limit;
        let whereClause = '1=1';
        const params = [];
        if (search) {
            whereClause += ' AND (shipmentNumber LIKE ? OR bookingNumber LIKE ? OR blNumber LIKE ? OR vesselName LIKE ? OR freightForwarder LIKE ?)';
            const l = `%${search}%`;
            params.push(l, l, l, l, l);
        }
        if (status) {
            const statuses = status.split(',');
            whereClause += ` AND status IN (${statuses.map(() => '?').join(',')})`;
            params.push(...statuses);
        }
        const containerType = req.query.containerType || '';
        const containerSize = req.query.containerSize || '';
        if (containerType || containerSize) {
            whereClause += ` AND EXISTS (SELECT 1 FROM Container c WHERE c.shipmentId = Shipment.id AND c.isActive = 1`;
            if (containerType) {
                whereClause += ` AND c.containerType = ?`;
                params.push(containerType);
            }
            if (containerSize) {
                whereClause += ` AND c.containerSize = ?`;
                params.push(containerSize);
            }
            whereClause += `)`;
        }
        if (companyId) {
            whereClause += ' AND companyId = ?';
            params.push(companyId);
        }
        if (shippingLine) {
            whereClause += ' AND shippingLine = ?';
            params.push(shippingLine);
        }
        if (originCountry) {
            whereClause += ' AND originCountry = ?';
            params.push(originCountry);
        }
        if (originPort) {
            whereClause += ' AND originPort = ?';
            params.push(originPort);
        }
        if (destinationPort) {
            whereClause += ' AND destinationPort = ?';
            params.push(destinationPort);
        }
        if (isActive !== undefined && isActive !== '') {
            whereClause += ' AND isActive = ?';
            params.push(isActive === 'true' ? 1 : 0);
        }
        else {
            whereClause += ' AND isActive = 1';
        }
        const countRows = await db.query(`SELECT COUNT(*) as c FROM Shipment WHERE ${whereClause}`, params);
        const total = countRows[0].c;
        const queryParams = [...params, limit, skip];
        const allowedSort = ['createdAt', 'updatedAt', 'status', 'eta', 'etd'].includes(sortBy) ? sortBy : 'createdAt';
        const allowedDir = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const shipments = await db.query(`SELECT * FROM Shipment WHERE ${whereClause} ORDER BY ${allowedSort} ${allowedDir} LIMIT ? OFFSET ?`, queryParams);
        const shipmentIds = shipments.map((shipment) => shipment.id);
        if (shipmentIds.length) {
            const placeholders = shipmentIds.map(() => '?').join(',');
            const companyIds = [...new Set(shipments.map((shipment) => shipment.companyId).filter(Boolean))];
            const exporterCompanyIds = [...new Set(shipments.map((shipment) => shipment.exporterCompanyId).filter(Boolean))];
            const companies = companyIds.length
                ? await db.query(`SELECT id, name, contactPerson FROM Company WHERE id IN (${companyIds.map(() => '?').join(',')})`, companyIds)
                : [];
            const exporterCompanies = exporterCompanyIds.length
                ? await db.query(`SELECT id, name, contactPerson FROM ExporterCompany WHERE id IN (${exporterCompanyIds.map(() => '?').join(',')})`, exporterCompanyIds)
                : [];
            const containers = await db.query(`
              SELECT id, shipmentId, containerNumber, containerSize, containerType, status
              FROM Container
              WHERE shipmentId IN (${placeholders})
            `, shipmentIds);
            const invoices = await db.query(`
              SELECT shipmentId, invoiceNumber, createdAt
              FROM Invoice
              WHERE shipmentId IN (${placeholders}) AND isActive = 1
              ORDER BY createdAt DESC
            `, shipmentIds);
            const countTables = [
                ['containers', 'Container'],
                ['documents', 'Document'],
                ['expenses', 'Expense'],
                ['timelineEvents', 'TimelineEvent'],
                ['shipmentItems', 'ShipmentItem'],
            ];
            const countRows = await Promise.all(countTables.map(([, table]) => db.query(`
              SELECT shipmentId, COUNT(*) as c
              FROM ${table}
              WHERE shipmentId IN (${placeholders})
              GROUP BY shipmentId
            `, shipmentIds)));
            const companyById = new Map(companies.map((company) => [company.id, company]));
            const exporterCompanyById = new Map(exporterCompanies.map((company) => [company.id, company]));
            const containersByShipmentId = new Map();
            for (const container of containers) {
                const current = containersByShipmentId.get(container.shipmentId) || [];
                current.push(container);
                containersByShipmentId.set(container.shipmentId, current);
            }
            const invoiceNumberByShipmentId = new Map();
            for (const invoice of invoices) {
                if (!invoiceNumberByShipmentId.has(invoice.shipmentId))
                    invoiceNumberByShipmentId.set(invoice.shipmentId, invoice.invoiceNumber);
            }
            const countsByTable = new Map(countTables.map(([key], index) => {
                const rowsByShipmentId = new Map(countRows[index].map((row) => [row.shipmentId, Number(row.c || 0)]));
                return [key, rowsByShipmentId];
            }));
            for (const shipment of shipments) {
                shipment.company = shipment.companyId ? companyById.get(shipment.companyId) || null : null;
                shipment.exporterCompany = shipment.exporterCompanyId ? exporterCompanyById.get(shipment.exporterCompanyId) || null : null;
                shipment.containers = containersByShipmentId.get(shipment.id) || [];
                shipment.invoiceNumber = invoiceNumberByShipmentId.get(shipment.id) || null;
                shipment._count = {
                    containers: countsByTable.get('containers')?.get(shipment.id) || 0,
                    documents: countsByTable.get('documents')?.get(shipment.id) || 0,
                    expenses: countsByTable.get('expenses')?.get(shipment.id) || 0,
                    timelineEvents: countsByTable.get('timelineEvents')?.get(shipment.id) || 0,
                    shipmentItems: countsByTable.get('shipmentItems')?.get(shipment.id) || 0,
                };
            }
        }
        return res.json({ data: shipments, pagination: { total, page, limit } });
    }
    catch (error) {
        console.error('Shipments GET error:', error);
        return res.status(500).json({ error: String(error) });
    }
});
// POST /api/shipments
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        if (body.blNumber) {
            const [duplicateBl] = await db.query('SELECT shipmentNumber FROM Shipment WHERE blNumber = ? AND isActive = 1', [body.blNumber]);
            if (duplicateBl)
                return res.status(409).json({ error: `BL number already exists in ${duplicateBl.shipmentNumber}` });
        }
        if (body.bookingNumber) {
            const [duplicateBooking] = await db.query('SELECT shipmentNumber FROM Shipment WHERE bookingNumber = ? AND isActive = 1', [body.bookingNumber]);
            if (duplicateBooking)
                return res.status(409).json({ error: `Booking number already exists in ${duplicateBooking.shipmentNumber}` });
        }
        const lastShipments = await db.query('SELECT shipmentNumber FROM Shipment ORDER BY createdAt DESC LIMIT 1');
        const nextNum = lastShipments.length > 0 ? parseInt(lastShipments[0].shipmentNumber.split('-').pop() || '0') + 1 : 1;
        const shipmentNumber = `SHP-${new Date().getFullYear()}-${String(nextNum).padStart(4, '0')}`;
        const id = createId();
        await db.execute(`
      INSERT INTO Shipment (id, shipmentNumber, bookingNumber, blNumber, shippingLine, freightForwarder, vesselName, voyageNumber, etd, eta, actualArrival, originCountry, originPort, destinationPort, warehouseLocation, deliveryAddress, priority, status, currency, companyId, exporterCompanyId, tags, internalNotes, goodsDescription, notes, notificationUserIds, isActive, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
    `, [
            id, shipmentNumber, body.bookingNumber || null, body.blNumber || null, body.shippingLine || null, body.freightForwarder || null, body.vesselName || null, body.voyageNumber || null, body.etd ? new Date(body.etd) : null, body.eta ? new Date(body.eta) : null, body.actualArrival ? new Date(body.actualArrival) : null, body.originCountry || null, body.originPort || null, body.destinationPort || null, body.warehouseLocation || null, body.deliveryAddress || null, body.priority || 'normal', body.status || 'draft', body.currency || 'USD', body.companyId || null, body.exporterCompanyId || null, body.tags || null, body.internalNotes || null, body.goodsDescription || null, body.notes || null, JSON.stringify(Array.isArray(body.notificationUserIds) ? body.notificationUserIds : []), body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1, new Date(), new Date()
        ]);
        await Promise.all((body.containers || []).map(async (container) => {
            await db.execute(`
              INSERT INTO Container (
                id, containerNumber, containerType, containerSize, sealNumber, stuffingType,
                weightCapacity, currentWeight, packageCount, status, currentLocation, goodsDescription,
                shipmentId, isActive, createdAt, updatedAt
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                createId(), container.containerNumber, container.containerType || 'standard',
                container.containerSize || '20ft', container.sealNumber || null,
                container.stuffingType || null, container.weightCapacity || 0,
                container.currentWeight || 0, container.packageCount || 0, container.status || 'at_pol',
                container.currentLocation || null, container.goodsDescription || null,
                id, 1, new Date(), new Date()
            ]);
        }));
        await upsertShipmentInvoice(id, body);
        await Promise.all((body.shipmentItems || body.items || []).map(async (item) => {
            await db.execute(`
              INSERT INTO ShipmentItem (
                id, shipmentId, productId, containerId, description, quantity, unitPrice,
                currency, grossWeight, netWeight, cbmVolume, packingType
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                createId(), id, item.productId || null, item.containerId || null,
                item.description || null, item.quantity || 0, item.unitPrice || 0,
                item.currency || body.currency || 'USD', item.grossWeight || 0,
                item.netWeight || 0, item.cbmVolume || 0, item.packingType || null
            ]);
        }));
        if (Array.isArray(body.requiredDocumentIds)) {
            await Promise.all(body.requiredDocumentIds.map(async (checklistId) => {
                await db.execute(`
                  INSERT INTO ShipmentDocument (
                    id, shipmentId, checklistId, status, createdAt, updatedAt
                  ) VALUES (?, ?, ?, 'pending', ?, ?)
                `, [createId(), id, checklistId, new Date(), new Date()]);
            }));
        }
        const shipments = await db.query('SELECT * FROM Shipment WHERE id = ?', [id]);
        const shipment = shipments[0];
        shipment.invoiceNumber = normalizeInvoiceNumber(body.invoiceNumber) || null;
        if (shipment.companyId) {
            const comps = await db.query('SELECT id, name FROM Company WHERE id = ?', [shipment.companyId]);
            shipment.company = comps[0] || null;
        }
        if (shipment.exporterCompanyId) {
            const exps = await db.query('SELECT id, name FROM ExporterCompany WHERE id = ?', [shipment.exporterCompanyId]);
            shipment.exporterCompany = exps[0] || null;
        }
        const tlId = createId();
        await db.execute(`
      INSERT INTO TimelineEvent (id, shipmentId, event, description, location, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [tlId, id, 'Shipment Created', 'Draft shipment created in the system', body.originPort || 'N/A', new Date()]);
        if (await isJobEnabled('workflow_automations') && trackingCarrierLabel(shipment.shippingLine) &&
            (shipment.blNumber || shipment.bookingNumber || (body.containers || []).some((container) => container.containerNumber))) {
            Object.assign(shipment, await syncShipmentTracking(id, true));
        }
        return res.status(201).json({ data: shipment });
    }
    catch (error) {
        console.error('Shipments POST error:', error);
        return res.status(error.status || 500).json({ error: error.message || String(error) });
    }
});
export default router;
