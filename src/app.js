import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();
import path from 'path';
import { fileURLToPath } from 'url';
import activitiesRouter from './routes/activities.js';
import companiesRouter from './routes/companies.js';
import containersRouter from './routes/containers.js';
import customsRouter from './routes/customs.js';
import dashboardRouter from './routes/dashboard.js';
import settingsRouter from './routes/settings.js';
import documentsRouter from './routes/documents.js';
import expensesRouter from './routes/expenses.js';
import exporterCompaniesRouter from './routes/exporter-companies.js';
import invoicesRouter from './routes/invoices.js';
import logisticsRouter from './routes/logistics.js';
import notificationsRouter from './routes/notifications.js';
import productsRouter from './routes/products.js';
import shipmentsRouter from './routes/shipments.js';
import shipmentDocumentsRouter from './routes/shipment-documents.js';
import reportsRouter from './routes/reports.js';
import usersRouter from './routes/users.js';
import shipmentItemsRouter from './routes/shipment-items.js';
import authRouter from './routes/auth.js';
import { authenticate, requireAdmin, requireModulePermission } from './services/auth.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});
app.use('/api/auth', authRouter);
app.use('/api/dashboard', authenticate, requireModulePermission('dashboard'), dashboardRouter);
app.use('/api/shipments', authenticate, requireModulePermission('shipments'), shipmentsRouter);
app.use('/api/containers', authenticate, requireModulePermission('containers'), containersRouter);
app.use('/api/companies', authenticate, requireModulePermission('companies'), companiesRouter);
app.use('/api/exporter-companies', authenticate, requireModulePermission('companies'), exporterCompaniesRouter);
app.use('/api/products', authenticate, requireModulePermission('companies'), productsRouter);
app.use('/api/documents', authenticate, requireModulePermission('documents'), documentsRouter);
app.use('/api/shipment-documents', authenticate, requireModulePermission('documents'), shipmentDocumentsRouter);
app.use('/api/shipment-items', authenticate, requireModulePermission('shipments'), shipmentItemsRouter);
app.use('/api/customs', authenticate, requireModulePermission('customs'), customsRouter);
app.use('/api/logistics', authenticate, requireModulePermission('logistics'), logisticsRouter);
app.use('/api/notifications', authenticate, requireModulePermission('notifications'), notificationsRouter);
app.use('/api/reports', authenticate, requireModulePermission('reports'), reportsRouter);
app.use('/api/expenses', authenticate, requireModulePermission('reports'), expensesRouter);
app.use('/api/invoices', authenticate, requireModulePermission('reports'), invoicesRouter);
app.use('/api/activities', authenticate, requireAdmin, activitiesRouter);
app.use('/api/settings/users', authenticate, requireAdmin, usersRouter);
app.use('/api/settings', authenticate, (req, res, next) => {
    if (req.method === 'GET' && req.path === '/options')
        return next();
    return requireAdmin(req, res, next);
}, settingsRouter);
app.use((error, _req, res, _next) => {
    console.error(error);
    if (res.headersSent)
        return;
    res.status(error.status || 500).json({
        error: error.status && error.status < 500 ? error.message : 'Internal server error',
    });
});
export default app;
