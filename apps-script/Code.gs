/************************************************************************
 * KKU HR Exp — Phase 2 Backend  (Google Apps Script: Code.gs)
 * สำหรับ "นักวิชาการโสตทัศนศึกษา" มหาวิทยาลัยขอนแก่น
 *
 * เพิ่มจาก Phase 1
 *   6) AI จำแนกข้อความด้วย Gemini  -> งาน = Work_Logs / ปัญหา = Issues
 *   7) บอร์ดปัญหาหน้างาน (ไม่ระบุตัวตนผู้แจ้ง) + เสนอแนวทางแก้ไข
 *   8) ประวัติของฉัน + แนบไฟล์ย้อนหลัง (อัปเดตลิงก์ลง Sheet เดิม)
 *
 * ความปลอดภัย: เก็บ GEMINI_API_KEY ไว้ใน Script Properties เท่านั้น
 ************************************************************************/

/* ======================================================================
 * [1] CONFIG
 * ==================================================================== */
var CLIENT_ID        = "582239705819-d8bbiel4qtlhmf25evv98edcp7ffgi43.apps.googleusercontent.com";
var ALLOWED_DOMAIN   = "kku.ac.th";
var DRIVE_FOLDER     = "KKU HR Exp - Uploads";
var TIMEZONE         = "Asia/Bangkok";
var AUTO_UPDATE_USER = true;

var GEMINI_MODEL     = "gemini-2.0-flash";   // เปลี่ยนรุ่นได้ เช่น "gemini-2.5-flash"
var GEMINI_PROP      = "GEMINI_API_KEY";     // ชื่อคีย์ใน Script Properties (ห้ามใส่คีย์ในไฟล์นี้)

var SHEETS = { USERS: "Users", WORK_LOGS: "Work_Logs", ISSUES: "Issues", SOLUTIONS: "Solutions" };

var HEADERS = {
  USERS:     ["Email", "Full_Name", "Total_XP", "Level", "Last_Login"],
  WORK_LOGS: ["Log_ID", "Timestamp", "User_Email", "Detail", "File_URLs", "Category"],
  ISSUES:    ["Issue_ID", "Timestamp", "User_Email", "Detail", "Status", "Solution", "Solved_By", "File_URLs", "Category"],
  SOLUTIONS: ["Solution_ID", "Issue_ID", "Timestamp", "Solution_Text", "Proposed_By", "Proposer_Name"]
};

/* ======================================================================
 * [2] doGet — อ่านข้อมูลผ่าน JSONP (callback=...) + export CSV
 * ==================================================================== */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = p.callback; // ถ้ามี callback => JSONP

  try {
    switch (p.action) {
      case "ping":
        return output_({ status: "ok", message: "KKU HR Exp API Phase 2", time: nowStr_() }, cb);
      case "pendingIssues":
        return output_(pendingIssues_(), cb);
      case "myHistory":
        return output_(myHistory_(p.idToken, p.email), cb);
      case "export":
        return ContentService.createTextOutput(exportSheetAsCsv_(p.sheet || SHEETS.WORK_LOGS))
          .setMimeType(ContentService.MimeType.CSV);
      default:
        return output_({ status: "ok", message: "KKU HR Exp API", sheets: [SHEETS.USERS, SHEETS.WORK_LOGS, SHEETS.ISSUES, SHEETS.SOLUTIONS] }, cb);
    }
  } catch (err) {
    return output_({ status: "error", message: String(err) }, cb);
  }
}

/* ======================================================================
 * [3] doPost — รับข้อมูลจากหน้าเว็บ
 *     action: login | workLog | issue | autoSubmit | addSolution | addFiles
 * ==================================================================== */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    if (!e || !e.postData || !e.postData.contents) return json_({ status: "error", message: "empty body" });

    var data = JSON.parse(e.postData.contents);

    var verifiedEmail = null;
    if (data.idToken) verifiedEmail = verifyIdToken_(data.idToken).email;
    var email = verifiedEmail || data.email;
    if (!email || email.split("@")[1] !== ALLOWED_DOMAIN) {
      return json_({ status: "error", message: "email domain not allowed" });
    }

    switch (data.action) {
      case "login":
        return handleLogin_(email, data.name || "");
      case "workLog":
        return handleWorkLog_(email, data.detail || "", data.files || [], data.category || "work");
      case "issue":
        return handleIssue_(email, data.detail || "", data.files || [], data.category || "issue");
      case "autoSubmit":
        return handleAutoSubmit_(email, data.detail || "", data.files || []);
      case "addSolution":
        return handleAddSolution_(email, data.name || "", data.issueId, data.solution || "");
      case "addFiles":
        return handleAddFiles_(email, data.recordType, data.recordId, data.files || []);
      default:
        return json_({ status: "error", message: "unknown action: " + data.action });
    }
  } catch (err) {
    return json_({ status: "error", message: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ======================================================================
 * [4] Handlers — เขียนข้อมูล
 * ==================================================================== */
function handleLogin_(email, name) {
  var sh = getSheet_(SHEETS.USERS, HEADERS.USERS);
  var row = findRowByHeader_(sh, "Email", email);
  var ts = nowStr_();
  if (row === -1) {
    appendByHeaders_(sh, HEADERS.USERS, { Email: email, Full_Name: name, Total_XP: 0, Level: 1, Last_Login: ts });
  } else if (AUTO_UPDATE_USER) {
    var map = headerMap_(sh);
    if (name) sh.getRange(row, map["Full_Name"]).setValue(name);
    sh.getRange(row, map["Last_Login"]).setValue(ts);
  }
  return json_({ status: "ok", email: email, time: ts });
}

function handleWorkLog_(email, detail, files, category) {
  var sh = getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
  var ts = nowStr_();
  var urls = uploadFiles_(files);
  var id = "LOG-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(sh, HEADERS.WORK_LOGS, {
    Log_ID: id, Timestamp: ts, User_Email: email, Detail: detail, File_URLs: urls.join("\n"), Category: category
  });
  return json_({ status: "ok", type: "work", id: id, time: ts, files: urls.length });
}

function handleIssue_(email, detail, files, category) {
  var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var ts = nowStr_();
  var urls = uploadFiles_(files);
  var id = "ISS-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(sh, HEADERS.ISSUES, {
    Issue_ID: id, Timestamp: ts, User_Email: email, Detail: detail,
    Status: "Pending", Solution: "", Solved_By: "", File_URLs: urls.join("\n"), Category: category
  });
  return json_({ status: "ok", type: "issue", id: id, time: ts, files: urls.length });
}

function handleAutoSubmit_(email, detail, files) {
  var result = classify_(detail);            // { category, source }
  if (result.category === "issue") return handleIssue_(email, detail, files, "issue");
  return handleWorkLog_(email, detail, files, "work");
}

function handleAddSolution_(email, name, issueId, solution) {
  if (!issueId) throw new Error("missing issueId");
  if (!solution) throw new Error("missing solution");

  var issSheet = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var row = findRowByHeader_(issSheet, "Issue_ID", issueId);
  if (row === -1) throw new Error("issue not found");

  var solSheet = getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS);
  var ts = nowStr_();
  var sid = "SOL-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(solSheet, HEADERS.SOLUTIONS, {
    Solution_ID: sid, Issue_ID: issueId, Timestamp: ts, Solution_Text: solution,
    Proposed_By: email, Proposer_Name: name
  });

  var imap = headerMap_(issSheet);
  var curStatus = String(issSheet.getRange(row, imap["Status"]).getValue() || "Pending");
  if (curStatus === "Pending" || curStatus === "") issSheet.getRange(row, imap["Status"]).setValue("In-Progress");

  return json_({ status: "ok", solutionId: sid, time: ts });
}

function handleAddFiles_(email, recordType, recordId, files) {
  if (!recordId) throw new Error("missing recordId");
  if (!files || !files.length) throw new Error("no files");

  if (recordType === "issue") {
    var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
    var row = findRowByHeader_(sh, "Issue_ID", recordId);
    if (row === -1) throw new Error("issue not found");
    assertOwner_(sh, row, "User_Email", email);
    appendFileUrls_(sh, row, uploadFiles_(files));
  } else {
    var sh2 = getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
    var row2 = findRowByHeader_(sh2, "Log_ID", recordId);
    if (row2 === -1) throw new Error("record not found");
    assertOwner_(sh2, row2, "User_Email", email);
    appendFileUrls_(sh2, row2, uploadFiles_(files));
  }
  return json_({ status: "ok", id: recordId, files: files.length });
}

/* ======================================================================
 * [5] อ่านข้อมูล (สำหรับบอร์ดปัญหา + ประวัติของฉัน)
 * ==================================================================== */
function pendingIssues_() {
  var iss = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES);
  var sols = readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS);

  var byIssue = {};
  sols.forEach(function (s) {
    var k = String(s.Issue_ID);
    (byIssue[k] = byIssue[k] || []).push({
      text: String(s.Solution_Text || ""),
      by: String(s.Proposer_Name || "เพื่อนร่วมงาน"),
      time: String(s.Timestamp || "")
    });
  });

  var list = [];
  for (var i = iss.length - 1; i >= 0; i--) {          // ใหม่สุดก่อน
    var r = iss[i];
    var status = String(r.Status || "Pending");
    if (status === "Solved" || status === "Closed") continue;
    list.push({
      id: String(r.Issue_ID || ""),
      time: String(r.Timestamp || ""),
      detail: String(r.Detail || ""),
      status: status,
      files: splitUrls_(r.File_URLs),
      solutions: byIssue[String(r.Issue_ID)] || []
    }); // เจตนาไม่ส่ง User_Email -> รักษาความเป็นส่วนตัว
  }
  return { status: "ok", count: list.length, issues: list };
}

function myHistory_(idToken, emailParam) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบใหม่เพื่อดูประวัติ");
  var email = verifyIdToken_(idToken).email;
  if (emailParam && emailParam !== email) throw new Error("email mismatch");

  var works = readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
    .filter(function (r) { return String(r.User_Email) === email; })
    .map(function (r) {
      return { type: "work", id: String(r.Log_ID), time: String(r.Timestamp), detail: String(r.Detail),
               category: String(r.Category || "work"), files: splitUrls_(r.File_URLs) };
    });

  var issues = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES))
    .filter(function (r) { return String(r.User_Email) === email; })
    .map(function (r) {
      return { type: "issue", id: String(r.Issue_ID), time: String(r.Timestamp), detail: String(r.Detail),
               status: String(r.Status || "Pending"), category: String(r.Category || "issue"), files: splitUrls_(r.File_URLs) };
    });

  var all = works.concat(issues).sort(function (a, b) { return a.time < b.time ? 1 : -1; });
  return { status: "ok", email: email, count: all.length, items: all };
}

/* ======================================================================
 * [6] AI จำแนกประเภทข้อความ (Gemini + fallback คำสำคัญ)
 * ==================================================================== */
function classify_(text) {
  try {
    return { category: classifyWithGemini_(text), source: "ai" };
  } catch (err) {
    console.warn("Gemini failed, ใช้คำสำคัญแทน: " + err);
    return { category: classifyByKeywords_(text), source: "keyword" };
  }
}

function classifyWithGemini_(text) {
  var key = PropertiesService.getScriptProperties().getProperty(GEMINI_PROP);
  if (!key) throw new Error("ยังไม่ได้ตั้งค่า " + GEMINI_PROP);

  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + key;

  var prompt =
    "คุณเป็นผู้ช่วยจำแนกบันทึกของนักวิชาการโสตทัศนศึกษา " +
    "ให้ตอบว่าเป็นงาน (work) หรือ ปัญหา (issue) เท่านั้น\n" +
    "- work  = งานประจำ / ตั้งระบบ / ถ่ายภาพ / คุมระบบ / ประชุม / กิจกรรม ที่ทำสำเร็จ\n" +
    "- issue = อุปกรณ์เสีย ชำรุด โปรแกรมค้าง ระบบมีปัญหา ต้องซ่อม หรือสิ่งที่ยังไม่เรียบร้อย\n" +
    "ตอบเป็น JSON รูปแบบ {\"category\":\"work\"} หรือ {\"category\":\"issue\"} เท่านั้น";

  var payload = {
    contents: [{ parts: [{ text: prompt + "\n\nข้อความ:\n" + text }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: { category: { type: "STRING", enum: ["work", "issue"] } },
        required: ["category"]
      }
    }
  };

  var res = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) throw new Error("Gemini HTTP " + res.getResponseCode() + ": " + res.getContentText());

  var body = JSON.parse(res.getContentText());
  var out = body.candidates[0].content.parts[0].text;
  var parsed = JSON.parse(out);
  return (String(parsed.category).toLowerCase() === "issue") ? "issue" : "work";
}

function classifyByKeywords_(text) {
  var t = String(text || "").toLowerCase();
  var issueWords = ["เสีย", "ชำรุด", "ค้าง", "ปัญหา", "ไม่ทำงาน", "ซ่อม", "พัง", "error",
    "ฟ้อง", "ซ่า", "แตก", "หลุด", "ช้า", "เบลอ", "ไม่มีเสียง", "เปิดไม่ติด", "จอดับ",
    "เชื่อมต่อไม่ได้", "ผิดพลาด", "ใช้งานไม่ได้", "แจ้งซ่อม"];
  for (var i = 0; i < issueWords.length; i++) {
    if (t.indexOf(issueWords[i]) !== -1) return "issue";
  }
  return "work";
}

/* ======================================================================
 * [7] ตรวจสอบ Google ID Token (@kku.ac.th)
 * ==================================================================== */
function verifyIdToken_(idToken) {
  var url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("invalid id token");

  var info = JSON.parse(res.getContentText());
  if (CLIENT_ID && CLIENT_ID.indexOf("PASTE_") === -1 && info.aud !== CLIENT_ID) throw new Error("token audience mismatch");
  var verifiedFlag = info.email_verified === true || info.email_verified === "true";
  if (!verifiedFlag) throw new Error("email not verified");
  if ((info.email || "").split("@")[1] !== ALLOWED_DOMAIN) throw new Error("email domain not allowed");
  return info;
}

/* ======================================================================
 * [8] Google Drive
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
    } catch (err) { urls.push("upload failed: " + err); }
  });
  return urls;
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/* ======================================================================
 * [9] Helper: อ่าน/เขียน Sheet แบบอ้างชื่อคอลัมน์ (ทนต่อการเพิ่มคอลัมน์)
 * ==================================================================== */
function getSpreadsheet_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function getSheet_(name, headers) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#7f1d1d").setFontColor("#ffffff");
    sh.setFrozenRows(1);
  } else {
    var lastCol = sh.getLastColumn();
    var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
    if (missing.length) {
      sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing])
        .setFontWeight("bold").setBackground("#7f1d1d").setFontColor("#ffffff");
    }
  }
  return sh;
}

function headerMap_(sh) {
  var row = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var map = {};
  row.forEach(function (h, i) { map[String(h).trim()] = i + 1; });
  return map;
}

function appendByHeaders_(sh, headers, obj) {
  var map = headerMap_(sh);
  var width = sh.getLastColumn();
  var row = new Array(width);
  for (var i = 0; i < width; i++) row[i] = "";
  headers.forEach(function (h) {
    if (map[h] && obj[h] !== undefined && obj[h] !== null) row[map[h] - 1] = obj[h];
  });
  sh.appendRow(row);
}

function readObjects_(sh, headers) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var map = headerMap_(sh);
  var width = sh.getLastColumn();
  var data = sh.getRange(2, 1, last - 1, width).getValues();
  return data.map(function (r) {
    var o = {};
    headers.forEach(function (h) { o[h] = map[h] ? r[map[h] - 1] : ""; });
    return o;
  });
}

function findRowByHeader_(sh, header, value) {
  var map = headerMap_(sh);
  if (!map[header]) return -1;
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var col = map[header];
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

function assertOwner_(sh, row, emailHeader, email) {
  var map = headerMap_(sh);
  var owner = String(sh.getRange(row, map[emailHeader]).getValue() || "");
  if (owner !== email) throw new Error("ไม่มีสิทธิ์แก้ไขรายการนี้");
}

function appendFileUrls_(sh, row, urls) {
  if (!urls || !urls.length) return;
  var map = headerMap_(sh);
  var col = map["File_URLs"];
  var cur = String(sh.getRange(row, col).getValue() || "");
  var merged = (cur ? cur + "\n" : "") + urls.join("\n");
  sh.getRange(row, col).setValue(merged);
}

function splitUrls_(v) {
  var s = String(v || "").trim();
  if (!s) return [];
  return s.split(/\s*\n\s*/).filter(function (x) { return x; });
}

function nowStr_() { return Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss"); }
function rand3_() { return Math.floor(Math.random() * 900 + 100); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** ตอบกลับแบบ JSON ปกติ หรือ JSONP ถ้ามี callback (ใช้กับ <script> ในเบราว์เซอร์) */
function output_(obj, callback) {
  var jsonStr = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + "(" + jsonStr + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json_(obj);
}

/* ======================================================================
 * [10] Admin Menu
 * ==================================================================== */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚙️ HR Exp Admin")
    .addItem("1) ตั้งค่า/อัปเกรดชีต (Phase 2)", "setupSheets")
    .addSeparator()
    .addItem("Export ทั้งหมดเป็น Excel (.xlsx)", "exportAllExcel")
    .addItem("Export ชีตปัจจุบันเป็น CSV", "exportCurrentCsv")
    .addItem("Export Work_Logs เป็น CSV", "exportWorkLogsCsv")
    .addItem("Export Issues เป็น CSV", "exportIssuesCsv")
    .addItem("Export Users เป็น CSV", "exportUsersCsv")
    .addItem("Export Solutions เป็น CSV", "exportSolutionsCsv")
    .addSeparator()
    .addItem("ดูลิงก์ Web App", "showWebAppUrl")
    .addToUi();
}

function setupSheets() {
  getSheet_(SHEETS.USERS, HEADERS.USERS);
  getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
  getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS);
  SpreadsheetApp.getUi().alert("อัปเกรดชีตเรียบร้อย:\n• Users\n• Work_Logs\n• Issues\n• Solutions");
}

function exportAllExcel() {
  var url = "https://docs.google.com/spreadsheets/d/" + getSpreadsheet_().getId() + "/export?format=xlsx";
  openLink_("Export ทั้งหมด (Excel)", url);
}
function exportCurrentCsv() {
  var sh = SpreadsheetApp.getActiveSheet();
  openLink_("Export ชีต: " + sh.getName() + " (CSV)", csvUrl_(getSpreadsheet_().getId(), sh.getSheetId()));
}
function exportWorkLogsCsv() { openLink_("Export Work_Logs (CSV)", csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.WORK_LOGS))); }
function exportIssuesCsv()   { openLink_("Export Issues (CSV)",   csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.ISSUES))); }
function exportUsersCsv()    { openLink_("Export Users (CSV)",    csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.USERS))); }
function exportSolutionsCsv(){ openLink_("Export Solutions (CSV)",csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.SOLUTIONS))); }

function csvUrl_(ssId, gid) { return "https://docs.google.com/spreadsheets/d/" + ssId + "/export?format=csv&gid=" + gid; }
function sheetIdByName_(name) { var sh = getSpreadsheet_().getSheetByName(name); return sh ? sh.getSheetId() : 0; }

function exportSheetAsCsv_(name) {
  var sh = getSheet_(name, HEADERS[name] || []);
  var values = sh.getDataRange().getValues();
  return values.map(function (row) {
    return row.map(function (cell) {
      return '"' + String(cell == null ? "" : cell).replace(/"/g, '""') + '"';
    }).join(",");
  }).join("\r\n");
}

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
  SpreadsheetApp.getUi().alert("ลิงก์ Web App:\n\n" + ScriptApp.getService().getUrl());
}

/** ใช้ตั้งค่า GEMINI_API_KEY ผ่านเมนู (ทางเลือก นอกเหนือจากการตั้งใน Script Properties เอง) */
function setGeminiKey() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt("ตั้งค่า Gemini API Key", "วาง API Key ที่นี่ (จะเก็บใน Script Properties):", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty(GEMINI_PROP, res.getResponseText().trim());
    ui.alert("บันทึกคีย์เรียบร้อย");
  }
}
