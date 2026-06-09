import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { fileURLToPath } from 'url';

import activitiesRouter from './routes/activities.ts';
import companiesRouter from './routes/companies.ts';
import containersRouter from './routes/containers.ts';
import customsRouter from './routes/customs.ts';
import dashboardRouter from './routes/dashboard.ts';
import settingsRouter from './routes/settings.ts';
import documentsRouter from './routes/documents.ts';
import expensesRouter from './routes/expenses.ts';
import exporterCompaniesRouter from './routes/exporter-companies.ts';
import invoicesRouter from './routes/invoices.ts';
import logisticsRouter from './routes/logistics.ts';
import notificationsRouter from './routes/notifications.ts';
import productsRouter from './routes/products.ts';
import shipmentsRouter from './routes/shipments.ts';
import shipmentDocumentsRouter from './routes/shipment-documents.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/activities', activitiesRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/containers', containersRouter);
app.use('/api/customs', customsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/exporter-companies', exporterCompaniesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/logistics', logisticsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/products', productsRouter);
app.use('/api/shipments', shipmentsRouter);
app.use('/api/shipment-documents', shipmentDocumentsRouter);

export default app;
