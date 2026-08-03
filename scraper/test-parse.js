const { parseMetrics } = require('./scraper.js');

// Usage: node test-parse.js [path-to-debug-innertext.txt]
// If a file path is given (e.g. the debug-innertext.txt artifact downloaded
// from a failed GitHub Actions run), this just prints what would be parsed
// from it -- handy for checking a real capture without needing Playwright.
const fileArg = process.argv[2];
if (fileArg) {
  const text = require('fs').readFileSync(fileArg, 'utf8');
  console.log(JSON.stringify(parseMetrics(text), null, 2));
  process.exit(0);
}

// Simulated innerText, modeled on the two screenshots the user shared.
// Label-first cards (top overview + energy summary bar) and
// value-first cards (CO2 reduction section) are both represented.
const sampleText = `
Sawan Pracharak Hospital
สถานะ
ปกติ
528 kW

กำลังไฟฟ้าแบบเรียลไทม์
328
kW
กำลังไฟฟ้าที่ติดตั้ง
999.66
kWp
PR โรงไฟฟ้า
90
%

การวิเคราะห์พลังงาน
-17.8
MWh
การผลิต
697.3
kWh
การใช้พลังงาน
18.5
MWh
รายได้สุทธิ
2,928.66
บาท

การลดการปล่อยไอเสีย
5,249.85
การลด CO2 (ตัน)
2,127.32
บันทึกถ่านหินมาตรฐาน (ตัน)
286,642
ต้นไม้ที่ปลูกเทียบเท่า (ต้นไม้)
`;

const result = parseMetrics(sampleText);
console.log(JSON.stringify(result, null, 2));

const expected = {
  pv_power_kw: 328,
  installed_capacity_kwp: 999.66,
  pr_percent: 90,
  energy_balance_mwh: -17.8,
  production_today: 697.3,
  consumption_today: 18.5,
  net_revenue_thb: 2928.66,
  co2_reduction_ton: 5249.85,
  coal_saved_ton: 2127.32,
  trees_equivalent: 286642,
};

let failures = 0;
for (const [key, expectedVal] of Object.entries(expected)) {
  const actual = result[key];
  if (actual !== expectedVal) {
    console.error(`MISMATCH ${key}: expected ${expectedVal}, got ${actual}`);
    failures++;
  }
}

if (failures === 0) {
  console.log('\nAll fields matched expected values. ✅');
  process.exit(0);
} else {
  console.error(`\n${failures} field(s) mismatched. ❌`);
  process.exit(1);
}
