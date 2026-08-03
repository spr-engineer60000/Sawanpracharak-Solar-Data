/**
 * iSolarCloud realtime dashboard scraper
 * -------------------------------------------------------------
 * This script does NOT call any private/internal iSolarCloud API and does
 * NOT attempt to decrypt or replicate their encrypted gateway requests.
 * It simply opens the plant's shared dashboard URL in a real (headless)
 * browser -- the same way a person would in Chrome -- lets the page's own
 * JavaScript load and decrypt the data as normal, and then reads the
 * plain text that is visibly rendered on screen. That text is parsed with
 * regular expressions and forwarded to a Google Apps Script Web App,
 * which stores it in a Google Sheet for the dashboard to display.
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   ISOLAR_URL        - the full plant URL (the one with the long token)
 *   ISOLAR_USERNAME   - iSolarCloud account username (the page requires login)
 *   ISOLAR_PASSWORD   - iSolarCloud account password
 *   APPSCRIPT_URL     - the deployed Google Apps Script Web App URL
 *   WEBHOOK_SECRET    - shared secret string, must match Apps Script Script Property WEBHOOK_SECRET
 */

// Pull a number associated with a Thai/English label in the page's visible
// text. The page's card layout isn't consistent: some cards render
// "label\nvalue unit" (label first), others render "value\nlabel" (value
// first, e.g. the CO2/coal/trees cards). This tries both directions:
//   1) label immediately followed by NUMBER + unit  (most metrics)
//   2) NUMBER immediately preceding the label, no unit required (fallback,
//      used for the value-first cards)
// Handles thousands separators and optional leading minus sign either way.
const NUM = '([\\-+]?\\d[\\d,]*\\.?\\d*)';
const CONTEXT_CHARS = 120;

function extractNumber(text, label, unitRegexSrc) {
  const idx = text.indexOf(label);
  if (idx === -1) return null;

  const after = text.slice(idx + label.length, idx + label.length + CONTEXT_CHARS);
  const forwardMatch = after.match(new RegExp(NUM + '\\s*(?:' + unitRegexSrc + ')'));
  if (forwardMatch) {
    const n = parseFloat(forwardMatch[1].replace(/,/g, ''));
    if (!Number.isNaN(n)) return n;
  }

  const before = text.slice(Math.max(0, idx - CONTEXT_CHARS), idx);
  const backwardMatches = [...before.matchAll(new RegExp(NUM, 'g'))];
  if (backwardMatches.length) {
    const last = backwardMatches[backwardMatches.length - 1];
    const n = parseFloat(last[1].replace(/,/g, ''));
    if (!Number.isNaN(n)) return n;
  }

  return null;
}

// The flow-diagram's home/grid MW figures (bottom-left / bottom-right of the
// solar-panel-to-house-to-pylon diagram) have no text label next to them in
// the page's visible text -- unlike every other metric here, which sits next
// to a Thai label we can anchor on. As a best-effort fallback, we take the
// first two standalone "X.X MW" numbers on the page, in reading order.
// Confirmed against the live dashboard (2026-08-03): the first number in
// reading order is actually the GRID exchange figure, and the second is the
// home/hospital load -- opposite of the left-to-right visual guess this used
// to make. This is less reliable than the label-anchored fields above; treat
// these two values with more skepticism.
function extractFirstTwoMw(text) {
  const matches = [...text.matchAll(new RegExp(NUM + '\\s*MW(?!h)', 'g'))];
  const vals = matches.map((m) => parseFloat(m[1].replace(/,/g, ''))).filter((n) => !Number.isNaN(n));
  return { first: vals[0] ?? null, second: vals[1] ?? null };
}

function parseMetrics(text) {
  const { first: gridExchangeMw, second: homeLoadMw } = extractFirstTwoMw(text);
  return {
    // Current instantaneous PV power output
    pv_power_kw: extractNumber(text, 'กำลังไฟฟ้าแบบเรียลไทม์', 'kW'),
    // Nameplate / installed capacity
    installed_capacity_kwp: extractNumber(text, 'กำลังไฟฟ้าที่ติดตั้ง', 'kWp'),
    // Performance ratio
    pr_percent: extractNumber(text, 'PR โรงไฟฟ้า', '%'),
    // Today's energy balance / production / consumption / revenue
    energy_balance_mwh: extractNumber(text, 'การวิเคราะห์พลังงาน', 'MWh'),
    production_today: extractNumber(text, 'การผลิต', 'kWh|MWh'),
    consumption_today: extractNumber(text, 'การใช้พลังงาน', 'kWh|MWh'),
    net_revenue_thb: extractNumber(text, 'รายได้สุทธิ', 'บาท'),
    // Cumulative environmental benefit. The site renders "CO2" with a
    // Unicode subscript-2 (CO₂) in this card, unlike a plain "2" elsewhere,
    // so anchor on "การลด CO" without the digit to match either form.
    co2_reduction_ton: extractNumber(text, 'การลด CO', 'ตัน'),
    coal_saved_ton: extractNumber(text, 'บันทึกถ่านหินมาตรฐาน', 'ตัน'),
    trees_equivalent: extractNumber(text, 'ต้นไม้ที่ปลูกเทียบเท่า', 'ต้นไม้'),
    // Flow-diagram figures (best-effort, see extractFirstTwoMw above)
    home_load_mw: homeLoadMw,
    grid_exchange_mw: gridExchangeMw,
  };
}

// Dismiss the cookie-consent banner if it's showing, so it doesn't cover the
// login form or the dashboard. Safe to call even if the banner isn't present.
async function dismissCookieBanner(page) {
  try {
    const acceptBtn = page.getByText('ใช่ ฉันยอมรับ', { exact: true });
    await acceptBtn.click({ timeout: 5000 });
    console.log('Dismissed cookie banner.');
  } catch (e) {
    // Banner wasn't there / already dismissed -- fine.
  }
}

// The iSolarCloud link requires an active login session. On a fresh browser
// (like a GitHub Actions runner) it lands on the login page instead of the
// plant dashboard, so log in with the account credentials first.
async function loginIfNeeded(page, username, password) {
  const usernameField = page.getByPlaceholder('บัญชี');
  const isLoginPage = await usernameField.isVisible({ timeout: 8000 }).catch(() => false);

  if (!isLoginPage) {
    console.log('Already past login (session valid or login not required).');
    return;
  }

  console.log('Login page detected; signing in...');
  await usernameField.fill(username);
  await page.getByPlaceholder('รหัสผ่าน').fill(password);

  // Stay signed in a bit longer between runs, if the checkbox is present.
  await page.getByText('จดจำฉัน').click({ timeout: 3000 }).catch(() => {});

  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click({ timeout: 10000 });

  // Wait for the URL to move away from the login screen, i.e. login succeeded.
  try {
    await page.waitForFunction(
      () => !document.body.innerText.includes('รหัสผ่านบัญชี'),
      { timeout: 20000 }
    );
    console.log('Login submitted successfully.');
  } catch (e) {
    throw new Error(
      'Login did not complete within 20s -- wrong credentials, or the account requires ' +
      'extra verification (OTP/CAPTCHA) that this script cannot handle automatically.'
    );
  }
}

async function main() {
  const { chromium } = require('playwright');

  const ISOLAR_URL = process.env.ISOLAR_URL;
  const ISOLAR_USERNAME = process.env.ISOLAR_USERNAME;
  const ISOLAR_PASSWORD = process.env.ISOLAR_PASSWORD;
  const APPSCRIPT_URL = process.env.APPSCRIPT_URL;
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

  if (!ISOLAR_URL || !ISOLAR_USERNAME || !ISOLAR_PASSWORD || !APPSCRIPT_URL || !WEBHOOK_SECRET) {
    console.error('Missing required env vars: ISOLAR_URL, ISOLAR_USERNAME, ISOLAR_PASSWORD, APPSCRIPT_URL, WEBHOOK_SECRET');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'th-TH',
  });
  const page = await context.newPage();

  console.log('Opening iSolarCloud plant page...');
  await page.goto(ISOLAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await dismissCookieBanner(page);

  try {
    await loginIfNeeded(page, ISOLAR_USERNAME, ISOLAR_PASSWORD);
  } catch (loginErr) {
    // Save what the login screen actually looked like so it's easier to
    // tell wrong-password vs OTP/CAPTCHA vs something else entirely.
    await page.screenshot({ path: 'debug-screenshot.png', fullPage: true }).catch(() => {});
    const failText = await page.evaluate(() => document.body.innerText).catch(() => '');
    require('fs').writeFileSync('debug-innertext.txt', failText);
    await browser.close();
    throw loginErr;
  }

  // After logging in, the app may have redirected to a generic home page --
  // go back to the specific plant URL to make sure we land on the right page.
  console.log('Navigating to plant page again (post-login)...');
  await page.goto(ISOLAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissCookieBanner(page);

  // Wait for the overview labels to actually appear (data has rendered).
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('กำลังไฟฟ้าแบบเรียลไทม์'),
      { timeout: 45000 }
    );
  } catch (e) {
    console.warn('Timed out waiting for expected label text; continuing anyway.');
  }

  // Give charts / async widgets a little extra time to settle.
  await page.waitForTimeout(5000);

  const text = await page.evaluate(() => document.body.innerText);
  const metrics = parseMetrics(text);

  const payload = {
    secret: WEBHOOK_SECRET,
    timestamp: new Date().toISOString(),
    plant_name: 'Sawan Pracharak Hospital',
    ...metrics,
  };

  console.log('Extracted metrics:', JSON.stringify(metrics, null, 2));

  const missing = Object.entries(metrics).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) {
    console.warn('Warning: could not parse these fields (page layout may have changed):', missing.join(', '));
  }
  // home_load_mw / grid_exchange_mw are a best-effort, unlabeled heuristic
  // (see extractFirstTwoMw) -- don't let them alone trip the failure check.
  const criticalMissing = missing.filter((k) => k !== 'home_load_mw' && k !== 'grid_exchange_mw');

  console.log('Posting to Apps Script webhook...');
  const res = await fetch(APPSCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const resText = await res.text();
  console.log('Webhook response status:', res.status);
  console.log('Webhook response body:', resText.slice(0, 500));

  if (!res.ok) {
    // Save a screenshot + full text dump as build artifacts to help debugging.
    await page.screenshot({ path: 'debug-screenshot.png', fullPage: true }).catch(() => {});
    require('fs').writeFileSync('debug-innertext.txt', text);
    await browser.close();
    process.exit(1);
  }

  // Data was posted successfully, but if too many fields failed to parse the
  // page layout may have changed -- flag the run so it's visible in the
  // Actions tab, and save debug artifacts to help fix the regex patterns.
  if (criticalMissing.length > 3) {
    await page.screenshot({ path: 'debug-screenshot.png', fullPage: true }).catch(() => {});
    require('fs').writeFileSync('debug-innertext.txt', text);
    await browser.close();
    console.error(`${criticalMissing.length} of ${Object.keys(metrics).length} fields failed to parse; see debug artifacts.`);
    process.exit(1);
  }

  await browser.close();
}

module.exports = { extractNumber, parseMetrics };

if (require.main === module) {
  main().catch((err) => {
    console.error('Scraper failed:', err);
    process.exit(1);
  });
}
