import { fetchHapagTracking } from "./src/services/hapag.js";

const trackingNumber = process.argv[2] || "29245713";

try {
  const result = await fetchHapagTracking(trackingNumber);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(error.response?.data || error.message || error);
  process.exit(1);
}
