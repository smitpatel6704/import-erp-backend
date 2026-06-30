import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const trackingNo = process.argv[2] || '269868191';

const browser = await chromium.launch({
  headless: true, // Render/server: true
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});

const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  viewport: null
});

const page = await context.newPage();

await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});

const clean = (v = '') => String(v).replace(/\s+/g, ' ').trim();

const formatDateForInput = (dateText = '') => {
  const d = new Date(dateText);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
};

try {
  await page.goto(`https://www.maersk.com/tracking/${trackingNo}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  try {
    await page.getByRole('button', { name: /allow all/i }).click({ timeout: 8000 });
  } catch {}

  await page.waitForFunction(
    (expectedTrackingNo) => {
      const text = document.body.innerText;
      return (
        text.includes('No results found') ||
        (text.includes(expectedTrackingNo) &&
          text.includes('From') &&
          text.includes('To') &&
          /[A-Z]{4}\d{7}/.test(text))
      );
    },
    trackingNo,
    { timeout: 90000 }
  );

  await page.waitForTimeout(3000);

  const text = await page.locator('body').innerText();

  await page.screenshot({ path: 'maersk-debug.png', fullPage: true });
  await fs.writeFile('maersk-debug.txt', text);

  if (text.includes('No results found') && !text.includes('Bill of Lading number')) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          trackingNo,
          error: 'No results found on Maersk public tracking'
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  const flatText = text.replace(/\s+/g, ' ').trim();
  const getMatch = (regex) => (flatText.match(regex)?.[1] || '').trim();

  const billOfLading = getMatch(/Bill of Lading number\s+([A-Z0-9]{9})\s+From/i);
  const originPort = getMatch(/From\s+([^\s]+)\s+To/i);
  const destinationPort = getMatch(/To\s+([^\s]+)\s+(?:[A-Z]{4}\d{7}|Last updated)/i);
  const containerNumber = getMatch(/([A-Z]{4}\d{7})\s*\|/i);
  const rawContainerType = getMatch(/[A-Z]{4}\d{7}\s*\|\s*(.*?)\s+Last updated/i);

  // Timeline events
  const vesselEventRegex = /(Vessel arrival|Vessel departure|Feeder arrival|Feeder departure|Load on|Discharge)\s*(?:\()?([A-Z\s/0-9-]+?)(?:\))?\s+([0-9]{2}\s+[A-Za-z]{3}\s+[0-9]{4}\s+[0-9]{2}:[0-9]{2})/gi;

  const events = [...flatText.matchAll(vesselEventRegex)].map((m) => ({
    event: clean(m[1]),
    vessel: clean(m[2]),
    dateText: clean(m[3])
  }));

  const arrivals = events.filter((e) => /arrival/i.test(e.event));
  const departures = events.filter((e) => /departure/i.test(e.event));

  const finalArrival = arrivals[arrivals.length - 1];
  const firstDeparture = departures[0];
  const latestDeparture = departures[departures.length - 1];

  const etaText =
    getMatch(/Estimated arrival date\s+([\s\S]*?)\s+(?:Latest event|Note:)/i) ||
    finalArrival?.dateText ||
    '';

  const etdText = firstDeparture?.dateText || '';

  const vesselName =
    latestDeparture?.vessel?.split('/')[0]?.trim() ||
    finalArrival?.vessel?.split('/')[0]?.trim() ||
    firstDeparture?.vessel?.split('/')[0]?.trim() ||
    '';

  const latestEvent =
    getMatch(/Last updated:.*?(?:ago|Date)\s+(.*?)\s+Note:/i) ||
    getMatch(/Latest event\s+(.*?)\s+Note:/i) ||
    (latestDeparture
      ? `${latestDeparture.event} · ${latestDeparture.vessel} · ${latestDeparture.dateText}`
      : '');

  let size = '';
  let type = rawContainerType;

  if (/40/i.test(rawContainerType)) size = '40FT';
  else if (/20/i.test(rawContainerType)) size = '20FT';
  else if (/45/i.test(rawContainerType)) size = '45FT';

  if (/dry/i.test(rawContainerType)) type = 'Dry Container';
  else if (/reefer/i.test(rawContainerType)) type = 'Reefer Container';
  else if (/open/i.test(rawContainerType)) type = 'Open Top Container';
  else if (/flat/i.test(rawContainerType)) type = 'Flat Rack Container';

  const result = {
    ok: true,
    trackingNo: billOfLading || trackingNo,
    vesselName,
    originPort,
    destinationPort,
    etd: formatDateForInput(etdText),
    eta: formatDateForInput(etaText),
    priority: 'Normal',
    status: 'Draft',
    shipmentValue: 0,
    originCountry: '',
    goodsDescription: '',
    notes: latestEvent ? `Latest event: ${latestEvent}` : '',
    containers: containerNumber
      ? [
          {
            containerNumber,
            size,
            type,
            containerGoods: ''
          }
        ]
      : [],
    raw: {
      billOfLading,
      rawContainerType,
      etaText,
      etdText,
      latestEvent,
      vesselName,
      events
    }
  };

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        trackingNo,
        error: error.message
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
