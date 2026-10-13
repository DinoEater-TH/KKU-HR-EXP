# KKU HR Exp

ระบบบันทึกงานและแจ้งปัญหาสำหรับ **นักวิชาการโสตทัศนศึกษา มหาวิทยาลัยขอนแก่น**
ใช้งานบนมือถือเป็นหลัก — บันทึกเวลาอัตโนมัติ · แนบรูป/ไฟล์ได้ · Admin Export CSV/Excel

## สถาปัตยกรรม

```
index.html (GitHub Pages)  →  Code.gs (Google Apps Script)  →  Google Sheets + Drive
```

| ส่วน | เทคโนโลยี | ที่อยู่ |
|---|---|---|
| Frontend | HTML + Tailwind CSS + Google Identity Services | `index.html` |
| Backend API | Google Apps Script | `apps-script/Code.gs` |
| Database | Google Sheets (`Users`, `Work_Logs`, `Issues`) | บัญชี @kku.ac.th |
| Storage | Google Drive (โฟลเดอร์ `KKU HR Exp - Uploads`) | บัญชี @kku.ac.th |

## ฟีเจอร์ (สรุปทุก Phase)

- **Login** ด้วย Google เฉพาะอีเมล `@kku.ac.th` + ชื่อ-นามสกุลจริง
- **บันทึกงาน / แจ้งปัญหา** พร้อม Auto Timestamp + แนบรูป/ไฟล์ (ย่อรูปอัตโนมัติ เก็บขึ้น Drive)
- **AI (Gemini)** แยกประเภทงาน/ปัญหา และตรวจความเกี่ยวข้องก่อนบันทึก
- **กันการทุจริต (Phase 5)** — กันสแปม · กันเนื้อหาซ้ำ · กันเนื้อหาไม่เกี่ยวกับงาน
- **XP / Level / ยศ** ตามเกณฑ์ที่แอดมินตั้งได้ + คลังองค์ความรู้ (Knowledge Base) + Like
- **แดชบอร์ด (Phase 5.2)** — สถิติส่วนตัว, กราฟ XP 6 เดือน, สัดส่วนกิจกรรม, จัดอันดับสมาชิก
- **แอดมิน**: ตรวจ/ยกเลิกรายการ (หัก XP คืน + audit), ดูข้อมูลรายบุคคล (drill-down), ประกาศ, จัดการสิทธิ์, Export CSV/Excel

## เริ่มต้นใช้งาน

ดูคู่มือแบบจับมือทำทีละ Step ได้ที่ **[DEPLOY.md](DEPLOY.md)**
