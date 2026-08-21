import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

const trackingNo = process.argv[2] || '269868191';

const isVercel =
  Boolean(process.env.VERCEL) ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
  process.platform === 'linux';

let executablePath;
let browserArgs;

if (isVercel) {
  console.log('[Maersk] Running on Vercel/Linux');

  const { default: serverlessChromium } =
    await import('@sparticuz/chromium');

  executablePath =
    await serverlessChromium.executablePath();

  browserArgs = [
    ...serverlessChromium.args,
    '--disable-blink-features=AutomationControlled'
  ];
} else {
  console.log('[Maersk] Running locally');

  executablePath =
    process.env.CHROME_EXECUTABLE_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  browserArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage'
  ];
}

console.log('[Maersk] platform:', process.platform);
console.log('[Maersk] VERCEL:', process.env.VERCEL);
console.log('[Maersk] executablePath:', executablePath);

if (!executablePath) {
  throw new Error(
    `Chrome executable not found. Platform: ${process.platform}`
  );
}

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: browserArgs
});

const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/137.0.0.0 Safari/537.36',

  viewport: {
    width: 1280,
    height: 720
  }
});

const page = await context.newPage();

await page.addInitScript(() => {
  Object.defineProperty(
    navigator,
    'webdriver',
    {
      get: () => undefined
    }
  );
});