import app from './app.js';
import { verifyDatabaseConnection } from './db.js';
import { ensureFeatureSchema } from './services/schema.js';
import { startNotificationScheduler } from './services/notifications.js';
import { startShipmentTrackingScheduler } from './services/tracking.js';
const PORT = process.env.PORT || 5001;

async function start() {
    console.log('[START] NEXPORT ERP backend is starting...');
    const database = await verifyDatabaseConnection();
    console.log(`[OK] Database connected: ${database.database}`);
    await ensureFeatureSchema();
    console.log('[OK] Database schema is ready');
    app.listen(PORT, () => {
        console.log(`[OK] Server running on port ${PORT}`);
        startNotificationScheduler();
        startShipmentTrackingScheduler();
        console.log('[OK] Background schedulers started');
    });
}

start().catch((error) => {
    console.error('[ERROR] Failed to start NEXPORT ERP backend:', error);
    process.exit(1);
});
