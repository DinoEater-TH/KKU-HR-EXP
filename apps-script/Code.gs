/************************************************************************
 * KKU HR Exp — Phase 1 Backend  (Google Apps Script: Code.gs)
 * สำหรับ "นักวิชาการโสตทัศนศึกษา" มหาวิทยาลัยขอนแก่น
 *
 * หน้าที่ของไฟล์นี้
 *   1) รับข้อมูลจากหน้าเว็บ (index.html) ผ่าน doPost / doGet
 *   2) ตรวจสอบ Login ว่าอีเมลลงท้าย @kku.ac.th เท่านั้น
 *   3) บันทึก วันที่-เวลา ปัจจุบัน ลง Sheet ให้อัตโนมัติ (Auto Timestamp)
 *   4) อัปโหลดรูป/ไฟล์แนบ ไป Google Drive แล้วเก็บลิงก์ลง Sheet
 *   5) เมนูสำหรับ Admin: สร้างชีตอัตโนมัติ / Export CSV / Export Excel
 ************************************************************************/

/* ======================================================================
 * [1] CONFIG — แก้เฉพาะค่าที่จำเป็น (อ่านวิธีใน DEPLOY.md)
 * ==================================================================== */
var CLIENT_ID        = "582239705819-d8bbiel4qtlhmf25evv98edcp7ffgi43.apps.googleusercontent.com"; // OAuth Client ID จาก Google Cloud
var ALLOWED_DOMAIN   = "kku.ac.th";          // อนุญาตเฉพาะโดเมนนี้
var DRIVE_FOLDER     = "KKU HR Exp - Uploads"; // ชื่อโฟลเดอร์เก็บไฟล์แนบใน Google Drive
var TIMEZONE         = "Asia/Bangkok";       // เวลาไทย
var AUTO_UPDATE_USER = true;                 // true = อัปเดต Last_Login ทุกครั้งที่เข้าระบบ

var SHEETS = { USERS: "Users", WORK_LOGS: "Work_Logs", ISSUES: "Issues" };

var HEADERS = {
  USERS:     ["Email", "Full_Name", "Total_XP", "Level", "Last_Login"],
  WORK_LOGS: ["Log_ID", "Timestamp", "User_Email", "Detail", "File_URLs"],
  ISSUES:    ["Issue_ID", "Timestamp", "Detail", "Status", "Solution", "Solved_By", "File_URLs"]
};

/* ======================================================================
 * [2] doGet — สำหรับทดสอบ/ตรวจสอบการเชื่อมต่อ และ export ผ่าน URL
 * ==================================================================== */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.action === "ping") {
      return json_({ status: "ok", message: "KKU HR Exp API is running", time: nowStr_() });
    }
    if (p.action === "export") {                    // /exec?action=export&sheet=Work_Logs&format=csv
      var name = p.sheet || SHEETS.WORK_LOGS;
      var csv = exportSheetAsCsv_(name);
      return ContentService.createTextOutput(csv).setMimeType(ContentService.MimeType.CSV);
    }
    return json_({ status: "ok", message: "KKU HR Exp API", sheets: [SHEETS.USERS, SHEETS.WORK_LOGS, SHEETS.ISSUES] });
  } catch (err) {
    return json_({ status: "error", message: String(err) });
  }
}

/* ======================================================================
 * [3] doPost — รับข้อมูลจากหน้าเว็บ (action: login / workLog / issue)
 * ==================================================================== */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // ป้องกันการเขียนชนกันเมื่อมีคนใช้พร้อมกัน

    if (!e || !e.postData || !e.postData.contents) {
      return json_({ status: "error", message: "empty body" });
    }

    var data = JSON.parse(e.postData.contents);

    // ตรวจสอบตัวตน (ถ้าส่ง idToken มา) — ต้องเป็น @kku.ac.th และ token ถูกต้อง
    var verifiedEmail = null;
    if (data.idToken) {
      var info = verifyIdToken_(data.idToken);
      verifiedEmail = info.email;
    }
    var email = verifiedEmail || data.email;
    if (!email || email.split("@")[1] !== ALLOWED_DOMAIN) {
      return json_({ status: "error", message: "email domain not allowed" });
    }

    switch (data.action) {
      case "login":   return handleLogin_(email, data.name || "");
      case "workLog": return handleWorkLog_(email, data.detail || "", data.files || []);
      case "issue":   return handleIssue_(email, data.detail || "", data.files || []);
      default:        return json_({ status: "error", message: "unknown action: " + data.action });
    }
  } catch (err) {
    return json_({ status: "error", message: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ======================================================================
 * [4] Handlers
 * ==================================================================== */
function handleLogin_(email, name) {
  var sh = getSheet_(SHEETS.USERS, HEADERS.USERS);
  var row = findRow_(sh, 1, email);         // หาจากคอลัมน์ Email
  var ts = nowStr_();

  if (row === -1) {
    sh.appendRow([email, name, 0, 1, ts]);
  } else if (AUTO_UPDATE_USER) {
    if (name) sh.getRange(row, 2).setValue(name);
    sh.getRange(row, 5).setValue(ts);
  }
  return json_({ status: "ok", email: email, time: ts });
}

function handleWorkLog_(email, detail, files) {
  var sh = getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
  var ts = nowStr_();                                   // <<< Auto Timestamp
  var urls = uploadFiles_(files);                       // อัปโหลดขึ้น Drive
  var id = "LOG-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  sh.appendRow([id, ts, email, detail, urls.join("\n")]);
  return json_({ status: "ok", id: id, time: ts, files: urls.length });
}

function handleIssue_(email, detail, files) {
  var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var ts = nowStr_();                                   // <<< Auto Timestamp
  var urls = uploadFiles_(files);
  var id = "ISS-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  // คอลัมน์: Issue_ID, Timestamp, Detail, Status, Solution, Solved_By, File_URLs
  sh.appendRow([id, ts, detail, "Open", "", "", urls.join("\n")]);
  return json_({ status: "ok", id: id, time: ts, files: urls.length });
}

/* ======================================================================
 * [5] ตรวจสอบ Google ID Token (บังคับโดเมน @kku.ac.th)
 * ==================================================================== */
function verifyIdToken_(idToken) {
  var url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("invalid id token");

  var info = JSON.parse(res.getContentText());

  if (CLIENT_ID && CLIENT_ID.indexOf("PASTE_") === -1 && info.aud !== CLIENT_ID) {
    throw new Error("token audience mismatch");
  }
  var verifiedFlag = info.email_verified === true || info.email_verified === "true";
  if (!verifiedFlag) throw new Error("email not verified");
  if ((info.email || "").split("@")[1] !== ALLOWED_DOMAIN) throw new Error("email domain not allowed");

  return info;
}

/* ======================================================================
 * [6] อัปโหลดไฟล์ขึ้น Google Drive แล้วคืนลิงก์
 *     files = [{ name, mimeType, base64 }, ...]
 * ==================================================================== */
function uploadFiles_(files) {
  if (!files || !files.length) return [];
  var folder = getOrCreateFolder_(DRIVE_FOLDER);
  var urls = [];

  files.forEach(function (f, i) {
    try {
      if (!f || !f.base64) return;
      var bytes = Utilities.base64Decode(f.base64);
      var name = f.name || ("file-" + (i + 1));
      var blob = Utilities.newBlob(bytes, f.mimeType || "application/octet-stream", name);
      var file = folder.createFile(blob);
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (ignore) {}
      urls.push(file.getUrl());
    } catch (err) {
      urls.push("upload failed: " + err);
    }
  });
  return urls;
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/* ======================================================================
 * [7] Helper ทั่วไป
 * ==================================================================== */
function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name, headers) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#7f1d1d").setFontColor("#ffffff");
    sh.setFrozenRows(1);
  }
  return sh;
}

function findRow_(sheet, col, value) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var values = sheet.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

function nowStr_() {
  return Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");
}

function rand3_() { return Math.floor(Math.random() * 900 + 100); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ======================================================================
 * [8] Admin Menu — ทำงานใน Google Sheets
 *     (เปิด Sheet แล้วจะมีเมนู "⚙️ HR Exp Admin" ด้านบน)
 * ==================================================================== */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚙️ HR Exp Admin")
    .addItem("1) ตั้งค่า/สร้างชีตอัตโนมัติ", "setupSheets")
    .addSeparator()
    .addItem("Export ทั้งหมดเป็น Excel (.xlsx)", "exportAllExcel")
    .addItem("Export ชีตปัจจุบันเป็น CSV", "exportCurrentCsv")
    .addItem("Export Work_Logs เป็น CSV", "exportWorkLogsCsv")
    .addItem("Export Issues เป็น CSV", "exportIssuesCsv")
    .addItem("Export Users เป็น CSV", "exportUsersCsv")
    .addSeparator()
    .addItem("ดูลิงก์ Web App", "showWebAppUrl")
    .addToUi();
}

/** สร้างชีตทั้ง 3 พร้อมหัวคอลัมน์ให้อัตโนมัติ */
function setupSheets() {
  getSheet_(SHEETS.USERS, HEADERS.USERS);
  getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
  getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  SpreadsheetApp.getUi().alert("สร้างชีตเรียบร้อย:\n• " + SHEETS.USERS + "\n• " + SHEETS.WORK_LOGS + "\n• " + SHEETS.ISSUES);
}

/** Export ทุกชีตเป็นไฟล์ Excel (.xlsx) -> เปิดลิงก์ให้ดาวน์โหลด */
function exportAllExcel() {
  var id = getSpreadsheet_().getId();
  var url = "https://docs.google.com/spreadsheets/d/" + id + "/export?format=xlsx";
  openLink_("Export ทั้งหมด (Excel)", url);
}

/** Export ชีตที่กำลังเปิดอยู่เป็น CSV */
function exportCurrentCsv() {
  var sh = SpreadsheetApp.getActiveSheet();
  var url = csvUrl_(getSpreadsheet_().getId(), sh.getSheetId());
  openLink_("Export ชีต: " + sh.getName() + " (CSV)", url);
}

function exportWorkLogsCsv() { openLink_("Export Work_Logs (CSV)", csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.WORK_LOGS))); }
function exportIssuesCsv()   { openLink_("Export Issues (CSV)",   csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.ISSUES))); }
function exportUsersCsv()    { openLink_("Export Users (CSV)",    csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.USERS))); }

function csvUrl_(ssId, gid) {
  return "https://docs.google.com/spreadsheets/d/" + ssId + "/export?format=csv&gid=" + gid;
}

function sheetIdByName_(name) {
  var sh = getSpreadsheet_().getSheetByName(name);
  return sh ? sh.getSheetId() : 0;
}

/** สร้างข้อความ CSV จากชีตที่ระบุ (ใช้ใน doGet action=export) */
function exportSheetAsCsv_(name) {
  var sh = getSheet_(name, HEADERS[name] || []);
  var values = sh.getDataRange().getValues();
  return values.map(function (row) {
    return row.map(function (cell) {
      var s = String(cell == null ? "" : cell);
      return '"' + s.replace(/"/g, '""') + '"';
    }).join(",");
  }).join("\r\n");
}

/** เปิดลิงก์ให้ผู้ใช้ผ่านกล่องข้อความ (ผู้ใช้เป็นเจ้าของไฟล์อยู่แล้ว จึงดาวน์โหลดได้) */
function openLink_(title, url) {
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Sarabun,Arial;padding:16px;text-align:center">' +
    '<h3 style="margin:0 0 8px">' + title + '</h3>' +
    '<p style="font-size:13px;color:#555">คลิกปุ่มด้านล่างเพื่อดาวน์โหลด</p>' +
    '<a href="' + url + '" target="_blank" ' +
    'style="display:inline-block;margin-top:8px;padding:12px 22px;background:#7f1d1d;color:#fff;text-decoration:none;border-radius:10px;font-weight:bold">' +
    '⬇️ ดาวน์โหลดไฟล์</a></div>'
  ).setWidth(340).setHeight(200);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}

function showWebAppUrl() {
  var url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert("ลิงก์ Web App:\n\n" + url);
}
