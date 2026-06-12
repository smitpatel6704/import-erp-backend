import app from './app.js';
import { ensureFeatureSchema } from './services/schema.js';
import { startNotificationScheduler } from './services/notifications.js';
const PORT = process.env.PORT || 5001;

async function start() {
    await ensureFeatureSchema();
    app.listen(PORT, () => {
        console.log(`NEXPORT ERP server running on port ${PORT}`);
        startNotificationScheduler();
    });
}

start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
