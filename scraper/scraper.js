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
// first, e.g. the CO2/coal/trees cards). This tries both directions, both
// ANCHORED to sit immediately adjacent to the label (only whitespace in
// between), tried against every occurrence of `label` in the text in turn:
//   1) label immediately followed by NUMBER + unit  (most metrics)
//   2) NUMBER immediately preceding the label, no unit required (fallback,
//      used for the value-first cards, where the unit is embedded in the
//      label text itself, e.g. "การลด CO₂ (ตัน)")
// Handles thousands separators and optional leading minus sign either way.
//
// This used to be a much looser, unanchored scan of the whole
// CONTEXT_CHARS window on both sides, which caused a real production bug:
// at night this plant's real-time PV power genuinely renders as no numeric
// text at all (it isn't producing, so there's nothing to show -- see
// pv_power_kw's night-default below), and the old forward scan would just
// keep walking past that empty space until it found the NEXT card's
// number instead -- e.g. matching "999.66" from "กำลังไฟฟ้าที่ติดตั้ง
// 999.66 kWp" (installed capacity) as if it were the real-time "kW"
// reading, because the unit check for "kW" wasn't given a boundary and so
// also matched as a prefix of "kWp". The old backward fallback was worse:
// it accepted ANY number found up to 120 characters back with no adjacency
// or unit check at all, so on any field whose value was momentarily
// missing it could just as easily grab an unrelated number from a
// completely different card. Anchoring both directions to "immediately
// adjacent" removes both ambiguities, and the negative lookahead after the
// unit stops a short unit (like "kW") from matching as a prefix of a
// longer one (like "kWp").
const NUM = '([\\-+]?\\d[\\d,]*\\.?\\d*)';
const CONTEXT_CHARS = 120;

function extractNumber(text, label, unitRegexSrc) {
  const unit = '(?:' + unitRegexSrc + ')(?![a-zA-Zก-๙])';
  const forwardRe = new RegExp('^\\s*' + NUM + '\\s*' + unit);
  const backwardRe = new RegExp(NUM + '\\s*$');
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(label, searchFrom);
    if (idx === -1) return null;

    const after = text.slice(idx + label.length, idx + label.length + CONTEXT_CHARS);
    const fwd = after.match(forwardRe);
    if (fwd) {
      const n = parseFloat(fwd[1].replace(/,/g, ''));
      if (!Number.isNaN(n)) return n;
    }

    const before = text.slice(Math.max(0, idx - CONTEXT_CHARS), idx);
    const bwd = before.match(backwardRe);
    if (bwd) {
      const n = parseFloat(bwd[1].replace(/,/g, ''));
      if (!Number.isNaN(n)) return n;
    }

    searchFrom = idx + label.length;
  }
}

// The flow-diagram's home/grid MW figures (bottom-left / bottom-right of the
// solar-panel-to-house-to-pylon diagram) have no text label next to them in
// the page's visible text -- unlike every other metric here, which sits next
// to a Thai label we can anchor on. LAST-RESORT fallback only: take the
// first two standalone "X.X MW" numbers in document.body.innerText reading
// order. This turned out to be unreliable in practice -- which value comes
// first in the flattened text does not consistently match which one is
// visually home vs grid, so this has been wrong in both directions at
// different times. main() now prefers extractHomeGridMwFromDom() (anchored
// on actual on-screen left/right position) and only falls back to this
// text-order guess if that fails. Treat this fallback's output with real
// skepticism.
function extractFirstTwoMw(text) {
  const matches = [...text.matchAll(new RegExp(NUM + '\\s*MW(?!h)', 'g'))];
  const vals = matches.map((m) => parseFloat(m[1].replace(/,/g, ''))).filter((n) => !Number.isNaN(n));
  return { first: vals[0] ?? null, second: vals[1] ?? null };
}

// Anchored variant of extractNumber(), for metrics whose unit isn't fixed
// (see extractNumberNormalized below). extractNumber()'s forward match scans
// the *whole* CONTEXT_CHARS window after the label for the first NUM+unit
// occurrence -- fine when the unit pattern covers every unit that value
// could ever render in, but if a caller only searches for e.g. "kWh" and
// the number actually rendered as "MWh" this time, that loose scan walks
// straight past it and can latch onto a completely different label's "kWh"
// value later in the window. Anchoring the match to *immediately* after the
// label (only whitespace in between) avoids that ambiguity, and reports
// which unit token was actually found alongside the number.
//
// If the label's FIRST occurrence in the page text isn't immediately
// followed by a number (e.g. it's also a substring of some other heading or
// menu text elsewhere on the page, appearing earlier in reading order than
// the actual metric card), an anchored match against only that first
// occurrence would find nothing and wrongly return null -- so this tries
// every occurrence of the label in turn until one is immediately followed
// by a NUM+unit match.
function extractNumberAndUnit(text, label, unitRegexSrc) {
  const re = new RegExp('^\\s*' + NUM + '\\s*(' + unitRegexSrc + ')');
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(label, searchFrom);
    if (idx === -1) return null;
    const after = text.slice(idx + label.length, idx + label.length + CONTEXT_CHARS);
    const m = after.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!Number.isNaN(n)) return { value: n, unit: m[2] };
    }
    searchFrom = idx + label.length;
  }
}

// The site auto-switches "การผลิต" (production_today) and "การใช้พลังงาน"
// (consumption_today) between kWh and MWh depending on magnitude at scrape
// time -- e.g. "697.3 kWh" early in the day vs "1.5 MWh" later once it
// crosses 1 MWh. The old extractNumber(text, label, 'kWh|MWh') call only
// captured the number, not which unit token actually matched, so whenever
// the site rendered "MWh" the raw number got treated as if it were 1000x
// smaller than it really is (e.g. "1.5 MWh" stored as 1.5 instead of 1500),
// which is why production_today showed up as ~0 after Dashboard.html divides
// it by 1000. This finds whichever unit was actually rendered (via the
// anchored extractNumberAndUnit above) and normalizes it back to a single
// fixed base unit -- 'kWh' for production_today, 'MWh' for consumption_today,
// matching what Dashboard.html already expects each field to be stored in --
// so the displayed value is correct regardless of which unit the page used.
function extractNumberNormalized(text, label, nativeUnit) {
  const found = extractNumberAndUnit(text, label, 'kWh|MWh');
  if (!found) return null;
  const valueInKwh = /mwh/i.test(found.unit) ? found.value * 1000 : found.value;
  return nativeUnit === 'kWh' ? valueInKwh : valueInKwh / 1000;
}

// Real-time PV power and PR are the two figures on this page that
// genuinely go to (or near) 0 overnight -- there is no sunlight, so there
// is nothing to produce, and the site sometimes renders no numeric text at
// all for them in that state rather than literally "0". Physically, PV
// output also can never legitimately reach/exceed the plant's own
// installed (nameplate) capacity -- confirmed by the plant owner ("at
// night solar can't produce, should be 0"). So: if extraction comes back
// empty, or comes back implausibly high (>= installed capacity, or PR way
// past 100%), treat it as "not producing" and report 0 rather than either
// null or a clearly-wrong number.
function resolvePvPowerKw_(rawPvPowerKw, installedCapacityKwp) {
  if (rawPvPowerKw === null) return 0;
  if (typeof installedCapacityKwp === 'number' && rawPvPowerKw >= installedCapacityKwp) return 0;
  return rawPvPowerKw;
}
function resolvePrPercent_(rawPrPercent) {
  if (rawPrPercent === null) return 0;
  if (rawPrPercent > 105) return 0; // small headroom above 100% for rounding; anything past that is a bad parse
  return rawPrPercent;
}

function parseMetrics(text) {
  const { first: homeLoadMw, second: gridExchangeMw } = extractFirstTwoMw(text);
  const installedCapacityKwp = extractNumber(text, 'กำลังไฟฟ้าที่ติดตั้ง', 'kWp');
  return {
    // Current instantaneous PV power output
    pv_power_kw: resolvePvPowerKw_(extractNumber(text, 'กำลังไฟฟ้าแบบเรียลไทม์', 'kW'), installedCapacityKwp),
    // Nameplate / installed capacity
    installed_capacity_kwp: installedCapacityKwp,
    // Performance ratio
    pr_percent: resolvePrPercent_(extractNumber(text, 'PR โรงไฟฟ้า', '%')),
    // Today's energy balance / production / consumption / revenue
    energy_balance_mwh: extractNumber(text, 'การวิเคราะห์พลังงาน', 'MWh'),
    production_today: extractNumberNormalized(text, 'การผลิต', 'kWh'),
    consumption_today: extractNumberNormalized(text, 'การใช้พลังงาน', 'MWh'),
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

// Resolve the home/grid MW figures. Two earlier versions of this tried to
// infer which value is which from where they render on screen (first exact
// text order, then "leftmost = home, rightmost = grid" DOM position) -- both
// turned out to be unreliable: real side-by-side screenshots taken only ~3
// minutes apart, of an essentially unchanged real-world state, came back
// with the two values on OPPOSITE sides between one scrape and the next. So
// on-screen position for this pair just isn't a stable signal at all --
// don't use it for the assignment (only for finding the right *pair* of
// numbers among any other stray "X.X MW" text on the page).
//
// Instead, use basic energy balance, which the plant owner confirmed
// directly: this plant has no battery/export, so everything the hospital
// draws (home load) comes from PV generation plus grid import --
// i.e. pv_power + grid_exchange should equal home_load (equivalently, the
// dashboard's "PV/โหลด %" and "กริด/โหลด %" ratios should sum to ~100%, and
// grid_exchange should always be smaller than home_load). Given the two
// candidate readouts, try both possible (home, grid) assignments and keep
// whichever one actually balances -- that's a physical constraint, not a
// guess, so it's stable regardless of how the page happens to lay things out.
async function extractHomeGridMwFromDom(page, pvPowerKw) {
  try {
    const found = await page.evaluate(() => {
      const re = /^-?[\d,]*\.?\d+\s*MW$/; // standalone "X.X MW", not "MWh"

      // Real debug-innertext.txt from the live site shows these readouts as
      // e.g. "3.9MW" with NO space before the unit -- a strong sign the
      // number and the "MW" unit sit in two separate sibling elements (e.g.
      // a bold value span next to a smaller/greyed unit span) rather than
      // one single text node, since that's exactly the pattern you get when
      // adjacent inline elements have no whitespace between them in the
      // source HTML. A plain TreeWalker over individual TEXT nodes (the
      // previous approach) can NEVER match a pattern that requires both the
      // digits and the unit together when they live in different nodes --
      // each node only ever contains half the string -- so it silently
      // found fewer than 2 matches and fell back to the much less reliable
      // extractFirstTwoMw() text-order guess. That fallback is what
      // actually produced a wrong home/grid assignment despite this
      // function's balance logic being correct: the balance logic never
      // ran at all.
      //
      // Fix: scan every ELEMENT (not text node) by its rendered innerText,
      // which correctly reflects the combined text of a number-span next to
      // a unit-span the same way a human eye reading the page would. Keep
      // only matching elements with no matching descendant, so a wrapper
      // that merely contains a number-span and a unit-span is kept (it's
      // the smallest element whose own text satisfies the full pattern),
      // while both an over-broad ancestor and the correct wrapper matching
      // together don't produce duplicate/nested entries.
      const candidates = Array.from(document.querySelectorAll('body *')).filter((el) => {
        const t = (el.innerText || el.textContent || '').trim();
        return t && re.test(t);
      });
      const leaves = candidates.filter(
        (el) => !candidates.some((other) => other !== el && el.contains(other))
      );
      const results = [];
      leaves.forEach((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        results.push({ text: text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      });
      return results;
    });

    if (found.length < 2) return null;

    // Still cluster by Y first, to throw out any stray "X.X MW" text
    // elsewhere on the page (e.g. an inline label along the connecting
    // line) and keep only the row the two big home/grid readouts sit in.
    const Y_TOLERANCE = 20; // px; matches within this band count as the same row
    const byY = [...found].sort((a, b) => b.y - a.y); // bottommost first
    const bottomY = byY[0].y;
    const cluster = byY.filter((f) => Math.abs(f.y - bottomY) <= Y_TOLERANCE);
    if (cluster.length < 2) return null;

    const parse = (s) => parseFloat(s.replace(/MW/i, '').replace(/,/g, '').trim());
    const values = cluster.map((c) => parse(c.text)).filter((n) => !Number.isNaN(n));
    if (values.length < 2) return null;

    // If more than 2 values somehow land in that row, the two extremes are
    // still the most likely candidates for the real readouts.
    const a = values.length === 2 ? values[0] : Math.max(...values);
    const b = values.length === 2 ? values[1] : Math.min(...values);

    const pvMw = typeof pvPowerKw === 'number' && !Number.isNaN(pvPowerKw) ? pvPowerKw / 1000 : 0;
    const optionA = { homeLoadMw: a, gridExchangeMw: b };
    const optionB = { homeLoadMw: b, gridExchangeMw: a };
    const residual = (opt) => Math.abs(pvMw + opt.gridExchangeMw - opt.homeLoadMw);
    return residual(optionA) <= residual(optionB) ? optionA : optionB;
  } catch (e) {
    return null;
  }
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

  // Prefer resolving home/grid MW by energy balance (pv + grid ~= load) --
  // see extractHomeGridMwFromDom() above. This overrides the text-order
  // guess already in `metrics` when it succeeds; the text-order guess only
  // stays as a fallback for when the DOM read fails outright.
  const domHomeGrid = await extractHomeGridMwFromDom(page, metrics.pv_power_kw);
  if (domHomeGrid) {
    metrics.home_load_mw = domHomeGrid.homeLoadMw;
    metrics.grid_exchange_mw = domHomeGrid.gridExchangeMw;
    console.log('Resolved home/grid MW by energy balance:', domHomeGrid);
  } else {
    console.warn('Could not resolve home/grid MW by energy balance; using less-reliable text-order guess instead.');
  }

  // Always save a screenshot + full text dump, even on success -- this is
  // the ONLY way to see exactly what the page rendered for a given run
  // without waiting for an outright failure (the pass/fail check below only
  // trips on >3 missing *critical* fields, so a single silently-wrong field
  // like production_today never triggered a debug upload before, which is
  // why misparses like that took several guess-and-check rounds to fix).
  // Kept small/overwritten every run rather than versioned.
  await page.screenshot({ path: 'debug-screenshot.png', fullPage: true }).catch(() => {});
  require('fs').writeFileSync('debug-innertext.txt', text);

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
    // debug-screenshot.png / debug-innertext.txt were already written above.
    await browser.close();
    process.exit(1);
  }

  // Data was posted successfully, but if too many fields failed to parse the
  // page layout may have changed -- flag the run so it's visible in the
  // Actions tab. debug-screenshot.png / debug-innertext.txt were already
  // written above either way.
  if (criticalMissing.length > 3) {
    await browser.close();
    console.error(`${criticalMissing.length} of ${Object.keys(metrics).length} fields failed to parse; see debug artifacts.`);
    process.exit(1);
  }

  await browser.close();
}

module.exports = { extractNumber, parseMetrics, extractHomeGridMwFromDom };

if (require.main === module) {
  main().catch((err) => {
    console.error('Scraper failed:', err);
    process.exit(1);
  });
}
