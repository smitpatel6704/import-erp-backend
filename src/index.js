import app from './app.js';
import { ensureShipmentTrackingColumns, maerskScraperMode, startShipmentTrackingScheduler } from './services/tracking.js';
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
