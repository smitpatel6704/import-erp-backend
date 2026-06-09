  import app from './app';
import { ensureShipmentTrackingColumns, maerskScraperMode, startShipmentTrackingScheduler } from './services/tracking';

const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
