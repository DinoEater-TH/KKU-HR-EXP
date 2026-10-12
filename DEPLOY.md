# คู่มือติดตั้ง KKU HR Exp — Phase 1 (จับมือทำทีละ Step)

> ระบบบันทึกงาน + แจ้งปัญหา สำหรับนักวิชาการโสตทัศนศึกษา ม.ขอนแก่น
> ใช้บนมือถือเป็นหลัก · บันทึกเวลาอัตโนมัติ · แนบรูปได้ · Admin Export CSV/Excel ได้

ระบบมี 3 ส่วนที่ต้องเชื่อมกัน:

```
[ index.html บน GitHub Pages ]  --(ส่งข้อมูล)-->  [ Code.gs บน Google Apps Script ]  -->  [ Google Sheets + Drive ]
        หน้าจอมือถือ                                    เบื้องหลัง                        ที่เก็บข้อมูล
```

ทำตามลำดับ **A → G** ให้ครบก่อน แล้วค่อยเปิดทดสอบบนมือถือ

---

## เตรียมของก่อนเริ่ม

เตรียมให้พร้อม:
1. บัญชี Google **@kku.ac.th** (ใช้เป็นเจ้าของฐานข้อมูลและ Deploy)
2. บัญชี **GitHub** ที่มี repo นี้อยู่แล้ว (`DinoEater-TH/KKU-HR-EXP`)
3. คอมพิวเตอร์ 1 เครื่อง สำหรับตั้งค่าครั้งแรก

ไฟล์ที่ต้องใช้ในโปรเจกต์นี้:
- `index.html` (หน้าจอมือถือ)
- `apps-script/Code.gs` (โค้ดเบื้องหลัง)

---

## ส่วน A: สร้าง Google Sheets (ฐานข้อมูล) + วางโค้ด

**A1.** เปิดเบราว์เซอร์ไปที่ https://sheets.new
**A2.** มุมซ้ายบนคลิกคำว่า "Untitled spreadsheet" พิมพ์ชื่อว่า `KKU HR Exp Database` แล้วกด Enter
**A3.** ที่แถบเมนูด้านบน กด **Extensions** → **Apps Script**
**A4.** จะเปิดหน้าเขียนโค้ดขึ้นมา ในกล่องข้อความกลางจอ **ลบโค้ดเดิมทั้งหมดออก** (ที่เขียนว่า `function myFunction() {}`)
**A5.** เปิดไฟล์ `apps-script/Code.gs` ในโปรเจกต์นี้ คัดลอกทั้งหมด แล้ว **วางลงในกล่อง** แทน
**A6.** กดไอคอน 💾 (บันทึก) มุมซ้ายบน หรือกด `Ctrl + S`
**A7.** ด้านบนมีช่อง dropdown เลือกฟังก์ชัน ให้เลือก **`setupSheets`** แล้วกดปุ่ม **Run ▶️**
**A8.** จะมีป๊อปอัปขออนุญาต (Authorization required) กด **Review permissions** → เลือกบัญชี @kku.ac.th ของคุณ
   - ถ้าขึ้น "Google hasn't verified this app" กด **Advanced** → **Go to (ชื่อโปรเจกต์) (unsafe)**
   - กด **Allow**
**A9.** กลับไปที่แท็บ Google Sheets จะเห็นชีต 3 อันถูกสร้างให้อัตโนมัติ:
   `Users`, `Work_Logs`, `Issues`

> ✅ ตรวจสอบ: เปิดชีต `Work_Logs` ต้องมีหัวคอลัมน์สีแดงเข้มแถวแรก

### โครงสร้างคอลัมน์ (ระบบสร้างให้แล้ว อย่าลบ แก้ชื่อ)

**ชีต `Users`**
| คอลัมน์ | A | B | C | D | E |
|---|---|---|---|---|---|
| หัวตาราง | Email | Full_Name | Total_XP | Level | Last_Login |

**ชีต `Work_Logs`**
| คอลัมน์ | A | B | C | D | E |
|---|---|---|---|---|---|
| หัวตาราง | Log_ID | Timestamp | User_Email | Detail | File_URLs |

**ชีต `Issues`**
| คอลัมน์ | A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|---|
| หัวตาราง | Issue_ID | Timestamp | Detail | Status | Solution | Solved_By | File_URLs |

---

## ส่วน B: สร้าง Google OAuth Client ID (สำหรับปุ่ม Login)

**B1.** เปิด https://console.cloud.google.com/
**B2.** มุมซ้ายบน ข้างๆ "Google Cloud" กด dropdown เลือก project → **New Project**
**B3.** ตั้งชื่อ `KKU HR Exp` → กด **Create** → รอสักครู่ → เลือกโปรเจกต์ที่สร้าง
**B4.** เมนูซ้าย (≡) → **APIs & Services** → **OAuth consent screen**
   - เลือก **Internal** (ถ้าองค์กรให้เลือก) เพื่อจำกัดเฉพาะคนในมหาวิทยาลัย
   - ถ้าเลือก **Internal ไม่ได้** ให้เลือก **External**
   - App name: `KKU HR Exp` · User support email: อีเมลคุณ · Developer contact: อีเมลคุณ
   - กด **Save and Continue** ไปจนจบ (ส่วน Scopes / Test users กดข้ามไปก่อนได้)
**B5.** ถ้าเลือก **External**: ไปที่หัวข้อ **Test users** → **Add users** → ใส่อีเมล @kku.ac.th ที่จะทดสอบ แล้ว Save
   (บัญชีที่ไม่อยู่ใน Test users จะ Login ไม่ได้ จนกว่าจะกด Publish app)
**B6.** เมนูซ้าย → **Credentials** → **+ Create Credentials** → **OAuth client ID**
**B7.** Application type: เลือก **Web application**
**B8.** Name: `KKU HR Exp Web`
**B9.** หัวข้อ **Authorized JavaScript origins** กด **+ Add URI** แล้วเพิ่ม:
   - `https://dinoeater-th.github.io`
   - `http://localhost` (ไว้ทดสอบบนเครื่อง)
**B10.** กด **Create**
**B11.** จะได้หน้าต่างแสดง **Client ID** (ลงท้ายด้วย `.apps.googleusercontent.com`) — **คัดลอกเก็บไว้**

> ❗ สำคัญ: origin ต้องเป็น URL ของ GitHub Pages เท่านั้น (ไม่ต้องมี `/` ปิดท้าย, ไม่ต้องใส่ชื่อ repo)

---

## ส่วน C: เอา Client ID ไปใส่ในโค้ด 2 ที่

**C1. ใส่ใน `Code.gs`** — เปิด Apps Script อีกครั้ง หาบรรทัดบนสุด:
```javascript
var CLIENT_ID = "PASTE_GOOGLE_CLIENT_ID_HERE.apps.googleusercontent.com";
```
เปลี่ยนเป็น Client ID ของคุณ (เอาไว้ในเครื่องหมายคำพูด) แล้วบันทึก

**C2. ใส่ใน `index.html`** — เปิดไฟล์ `index.html` หาบรรทัด:
```javascript
GOOGLE_CLIENT_ID : "PASTE_GOOGLE_CLIENT_ID_HERE.apps.googleusercontent.com",
```
เปลี่ยนเป็น Client ID เดียวกัน

---

## ส่วน D: Deploy Apps Script เป็น Web App (ได้ลิงก์ API)

**D1.** ในหน้า Apps Script มุมขวาบน กด **Deploy** → **New deployment**
**D2.** กดไอคอน ⚙️ ข้างคำว่า "Select type" → เลือก **Web app**
**D3.** ตั้งค่า:
   - **Description:** `KKU HR Exp v1`
   - **Execute as:** `Me (อีเมล @kku.ac.th ของคุณ)`
   - **Who has access:** `Anyone`
**D4.** กด **Deploy**
**D5.** จะได้ **Web app URL** (ลงท้ายด้วย `/exec`) — **คัดลอกเก็บไว้**

> ℹ️ ทำไมเลือก "Anyone": หน้าเว็บจาก GitHub Pages เป็นคนละโดเมน ถ้าตั้งเป็น "Only myself" มือถือจะส่งข้อมูลเข้ามาไม่ได้
> ระบบยังปลอดภัยเพราะทุกคำขอต้องแนบ Google ID Token และ `Code.gs` ตรวจว่าอีเมลลงท้าย `@kku.ac.th` เสมอ

**D6.** ถ้าแก้โค้ด Code.gs ภายหลัง ต้องกด **Deploy → Manage deployments → ✏️ (Edit) → Version: New version → Deploy** ทุกครั้ง เพื่อให้ค่าใหม่มีผล

---

## ส่วน E: เอา Web App URL ไปใส่ใน `index.html`

เปิด `index.html` หาบรรทัด:
```javascript
APPS_SCRIPT_URL : "PASTE_APPS_SCRIPT_WEB_APP_URL_HERE",
```
วาง Web App URL จากข้อ D5 (ที่ลงท้าย `/exec`) แทน แล้วบันทึก

---

## ส่วน F: อัปโหลดไฟล์ขึ้น GitHub + เปิด GitHub Pages

**F1.** อัปโหลด/commit ไฟล์ `index.html` และ `apps-script/Code.gs` ขึ้น repo
(ถ้าใช้คำสั่ง git:)
```
git add .
git commit -m "Phase 1: index.html + Code.gs"
git push
```
**F2.** ไปที่หน้า repo บน GitHub → **Settings** → เมนูซ้าย **Pages**
**F3.** หัวข้อ **Build and deployment** → **Source:** เลือก `Deploy from a branch`
**F4.** **Branch:** เลือก `main` และโฟลเดอร์ `/ (root)` → กด **Save**
**F5.** รอ 1–2 นาที แล้วรีเฟรชหน้า จะเห็นลิงก์เว็บ เช่น
   `https://dinoeater-th.github.io/KKU-HR-EXP/`
**F6.** กลับไปที่ข้อ B เพื่อยืนยันว่า origin `https://dinoeater-th.github.io` ถูกใส่ใน Authorized JavaScript origins แล้ว

---

## ส่วน G: ทดสอบบนมือถือ

**G1.** เปิดลิงก์ GitHub Pages จากข้อ F5 บนมือถือ
**G2.** กดปุ่ม **ลงชื่อเข้าใช้ด้วย Google** → เลือก/ล็อกอินบัญชี @kku.ac.th
   - ถ้าใช้อีเมลอื่น ระบบจะขึ้น "อนุญาตเฉพาะอีเมล @kku.ac.th เท่านั้น"
**G3.** เมื่อเข้าได้ จะเห็นชื่อ-นามสกุลจริงของคุณที่แถบด้านบน
**G4.** พิมพ์รายละเอียดใน "บันทึกงาน" → กด **📷 ถ่ายรูป** แนบรูปได้ (หรือไม่แนบก็ได้) → กด **ส่งบันทึกงาน**
**G5.** เปิด Google Sheet → ชีต `Work_Logs` ต้องมีแถวใหม่ พร้อม **วันที่-เวลาปัจจุบัน** ในคอลัมน์ `Timestamp` อัตโนมัติ และมีลิงก์รูปในคอลัมน์ `File_URLs`

---

## การใช้งานฝั่ง Admin (Export ข้อมูล)

เปิด Google Sheet «KKU HR Exp Database» แล้วดูแถบเมนูด้านบน จะมีเมนู **⚙️ HR Exp Admin**:

- **Export ทั้งหมดเป็น Excel (.xlsx)** → ดาวน์โหลดทุกชีตเป็นไฟล์ Excel เปิดในโปรแกรมตารางได้เลย
- **Export ชีตปัจจุบันเป็น CSV** → ดาวน์โหลดชีตที่กำลังเปิดอยู่
- **Export Work_Logs / Issues / Users เป็น CSV** → ดาวน์โหลดเฉพาะชีตนั้น
- **ตั้งค่า/สร้างชีตอัตโนมัติ** → สร้างชีตและหัวคอลัมน์ให้ใหม่ (ใช้กรณีชีตหาย)
- **ดูลิงก์ Web App** → แสดง URL ของ API

> เมนูนี้เห็นเฉพาะผู้ที่มีสิทธิ์แก้ไขไฟล์ Google Sheet (ผู้ดูแล) เท่านั้น

---

## แก้ปัญหาที่พบบ่อย (Troubleshooting)

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| ปุ่ม Login ไม่ขึ้น | ยังไม่ได้ใส่ Client ID, หรือ origin ใน B9 ไม่ตรงกับ URL GitHub Pages, หรือรอ 5 นาทีให้ Google อัปเดต |
| Login ได้แต่ขึ้น "domain not allowed" | ใช้อีเมลที่ไม่ใช่ @kku.ac.th หรือใส่ `ALLOWED_DOMAIN` ผิดใน Code.gs |
| กดส่งแล้วข้อมูลไม่เข้า Sheet | ยังไม่ได้ Deploy ใหม่หลังแก้โค้ด (ดู D6) หรือ Web App access ไม่ใช่ "Anyone" |
| ขึ้น "Google hasn't verified this app" | ปกติของแอปที่ยังไม่ publish กด Advanced → Go to ... (unsafe) |
| รูปไม่ขึ้นใน Drive | เกินโควตา Drive หรือไฟล์ > 8MB (หน้าเว็บจำกัดไว้ที่ 8MB) |
| หน้าเว็บขึ้นแถบเหลือง "ยังไม่ได้ตั้งค่า" | ยังไม่ได้แก้ CONFIG ใน index.html (ดู C2, E) |

---

## โครงสร้างไฟล์ในโปรเจกต์

```
KKU HR EXP/
├─ index.html            ← หน้าเว็บมือถือ (อัปขึ้น GitHub Pages)
├─ apps-script/
│  └─ Code.gs            ← โค้ดเบื้องหลัง (วางใน Google Apps Script)
├─ DEPLOY.md             ← คู่มือนี้
└─ README.md
```
