/************************************************************************
 * KKU HR Exp — Phase 5.1 Backend  (Google Apps Script: Code.gs)
 * สำหรับ "นักวิชาการโสตทัศนศึกษา" มหาวิทยาลัยขอนแก่น
 *
 * โครงสร้างทั้งหมด (Phase 1-5)
 *   Sheets: Users, Work_Logs, Issues, Solutions,
 *           XP_History, XP_Rules, Likes, Notifications, Notif_Acks
 *   API   : doGet (JSONP อ่านข้อมูล) / doPost (เขียนข้อมูล)
 *   AI    : Gemini จำแนกข้อความ + ตรวจความเกี่ยวข้อง (คีย์เก็บใน Script Properties)
 *   Game  : XP / Level / Title ตามตาราง XP_Rules
 *   KB    : คลังองค์ความรู้จากเคสที่แก้สำเร็จ + Like (+5 XP)
 *   Notify: ประกาศจาก Admin (บังหน้าจอจนกว่าจะรับทราบ)
 *   Guard : กันสแปม / เนื้อหาซ้ำ / เนื้อหาไม่เกี่ยวกับงาน (Phase 5)
 *   Audit : แอดมินยกเลิกรายการ (Soft-void) หัก XP คืน + audit trail (Phase 5.1)
 *
 * ความปลอดภัย: GEMINI_API_KEY และ ADMIN_EMAILS เก็บใน Script Properties เท่านั้น
 ************************************************************************/

/* ======================================================================
 * [1] CONFIG
 * ==================================================================== */
var CLIENT_ID        = "582239705819-d8bbiel4qtlhmf25evv98edcp7ffgi43.apps.googleusercontent.com";
var ALLOWED_DOMAIN   = "kku.ac.th";
var DRIVE_FOLDER     = "KKU HR Exp - Uploads";
var TIMEZONE         = "Asia/Bangkok";
var AUTO_UPDATE_USER = true;

var GEMINI_MODEL     = "gemini-2.0-flash";
var GEMINI_PROP      = "GEMINI_API_KEY";
var ADMIN_PROP       = "ADMIN_EMAILS";   // เก็บเป็น "a@kku.ac.th,b@kku.ac.th"

var XP = { WORK_LOG: 10, ISSUE: 15, SOLUTION: 25, RESOLVE: 50, LIKE_RECEIVED: 5 };

/* ---- ป้องกันการใช้งานผิด: สแปม / เนื้อหาซ้ำ / เนื้อหาไม่เกี่ยวกับงาน ---- */
var SPAM_MIN_INTERVAL_SEC = 10;    // ระยะห่างขั้นต่ำระหว่างการส่ง (วินาที)
var SPAM_MAX_PER_WINDOW   = 5;     // ส่งได้สูงสุดกี่ครั้งต่อช่วงเวลา
var SPAM_WINDOW_MIN       = 30;    // ช่วงเวลานับสแปม (นาที)
var DUP_LOOKBACK_HOURS    = 24;    // ย้อนตรวจเนื้อหาซ้ำ (ชั่วโมง)
var DUP_SIMILARITY        = 0.85;  // เกณฑ์ความคล้าย (0.0-1.0)
var MIN_DETAIL_CHARS      = 5;     // ความยาวข้อความขั้นต่ำ (ตัวอักษร)
var REJECT_NON_WORK       = true;  // ปฏิเสธเนื้อหาที่ไม่เกี่ยวข้องกับงาน
var OFF_TOPIC_WORDS = ["ประท้วง", "ทวงหนี้", "ร้องเรียน", "ลาออก", "การเมือง", "เลือกตั้ง",
  "เล่นเกม", "หวย", "พนัน", "ขายของ", "เงินเดือน", "โบนัส", "หยุดงาน", "สไตรก์", "เรียกร้อง", "สหภาพ", "ไม่ยุติธรรม", "ด่าผู้บริหาร"];

var SHEETS = {
  USERS: "Users", WORK_LOGS: "Work_Logs", ISSUES: "Issues", SOLUTIONS: "Solutions",
  XP_HISTORY: "XP_History", XP_RULES: "XP_Rules", LIKES: "Likes",
  NOTIFICATIONS: "Notifications", NOTIF_ACKS: "Notif_Acks"
};

var HEADERS = {
  USERS:         ["Email", "Full_Name", "Total_XP", "Level", "Last_Login", "Role"],
  WORK_LOGS:     ["Log_ID", "Timestamp", "User_Email", "Detail", "File_URLs", "Category", "Client_Ref", "Links", "Status", "Void_Reason", "Voided_By", "Voided_At"],
  ISSUES:        ["Issue_ID", "Timestamp", "User_Email", "Detail", "Status", "Solution", "Solved_By", "File_URLs", "Category", "Solved_By_Email", "Client_Ref", "KB_Approved", "Links", "Void_Reason", "Voided_By", "Voided_At"],
  SOLUTIONS:     ["Solution_ID", "Issue_ID", "Timestamp", "Solution_Text", "Proposed_By", "Proposer_Name"],
  XP_HISTORY:    ["XP_ID", "Timestamp", "User_Email", "Amount", "Reason", "Ref_ID", "Client_Ref"],
  XP_RULES:      ["Level", "Title", "Min_XP"],
  LIKES:         ["Like_ID", "Issue_ID", "User_Email", "Timestamp"],
  NOTIFICATIONS: ["Notif_ID", "Message", "Created_At", "Active"],
  NOTIF_ACKS:    ["Ack_ID", "Notif_ID", "User_Email", "Ack_At"]
};

var SEED_XP_RULES = [
  [1, "AV Trainee", 0],
  [2, "Media Operator", 100],
  [3, "AV Specialist", 300],
  [4, "Senior AV Specialist", 700],
  [5, "AV Expert", 1500]
];

/* ======================================================================
 * [2] doGet — อ่านข้อมูลผ่าน JSONP (callback=...)
 * ==================================================================== */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = p.callback;
  try {
    switch (p.action) {
      case "ping":
        return output_({ status: "ok", message: "KKU HR Exp API Phase 5.1", time: nowStr_() }, cb);
      case "pendingIssues":
        return output_(pendingIssues_(p.idToken), cb);
      case "myHistory":
        return output_(myHistory_(p.idToken, p.email), cb);
      case "knowledgeBase":
        return output_(knowledgeBase_(p.idToken, p.email), cb);
      case "myProfile":
        return output_(myProfile_(p.idToken, p.email), cb);
      case "activeNotifications":
        return output_(activeNotifications_(p.idToken), cb);
      case "submitResult":
        return output_(submitResult_(p.clientRef, p.idToken), cb);
      case "adminOverview":
        return output_(adminOverview_(p.idToken), cb);
      case "adminSubmissions":
        return output_(adminSubmissions_(p.idToken, p.type, p.q, p.includeVoided), cb);
      case "exportData":
        return output_(exportData_(p.idToken, p.type), cb);
      case "export":
        return ContentService.createTextOutput(exportSheetAsCsv_(p.sheet || SHEETS.WORK_LOGS))
          .setMimeType(ContentService.MimeType.CSV);
      default:
        return output_({ status: "ok", message: "KKU HR Exp API Phase 5.1" }, cb);
    }
  } catch (err) {
    return output_({ status: "error", message: String(err) }, cb);
  }
}

/* ======================================================================
 * [3] doPost — เขียนข้อมูล
 *   action: login | workLog | issue | autoSubmit | addSolution | addFiles
 *           | resolveIssue | likeArticle | ackNotification
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
      case "login":          return handleLogin_(email, data.name || "");
      case "workLog":        return handleWorkLog_(email, data.detail || "", data.files || [], data.category || "work", data.clientRef);
      case "issue":          return handleIssue_(email, data.detail || "", data.files || [], data.category || "issue", data.clientRef);
      case "autoSubmit":     return handleAutoSubmit_(email, data.detail || "", data.files || [], data.clientRef);
      case "addSolution":    return handleAddSolution_(email, data.name || "", data.issueId, data.solution || "");
      case "addFiles":       return handleAddFiles_(email, data.recordType, data.recordId, data.files || []);
      case "addLinks":       return handleAddLinks_(email, data.recordType, data.recordId, data.links || []);
      case "resolveIssue":   return handleResolveIssue_(email, data.issueId);
      case "likeArticle":    return handleLikeArticle_(email, data.issueId);
      case "ackNotification":return handleAckNotification_(email, data.notifIds || []);
      case "approveIssue":   return handleApproveIssue_(email, data.issueId);
      case "grantBonusXp":   return handleGrantBonusXp_(email, data.targetEmail, data.amount, data.reason);
      case "createNotification": return handleCreateNotification_(email, data.message || "");
      case "setUserRole":    return handleSetUserRole_(email, data.targetEmail, data.role);
case "saveXpRules":
        return handleSaveXpRules_(email, data.rules || []);
      case "voidRecord":
        return handleVoidRecord_(email, data.recordType, data.recordId, data.reason || "");
      default:               return json_({ status: "error", message: "unknown action: " + data.action });
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
    appendByHeaders_(sh, HEADERS.USERS, { Email: email, Full_Name: name, Total_XP: 0, Level: 1, Last_Login: ts, Role: "User" });
  } else if (AUTO_UPDATE_USER) {
    var map = headerMap_(sh);
    if (name) sh.getRange(row, map["Full_Name"]).setValue(name);
    sh.getRange(row, map["Last_Login"]).setValue(ts);
  }
  return json_({ status: "ok", email: email, time: ts, isAdmin: isAdmin_(email) });
}

function handleWorkLog_(email, detail, files, category, clientRef) {
  validateAndAssess_(email, detail, clientRef);
  return recordWork_(email, detail, files, category || "work", clientRef);
}

function handleIssue_(email, detail, files, category, clientRef) {
  validateAndAssess_(email, detail, clientRef);
  return recordIssue_(email, detail, files, category || "issue", clientRef);
}

function handleAutoSubmit_(email, detail, files, clientRef) {
  var a = validateAndAssess_(email, detail, clientRef);
  if (a.category === "issue") return recordIssue_(email, detail, files, "issue", clientRef);
  return recordWork_(email, detail, files, "work", clientRef);
}

function recordWork_(email, detail, files, category, clientRef) {
  var sh = getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
  var ts = nowStr_();
  var urls = uploadFiles_(files);
  var id = "LOG-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(sh, HEADERS.WORK_LOGS, {
    Log_ID: id, Timestamp: ts, User_Email: email, Detail: detail,
    File_URLs: urls.join("\n"), Category: category, Client_Ref: clientRef || ""
  });
  var lv = awardXp_(email, XP.WORK_LOG, "work_log", id, clientRef);
  return json_({ status: "ok", type: "work", id: id, time: ts, files: urls.length, xp: XP.WORK_LOG, totalXp: lv.totalXp });
}

function recordIssue_(email, detail, files, category, clientRef) {
  var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var ts = nowStr_();
  var urls = uploadFiles_(files);
  var id = "ISS-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(sh, HEADERS.ISSUES, {
    Issue_ID: id, Timestamp: ts, User_Email: email, Detail: detail, Status: "Pending",
    Solution: "", Solved_By: "", File_URLs: urls.join("\n"), Category: category, Client_Ref: clientRef || ""
  });
  var lv = awardXp_(email, XP.ISSUE, "issue", id, clientRef);
  return json_({ status: "ok", type: "issue", id: id, time: ts, files: urls.length, xp: XP.ISSUE, totalXp: lv.totalXp });
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
    Solution_ID: sid, Issue_ID: issueId, Timestamp: ts, Solution_Text: solution, Proposed_By: email, Proposer_Name: name
  });

  var imap = headerMap_(issSheet);
  var curStatus = String(issSheet.getRange(row, imap["Status"]).getValue() || "Pending");
  if (curStatus === "Pending" || curStatus === "") issSheet.getRange(row, imap["Status"]).setValue("In-Progress");

  var lv = awardXp_(email, XP.SOLUTION, "solution", sid, "");
  return json_({ status: "ok", solutionId: sid, time: ts, xp: XP.SOLUTION, totalXp: lv.totalXp });
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

/* อัปเดตลิงก์ข้อมูลเพิ่มเติม (วาง/แก้ไข) — ส่งรายการลิงก์ทั้งชุดมาระบุผลลัพธ์สุดท้าย */
function handleAddLinks_(email, recordType, recordId, links) {
  if (!recordId) throw new Error("missing recordId");
  var sh, idHeader;
  if (recordType === "issue") { sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES); idHeader = "Issue_ID"; }
  else { sh = getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS); idHeader = "Log_ID"; }

  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("record not found");
  assertOwner_(sh, row, "User_Email", email);

  var map = headerMap_(sh);
  var col = map["Links"];
  if (!col) throw new Error("ยังไม่มีคอลัมน์ Links — ให้แอดมินอัปเกรดชีตก่อน");

  var clean = [];
  (links || []).forEach(function (x) {
    var u = normalUrl_(x && x.u);
    if (!u) return;
    if (/\s/.test(u) || u.indexOf(".") === -1) throw new Error("ลิงก์ไม่ถูกต้อง: " + u);
    clean.push({ t: String((x && x.t) || "").slice(0, 80), u: u });
  });

  sh.getRange(row, col).setValue(serializeLinks_(clean));
  return json_({ status: "ok", id: recordId, count: clean.length, links: clean });
}

function handleResolveIssue_(email, issueId) {
  var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var row = findRowByHeader_(sh, "Issue_ID", issueId);
  if (row === -1) throw new Error("issue not found");
  var map = headerMap_(sh);

  var owner = String(sh.getRange(row, map["User_Email"]).getValue() || "");
  if (owner !== email && !isAdmin_(email)) throw new Error("ไม่มีสิทธิ์ยืนยันรายการนี้");

  // หาผู้เสนอวิธีแก้ (คนแรก) เพื่อให้เครดิต
  var sols = readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS)
    .filter(function (s) { return String(s.Issue_ID) === String(issueId); });
  var solverEmail = sols.length ? String(sols[0].Proposed_By || "") : "";
  var solverName = sols.length ? String(sols[0].Proposer_Name || "") : "";
  if (!solverEmail) { solverEmail = email; solverName = ""; }

  sh.getRange(row, map["Status"]).setValue("Solved");
  if (map["KB_Approved"]) sh.getRange(row, map["KB_Approved"]).setValue(false);
  if (map["Solved_By"]) sh.getRange(row, map["Solved_By"]).setValue(solverName || solverEmail);
  if (map["Solved_By_Email"]) sh.getRange(row, map["Solved_By_Email"]).setValue(solverEmail);

  var lv = awardXp_(email, XP.RESOLVE, "resolve_issue", issueId, "");
  return json_({ status: "ok", xp: XP.RESOLVE, totalXp: lv.totalXp, level: lv.level, title: lv.title, solver: solverName || solverEmail });
}

function handleLikeArticle_(email, issueId) {
  var lsh = getSheet_(SHEETS.LIKES, HEADERS.LIKES);
  var likes = readObjects_(lsh, HEADERS.LIKES);
  var already = likes.some(function (l) { return String(l.Issue_ID) === String(issueId) && String(l.User_Email) === email; });
  if (already) throw new Error("คุณกด Like บทความนี้แล้ว");

  appendByHeaders_(lsh, HEADERS.LIKES, {
    Like_ID: "LIKE-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
    Issue_ID: issueId, User_Email: email, Timestamp: nowStr_()
  });

  // ให้ +5 XP กับผู้เขียนวิธีแก้
  var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var row = findRowByHeader_(sh, "Issue_ID", issueId);
  if (row === -1) throw new Error("issue not found");
  var map = headerMap_(sh);
  var solverEmail = map["Solved_By_Email"] ? String(sh.getRange(row, map["Solved_By_Email"]).getValue() || "") : "";
  if (solverEmail) awardXp_(solverEmail, XP.LIKE_RECEIVED, "like_received", issueId, "");

  var count = likes.filter(function (l) { return String(l.Issue_ID) === String(issueId); }).length + 1;
  return json_({ status: "ok", count: count });
}

function handleAckNotification_(email, notifIds) {
  var sh = getSheet_(SHEETS.NOTIF_ACKS, HEADERS.NOTIF_ACKS);
  var ts = nowStr_();
  (notifIds || []).forEach(function (id) {
    appendByHeaders_(sh, HEADERS.NOTIF_ACKS, {
      Ack_ID: "ACK-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
      Notif_ID: id, User_Email: email, Ack_At: ts
    });
  });
  return json_({ status: "ok", acked: (notifIds || []).length });
}

/* ======================================================================
 * [4b] Admin-only handlers (Phase 4)
 * ==================================================================== */
function handleApproveIssue_(adminEmail, issueId) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var row = findRowByHeader_(sh, "Issue_ID", issueId);
  if (row === -1) throw new Error("issue not found");
  var map = headerMap_(sh);
  if (String(sh.getRange(row, map["Status"]).getValue()) !== "Solved") throw new Error("ต้องเป็นเคสที่แก้ไขสำเร็จก่อน");
  sh.getRange(row, map["KB_Approved"]).setValue(true);
  return json_({ status: "ok", id: issueId });
}

function handleGrantBonusXp_(adminEmail, targetEmail, amount, reason) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!targetEmail || String(targetEmail).split("@")[1] !== ALLOWED_DOMAIN) throw new Error("อีเมลเป้าหมายไม่ถูกต้อง");
  var amt = Number(amount);
  if (!amt || isNaN(amt)) throw new Error("จำนวน XP ไม่ถูกต้อง");
  var lv = awardXp_(targetEmail, amt, "bonus:" + (reason || "admin"), "BONUS", "");
  return json_({ status: "ok", email: targetEmail, amount: amt, totalXp: lv.totalXp, level: lv.level });
}

function handleCreateNotification_(adminEmail, message) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!message) throw new Error("ข้อความว่าง");
  var sh = getSheet_(SHEETS.NOTIFICATIONS, HEADERS.NOTIFICATIONS);
  var id = "NOTI-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(sh, HEADERS.NOTIFICATIONS, { Notif_ID: id, Message: message, Created_At: nowStr_(), Active: true });
  return json_({ status: "ok", id: id });
}

function handleSetUserRole_(adminEmail, targetEmail, role) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!targetEmail || String(targetEmail).split("@")[1] !== ALLOWED_DOMAIN) throw new Error("อีเมลเป้าหมายไม่ถูกต้อง");
  var r = (String(role).toLowerCase() === "admin") ? "Admin" : "User";
  var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
  var row = findRowByHeader_(ush, "Email", targetEmail);
  var map = headerMap_(ush);
  if (row === -1) appendByHeaders_(ush, HEADERS.USERS, { Email: targetEmail, Full_Name: "", Total_XP: 0, Level: 1, Last_Login: "", Role: r });
  else ush.getRange(row, map["Role"]).setValue(r);
  return json_({ status: "ok", email: targetEmail, role: r });
}

/* บันทึกเกณฑ์ Level & XP ใหม่ทั้งชุด แล้วคำนวณ Level ผู้ใช้ทุกคนใหม่ */
function handleSaveXpRules_(adminEmail, rules) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");

  var clean = [];
  (rules || []).forEach(function (r) {
    var min = Number(r && r.min);
    if (isNaN(min) || min < 0) return;
    var title = String((r && r.title) || "").trim().slice(0, 60);
    clean.push({ level: 0, title: title || ("Level " + (clean.length + 1)), min: Math.round(min) });
  });
  if (!clean.length) throw new Error("ต้องมีอย่างน้อย 1 ระดับ");

  // เรียงตาม XP ขั้นต่ำ แล้วกำหนดเลข Level 1,2,3,... ใหม่
  clean.sort(function (a, b) { return a.min - b.min; });
  clean.forEach(function (r, i) { r.level = i + 1; });

  var sh = getSheet_(SHEETS.XP_RULES, HEADERS.XP_RULES);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  var values = clean.map(function (r) { return [r.level, r.title, r.min]; });
  sh.getRange(2, 1, values.length, 3).setValues(values);

  var usersUpdated = recomputeUserLevels_();
  return json_({ status: "ok", count: clean.length, usersUpdated: usersUpdated, rules: clean });
}

/* คำนวณ Level ของผู้ใช้ทุกคนใหม่ตามเกณฑ์ล่าสุด */
function recomputeUserLevels_() {
  var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
  var last = ush.getLastRow();
  if (last < 2) return 0;
  var rules = getXpRules_();
  var map = headerMap_(ush);
  var expCol = map["Total_XP"], lvlCol = map["Level"];
  var xpVals = ush.getRange(2, expCol, last - 1, 1).getValues();
  var lvVals = ush.getRange(2, lvlCol, last - 1, 1).getValues();
  var changed = 0;
  for (var i = 0; i < xpVals.length; i++) {
    var lv = computeLevel_(rules, Number(xpVals[i][0] || 0)).level;
    if (Number(lvVals[i][0] || 1) !== lv) changed++;
    lvVals[i][0] = lv;
  }
  ush.getRange(2, lvlCol, lvVals.length, 1).setValues(lvVals);
  return changed;
}

/* ======================================================================
 * [5] อ่านข้อมูล (JSONP)
 * ==================================================================== */
function pendingIssues_(idToken) {
  var me = idToken ? verifyIdToken_(idToken).email : null;
  var admin = me ? isAdmin_(me) : false;

  var iss = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES);
  var sols = readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS);

  var byIssue = {};
  sols.forEach(function (s) {
    var k = String(s.Issue_ID);
    (byIssue[k] = byIssue[k] || []).push({
      text: String(s.Solution_Text || ""), by: String(s.Proposer_Name || "เพื่อนร่วมงาน"), time: String(s.Timestamp || "")
    });
  });

  var list = [];
  for (var i = iss.length - 1; i >= 0; i--) {
    var r = iss[i];
    var status = String(r.Status || "Pending");
    if (status === "Solved" || status === "Closed" || status === "Void") continue;
    var canResolve = !!me && (admin || String(r.User_Email) === me);
    list.push({
      id: String(r.Issue_ID || ""), time: String(r.Timestamp || ""), detail: String(r.Detail || ""),
      status: status, files: splitUrls_(r.File_URLs), links: parseLinks_(r.Links), solutions: byIssue[String(r.Issue_ID)] || [],
      canResolve: canResolve
    }); // ไม่ส่ง User_Email
  }
  return { status: "ok", count: list.length, issues: list };
}

function myHistory_(idToken, emailParam) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบใหม่เพื่อดูประวัติ");
  var email = verifyIdToken_(idToken).email;
  if (emailParam && emailParam !== email) throw new Error("email mismatch");

  var works = readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
    .filter(function (r) { return String(r.User_Email) === email && !isVoided_(r); })
    .map(function (r) {
      return { type: "work", id: String(r.Log_ID), time: String(r.Timestamp), detail: String(r.Detail), category: String(r.Category || "work"), files: splitUrls_(r.File_URLs), links: parseLinks_(r.Links) };
    });

  var issues = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
    .filter(function (r) { return String(r.User_Email) === email && !isVoided_(r); })
    .map(function (r) {
      return { type: "issue", id: String(r.Issue_ID), time: String(r.Timestamp), detail: String(r.Detail), status: String(r.Status || "Pending"), category: String(r.Category || "issue"), files: splitUrls_(r.File_URLs), links: parseLinks_(r.Links) };
    });

  var all = works.concat(issues).sort(function (a, b) { return a.time < b.time ? 1 : -1; });
  return { status: "ok", email: email, isAdmin: isAdmin_(email), count: all.length, items: all };
}

function knowledgeBase_(idToken, emailParam) {
  var me = idToken ? verifyIdToken_(idToken).email : null;

  var iss = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES);
  var sols = readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS);
  var likes = readObjects_(getSheet_(SHEETS.LIKES, HEADERS.LIKES), HEADERS.LIKES);

  var byIssue = {};
  sols.forEach(function (s) {
    var k = String(s.Issue_ID);
    (byIssue[k] = byIssue[k] || []).push({ text: String(s.Solution_Text || ""), by: String(s.Proposer_Name || "เพื่อนร่วมงาน") });
  });

  var list = [];
  iss.forEach(function (r) {
    if (String(r.Status) === "Void") return;
    if (String(r.Status) !== "Solved") return;
    if (!isTruthy_(r.KB_Approved)) return;   // ต้องผ่านการอนุมัติจากแอดมินก่อน
    var id = String(r.Issue_ID);
    var likeList = likes.filter(function (l) { return String(l.Issue_ID) === id; });
    list.push({
      id: id, time: String(r.Timestamp || ""), detail: String(r.Detail || ""),
      files: splitUrls_(r.File_URLs), links: parseLinks_(r.Links), solutions: byIssue[id] || [],
      solver: String(r.Solved_By || ""), likeCount: likeList.length,
      likedByMe: !!me && likeList.some(function (l) { return String(l.User_Email) === me; })
    });
  });
  list.sort(function (a, b) { return a.time < b.time ? 1 : -1; });
  return { status: "ok", count: list.length, articles: list };
}

function myProfile_(idToken, emailParam) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบใหม่เพื่อดูโปรไฟล์");
  var info = verifyIdToken_(idToken);
  var email = info.email;
  if (emailParam && emailParam !== email) throw new Error("email mismatch");

  var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
  var row = findRowByHeader_(ush, "Email", email);
  var map = headerMap_(ush);
  var totalXp = row === -1 ? 0 : Number(ush.getRange(row, map["Total_XP"]).getValue() || 0);
  var name = row === -1 ? (info.name || "") : String(ush.getRange(row, map["Full_Name"]).getValue() || info.name || "");

  var lv = levelFor_(totalXp);
  var history = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.User_Email) === email && String(h.Reason || "").indexOf("rejected:") !== 0; })
    .map(function (h) { return { time: String(h.Timestamp || ""), amount: Number(h.Amount || 0), reason: String(h.Reason || "") }; })
    .sort(function (a, b) { return a.time < b.time ? 1 : -1; })
    .slice(0, 50);

  return {
    status: "ok", email: email, name: name, totalXp: totalXp, isAdmin: isAdmin_(email),
    level: lv.level, title: lv.title, minXp: lv.minXp, nextXp: lv.nextMinXp, nextTitle: lv.nextTitle,
    history: history
  };
}

function activeNotifications_(idToken) {
  if (!idToken) return { status: "ok", notifications: [] };
  var email = verifyIdToken_(idToken).email;

  var notifs = readObjects_(getSheet_(SHEETS.NOTIFICATIONS, HEADERS.NOTIFICATIONS), HEADERS.NOTIFICATIONS)
    .filter(function (n) { return n.Active === true || String(n.Active).toUpperCase() === "TRUE"; });
  var acks = readObjects_(getSheet_(SHEETS.NOTIF_ACKS, HEADERS.NOTIF_ACKS), HEADERS.NOTIF_ACKS)
    .filter(function (a) { return String(a.User_Email) === email; })
    .map(function (a) { return String(a.Notif_ID); });

  var pending = notifs.filter(function (n) { return acks.indexOf(String(n.Notif_ID)) === -1; })
    .map(function (n) { return { id: String(n.Notif_ID), message: String(n.Message || ""), time: String(n.Created_At || "") }; });

  return { status: "ok", count: pending.length, notifications: pending };
}

function submitResult_(clientRef, idToken) {
  if (!clientRef) throw new Error("missing clientRef");
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบใหม่");
  var email = verifyIdToken_(idToken).email;

  var xpRow = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.Client_Ref) === String(clientRef) && String(h.User_Email) === email; })[0];
  if (!xpRow) return { status: "ok", found: false };

  if (String(xpRow.Reason || "").indexOf("rejected:") === 0) {
    return { status: "ok", found: true, rejected: true, message: String(xpRow.Reason).slice("rejected:".length).trim() };
  }

  var refId = String(xpRow.Ref_ID || "");
  var reason = String(xpRow.Reason || "");
  var type = reason === "issue" ? "issue" : "work";

  var timestamp = String(xpRow.Timestamp || "");
  var category = reason;
  if (type === "work") {
    var w = readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
      .filter(function (r) { return String(r.Log_ID) === refId; })[0];
    if (w) { timestamp = String(w.Timestamp); category = String(w.Category || "work"); }
  } else {
    var it = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
      .filter(function (r) { return String(r.Issue_ID) === refId; })[0];
    if (it) { timestamp = String(it.Timestamp); category = String(it.Category || "issue"); }
  }

  var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
  var row = findRowByHeader_(ush, "Email", email);
  var map = headerMap_(ush);
  var totalXp = row === -1 ? 0 : Number(ush.getRange(row, map["Total_XP"]).getValue() || 0);
  var lv = levelFor_(totalXp);

  return {
    status: "ok", found: true, type: type, category: category, refId: refId,
    amount: Number(xpRow.Amount || 0), timestamp: timestamp,
    totalXp: totalXp, level: lv.level, title: lv.title, nextXp: lv.nextMinXp
  };
}

/* ======================================================================
 * [5b] Admin data: overview + export (Phase 4)
 * ==================================================================== */
function adminOverview_(idToken) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  if (!isAdmin_(email)) throw new Error("เฉพาะแอดมินเท่านั้น");

  var iss = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES);
  var pending = iss.filter(function (r) { return String(r.Status) === "Solved" && !isTruthy_(r.KB_Approved); })
    .map(function (r) {
      return { id: String(r.Issue_ID), time: String(r.Timestamp || ""), detail: String(r.Detail || ""),
               solver: String(r.Solved_By || ""), files: splitUrls_(r.File_URLs) };
    })
    .sort(function (a, b) { return a.time < b.time ? 1 : -1; });

  var users = readObjects_(getSheet_(SHEETS.USERS, HEADERS.USERS), HEADERS.USERS)
    .map(function (u) {
      return { email: String(u.Email || ""), name: String(u.Full_Name || ""),
               totalXp: Number(u.Total_XP || 0), level: Number(u.Level || 1), role: String(u.Role || "User") };
    });

  var notifs = readObjects_(getSheet_(SHEETS.NOTIFICATIONS, HEADERS.NOTIFICATIONS), HEADERS.NOTIFICATIONS)
    .filter(function (n) { return isTruthy_(n.Active); })
    .map(function (n) { return { id: String(n.Notif_ID), message: String(n.Message || ""), time: String(n.Created_At || "") }; })
    .sort(function (a, b) { return a.time < b.time ? 1 : -1; });

  var rules = getXpRules_().map(function (r) { return { level: r.level, title: r.title, min: r.min }; });

  return { status: "ok", pendingApprovals: pending, users: users, notifications: notifs, rules: rules };
}

/* รายการส่งข้อมูลทั้งหมด (งาน/ปัญหา) สำหรับแอดมิน ตรวจสอบ + ยกเลิก */
function adminSubmissions_(idToken, type, q, includeVoided) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  if (!isAdmin_(email)) throw new Error("เฉพาะแอดมินเท่านั้น");

  var names = {};
  readObjects_(getSheet_(SHEETS.USERS, HEADERS.USERS), HEADERS.USERS)
    .forEach(function (u) { names[String(u.Email)] = String(u.Full_Name || ""); });

  var wantVoided = isTruthy_(includeVoided);
  var ql = String(q || "").trim().toLowerCase();
  var matches = function (o) {
    if (!ql) return true;
    return String(o.Detail || "").toLowerCase().indexOf(ql) !== -1
        || String(o.User_Email || "").toLowerCase().indexOf(ql) !== -1
        || String(names[String(o.User_Email)] || "").toLowerCase().indexOf(ql) !== -1;
  };

  var list = [];
  if (type !== "issue") {
    readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
      .filter(matches).forEach(function (r) {
        var v = isVoided_(r);
        if (v && !wantVoided) return;
        list.push({
          type: "work", id: String(r.Log_ID || ""), time: String(r.Timestamp || ""),
          user: String(r.User_Email || ""), name: names[String(r.User_Email)] || "",
          detail: String(r.Detail || ""), category: String(r.Category || "work"), voided: v,
          voidReason: String(r.Void_Reason || ""), voidedBy: String(r.Voided_By || ""), voidedAt: String(r.Voided_At || "")
        });
      });
  }
  if (type !== "work") {
    readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
      .filter(matches).forEach(function (r) {
        var v = isVoided_(r);
        if (v && !wantVoided) return;
        list.push({
          type: "issue", id: String(r.Issue_ID || ""), time: String(r.Timestamp || ""),
          user: String(r.User_Email || ""), name: names[String(r.User_Email)] || "",
          detail: String(r.Detail || ""), category: String(r.Category || "issue"),
          status: String(r.Status || "Pending"), voided: v,
          voidReason: String(r.Void_Reason || ""), voidedBy: String(r.Voided_By || ""), voidedAt: String(r.Voided_At || "")
        });
      });
  }

  list.sort(function (a, b) { return a.time < b.time ? 1 : -1; });
  var capped = list.slice(0, 200);
  return { status: "ok", count: list.length, shown: capped.length, items: capped, canVoid: true };
}

function exportData_(idToken, type) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  if (!isAdmin_(email)) throw new Error("เฉพาะแอดมินเท่านั้น");

  var names = {};
  readObjects_(getSheet_(SHEETS.USERS, HEADERS.USERS), HEADERS.USERS)
    .forEach(function (u) { names[String(u.Email)] = String(u.Full_Name || ""); });

  if (type === "issues") {
    var rows = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES).map(function (r) {
      return {
        "วันที่-เวลา": String(r.Timestamp || ""),
        "ชื่อผู้แจ้ง": names[String(r.User_Email)] || "",
        "อีเมล": String(r.User_Email || ""),
        "รายละเอียด": String(r.Detail || ""),
        "หมวดหมู่ (AI)": String(r.Category || ""),
        "สถานะ": String(r.Status || ""),
        "อนุมัติขึ้น KB": isTruthy_(r.KB_Approved) ? "Yes" : "No",
        "ผู้แก้ไข/ผู้เสนอ": String(r.Solved_By || ""),
        "วิธีแก้ไข": String(r.Solution || ""),
        "ไฟล์แนบ": splitUrls_(r.File_URLs).join("\n"),
        "ลิงก์เพิ่มเติม": formatLinks_(r.Links)
      };
    });
    rows.sort(function (a, b) { return a["วันที่-เวลา"] < b["วันที่-เวลา"] ? 1 : -1; });
    return { status: "ok", type: "issues", count: rows.length, rows: rows };
  }

  var rows2 = readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS).map(function (r) {
    return {
      "วันที่-เวลา": String(r.Timestamp || ""),
      "ชื่อผู้บันทึก": names[String(r.User_Email)] || "",
      "อีเมล": String(r.User_Email || ""),
      "รายละเอียด": String(r.Detail || ""),
      "หมวดหมู่ (AI)": String(r.Category || ""),
      "สถานะ": isVoided_(r) ? "Void (ถูกยกเลิก)" : "Active",
      "ไฟล์แนบ": splitUrls_(r.File_URLs).join("\n"),
      "ลิงก์เพิ่มเติม": formatLinks_(r.Links)
    };
  });
  rows2.sort(function (a, b) { return a["วันที่-เวลา"] < b["วันที่-เวลา"] ? 1 : -1; });
  return { status: "ok", type: "worklogs", count: rows2.length, rows: rows2 };
}

function isTruthy_(v) { return v === true || String(v).toUpperCase() === "TRUE"; }

/* ======================================================================
 * [6] XP / Level
 * ==================================================================== */
function getXpRules_() {
  var sh = getSheet_(SHEETS.XP_RULES, HEADERS.XP_RULES);
  if (sh.getLastRow() < 2) {
    SEED_XP_RULES.forEach(function (r) { sh.appendRow(r); });
    sh.getRange(2, 1, SEED_XP_RULES.length, 3).setValues(SEED_XP_RULES);
  }
  var rules = readObjects_(sh, HEADERS.XP_RULES)
    .map(function (r) { return { level: Number(r.Level) || 0, title: String(r.Title || "Level " + r.Level), min: Number(r.Min_XP) || 0 }; })
    .sort(function (a, b) { return a.min - b.min; });
  return rules;
}

function levelFor_(totalXp) {
  return computeLevel_(getXpRules_(), totalXp);
}

/* คำนวณ Level จากชุดเกณฑ์ที่ส่งเข้ามา (ใช้ซ้ำได้ ไม่ต้องอ่านชีตทุกครั้ง) */
function computeLevel_(rules, totalXp) {
  if (!rules || !rules.length) return { level: 1, title: "Level 1", minXp: 0, nextMinXp: null, nextTitle: null };
  var cur = rules[0], next = null;
  for (var i = 0; i < rules.length; i++) {
    if (totalXp >= rules[i].min) cur = rules[i];
    else { next = rules[i]; break; }
  }
  return { level: cur.level, title: cur.title, minXp: cur.min, nextMinXp: next ? next.min : null, nextTitle: next ? next.title : null };
}

function awardXp_(email, amount, reason, refId, clientRef) {
  var xsh = getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY);
  var ts = nowStr_();
  appendByHeaders_(xsh, HEADERS.XP_HISTORY, {
    XP_ID: "XP-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
    Timestamp: ts, User_Email: email, Amount: amount, Reason: reason, Ref_ID: refId || "", Client_Ref: clientRef || ""
  });

  var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
  var map = headerMap_(ush);
  var row = findRowByHeader_(ush, "Email", email);
  var total;
  if (row === -1) {
    appendByHeaders_(ush, HEADERS.USERS, { Email: email, Full_Name: "", Total_XP: amount, Level: 1, Last_Login: ts });
    row = findRowByHeader_(ush, "Email", email);
    total = amount;
  } else {
    total = Number(ush.getRange(row, map["Total_XP"]).getValue() || 0) + amount;
    ush.getRange(row, map["Total_XP"]).setValue(total);
  }
  var lv = levelFor_(total);
  ush.getRange(row, map["Level"]).setValue(lv.level);
  return { totalXp: total, level: lv.level, title: lv.title };
}

/* ======================================================================
 * [7] AI จำแนกข้อความ + ตรวจความเกี่ยวข้องกับงาน (Gemini + fallback)
 * ==================================================================== */
function assessContent_(text) {
  try { return assessWithGemini_(text); }
  catch (err) { console.warn("Gemini failed: " + err); return assessByKeywords_(text); }
}

function assessWithGemini_(text) {
  var key = PropertiesService.getScriptProperties().getProperty(GEMINI_PROP);
  if (!key) throw new Error("ยังไม่ได้ตั้งค่า " + GEMINI_PROP);

  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + key;
  var prompt =
    "คุณเป็นผู้ช่วยตรวจสอบบันทึกของนักวิชาการโสตทัศนศึกษา (งานเครื่องเสียง/ภาพ/แสง/อุปกรณ์ AV ในมหาวิทยาลัย)\n" +
    "1) จัดหมวด: \"work\" = งานที่ทำ/สำเร็จ (ตั้งระบบ ถ่ายภาพ คุมระบบ ประชุม กิจกรรม) หรือ \"issue\" = อุปกรณ์เสีย/ชำรุด/ค้าง/ต้องซ่อม\n" +
    "2) ตรวจความเกี่ยวข้อง: \"valid\" = true ถ้าข้อความเกี่ยวข้องกับงานโสตทัศนศึกษา/งานในองค์กร และ false ถ้าไม่เกี่ยวข้อง " +
    "(เช่น เรื่องส่วนตัว การเมือง การประท้วง ทวงสิทธิ์ ด่าผู้บริหาร ขายของ เกม บันเทิง ฯลฯ)\n" +
    "ตอบ JSON รูปแบบ {\"category\":\"work\"|\"issue\",\"valid\":true|false} เท่านั้น";

  var payload = {
    contents: [{ parts: [{ text: prompt + "\n\nข้อความ:\n" + text }] }],
    generationConfig: {
      temperature: 0, responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          category: { type: "STRING", enum: ["work", "issue"] },
          valid: { type: "BOOLEAN" }
        },
        required: ["category", "valid"]
      }
    }
  };
  var res = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("Gemini HTTP " + res.getResponseCode());
  var out = JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
  var j = JSON.parse(out);
  return {
    category: (String(j.category).toLowerCase() === "issue") ? "issue" : "work",
    valid: j.valid !== false
  };
}

function assessByKeywords_(text) {
  return { category: classifyByKeywords_(text), valid: classifyOffTopic_(text) };
}

function classifyByKeywords_(text) {
  var t = String(text || "").toLowerCase();
  var issueWords = ["เสีย", "ชำรุด", "ค้าง", "ปัญหา", "ไม่ทำงาน", "ซ่อม", "พัง", "error", "ฟ้อง", "ซ่า",
    "แตก", "หลุด", "ช้า", "เบลอ", "ไม่มีเสียง", "เปิดไม่ติด", "จอดับ", "เชื่อมต่อไม่ได้", "ผิดพลาด", "ใช้งานไม่ได้", "แจ้งซ่อม"];
  for (var i = 0; i < issueWords.length; i++) if (t.indexOf(issueWords[i]) !== -1) return "issue";
  return "work";
}

function classifyOffTopic_(text) {
  var t = String(text || "").toLowerCase();
  for (var i = 0; i < OFF_TOPIC_WORDS.length; i++) if (t.indexOf(OFF_TOPIC_WORDS[i]) !== -1) return false;
  return true;
}

/* ======================================================================
 * [7b] ป้องกันการใช้งานผิด: สแปม / เนื้อหาซ้ำ / เนื้อหาไม่เกี่ยวกับงาน
 * ==================================================================== */
function validateAndAssess_(email, detail, clientRef) {
  var d = String(detail || "").trim();
  if (d.length < MIN_DETAIL_CHARS) rejectSubmission_(email, d, clientRef, "ข้อความสั้นเกินไป (อย่างน้อย " + MIN_DETAIL_CHARS + " ตัวอักษร) กรุณากรอกรายละเอียดงานให้ชัดเจนขึ้น");

  var spam = checkRateLimit_(email);
  if (spam.blocked) rejectSubmission_(email, d, clientRef, spam.msg);

  if (checkDuplicate_(email, d)) rejectSubmission_(email, d, clientRef, "เนื้อหานี้ซ้ำ/คล้ายกับรายการที่คุณบันทึกไว้แล้ว โปรดตรวจสอบที่แท็บ 🗂️ ประวัติ");

  var a = assessContent_(d);
  if (REJECT_NON_WORK && a.valid === false) rejectSubmission_(email, d, clientRef, "เนื้อหาไม่เกี่ยวข้องกับงานโสตทัศนศึกษา กรุณาบันทึกเฉพาะงาน/ปัญหาในการทำงานเท่านั้น");
  return a;
}

/* บันทึกการปฏิเสธลง XP_History (Amount=0, Reason=rejected:...) แล้วโยน Error
   เพื่อให้ฝั่ง frontend ดึงข้อความผ่าน submitResult ได้ */
function rejectSubmission_(email, detail, clientRef, message) {
  var xsh = getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY);
  appendByHeaders_(xsh, HEADERS.XP_HISTORY, {
    XP_ID: "REJ-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
    Timestamp: nowStr_(), User_Email: email, Amount: 0,
    Reason: "rejected: " + message, Ref_ID: "", Client_Ref: clientRef || ""
  });
  throw new Error(message);
}

function checkRateLimit_(email) {
  var hist = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) {
      var r = String(h.Reason || "");
      return String(h.User_Email) === email && (r === "work_log" || r === "issue" || r.indexOf("rejected:") === 0);
    });
  var now = Date.now();
  var last = 0, count = 0;
  for (var i = 0; i < hist.length; i++) {
    var t = parseBkkTs_(String(hist[i].Timestamp));
    if (!t) continue;
    var epoch = t.getTime();
    if (epoch > last) last = epoch;
    if (now - epoch <= SPAM_WINDOW_MIN * 60000) count++;
  }
  if (last && now - last < SPAM_MIN_INTERVAL_SEC * 1000) {
    var wait = Math.ceil((SPAM_MIN_INTERVAL_SEC * 1000 - (now - last)) / 1000);
    return { blocked: true, msg: "กรุณารออีก " + wait + " วินาที ก่อนส่งรายการถัดไป" };
  }
  if (count >= SPAM_MAX_PER_WINDOW) {
    return { blocked: true, msg: "ส่งข้อมูลถี่เกินไป (เกิน " + SPAM_MAX_PER_WINDOW + " ครั้ง ใน " + SPAM_WINDOW_MIN + " นาที) กรุณารอสักครู่" };
  }
  return { blocked: false };
}

function checkDuplicate_(email, detail) {
  var norm = normalizeText_(detail);
  if (!norm) return false;
  var lookback = Date.now() - DUP_LOOKBACK_HOURS * 3600000;
  var rows = readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
    .concat(readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES))
    .filter(function (r) { return String(r.User_Email) === email && !isVoided_(r); });
  for (var i = 0; i < rows.length; i++) {
    var t = parseBkkTs_(String(rows[i].Timestamp));
    if (t && t.getTime() < lookback) continue;
    var n2 = normalizeText_(String(rows[i].Detail || ""));
    if (!n2) continue;
    if (n2 === norm || norm.indexOf(n2) !== -1 || n2.indexOf(norm) !== -1) return true;
    if (textSimilarity_(norm, n2) >= DUP_SIMILARITY) return true;
  }
  return false;
}

function normalizeText_(s) {
  return String(s || "").toLowerCase()
    .replace(/[^\u0E00-\u0E7Fa-zA-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams_(s) {
  var out = [];
  for (var i = 0; i < s.length - 1; i++) out.push(s.substr(i, 2));
  return out;
}

function textSimilarity_(a, b) {
  var ga = bigrams_(a), gb = bigrams_(b);
  if (!ga.length && !gb.length) return 1;
  if (!ga.length || !gb.length) return 0;
  var ca = {}, cb = {}, keys = {};
  for (var i = 0; i < ga.length; i++) { ca[ga[i]] = (ca[ga[i]] || 0) + 1; keys[ga[i]] = 1; }
  for (var j = 0; j < gb.length; j++) { cb[gb[j]] = (cb[gb[j]] || 0) + 1; keys[gb[j]] = 1; }
  var inter = 0, union = 0;
  Object.keys(keys).forEach(function (k) {
    var x = ca[k] || 0, y = cb[k] || 0;
    inter += Math.min(x, y);
    union += Math.max(x, y);
  });
  return union ? inter / union : 0;
}

/* แปลง "yyyy-MM-dd HH:mm:ss" (เวลาไทย) เป็น Date (Bangkok = UTC+7) */
function parseBkkTs_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 7 * 3600000);
}

/* ======================================================================
 * [7c] แอดมินยกเลิกรายการ (Soft-void) + audit + คืน XP
 * ==================================================================== */
/* เช็กว่ารายการถูกยกเลิกแล้วหรือยัง (Status = "Void") */
function isVoided_(r) { return String(r && r.Status || "").trim() === "Void"; }

/* ยกเลิก record ของผู้ใช้ (งาน/ปัญหา) โดยแอดมิน: ติดธง Void + เก็บ audit + หัก XP คืน */
function handleVoidRecord_(adminEmail, recordType, recordId, reason) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!recordId) throw new Error("ไม่พบรหัสรายการ");
  reason = String(reason || "").trim();
  if (!reason) throw new Error("กรุณาระบุเหตุผลในการยกเลิก");

  var type = (String(recordType) === "issue") ? "issue" : "work";
  var sh = type === "issue"
    ? getSheet_(SHEETS.ISSUES, HEADERS.ISSUES)
    : getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
  var idHeader = type === "issue" ? "Issue_ID" : "Log_ID";

  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("ไม่พบรายการนี้ (อาจถูกลบจากชีตไปแล้ว)");
  var map = headerMap_(sh);
  var cur = String(sh.getRange(row, map["Status"]).getValue() || "");
  if (cur === "Void") throw new Error("รายการนี้ถูกยกเลิกไปแล้ว");

  var owner = String(sh.getRange(row, map["User_Email"]).getValue() || "");
  var ts = nowStr_();
  sh.getRange(row, map["Status"]).setValue("Void");
  if (map["Void_Reason"]) sh.getRange(row, map["Void_Reason"]).setValue(reason.slice(0, 200));
  if (map["Voided_By"])   sh.getRange(row, map["Voided_By"]).setValue(adminEmail);
  if (map["Voided_At"])   sh.getRange(row, map["Voided_At"]).setValue(ts);

  var reversed = reverseXpForRecord_(owner, recordId, reason);
  return json_({ status: "ok", type: type, id: recordId, reversedXp: reversed, message: "ยกเลิกรายการเรียบร้อย" });
}

/* หัก XP คืนสำหรับ record: เพิ่มแถว XP_History (Amount ติดลบ) + ลด Total_XP + recompute Level
   กันซ้ำ: ถ้ามีแถว Reason="void" สำหรับ Ref_ID เดิมแล้ว จะไม่หักซ้ำ */
function reverseXpForRecord_(email, recordId, reason) {
  var xsh = getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY);
  var rows = readObjects_(xsh, HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.Ref_ID) === String(recordId); });
  if (rows.some(function (h) { return String(h.Reason) === "void"; })) return 0;
  var base = 0;
  rows.forEach(function (h) {
    var r = String(h.Reason);
    if (r === "work_log" || r === "issue") base += Number(h.Amount || 0);
  });
  if (!base) return 0;

  appendByHeaders_(xsh, HEADERS.XP_HISTORY, {
    XP_ID: "XP-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
    Timestamp: nowStr_(), User_Email: email, Amount: -base, Reason: "void",
    Ref_ID: recordId, Client_Ref: ("void: " + reason).slice(0, 100)
  });

  if (email) {
    var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
    var map = headerMap_(ush);
    var urow = findRowByHeader_(ush, "Email", email);
    if (urow !== -1) {
      var total = Number(ush.getRange(urow, map["Total_XP"]).getValue() || 0) - base;
      if (total < 0) total = 0;
      ush.getRange(urow, map["Total_XP"]).setValue(total);
      ush.getRange(urow, map["Level"]).setValue(levelFor_(total).level);
    }
  }
  return base;
}

/* ======================================================================
 * [8] Auth / Admin / Drive
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

function isAdmin_(email) {
  if (!email) return false;
  try {
    var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
    var row = findRowByHeader_(ush, "Email", email);
    if (row !== -1) {
      var map = headerMap_(ush);
      if (map["Role"] && String(ush.getRange(row, map["Role"]).getValue()).toLowerCase() === "admin") return true;
    }
  } catch (e) {}
  var list = PropertiesService.getScriptProperties().getProperty(ADMIN_PROP) || "";
  return list.split(",").map(function (s) { return s.trim().toLowerCase(); }).indexOf(String(email).toLowerCase()) !== -1;
}

function uploadFiles_(files) {
  if (!files || !files.length) return [];
  var folder = getOrCreateFolder_(DRIVE_FOLDER);
  var urls = [];
  files.forEach(function (f, i) {
    try {
      if (!f || !f.base64) return;
      var bytes = Utilities.base64Decode(f.base64);
      var blob = Utilities.newBlob(bytes, f.mimeType || "application/octet-stream", f.name || ("file-" + (i + 1)));
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
 * [9] Sheet helpers (อ้างชื่อคอลัมน์ ทนต่อการเพิ่มคอลัมน์)
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
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) return i + 2;
  return -1;
}

function assertOwner_(sh, row, emailHeader, email) {
  var map = headerMap_(sh);
  if (String(sh.getRange(row, map[emailHeader]).getValue() || "") !== email) throw new Error("ไม่มีสิทธิ์แก้ไขรายการนี้");
}

function appendFileUrls_(sh, row, urls) {
  if (!urls || !urls.length) return;
  var map = headerMap_(sh);
  var col = map["File_URLs"];
  var cur = String(sh.getRange(row, col).getValue() || "");
  sh.getRange(row, col).setValue((cur ? cur + "\n" : "") + urls.join("\n"));
}

function splitUrls_(v) {
  var s = String(v || "").trim();
  return s ? s.split(/\s*\n\s*/).filter(function (x) { return x; }) : [];
}

/* ---------- ลิงก์ข้อมูลเพิ่มเติม (เก็บเป็น JSON ในคอลัมน์ Links) ---------- */
function parseLinks_(v) {
  var s = String(v || "").trim();
  if (!s) return [];
  try {
    var a = JSON.parse(s);
    if (Array.isArray(a)) {
      return a.map(function (x) {
        return { t: String((x && x.t) || ""), u: String((x && x.u) || "") };
      }).filter(function (x) { return x.u; });
    }
  } catch (e) {}
  // รองรับข้อมูลเก่า: บรรทัดละ 1 ลิงก์ (ไม่มีชื่อกำกับ)
  return splitUrls_(s).map(function (u) { return { t: "", u: u }; });
}
function serializeLinks_(links) {
  var clean = (links || []).map(function (x) {
    return { t: String((x && x.t) || "").slice(0, 80), u: String((x && x.u) || "") };
  }).filter(function (x) { return x.u; });
  return JSON.stringify(clean);
}
function normalUrl_(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.slice(0, 1000);
}
function formatLinks_(v) {
  var links = parseLinks_(v);
  return links.map(function (l) { return (l.t ? l.t + ": " : "") + l.u; }).join("\n");
}

function nowStr_() { return Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss"); }
function rand3_() { return Math.floor(Math.random() * 900 + 100); }

function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function output_(obj, callback) {
  var s = JSON.stringify(obj);
  if (callback) return ContentService.createTextOutput(callback + "(" + s + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
  return json_(obj);
}

/* ======================================================================
 * [10] Admin Menu
 * ==================================================================== */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚙️ HR Exp Admin")
    .addItem("1) ตั้งค่า/อัปเกรดชีต", "setupSheets")
    .addItem("2) ตั้งค่า Gemini API Key", "setGeminiKey")
    .addItem("3) ตั้งค่าแอดมิน (ADMIN_EMAILS)", "setAdminEmails")
    .addItem("4) สร้างประกาศแจ้งเตือนใหม่", "createNotification")
    .addSeparator()
    .addItem("Export ทั้งหมดเป็น Excel (.xlsx)", "exportAllExcel")
    .addItem("Export ชีตปัจจุบันเป็น CSV", "exportCurrentCsv")
    .addItem("Export Work_Logs เป็น CSV", "exportWorkLogsCsv")
    .addItem("Export Issues เป็น CSV", "exportIssuesCsv")
    .addItem("Export Solutions เป็น CSV", "exportSolutionsCsv")
    .addItem("Export XP_History เป็น CSV", "exportXpHistoryCsv")
    .addSeparator()
    .addItem("ดูลิงก์ Web App", "showWebAppUrl")
    .addToUi();
}

function setupSheets() {
  Object.keys(SHEETS).forEach(function (k) { getSheet_(SHEETS[k], HEADERS[k]); });
  getXpRules_(); // seed ค่าเริ่มต้นถ้ายังว่าง
  SpreadsheetApp.getUi().alert(
    "อัปเกรดชีต เรียบร้อย:\n" +
    "• Users (+Role), Work_Logs (+Links), Issues (+KB_Approved, +Links)\n" +
    "• Solutions, XP_History, XP_Rules, Likes\n" +
    "• Notifications, Notif_Acks"
  );
}

function setGeminiKey() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt("ตั้งค่า Gemini API Key", "วาง API Key (ขึ้นต้น AIza...):", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty(GEMINI_PROP, res.getResponseText().trim());
    ui.alert("บันทึก GEMINI_API_KEY เรียบร้อย");
  }
}

function setAdminEmails() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt("ตั้งค่าแอดมิน", "ใส่อีเมลแอดมิน คั่นด้วยเครื่องหมาย , เช่น a@kku.ac.th,b@kku.ac.th", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty(ADMIN_PROP, res.getResponseText().trim());
    ui.alert("บันทึก ADMIN_EMAILS เรียบร้อย");
  }
}

function createNotification() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt("สร้างประกาศแจ้งเตือน", "พิมพ์ข้อความที่ต้องการให้ผู้ใช้ทุกคนเห็น:", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var msg = res.getResponseText().trim();
  if (!msg) { ui.alert("ข้อความว่าง"); return; }

  var sh = getSheet_(SHEETS.NOTIFICATIONS, HEADERS.NOTIFICATIONS);
  appendByHeaders_(sh, HEADERS.NOTIFICATIONS, {
    Notif_ID: "NOTI-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss"),
    Message: msg, Created_At: nowStr_(), Active: true
  });
  ui.alert("สร้างประกาศเรียบร้อย ผู้ใช้จะเห็นเมื่อเปิดแอปครั้งถัดไป");
}

function exportAllExcel() { openLink_("Export ทั้งหมด (Excel)", "https://docs.google.com/spreadsheets/d/" + getSpreadsheet_().getId() + "/export?format=xlsx"); }
function exportCurrentCsv() { var sh = SpreadsheetApp.getActiveSheet(); openLink_("Export ชีต: " + sh.getName(), csvUrl_(getSpreadsheet_().getId(), sh.getSheetId())); }
function exportWorkLogsCsv()  { openLink_("Export Work_Logs (CSV)",  csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.WORK_LOGS))); }
function exportIssuesCsv()    { openLink_("Export Issues (CSV)",    csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.ISSUES))); }
function exportSolutionsCsv() { openLink_("Export Solutions (CSV)", csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.SOLUTIONS))); }
function exportXpHistoryCsv() { openLink_("Export XP_History (CSV)",csvUrl_(getSpreadsheet_().getId(), sheetIdByName_(SHEETS.XP_HISTORY))); }

function csvUrl_(ssId, gid) { return "https://docs.google.com/spreadsheets/d/" + ssId + "/export?format=csv&gid=" + gid; }
function sheetIdByName_(name) { var sh = getSpreadsheet_().getSheetByName(name); return sh ? sh.getSheetId() : 0; }

function exportSheetAsCsv_(name) {
  var sh = getSheet_(name, HEADERS[name] || []);
  var values = sh.getDataRange().getValues();
  return values.map(function (row) {
    return row.map(function (cell) { return '"' + String(cell == null ? "" : cell).replace(/"/g, '""') + '"'; }).join(",");
  }).join("\r\n");
}

function openLink_(title, url) {
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Sarabun,Arial;padding:16px;text-align:center">' +
    '<h3 style="margin:0 0 8px">' + title + '</h3>' +
    '<p style="font-size:13px;color:#555">คลิกปุ่มด้านล่างเพื่อดาวน์โหลด</p>' +
    '<a href="' + url + '" target="_blank" style="display:inline-block;margin-top:8px;padding:12px 22px;background:#7f1d1d;color:#fff;text-decoration:none;border-radius:10px;font-weight:bold">⬇️ ดาวน์โหลดไฟล์</a></div>'
  ).setWidth(340).setHeight(200);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}

function showWebAppUrl() { SpreadsheetApp.getUi().alert("ลิงก์ Web App:\n\n" + ScriptApp.getService().getUrl()); }
