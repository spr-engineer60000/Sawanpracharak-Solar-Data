/**
 * Sawan Pracharak Hospital - Solar Dashboard (Apps Script backend)
 * -----------------------------------------------------------------
 * Two entry points:
 *   doPost(e)  - webhook that receives scraped metrics (JSON body) from the
 *                GitHub Actions scraper and appends them to the "History" sheet.
 *   doGet(e)   - serves the dashboard web page. Add ?format=json to instead
 *                get the latest reading + recent history as JSON (used by
 *                the dashboard page itself for auto-refresh, and handy for
 *                testing in a browser).
 *
 * One-time setup (see SETUP.md for full instructions):
 *   1. Create/open a Google Sheet, Extensions > Apps Script.
 *   2. Paste this file as Code.gs, and Dashboard.html as a separate HTML file.
 *   3. Project Settings > Script Properties > add WEBHOOK_SECRET = <same
 *      value you put in the GitHub secret WEBHOOK_SECRET>.
 *   4. Deploy > New deployment > Web app. Execute as "Me", Access "Anyone".
 *   5. Copy the Web app URL into the GitHub secret APPSCRIPT_URL.
 */

const SHEET_NAME = 'History';
const MAX_HISTORY_ROWS_FOR_CHART = 288; // ~24h of data at 5-minute intervals
const TIMEZONE = 'Asia/Bangkok';

const COLUMNS = [
  'timestamp',
  'plant_name',
  'pv_power_kw',
  'installed_capacity_kwp',
  'pr_percent',
  'energy_balance_mwh',
  'production_today',
  'consumption_today',
  'net_revenue_thb',
  'co2_reduction_ton',
  'coal_saved_ton',
  'trees_equivalent',
  'home_load_mw',
  'grid_exchange_mw',
  // Appended at the end (not next to 'timestamp') on purpose -- new columns
  // must always go at the end so existing rows' column positions don't
  // shift (see getOrCreateSheet_ below). This is purely a human-readable
  // mirror of 'timestamp' for anyone opening the Sheet directly -- e.g.
  // "4 ส.ค. 2569 20:18:24 น." instead of "2026-08-04T13:18:24.243Z". All
  // date-based logic in this file (dateKey_, dayPoints_, month/year rollups,
  // etc.) keeps reading the raw 'timestamp' column, unaffected by this.
  'timestamp_readable',
];

const THAI_MONTHS_ = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

// "4 ส.ค. 2569 20:18:24 น." -- day, Thai month abbreviation, Buddhist-era
// year (Gregorian + 543, matching how the Dashboard page itself already
// displays dates client-side via toLocaleDateString('th-TH', ...)), 24-hour
// time, all in Asia/Bangkok local time regardless of what timezone the
// scraper's machine (a GitHub Actions runner, UTC) sent the raw ISO
// timestamp in.
function formatThaiTimestamp_(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const day = Utilities.formatDate(d, TIMEZONE, 'd');
  const monthIdx = Number(Utilities.formatDate(d, TIMEZONE, 'M')) - 1;
  const buddhistYear = Number(Utilities.formatDate(d, TIMEZONE, 'yyyy')) + 543;
  const time = Utilities.formatDate(d, TIMEZONE, 'HH:mm:ss');
  return day + ' ' + THAI_MONTHS_[monthIdx] + ' ' + buddhistYear + ' ' + time + ' น.';
}

function getOrCreateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS.map((c) => c));
    sheet.setFrozenRows(1);
    return sheet;
  }
  // Sheet already existed (e.g. from before home_load_mw/grid_exchange_mw
  // were added) -- extend the header row in place so new columns get labels.
  const existingCols = sheet.getLastColumn();
  if (existingCols < COLUMNS.length) {
    sheet
      .getRange(1, existingCols + 1, 1, COLUMNS.length - existingCols)
      .setValues([COLUMNS.slice(existingCols)]);
  }
  return sheet;
}

function doPost(e) {
  try {
    const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    const body = JSON.parse(e.postData.contents);

    if (!secret || body.secret !== secret) {
      return jsonResponse_({ ok: false, error: 'unauthorized' }, 401);
    }

    const sheet = getOrCreateSheet_();
    const resolvedTimestamp = body.timestamp || new Date().toISOString();
    const row = COLUMNS.map((col) => {
      if (col === 'timestamp') return resolvedTimestamp;
      if (col === 'timestamp_readable') return formatThaiTimestamp_(resolvedTimestamp);
      return body[col] !== undefined ? body[col] : '';
    });
    sheet.appendRow(row);

    return jsonResponse_({ ok: true });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) }, 500);
  }
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.format === 'json') {
    return jsonResponse_(buildDashboardData_());
  }
  if (params.format === 'chart') {
    return jsonResponse_(buildChartData_(params));
  }
  const template = HtmlService.createTemplateFromFile('Dashboard');
  return template
    .evaluate()
    .setTitle('Sawan Pracharak Hospital - Solar Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Public wrapper callable from the client-side dashboard via
 * google.script.run.getDashboardDataForClient().
 */
function getDashboardDataForClient() {
  return buildDashboardData_();
}

/**
 * Public wrapper for the day/month/year chart data, callable via
 * google.script.run.getChartDataForClient({view, date, year, month}).
 * See buildChartData_() for the params shape.
 */
function getChartDataForClient(params) {
  return buildChartData_(params || {});
}

function buildDashboardData_() {
  const sheet = getOrCreateSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { latest: null, history: [] };
  }

  const startRow = Math.max(2, lastRow - MAX_HISTORY_ROWS_FOR_CHART + 1);
  const numRows = lastRow - startRow + 1;
  const values = sheet.getRange(startRow, 1, numRows, COLUMNS.length).getValues();

  const history = values.map((row) => rowToObject_(row));
  const latest = history[history.length - 1];

  return { latest, history };
}

/**
 * Historical chart data for the "วัน / เดือน / ปี" (day / month / year) tabs.
 * params:
 *   view = 'day'   + date  ('yyyy-MM-dd', defaults to today, Asia/Bangkok)
 *          -> per-reading PV/grid/load power series for that one day
 *   view = 'month' + year, month (1-12, defaults to current)
 *          -> per-day total production (kWh) for that month
 *   view = 'year'  + year (defaults to current)
 *          -> per-month total production (kWh) for that year
 *
 * NOTE: this reads the whole History sheet every call. Fine for the data
 * volumes a single-plant 5-minute scrape produces over a year or two; if the
 * sheet grows very large, consider maintaining a separate daily-rollup sheet
 * instead of scanning raw rows here.
 */
function buildChartData_(params) {
  const view = params.view || 'day';
  const sheet = getOrCreateSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { view: view, points: [] };

  const numRows = lastRow - 1;
  const rows = sheet.getRange(2, 1, numRows, COLUMNS.length).getValues().map(rowToObject_);

  if (view === 'month') return buildMonthChart_(rows, params);
  if (view === 'year') return buildYearChart_(rows, params);
  return buildDayChart_(rows, params);
}

// Builds the point list for one calendar day, carrying every field the
// client-side charts (balance / production / consumption / revenue -- see
// Dashboard.html's chartState.mode) might need to plot, so a single request
// covers all four summary-card chart views without extra round-trips.
function dayPoints_(rows, date) {
  return rows
    .filter(function (r) { return dateKey_(r.timestamp) === date; })
    .map(function (r) {
      return {
        timestamp: toIso_(r.timestamp),
        pv_power_kw: r.pv_power_kw,
        grid_exchange_mw: r.grid_exchange_mw,
        home_load_mw: r.home_load_mw,
        production_today: r.production_today,
        consumption_today: r.consumption_today,
        net_revenue_thb: r.net_revenue_thb,
        energy_balance_mwh: r.energy_balance_mwh,
      };
    });
}

function buildDayChart_(rows, params) {
  const date = params.date || Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  const points = dayPoints_(rows, date);

  // Also return the previous calendar day's points, time-aligned by
  // "HH:mm", so the production/consumption/revenue chart views can draw a
  // "เมื่อวาน" (yesterday) comparison line the same way the source site does
  // -- without a second round-trip from the client.
  const prevDate = Utilities.formatDate(
    new Date(new Date(date + 'T00:00:00').getTime() - 24 * 60 * 60 * 1000),
    TIMEZONE,
    'yyyy-MM-dd'
  );
  const prevPoints = dayPoints_(rows, prevDate);

  // Summary for the SELECTED day (not always "today") -- the running-total
  // fields (energy_balance_mwh, production_today, consumption_today,
  // net_revenue_thb) reset each day, so the day's last reading approximates
  // its final total, same logic dailyProductionTotals_() already uses for
  // the month/year rollups. Lets the client show that day's own totals in
  // the summary-bar cards when browsing history via the date picker,
  // instead of always showing whatever today's live reading happens to be.
  const daySummary = points.length ? points[points.length - 1] : null;

  return { view: 'day', date: date, points: points, prevDate: prevDate, prevPoints: prevPoints, daySummary: daySummary };
}

function buildMonthChart_(rows, params) {
  const year = parseInt(params.year, 10) || currentYear_();
  const month = parseInt(params.month, 10) || currentMonth_();
  const prefix = year + '-' + pad2_(month);
  const byDay = dailyProductionTotals_(rows, prefix);
  const points = Object.keys(byDay)
    .sort()
    .map(function (key) { return { label: key.slice(8, 10), production_kwh: byDay[key] }; });
  return { view: 'month', year: year, month: month, points: points };
}

function buildYearChart_(rows, params) {
  const year = parseInt(params.year, 10) || currentYear_();
  const byDay = dailyProductionTotals_(rows, String(year));
  const byMonth = {};
  Object.keys(byDay).forEach(function (key) {
    const month = key.slice(5, 7);
    byMonth[month] = (byMonth[month] || 0) + byDay[key];
  });
  const points = Object.keys(byMonth)
    .sort()
    .map(function (month) { return { label: month, production_kwh: byMonth[month] }; });
  return { view: 'year', year: year, points: points };
}

// Groups rows by calendar day (yyyy-MM-dd) whose key starts with keyPrefix,
// taking the MAX production_today seen per day -- since that field is a
// running total through the day, its last/highest reading approximates the
// day's final production total.
function dailyProductionTotals_(rows, keyPrefix) {
  const byDay = {};
  rows.forEach(function (r) {
    const key = dateKey_(r.timestamp);
    if (key.indexOf(keyPrefix) !== 0) return;
    const val = Number(r.production_today);
    if (Number.isNaN(val)) return;
    if (!(key in byDay) || val > byDay[key]) byDay[key] = val;
  });
  return byDay;
}

function dateKey_(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}

function toIso_(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toISOString();
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function currentYear_() { return Number(Utilities.formatDate(new Date(), TIMEZONE, 'yyyy')); }
function currentMonth_() { return Number(Utilities.formatDate(new Date(), TIMEZONE, 'M')); }

function rowToObject_(row) {
  const obj = {};
  COLUMNS.forEach((col, i) => {
    obj[col] = row[i];
  });
  return obj;
}

function jsonResponse_(obj, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * Convenience function: run this once manually from the Apps Script editor
 * (select it in the toolbar dropdown and click Run) to set your webhook
 * secret without needing to click through Project Settings.
 * Change YOUR_SECRET_HERE, run it once, then you can delete the line.
 */
function setup_setWebhookSecret() {
  const YOUR_SECRET_HERE = 'sawan-solar-2569';
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET', YOUR_SECRET_HERE);
  Logger.log('Webhook secret saved.');
}

// ---------------------------------------------------------------------
// Backup scheduler for the scraper.
//
// GitHub's own `schedule:` cron trigger on scrape.yml turned out to be
// unreliable in practice: it eventually started firing on its own, but
// only every few hours instead of every 15 minutes as configured -- a
// known best-effort limitation of GitHub Actions schedules under load,
// not something fixable from the workflow file itself.
//
// This calls GitHub's REST API (workflow_dispatch) directly from an Apps
// Script time-driven trigger instead, so the *actual* 15-minute cadence
// is driven by Google's own scheduler rather than GitHub's. Runs
// alongside GitHub's native schedule -- if both happen to fire close
// together that's harmless, just a slightly earlier/extra data point.
//
// One-time setup (see SETUP.md):
//   1. Run setup_setGithubPat() once with your token pasted in.
//   2. In the Apps Script editor: Triggers (clock icon) > Add Trigger >
//      function triggerGitHubScrape_ > Time-driven > Minutes timer >
//      Every 15 minutes > Save.
// ---------------------------------------------------------------------
const GITHUB_OWNER = 'spr-engineer60000';
const GITHUB_REPO = 'Sawanpracharak-Solar-Data';
const GITHUB_WORKFLOW_FILE = 'scrape.yml';
const GITHUB_BRANCH = 'main';

function triggerGitHubScrape_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_PAT');
  if (!token) {
    Logger.log('triggerGitHubScrape_: no GITHUB_PAT script property set -- skipping. Run setup_setGithubPat() first.');
    return;
  }
  const url =
    'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO +
    '/actions/workflows/' + GITHUB_WORKFLOW_FILE + '/dispatches';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
    },
    payload: JSON.stringify({ ref: GITHUB_BRANCH }),
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  // 204 No Content = GitHub accepted the dispatch. Anything else is worth
  // surfacing -- shows up under "Executions" in the Apps Script editor if
  // this ever starts failing silently (e.g. the token expired/was revoked,
  // or the repo/workflow name changed).
  if (code !== 204) {
    Logger.log('triggerGitHubScrape_: unexpected response ' + code + ': ' + response.getContentText());
  }
}

/**
 * Convenience function: run this once manually (select it in the toolbar
 * dropdown, click Run) to store your GitHub Personal Access Token without
 * needing to click through Project Settings. Change YOUR_TOKEN_HERE, run
 * it once, then you can delete the line (the token stays saved either way).
 *
 * Needs a Fine-grained PAT scoped to ONLY the Sawanpracharak-Solar-Data
 * repo, with just the "Actions: Read and write" repository permission --
 * see SETUP.md for exact steps to create one.
 */
function setup_setGithubPat() {
  const YOUR_TOKEN_HERE = 'paste-your-github_pat_xxx-token-here';
  PropertiesService.getScriptProperties().setProperty('GITHUB_PAT', YOUR_TOKEN_HERE);
  Logger.log('GitHub PAT saved.');
}
