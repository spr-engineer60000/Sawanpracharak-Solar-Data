# วิธีติดตั้ง Dashboard แสดงผลข้อมูลโซลาร์แบบ Real-time (Sawan Pracharak Hospital)

ระบบนี้ทำงาน 3 ส่วนต่อกัน:

1. **GitHub Actions** — เปิดหน้าเว็บ iSolarCloud ที่คุณให้ลิงก์มา ด้วย headless browser ทุก 5 นาที แล้วอ่านค่าตัวเลขที่แสดงผลบนจอ (เหมือนคนเปิดดูเอง ไม่ได้ยิง API ตรง)
2. **Google Apps Script (Web App)** — รับข้อมูลที่ส่งมา บันทึกลง Google Sheet
3. **หน้า Dashboard** — เป็นหน้าเว็บที่ Apps Script เสิร์ฟให้ อัปเดตอัตโนมัติทุก 30 วินาที

ทำตามลำดับ 2 ขั้นตอนใหญ่ด้านล่างนี้ครับ (ทำ Apps Script ก่อน เพราะต้องใช้ URL ของมันไปใส่ใน GitHub)

---

## ขั้นตอนที่ 1: ตั้งค่า Google Apps Script

1. ไปที่ [sheets.google.com](https://sheets.google.com) สร้าง Google Sheet ใหม่ (ตั้งชื่อเช่น "Sawan Solar Data")
2. เมนู **ส่วนขยาย (Extensions) → Apps Script**
3. จะเห็นไฟล์ `Code.gs` เปล่าๆ อยู่แล้ว — ลบโค้ดเดิมทิ้ง แล้ว copy เนื้อหาทั้งหมดจากไฟล์ `apps-script/Code.gs` ที่แนบมา วางแทน
4. เพิ่มไฟล์ HTML: คลิก **+** ข้าง "Files" → **HTML** → ตั้งชื่อไฟล์ว่า `Dashboard` (สำคัญ: ต้องชื่อ `Dashboard` ให้ตรงกับที่โค้ดอ้างถึง) → copy เนื้อหาจากไฟล์ `apps-script/Dashboard.html` วางแทนเนื้อหา default
5. ตั้งค่า secret key: ในไฟล์ `Code.gs` เลื่อนไปด้านล่างสุด หาฟังก์ชัน `setup_setWebhookSecret()` แก้ข้อความ `change-me-to-a-random-string` เป็นรหัสลับที่คุณตั้งเอง (ตัวอย่าง: `sawan-solar-8x92kf`) — **จดรหัสนี้ไว้** จะต้องใช้อีกครั้งใน GitHub
6. เลือกฟังก์ชัน `setup_setWebhookSecret` จาก dropdown ด้านบน (ข้าง Debug) แล้วกด **Run** (▶) หนึ่งครั้ง เพื่อบันทึกรหัสลับ (ครั้งแรกจะขอ authorize สิทธิ์ — กด Allow)
7. **Deploy → New deployment**
   - Select type (ไอคอนเฟือง) → **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - กด **Deploy**
8. จะได้ **Web app URL** (ขึ้นต้นด้วย `https://script.google.com/macros/s/.../exec`) — **copy เก็บไว้** จะใช้ในขั้นตอนถัดไป
9. ทดสอบ: เปิด URL นั้นในเบราว์เซอร์ ควรเห็นหน้า Dashboard เปล่าๆ (ยังไม่มีข้อมูลเพราะยังไม่มี GitHub Actions รันเข้ามา) ถ้าเห็นหน้าเว็บแสดงว่าตั้งค่าถูกต้อง

---

## ขั้นตอนที่ 2: ตั้งค่า GitHub Actions

1. สร้าง repository ใหม่บน GitHub — ตั้งเป็น **Public** (จำเป็น เพื่อให้ Actions รันได้ไม่จำกัดนาทีฟรี เพราะเรารันทุก 5 นาทีทั้งวัน ถ้าเป็น private จะใช้โควตาฟรีหมดเร็ว)
   - อย่ากังวลเรื่องความเป็นส่วนตัว: โค้ดในนี้ไม่มีลิงก์/token ของคุณฝังอยู่เลย ทุกอย่างเก็บเป็น "Secrets" ที่คนอื่นมองไม่เห็น
2. Upload ไฟล์ทั้งหมดในโฟลเดอร์ที่แนบมา (`scraper/`, `.github/workflows/scrape.yml`) เข้า repo — วิธีง่ายที่สุดคือลาก-วางไฟล์ทั้งหมดผ่านหน้าเว็บ GitHub (Add file → Upload files) โดยคง โครงสร้างโฟลเดอร์เดิมไว้ (`.github/workflows/scrape.yml` ต้องอยู่ที่ path นี้เป๊ะๆ)
3. ไปที่ **Settings → Secrets and variables → Actions → New repository secret** เพิ่ม 3 ตัว:
   - `ISOLAR_URL` = ลิงก์เต็มของหน้า iSolarCloud ที่คุณส่งมาให้ผม (ที่ขึ้นต้นด้วย `https://web3.isolarcloud.com.hk/#/plantDetail/...`)
   - `APPSCRIPT_URL` = Web app URL ที่ได้จากขั้นตอนที่ 1 ข้อ 8
   - `WEBHOOK_SECRET` = รหัสลับเดียวกับที่ตั้งในขั้นตอนที่ 1 ข้อ 5
4. ไปที่แท็บ **Actions** ของ repo → เปิดใช้งาน workflow ถ้ามันถาม → เลือก workflow "Scrape iSolarCloud dashboard" → กด **Run workflow** (ปุ่มมุมขวา) เพื่อทดสอบรันครั้งแรกทันที (ไม่ต้องรอ 5 นาที)
5. รอสัก 1-2 นาที แล้วดูผลใน Actions log:
   - ถ้าขึ้น ✅ สีเขียว แปลว่าดึงข้อมูลและส่งเข้า Sheet สำเร็จ → เปิด Web app URL ใหม่อีกครั้ง ควรเห็นตัวเลขขึ้นแล้ว
   - ถ้าขึ้น ❌ สีแดง ให้เปิดดู log ข้างใน จะมีบอกว่า field ไหนดึงไม่ได้ และจะมีไฟล์แนบ (artifact) ชื่อ `debug-artifacts` ที่มี screenshot กับข้อความทั้งหมดบนหน้าเว็บตอนนั้น — **ดาวน์โหลดไฟล์ `debug-innertext.txt` แล้วส่งกลับมาให้ผมได้เลย** ผมจะแก้ regex การอ่านค่าให้ตรงขึ้น

จากนั้นระบบจะรันอัตโนมัติทุก 5 นาทีตลอดไป โดยไม่ต้องทำอะไรเพิ่ม — เปิด Web app URL ค้างไว้แท็บหนึ่งก็จะเห็นตัวเลขขยับเองทุก 30 วินาที

---

## ข้อควรทราบ

- **ความถี่จริง**: GitHub ระบุว่า schedule แบบ cron อาจดีเลย์ได้บ้างช่วงโหลดสูง (ปกติคลาดเคลื่อนไม่กี่นาที) ไม่ใช่ real-time เป๊ะวินาทีต่อวินาที แต่ใกล้เคียงมาก
- **ถ้า GitHub repo ไม่มีการเปลี่ยนแปลงนาน 60 วัน** GitHub จะปิด scheduled workflow อัตโนมัติ (ต้องเข้าไปกด enable ใหม่) — ถ้าอยากเลี่ยงปัญหานี้บอกผมได้ ผมตั้งเตือนให้ได้
- **ความปลอดภัย**: ลิงก์ iSolarCloud ที่คุณให้มามี token ฝังอยู่ในตัว URL เอง (ใครมีลิงก์นี้ก็เห็นข้อมูลได้) — เก็บเป็น GitHub Secret แล้วจะไม่มีใครเห็นได้จาก repo แม้จะเป็น public repo ก็ตาม
- ถ้าอยากเปลี่ยนความถี่จาก 5 นาที เป็นค่าอื่น แก้บรรทัด `cron: '*/5 * * * *'` ในไฟล์ `.github/workflows/scrape.yml` ได้เลย (ห้ามถี่กว่า 5 นาที เพราะเป็นข้อจำกัดของ GitHub Actions)
