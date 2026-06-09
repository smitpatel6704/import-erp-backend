import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { fileURLToPath } from 'url';

import activitiesRouter from './routes/activities';
import companiesRouter from './routes/companies';
import containersRouter from './routes/containers';
import customsRouter from './routes/customs';
import dashboardRouter from './routes/dashboard';
import settingsRouter from './routes/settings';
import documentsRouter from './routes/documents';
import expensesRouter from './routes/expenses';
import exporterCompaniesRouter from './routes/exporter-companies';
import invoicesRouter from './routes/invoices';
import logisticsRouter from './routes/logistics';
import notificationsRouter from './routes/notifications';
import productsRouter from './routes/products';
import shipmentsRouter from './routes/shipments';
import shipmentDocumentsRouter from './routes/shipment-documents';

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
