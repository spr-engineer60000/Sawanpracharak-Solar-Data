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
];

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
    const row = COLUMNS.map((col) => {
      if (col === 'timestamp') return body.timestamp || new Date().toISOString();
      return body[col] !== undefined ? body[col] : '';
    });
    sheet.appendRow(row);

    return jsonResponse_({ ok: true });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) }, 500);
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.format === 'json') {
    return jsonResponse_(buildDashboardData_());
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
