import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import activitiesRouter from './routes/activities.js';
import companiesRouter from './routes/companies.js';
import containersRouter from './routes/containers.js';
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
import cronRouter from './routes/cron.js';
import maerskRouter from './routes/maersk.js';
import { auditMutation } from './services/audit.js';
import { authenticate, requireAdmin, requireModulePermission } from './services/auth.js';
import { sendStoredDocumentFile } from './services/document-files.js';
const app = express();
const isProduction = () => process.env.NODE_ENV === 'production' || process.env.VERCEL;
const allowedOrigins = () => new Set(
    [
        process.env.APP_URL,
        process.env.FRONTEND_URL,
        ...(process.env.CORS_ORIGINS || '').split(','),
    ]
        .map((origin) => String(origin || '').trim().replace(/\/$/, ''))
        .filter(Boolean)
);
const apiAttempts = new Map();
const rateLimit = ({ windowMs, max, keyPrefix }) => (req, res, next) => {
    const now = Date.now();
    const ip = String(req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || 'unknown')
        .split(',')[0]
        .trim();
    const key = `${keyPrefix}:${ip}`;
    const current = apiAttempts.get(key);
    if (!current || current.resetAt <= now) {
        apiAttempts.set(key, { count: 1, resetAt: now + windowMs });
        return next();
    }
    current.count += 1;
    if (current.count > max) {
        res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    return next();
};

app.disable('x-powered-by');
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.setHeader('Content-Security-Policy', 
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "connect-src 'self' https://*.supabase.co; " +
      "font-src 'self' data:; " +
      "object-src 'self'; " +
      "base-uri 'self'; " +
      "form-action 'self';"
    );
    next();
});
app.set('trust proxy', 1);
app.use(cors({
    origin(origin, callback) {
        if (!origin)
            return callback(null, true);
        const normalizedOrigin = String(origin).replace(/\/$/, '');
        if (!isProduction())
            return callback(null, true);
        if (allowedOrigins().has(normalizedOrigin))
            return callback(null, true);
        return callback(new Error('CORS origin is not allowed'));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
}));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 600, keyPrefix: 'api' }));
app.use(express.json({ limit: '4mb' }));
app.get('/uploads/:filename', authenticate, requireModulePermission('documents'), sendStoredDocumentFile);
app.get('/api/uploads/:filename', authenticate, requireModulePermission('documents'), sendStoredDocumentFile);
app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});
app.use('/api/cron', cronRouter);
app.use('/api/auth', authRouter);
app.use('/api/dashboard', authenticate, requireModulePermission('dashboard'), dashboardRouter);
app.use('/api/shipments', authenticate, requireModulePermission('shipments'), auditMutation('shipment'), shipmentsRouter);
app.use('/api/maersk', authenticate, requireModulePermission('shipments'), maerskRouter);
app.use('/api/containers', authenticate, requireModulePermission('containers'), auditMutation('container'), containersRouter);
app.use('/api/companies', authenticate, requireModulePermission('companies'), auditMutation('company'), companiesRouter);
app.use('/api/exporter-companies', authenticate, requireModulePermission('companies'), auditMutation('exporter_company'), exporterCompaniesRouter);
app.use('/api/products', authenticate, requireModulePermission('companies'), auditMutation('product'), productsRouter);
app.use('/api/documents', authenticate, requireModulePermission('documents'), auditMutation('document'), documentsRouter);
app.use('/api/shipment-documents', authenticate, requireModulePermission('documents'), auditMutation((req) => {
    if (req.path.startsWith('/checklist-types'))
        return 'document_checklist';
    if (req.path.includes('/merge'))
        return 'document_bundle';
    return 'shipment_document';
}), shipmentDocumentsRouter);
app.use('/api/shipment-items', authenticate, requireModulePermission('shipments'), auditMutation('shipment_item'), shipmentItemsRouter);
app.use('/api/logistics', authenticate, requireModulePermission('logistics'), auditMutation('logistics'), logisticsRouter);
app.use('/api/notifications', authenticate, requireModulePermission('notifications'), notificationsRouter);
app.use('/api/reports', authenticate, requireModulePermission('reports'), reportsRouter);
app.use('/api/expenses', authenticate, requireModulePermission('reports'), auditMutation('expense'), expensesRouter);
app.use('/api/invoices', authenticate, requireModulePermission('reports'), auditMutation('invoice'), invoicesRouter);
app.use('/api/activities', authenticate, requireAdmin, activitiesRouter);
app.use('/api/settings/users', authenticate, requireAdmin, auditMutation((req) => req.path.includes('resend-invitation') ? 'user_invitation' : 'user'), usersRouter);
app.use('/api/settings', authenticate, (req, res, next) => {
    if (req.method === 'GET' && (req.path === '/options' || req.path === '/brand-logos'))
        return next();
    return requireAdmin(req, res, next);
}, auditMutation('setting_option'), settingsRouter);
app.use((error, _req, res, _next) => {
    console.error(error);
    if (res.headersSent)
        return;
    res.status(error.status || 500).json({
        error: error.status && error.status < 500 ? error.message : 'Internal server error',
    });
});
export default app;
