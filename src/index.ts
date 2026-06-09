import app from './app.ts';
import { ensureShipmentTrackingColumns, maerskScraperMode, startShipmentTrackingScheduler } from './services/tracking.ts';

const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
