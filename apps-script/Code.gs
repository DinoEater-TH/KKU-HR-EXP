/************************************************************************
 * KKU HR Exp — Phase 6.17 Backend  (Google Apps Script: Code.gs)
 * สำหรับ "นักวิชาการโสตทัศนศึกษา" มหาวิทยาลัยขอนแก่น
 *
 * โครงสร้างทั้งหมด (Phase 1-5)
 *   Sheets: Users, Work_Logs, Issues, Solutions,
 *           XP_History, XP_Rules, Likes, Notifications, Notif_Acks
 *   API   : doGet (อ่านข้อมูล → JSON) / doPost (เขียนข้อมูล)
 *   AI    : Gemini จำแนกข้อความ + ตรวจความเกี่ยวข้อง (คีย์เก็บใน Script Properties)
 *   Game  : XP / Level / Title ตามตาราง XP_Rules
 *   KB    : คลังองค์ความรู้จากเคสที่แก้สำเร็จ + กดถูกใจรายข้อเสนอแนะ (ได้ XP ตามที่แอดมินตั้งค่า)
 *   Notify: ประกาศจาก Admin (บังหน้าจอจนกว่าจะรับทราบ)
 *   Guard : กันสแปม / เนื้อหาซ้ำ / เนื้อหาไม่เกี่ยวกับงาน (Phase 5)
 *   Audit : แอดมินยกเลิกรายการ (Soft-void) หัก XP คืน + audit trail (Phase 5.1)
 *   Dash  : แดชบอร์ดผู้ใช้ + จัดอันดับ + ดูข้อมูลรายบุคคล (admin) (Phase 5.2)
 *   RPG   : โบนัส Streak (บันทึกต่อเนื่องรายวัน + milestone) (Phase 6.0)
 *   RPG   : Achievements / เหรียญตรา ปลดล็อก + XP (Phase 6.1)
 *   Edit  : เจ้าของแก้ไขข้อความรายการของตัวเองได้ (Phase 6.4)
 *   Soln  : เสนอแนวทางแก้ไขได้ครั้งเดียว/รายการ + แก้ข้อความที่เสนอได้ (Phase 6.5)
 *   Back  : บันทึกงานย้อนหลังได้ (ระบุวันที่/เวลา) — ย้อนหลังเกิน 3 เดือนไม่ได้ XP (Phase 6.13)
 *   Dedupe: ซ่อนวิธีแก้ไขที่ซ้ำ/ใกล้เคียงกันในบอร์ดและคลังองค์ความรู้ (Phase 6.14)
 *   Like  : กดถูกใจราย "ข้อเสนอแนะ" (ไม่ใช่รายรายการ) — เจ้าของได้ XP ต่อผู้กด 1 คน (Phase 6.16)
 *   KB2   : ต้องมีข้อเสนอแนะ ≥1 ก่อนยืนยันสำเร็จ + เข้าคลังอัตโนมัติ + แอดมินลบข้อเสนอแนะได้ (คืน XP ทั้งหมด) (Phase 6.17)
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

/* ---- RPG: แต้ม XP ต่อกิจกรรม (Phase 6.8 แอดมินกำหนดได้เอง) ---- */
var XP_DEFAULTS = { WORK_LOG: 10, ISSUE: 15, SOLUTION: 25, RESOLVE: 50, LIKE_RECEIVED: 5 };
var XP_LABELS = {
  WORK_LOG:      "📝 บันทึกงาน (ต่อรายการ)",
  ISSUE:         "🛠️ แจ้งปัญหา (ต่อรายการ)",
  SOLUTION:      "💡 เสนอแนวทางแก้ไขปัญหา",
  RESOLVE:       "✅ ยืนยันว่าแก้ไขสำเร็จ",
  LIKE_RECEIVED: "❤️ เจ้าของข้อเสนอแนะได้รับถูกใจ จากคนอื่น (ต่อครั้ง)"
};
var XP_CONFIG_PROP = "XP_CONFIG";   // เก็บ JSON ใน Script Properties
var XP_MAX_POINTS   = 100000;       // เพดานแต้มต่อกิจกรรม

/* อ่านแต้ม XP ที่แอดมินตั้งไว้ (merge กับค่าเริ่มต้น) */
function getXpConfig_() {
  var cfg = {};
  Object.keys(XP_DEFAULTS).forEach(function (k) { cfg[k] = XP_DEFAULTS[k]; });
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(XP_CONFIG_PROP);
    if (raw) {
      var o = JSON.parse(raw) || {};
      Object.keys(XP_DEFAULTS).forEach(function (k) {
        var v = Number(o[k]);
        if (!isNaN(v) && v >= 0) cfg[k] = Math.min(XP_MAX_POINTS, Math.round(v));
      });
    }
  } catch (e) {}
  return cfg;
}

/* แอดมินบันทึกแต้ม XP ต่อกิจกรรม */
function handleSaveXpConfig_(adminEmail, config) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  var clean = {};
  Object.keys(XP_DEFAULTS).forEach(function (k) {
    var v = Number(config[k]);
    if (isNaN(v) || v < 0) v = XP_DEFAULTS[k];
    clean[k] = Math.min(XP_MAX_POINTS, Math.round(v));
  });
  PropertiesService.getScriptProperties().setProperty(XP_CONFIG_PROP, JSON.stringify(clean));
  return json_({ status: "ok", config: clean, message: "บันทึกแต้ม XP แล้ว" });
}

/* ---- RPG: โบนัส Streak (มาบันทึกต่อเนื่อง) — แอดมินกำหนดได้เอง (Phase 6.8.3) ---- */
var STREAK_BONUS_DAILY       = 5;                                  // ค่าเริ่มต้น: โบนัสเมื่อบันทึกครั้งแรกของวัน
var STREAK_MILESTONES        = { 3: 15, 7: 40, 14: 100, 30: 300 }; // ค่าเริ่มต้น: โบนัสพิเศษเมื่อติดต่อกันครบ N วัน
var STREAK_CONFIG_PROP       = "STREAK_CONFIG";                    // เก็บ JSON: {daily:5, milestones:{3:15,...}}
var STREAK_MILESTONE_DAYS    = [3, 7, 14, 30];

/* อ่านโบนัสสตรีคที่แอดมินตั้งไว้ (merge กับค่าเริ่มต้น) */
function getStreakConfig_() {
  var cfg = { daily: STREAK_BONUS_DAILY, milestones: {} };
  STREAK_MILESTONE_DAYS.forEach(function (d) { cfg.milestones[String(d)] = STREAK_MILESTONES[d]; });
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(STREAK_CONFIG_PROP);
    if (raw) {
      var o = JSON.parse(raw) || {};
      var dv = Number(o.daily);
      if (!isNaN(dv) && dv >= 0) cfg.daily = Math.min(XP_MAX_POINTS, Math.round(dv));
      var m = o.milestones || {};
      STREAK_MILESTONE_DAYS.forEach(function (d) {
        var v = Number(m[String(d)]);
        if (!isNaN(v) && v >= 0) cfg.milestones[String(d)] = Math.min(XP_MAX_POINTS, Math.round(v));
      });
    }
  } catch (e) {}
  return cfg;
}

/* แอดมินบันทึกโบนัสสตรีค */
function handleSaveStreakConfig_(adminEmail, config) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  var dv = Number(config && config.daily);
  if (isNaN(dv) || dv < 0) dv = STREAK_BONUS_DAILY;
  var out = { daily: Math.min(XP_MAX_POINTS, Math.round(dv)), milestones: {} };
  STREAK_MILESTONE_DAYS.forEach(function (d) {
    var v = Number(config && config.milestones ? config.milestones[String(d)] : NaN);
    if (isNaN(v) || v < 0) v = STREAK_MILESTONES[d];
    out.milestones[String(d)] = Math.min(XP_MAX_POINTS, Math.round(v));
  });
  PropertiesService.getScriptProperties().setProperty(STREAK_CONFIG_PROP, JSON.stringify(out));
  return json_({ status: "ok", config: out, message: "บันทึกโบนัสสตรีคแล้ว" });
}

/* ค่าเริ่มต้นสำหรับปุ่ม "คืนค่าเริ่มต้น" ฝั่งหน้าเว็บ */
function streakConfigDefaults_() {
  var ms = {}; STREAK_MILESTONE_DAYS.forEach(function (d) { ms[String(d)] = STREAK_MILESTONES[d]; });
  return { daily: STREAK_BONUS_DAILY, milestones: ms };
}

/* ---- การมองเห็นของผู้ใช้ (Phase 6.22)
 * แอดมินเปิด/ปิดการแสดงผล "ผู้ทำคะแนนสูงสุด" และ "อันดับสมาชิกทั้งหมด" ให้ผู้ใช้ทั่วไป
 * เก็บใน Script Property: UI_CONFIG = {showTopScorers:true, showMemberRank:false}
 * หมายเหตุ: แอดมินมองเห็นได้เสมอไม่ว่าตั้งค่าใด */
var UI_CONFIG_PROP    = "UI_CONFIG";
var UI_CONFIG_DEFAULT = { showTopScorers: true, showMemberRank: false };
var UI_CONFIG_LABELS  = { showTopScorers: "🏆 ผู้ทำคะแนนสูงสุด", showMemberRank: "👥 อันดับสมาชิกทั้งหมด" };

function getUiConfig_() {
  var cfg = { showTopScorers: UI_CONFIG_DEFAULT.showTopScorers, showMemberRank: UI_CONFIG_DEFAULT.showMemberRank };
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(UI_CONFIG_PROP);
    if (raw) {
      var o = JSON.parse(raw) || {};
      if (o.showTopScorers !== undefined) cfg.showTopScorers = (o.showTopScorers === true || String(o.showTopScorers) === "true");
      if (o.showMemberRank !== undefined) cfg.showMemberRank = (o.showMemberRank === true || String(o.showMemberRank) === "true");
    }
  } catch (e) {}
  return cfg;
}

/* แอดมินบันทึกค่าการมองเห็นของผู้ใช้ */
function handleSaveUiConfig_(adminEmail, config) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  var cur = getUiConfig_();
  config = config || {};
  var next = {
    showTopScorers: (config.showTopScorers === undefined) ? cur.showTopScorers : (config.showTopScorers === true || String(config.showTopScorers) === "true"),
    showMemberRank: (config.showMemberRank === undefined) ? cur.showMemberRank : (config.showMemberRank === true || String(config.showMemberRank) === "true")
  };
  PropertiesService.getScriptProperties().setProperty(UI_CONFIG_PROP, JSON.stringify(next));
  return json_({ status: "ok", config: next, message: "บันทึกการมองเห็นของผู้ใช้แล้ว" });
}

/* ---- RPG: Achievements / เหรียญตรา (Phase 6.1) ----
 * type อ้างอิงค่าจาก achievementStats_() : work_count | issue_count | solution_count |
 * solved_count | like_count | level | total_xp | streak | night_owl | early_bird
 * rarity : bronze | silver | gold | platinum (ใช้กำหนดสีกรอบ) */
var ACHIEVEMENTS = [
  { id: "first_log",      name: "ก้าวแรก",         desc: "บันทึกงานครั้งแรก",                icon: "🚀", type: "work_count",     goal: 1,    xp: 10,  rarity: "bronze" },
  { id: "first_issue",    name: "ผู้สังเกตการณ์",   desc: "แจ้งปัญหาครั้งแรก",                icon: "🐞", type: "issue_count",    goal: 1,    xp: 10,  rarity: "bronze" },
  { id: "first_solution", name: "ผู้ช่วยคนแรก",    desc: "เสนอวิธีแก้ปัญหาครั้งแรก",          icon: "💡", type: "solution_count", goal: 1,    xp: 15,  rarity: "bronze" },
  { id: "work_10",        name: "ขยันขันแข็ง",      desc: "บันทึกงานครบ 10 ครั้ง",            icon: "🛠️", type: "work_count",    goal: 10,   xp: 30,  rarity: "silver" },
  { id: "work_50",        name: "มือฉมัง",         desc: "บันทึกงานครบ 50 ครั้ง",            icon: "⚙️", type: "work_count",    goal: 50,   xp: 100, rarity: "gold" },
  { id: "work_100",       name: "ตำนานช่าง",        desc: "บันทึกงานครบ 100 ครั้ง",           icon: "🏗️", type: "work_count",    goal: 100,  xp: 250, rarity: "platinum" },
  { id: "issue_10",       name: "ตาสับปะรด",        desc: "แจ้งปัญหาครบ 10 ครั้ง",            icon: "👀", type: "issue_count",    goal: 10,   xp: 40,  rarity: "silver" },
  { id: "solution_10",    name: "นักแก้ปัญหา",      desc: "เสนอวิธีแก้ครบ 10 ครั้ง",           icon: "🧠", type: "solution_count", goal: 10,   xp: 80,  rarity: "silver" },
  { id: "solution_25",    name: "ที่ปรึกษา",        desc: "เสนอวิธีแก้ครบ 25 ครั้ง",           icon: "🎓", type: "solution_count", goal: 25,   xp: 200, rarity: "gold" },
  { id: "solved_5",       name: "ตัวจริง",          desc: "วิธีแก้ได้รับการยืนยัน 5 ครั้ง",    icon: "✅", type: "solved_count",   goal: 5,    xp: 60,  rarity: "silver" },
  { id: "solved_15",      name: "ฮีโร่",            desc: "วิธีแก้ได้รับการยืนยัน 15 ครั้ง",   icon: "🦸", type: "solved_count",   goal: 15,   xp: 150, rarity: "gold" },
  { id: "likes_10",       name: "ขวัญใจทีม",        desc: "ได้รับ Like ครบ 10 ครั้ง",          icon: "❤️", type: "like_count",     goal: 10,   xp: 50,  rarity: "silver" },
  { id: "likes_50",       name: "ซุปเปอร์สตาร์",    desc: "ได้รับ Like ครบ 50 ครั้ง",          icon: "⭐", type: "like_count",     goal: 50,   xp: 150, rarity: "gold" },
  { id: "level_3",        name: "ยกระดับ",          desc: "ไต่ถึงเลเวล 3",                    icon: "📈", type: "level",          goal: 3,    xp: 40,  rarity: "bronze" },
  { id: "level_5",        name: "ระดับสูง",         desc: "ไต่ถึงเลเวล 5",                    icon: "🏆", type: "level",          goal: 5,    xp: 120, rarity: "gold" },
  { id: "streak_3",       name: "ต่อเนื่อง 3 วัน",  desc: "มาบันทึก 3 วันติดกัน",             icon: "🔥", type: "streak",         goal: 3,    xp: 30,  rarity: "bronze" },
  { id: "streak_7",       name: "สัปดาห์ไฟลุก",     desc: "มาบันทึก 7 วันติดกัน",             icon: "🔥", type: "streak",         goal: 7,    xp: 80,  rarity: "gold" },
  { id: "streak_30",      name: "เดือนแห่งไฟ",      desc: "มาบันทึก 30 วันติดกัน",            icon: "🌋", type: "streak",         goal: 30,   xp: 300, rarity: "platinum" },
  { id: "xp_1000",        name: "พันแต้ม",          desc: "สะสมครบ 1,000 XP",                 icon: "💎", type: "total_xp",       goal: 1000, xp: 100, rarity: "gold" },
  { id: "night_owl",      name: "นกฮูก",            desc: "บันทึกงานหลัง 20:00 น.",           icon: "🦉", type: "night_owl",      goal: 1,    xp: 20,  rarity: "bronze" },
  { id: "early_bird",     name: "นกน้อยตื่นเช้า",   desc: "บันทึกงานก่อน 08:00 น.",           icon: "🐦", type: "early_bird",     goal: 1,    xp: 20,  rarity: "bronze" }
];

/* ---- ระบบจัดการเหรียญตรา (Phase 6.10): แอดมินแก้ไขได้ เก็บใน Script Properties ---- */
var ACHIEVEMENTS_PROP = "ACHIEVEMENTS";   // ว่าง = ใช้ค่าเริ่มต้นใน ACHIEVEMENTS
var ACHIEVEMENT_TYPES = ["work_count", "issue_count", "solution_count", "solved_count", "like_count", "level", "total_xp", "streak", "night_owl", "early_bird"];
var ACHIEVEMENT_TYPE_LABELS = {
  work_count: "จำนวนบันทึกงาน", issue_count: "จำนวนแจ้งปัญหา", solution_count: "จำนวนเสนอวิธีแก้",
  solved_count: "วิธีแก้ที่ได้รับการยืนยัน", like_count: "Like ที่ได้รับ", level: "เลเวล",
  total_xp: "XP รวม", streak: "สตรีค (วันติด)", night_owl: "บันทึกหลัง 20:00", early_bird: "บันทึกก่อน 08:00"
};
var ACHIEVEMENT_RARITIES = ["bronze", "silver", "gold", "platinum"];

function achievementsDefaults_() {
  return ACHIEVEMENTS.map(function (a) {
    return { id: a.id, name: a.name, desc: a.desc, icon: a.icon, type: a.type, goal: a.goal, xp: a.xp, rarity: a.rarity };
  });
}
function getAchievements_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(ACHIEVEMENTS_PROP);
    if (!raw) return achievementsDefaults_();
    var list = JSON.parse(raw);
    if (!list || !list.length || !list[0].id) return achievementsDefaults_();
    return list;
  } catch (e) { return achievementsDefaults_(); }
}
function handleSaveAchievements_(adminEmail, list) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!list || !list.length) throw new Error("ต้องมีเหรียญตราอย่างน้อย 1 รายการ");
  var seen = {};
  var clean = list.map(function (a, idx) {
    var id = String(a.id || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (!id) id = "ach_" + (idx + 1) + "_" + Math.floor(Math.random() * 900 + 100);
    if (seen[id]) throw new Error("รหัสเหรียญซ้ำ: " + id);
    seen[id] = true;
    var name = String(a.name || "").trim().slice(0, 60);
    if (!name) throw new Error("กรุณากรอกชื่อเหรียญทุกรายการ");
    var type = String(a.type || "");
    if (ACHIEVEMENT_TYPES.indexOf(type) === -1) throw new Error("เงื่อนไขไม่ถูกต้อง: " + type);
    var goal = Math.max(1, Math.round(Number(a.goal) || 1));
    var xp = Math.max(0, Math.round(Number(a.xp) || 0));
    if (xp > XP_MAX_POINTS) xp = XP_MAX_POINTS;
    var rarity = String(a.rarity || "bronze");
    if (ACHIEVEMENT_RARITIES.indexOf(rarity) === -1) rarity = "bronze";
    return { id: id, name: name, desc: String(a.desc || "").trim().slice(0, 120), icon: String(a.icon || "🏅").slice(0, 4), type: type, goal: goal, xp: xp, rarity: rarity };
  });
  PropertiesService.getScriptProperties().setProperty(ACHIEVEMENTS_PROP, JSON.stringify(clean));
  return json_({ status: "ok", count: clean.length, message: "บันทึกเหรียญตราแล้ว" });
}

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
  NOTIFICATIONS: "Notifications", NOTIF_ACKS: "Notif_Acks", USER_ACHIEVEMENTS: "User_Achievements",
  AUDIT_LOG: "Audit_Log", SERVICE_EVALS: "Service_Evals", SERVICE_TOKENS: "Service_Tokens"
};

var HEADERS = {
  USERS:         ["Email", "Full_Name", "Total_XP", "Level", "Last_Login", "Role"],
  WORK_LOGS:     ["Log_ID", "Timestamp", "User_Email", "Detail", "File_URLs", "File_Meta", "Category", "Client_Ref", "Links", "Status", "Void_Reason", "Voided_By", "Voided_At", "Reject_Reason", "Rejected_By", "Rejected_At", "Remove_Reason", "Removed_By", "Removed_At", "Prev_Status", "Removed_XP", "Backdated", "Submitted_At"],
  ISSUES:        ["Issue_ID", "Timestamp", "User_Email", "Detail", "Status", "Solution", "Solved_By", "File_URLs", "File_Meta", "Category", "Solved_By_Email", "Client_Ref", "KB_Approved", "Links", "Void_Reason", "Voided_By", "Voided_At", "Reject_Reason", "Rejected_By", "Rejected_At", "Remove_Reason", "Removed_By", "Removed_At", "KB_Remove_Reason", "KB_Removed_By", "KB_Removed_At", "Prev_Status", "Removed_XP"],
  SOLUTIONS:     ["Solution_ID", "Issue_ID", "Timestamp", "Solution_Text", "Proposed_By", "Proposer_Name", "Status", "Remove_Reason", "Removed_By", "Removed_At", "Prev_Status", "Removed_XP"],
  XP_HISTORY:    ["XP_ID", "Timestamp", "User_Email", "Amount", "Reason", "Ref_ID", "Client_Ref"],
  XP_RULES:      ["Level", "Title", "Min_XP"],
  LIKES:         ["Like_ID", "Solution_ID", "Issue_ID", "User_Email", "Timestamp"],
  NOTIFICATIONS: ["Notif_ID", "Message", "Created_At", "Active"],
  NOTIF_ACKS:    ["Ack_ID", "Notif_ID", "User_Email", "Ack_At"],
  USER_ACHIEVEMENTS: ["UA_ID", "Email", "Ach_ID", "Unlocked_At"],
  AUDIT_LOG:     ["Audit_ID", "Timestamp", "Actor_Email", "Action", "Target_Type", "Target_ID", "Reason", "Meta"],
  SERVICE_EVALS: ["Eval_ID", "Timestamp", "Request_Title", "Location", "Requester_Email", "Rating_Fast", "Rating_Unable", "Stars_Total", "Comment", "Officer_Email", "Officer_Name", "XP_Awarded", "Status", "Void_Reason", "Voided_By", "Voided_At"],
  SERVICE_TOKENS:["Token", "Officer_Email", "Officer_Name", "Created_At"]
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
        return output_({ status: "ok", message: "KKU HR Exp API Phase 6.25", time: nowStr_() }, cb);
      case "pendingIssues":
        return output_(pendingIssues_(p.idToken), cb);
      case "myHistory":
        return output_(myHistory_(p.idToken, p.email), cb);
      case "knowledgeBase":
        return output_(knowledgeBase_(p.idToken, p.email, p.includeRemoved), cb);
      case "myProfile":
        return output_(myProfile_(p.idToken, p.email), cb);
      case "dashboard":
        return output_(dashboard_(p.idToken, p.email), cb);
      case "achievements":
        return output_(achievementsList_(p.idToken, p.email), cb);
      case "adminUserDetail":
        return output_(adminUserDetail_(p.idToken, p.email), cb);
      case "adminUserRecords":
        return output_(adminUserRecords_(p.idToken, p.email, p.type, p.includeVoided), cb);
      case "myRejected":
        return output_(myRejected_(p.idToken), cb);
      case "xpConfig":
        return output_({ status: "ok", config: getXpConfig_(), labels: XP_LABELS, defaults: XP_DEFAULTS }, cb);
      case "streakConfig":
        return output_({ status: "ok", config: getStreakConfig_(), defaults: streakConfigDefaults_(), days: STREAK_MILESTONE_DAYS }, cb);
      case "uiConfig":
        return output_({ status: "ok", config: getUiConfig_(), labels: UI_CONFIG_LABELS, defaults: UI_CONFIG_DEFAULT }, cb);
      case "achievementsConfig":
        return output_({ status: "ok", list: getAchievements_(), types: ACHIEVEMENT_TYPES, typeLabels: ACHIEVEMENT_TYPE_LABELS, rarities: ACHIEVEMENT_RARITIES, defaults: achievementsDefaults_() }, cb);
      case "activeNotifications":
        return output_(activeNotifications_(p.idToken), cb);
      case "submitResult":
        return output_(submitResult_(p.clientRef, p.idToken), cb);
      case "adminOverview":
        return output_(adminOverview_(p.idToken), cb);
      case "adminSubmissions":
        return output_(adminSubmissions_(p.idToken, p.type, p.q, p.includeVoided), cb);
      case "auditLog":
        return output_(auditLog_(p.idToken, p.limit), cb);
      case "exportData":
        return output_(exportData_(p.idToken, p.type), cb);
      case "myExportRecords":
        return output_(myExportRecords_(p.idToken, p.email, p.from, p.to, p.type), cb);
      case "serviceToken":
        return output_(serviceToken_(p.idToken), cb);
      case "myServiceEvals":
        return output_(myServiceEvals_(p.idToken, p.email), cb);
      case "adminServiceEvals":
        return output_(adminServiceEvals_(p.idToken), cb);
      case "serviceEvalInfo":
        return output_(serviceEvalInfo_(p.token), cb);
      case "export":
        return ContentService.createTextOutput(exportSheetAsCsv_(p.sheet || SHEETS.WORK_LOGS))
          .setMimeType(ContentService.MimeType.CSV);
      default:
        return output_({ status: "ok", message: "KKU HR Exp API Phase 6.25" }, cb);
    }
  } catch (err) {
    return output_({ status: "error", message: String(err) }, cb);
  }
}

/* ======================================================================
 * [3] doPost — เขียนข้อมูล
 *   action: login | workLog | issue | autoSubmit | addSolution | addFiles
 *           | resolveIssue | likeSolution | likeArticle | ackNotification
 * ==================================================================== */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    if (!e || !e.postData || !e.postData.contents) return json_({ status: "error", message: "empty body" });

    var data = JSON.parse(e.postData.contents);

    // Public actions (no login required)
    if (data.action === "submitEvaluation") {
      return handleSubmitEvaluation_(data.token, data.title, data.location, data.submitterEmail, data.ratingFast, data.ratingUnable, data.comment);
    }

    var verifiedEmail = null;
    if (data.idToken) verifiedEmail = verifyIdToken_(data.idToken).email;
    var email = verifiedEmail || data.email;
    if (!email || email.split("@")[1] !== ALLOWED_DOMAIN) {
      return json_({ status: "error", message: "email domain not allowed" });
    }

    switch (data.action) {
      case "login":          return handleLogin_(email, data.name || "");
      case "workLog":        return handleWorkLog_(email, data.detail || "", data.files || [], data.category || "work", data.clientRef, data.logDate, data.logTime);
      case "issue":          return handleIssue_(email, data.detail || "", data.files || [], data.category || "issue", data.clientRef);
      case "autoSubmit":     return handleAutoSubmit_(email, data.detail || "", data.files || [], data.clientRef, data.logDate, data.logTime);
      case "addSolution":    return handleAddSolution_(email, data.name || "", data.issueId, data.solution || "");
      case "editSolution":   return handleEditSolution_(email, data.issueId, data.solution || "");
      case "addFiles":       return handleAddFiles_(email, data.recordType, data.recordId, data.files || []);
      case "addLinks":       return handleAddLinks_(email, data.recordType, data.recordId, data.links || []);
      case "editDetail":     return handleEditDetail_(email, data.recordType, data.recordId, data.detail || "");
      case "deleteMyRecord": return handleDeleteMyRecord_(email, data.recordType, data.recordId, data.reason || "");
      case "resolveIssue":   return handleResolveIssue_(email, data.issueId);
      case "likeSolution":   return handleLikeSolution_(email, data.solutionId);
      case "likeArticle":    return handleLikeArticle_(email, data.issueId);
      case "ackNotification":return handleAckNotification_(email, data.notifIds || []);
      case "approveIssue":   return handleApproveIssue_(email, data.issueId);
      case "grantBonusXp":   return handleGrantBonusXp_(email, data.targetEmail, data.amount, data.reason);
      case "createNotification": return handleCreateNotification_(email, data.message || "");
      case "setUserRole":    return handleSetUserRole_(email, data.targetEmail, data.role);
      case "saveXpRules":
        return handleSaveXpRules_(email, data.rules || []);
      case "saveXpConfig":
        return handleSaveXpConfig_(email, data.config || {});
      case "saveStreakConfig":
        return handleSaveStreakConfig_(email, data.config || {});
      case "saveUiConfig":
        return handleSaveUiConfig_(email, data.config || {});
      case "voidRecord":
        return handleVoidRecord_(email, data.recordType, data.recordId, data.reason || "");
      case "adminEditRecord":
        return handleAdminEditRecord_(email, data.recordType, data.recordId, data.detail || "", data.category, data.status);
      case "adminRejectRecord":
        return handleAdminRejectRecord_(email, data.recordType, data.recordId, data.reason || "");
      case "resubmitRecord":
        return handleResubmitRecord_(email, data.recordType, data.recordId, data.detail);
      case "saveAchievements":
        return handleSaveAchievements_(email, data.list || []);
      case "adminRemove":
        return handleAdminRemove_(email, data.kind, data.recordId || data.id, data.reason || "");
      case "adminRestore":
        return handleAdminRestore_(email, data.kind, data.recordId || data.id, data.reason || "");
      case "voidServiceEval":
        return handleVoidServiceEval_(email, data.evalId || data.id, data.reason || "");
      case "adminEditSolution":
        return handleAdminEditSolution_(email, data.solutionId, data.solution || data.text || "");
      case "adminRemoveFile":
        return handleAdminRemoveFile_(email, data.recordType, data.recordId || data.id, data.url || "");
      case "adminRemoveLink":
        return handleAdminRemoveLink_(email, data.recordType, data.recordId || data.id, data.url || "");
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
  evaluateAchievements_(email);
  return json_({ status: "ok", email: email, time: ts, isAdmin: isAdmin_(email) });
}

function handleWorkLog_(email, detail, files, category, clientRef, logDate, logTime) {
  var logTs = resolveLogDate_(logDate, logTime);
  validateAndAssess_(email, detail, clientRef);
  return recordWork_(email, detail, files, category || "work", clientRef, logTs);
}

function handleIssue_(email, detail, files, category, clientRef) {
  validateAndAssess_(email, detail, clientRef);
  return recordIssue_(email, detail, files, category || "issue", clientRef);
}

function handleAutoSubmit_(email, detail, files, clientRef, logDate, logTime) {
  var logTs = resolveLogDate_(logDate, logTime);
  var a = validateAndAssess_(email, detail, clientRef);
  if (a.category === "issue") return recordIssue_(email, detail, files, "issue", clientRef);
  return recordWork_(email, detail, files, "work", clientRef, logTs);
}

function recordWork_(email, detail, files, category, clientRef, logTs) {
  var sh = getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
  var backdated = !!logTs;
  var ts = logTs || nowStr_();
  var submittedAt = nowStr_();
  var infos = uploadFiles_(files);
  var urls = infos.map(function (fi) { return fi.url; });
  var id = "LOG-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(sh, HEADERS.WORK_LOGS, {
    Log_ID: id, Timestamp: ts, User_Email: email, Detail: detail,
    File_URLs: urls.join("\n"), File_Meta: urls.length ? JSON.stringify(infos) : "",
    Category: category, Client_Ref: clientRef || "",
    Backdated: backdated ? "TRUE" : "", Submitted_At: submittedAt
  });
  var eligible = backdateEligibleForXp_(logTs);
  var xpWork = eligible ? getXpConfig_().WORK_LOG : 0;
  var lv = awardXp_(email, xpWork, "work_log", id, clientRef);
  var st = eligible ? applyStreakBonus_(email, clientRef) : { awarded: 0, streak: streakStats_(email).current };
  evaluateAchievements_(email);
  return json_({ status: "ok", type: "work", id: id, time: ts, files: urls.length, xp: xpWork, backdated: backdated, noXp: !eligible, totalXp: lv.totalXp + st.awarded, streakBonus: st.awarded, streakDays: st.streak });
}

function recordIssue_(email, detail, files, category, clientRef) {
  var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var ts = nowStr_();
  var infos = uploadFiles_(files);
  var urls = infos.map(function (fi) { return fi.url; });
  var id = "ISS-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(sh, HEADERS.ISSUES, {
    Issue_ID: id, Timestamp: ts, User_Email: email, Detail: detail, Status: "Pending",
    Solution: "", Solved_By: "", File_URLs: urls.join("\n"), File_Meta: urls.length ? JSON.stringify(infos) : "",
    Category: category, Client_Ref: clientRef || ""
  });
  var xpIssue = getXpConfig_().ISSUE;
  var lv = awardXp_(email, xpIssue, "issue", id, clientRef);
  var st = applyStreakBonus_(email, clientRef);
  evaluateAchievements_(email);
  return json_({ status: "ok", type: "issue", id: id, time: ts, files: urls.length, xp: xpIssue, totalXp: lv.totalXp + st.awarded, streakBonus: st.awarded, streakDays: st.streak });
}

function handleAddSolution_(email, name, issueId, solution) {
  if (!issueId) throw new Error("missing issueId");
  solution = String(solution || "").trim();
  if (!solution) throw new Error("missing solution");
  if (solution.length < MIN_DETAIL_CHARS) throw new Error("ข้อความต้องมีอย่างน้อย " + MIN_DETAIL_CHARS + " ตัวอักษร");

  var issSheet = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var row = findRowByHeader_(issSheet, "Issue_ID", issueId);
  if (row === -1) throw new Error("issue not found");

  var solSheet = getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS);
  if (findSolutionRow_(solSheet, issueId, email) !== -1) {
    throw new Error("คุณเสนอแนวทางแก้ไขสำหรับรายการนี้ไปแล้ว — แก้ไขข้อความเดิมได้ที่ปุ่ม ✏️ แก้ไข");
  }

  // กันวิธีแก้ไขที่ซ้ำ/ใกล้เคียงกับที่มีผู้เสนอไว้แล้ว (Phase 6.14)
  var normNew = normalizeText_(solution);
  var existed = readObjects_(solSheet, HEADERS.SOLUTIONS);
  for (var i = 0; i < existed.length; i++) {
    if (String(existed[i].Issue_ID) !== String(issueId)) continue;
    if (solutionRemoved_(existed[i])) continue;
    var n = normalizeText_(String(existed[i].Solution_Text || ""));
    if (!n) continue;
    if (n === normNew || textSimilarity_(normNew, n) >= DUP_SIMILARITY) {
      throw new Error("มีผู้เสนอแนวทางแก้ไขที่ใกล้เคียงกันแล้ว ลองเสนอวิธีที่แตกต่างออกไป");
    }
  }

  var ts = nowStr_();
  var sid = "SOL-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_();
  appendByHeaders_(solSheet, HEADERS.SOLUTIONS, {
    Solution_ID: sid, Issue_ID: issueId, Timestamp: ts, Solution_Text: solution, Proposed_By: email, Proposer_Name: name
  });

  var imap = headerMap_(issSheet);
  var curStatus = String(issSheet.getRange(row, imap["Status"]).getValue() || "Pending");
  if (curStatus === "Pending" || curStatus === "") issSheet.getRange(row, imap["Status"]).setValue("In-Progress");

  var xpSol = getXpConfig_().SOLUTION;
  var lv = awardXp_(email, xpSol, "solution", sid, "");
  evaluateAchievements_(email);
  return json_({ status: "ok", solutionId: sid, time: ts, xp: xpSol, totalXp: lv.totalXp });
}

/* แก้ไขแนวทางแก้ไขของตัวเอง (เสนอได้ครั้งเดียวต่อรายการ แต่แก้ข้อความได้) */
function handleEditSolution_(email, issueId, solution) {
  if (!issueId) throw new Error("missing issueId");
  solution = String(solution || "").trim();
  if (!solution) throw new Error("ไม่มีข้อความ");
  if (solution.length < MIN_DETAIL_CHARS) throw new Error("ข้อความต้องมีอย่างน้อย " + MIN_DETAIL_CHARS + " ตัวอักษร");
  if (solution.length > 5000) throw new Error("ข้อความยาวเกินไป (สูงสุด 5000 ตัวอักษร)");

  var solSheet = getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS);
  var srow = findSolutionRow_(solSheet, issueId, email);
  if (srow === -1) throw new Error("ไม่พบแนวทางแก้ไขของคุณสำหรับรายการนี้");
  var map = headerMap_(solSheet);
  if (String(solSheet.getRange(srow, map["Status"]).getValue() || "") === "Removed") throw new Error("ข้อเสนอแนะนี้ถูกลบโดยแอดมิน แก้ไขไม่ได้");
  solSheet.getRange(srow, map["Solution_Text"]).setValue(solution);
  return json_({ status: "ok", issueId: issueId, solution: solution });
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

/* แก้ไขข้อความ (Detail) ของรายการตัวเอง — เจ้าของรายการเท่านั้น */
function handleEditDetail_(email, recordType, recordId, detail) {
  if (!recordId) throw new Error("missing recordId");
  detail = String(detail || "").trim();
  if (!detail) throw new Error("ไม่มีข้อความ");
  if (detail.length < MIN_DETAIL_CHARS) throw new Error("ข้อความต้องมีอย่างน้อย " + MIN_DETAIL_CHARS + " ตัวอักษร");
  if (detail.length > 5000) throw new Error("ข้อความยาวเกินไป (สูงสุด 5000 ตัวอักษร)");

  var sh, idHeader;
  if (recordType === "issue") { sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES); idHeader = "Issue_ID"; }
  else { sh = getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS); idHeader = "Log_ID"; }

  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("record not found");
  assertOwner_(sh, row, "User_Email", email);

  var map = headerMap_(sh);
  var status = String(sh.getRange(row, map["Status"]).getValue() || "");
  if (status === "Void") throw new Error("รายการนี้ถูกยกเลิกแล้ว แก้ไขไม่ได้");
  if (status === "Removed") throw new Error("รายการนี้ถูกลบโดยแอดมิน แก้ไขไม่ได้");

  var oldDetail = String(sh.getRange(row, map["Detail"]).getValue() || "");
  sh.getRange(row, map["Detail"]).setValue(detail);
  return json_({ status: "ok", id: recordId, type: recordType === "issue" ? "issue" : "work", detail: detail, previous: oldDetail });
}

function handleResolveIssue_(email, issueId) {
  var sh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
  var row = findRowByHeader_(sh, "Issue_ID", issueId);
  if (row === -1) throw new Error("issue not found");
  var map = headerMap_(sh);

  var owner = String(sh.getRange(row, map["User_Email"]).getValue() || "");
  if (owner !== email && !isAdmin_(email)) throw new Error("ไม่มีสิทธิ์ยืนยันรายการนี้");

  // ต้องมีแนวทางแก้ไข (ที่ไม่ถูกลบ) อย่างน้อย 1 วิธี ก่อนจึงจะยืนยันได้ (Phase 6.17)
  var sols = readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS)
    .filter(function (s) { return String(s.Issue_ID) === String(issueId) && !solutionRemoved_(s); });
  if (!sols.length) throw new Error("ยังไม่มีแนวทางแก้ไข — ต้องมีอย่างน้อย 1 วิธีจึงจะยืนยันว่าแก้ไขสำเร็จได้");

  // หาผู้เสนอวิธีแก้ (คนแรก) เพื่อให้เครดิต
  var solverEmail = String(sols[0].Proposed_By || "");
  var solverName = String(sols[0].Proposer_Name || "");

  sh.getRange(row, map["Status"]).setValue("Solved");
  // เคสที่แก้สำเร็จจะเข้าคลังองค์ความรู้อัตโนมัติทันที (Phase 6.17)
  if (map["KB_Approved"]) sh.getRange(row, map["KB_Approved"]).setValue(true);
  if (map["KB_Remove_Reason"]) sh.getRange(row, map["KB_Remove_Reason"]).setValue("");
  if (map["KB_Removed_By"]) sh.getRange(row, map["KB_Removed_By"]).setValue("");
  if (map["KB_Removed_At"]) sh.getRange(row, map["KB_Removed_At"]).setValue("");
  if (map["Solved_By"]) sh.getRange(row, map["Solved_By"]).setValue(solverName || solverEmail);
  if (map["Solved_By_Email"]) sh.getRange(row, map["Solved_By_Email"]).setValue(solverEmail);

  var xpRes = getXpConfig_().RESOLVE;
  var lv = awardXp_(email, xpRes, "resolve_issue", issueId, "");
  evaluateAchievements_(email);
  if (solverEmail && solverEmail !== email) evaluateAchievements_(solverEmail);
  return json_({ status: "ok", xp: xpRes, totalXp: lv.totalXp, level: lv.level, title: lv.title, solver: solverName || solverEmail });
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
  if (solverEmail) { awardXp_(solverEmail, getXpConfig_().LIKE_RECEIVED, "like_received", issueId, ""); evaluateAchievements_(solverEmail); }

  var count = likes.filter(function (l) { return String(l.Issue_ID) === String(issueId); }).length + 1;
  return json_({ status: "ok", count: count });
}

/* กดถูกใจ "ข้อเสนอแนะ" รายข้อ (Phase 6.16)
 * - 1 คนกดได้ 1 ครั้งต่อข้อเสนอแนะ (กันซ้ำด้วย Solution_ID + email)
 * - เจ้าของข้อเสนอแนะ (Proposed_By) ได้ XP ตามที่แอดมินตั้งค่า (LIKE_RECEIVED) ต่อผู้กด 1 คน
 * - กดถูกใจข้อเสนอของตัวเองไม่ได้ (จึงมีแต่ Like จาก "คนอื่น" เท่านั้นที่ให้ XP) */
function handleLikeSolution_(email, solutionId) {
  solutionId = String(solutionId || "").trim();
  if (!solutionId) throw new Error("missing solutionId");

  var solSheet = getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS);
  var srow = findRowByHeader_(solSheet, "Solution_ID", solutionId);
  if (srow === -1) throw new Error("ไม่พบข้อเสนอแนะนี้");
  var sObj = readObjects_(solSheet, HEADERS.SOLUTIONS)[srow - 2] || {};
  if (solutionRemoved_(sObj)) throw new Error("ข้อเสนอแนะนี้ถูกลบไปแล้ว");

  var owner = String(sObj.Proposed_By || "");
  if (owner && owner === email) throw new Error("กดถูกใจข้อเสนอแนะของตัวเองไม่ได้");

  var lsh = getSheet_(SHEETS.LIKES, HEADERS.LIKES);
  var likes = readObjects_(lsh, HEADERS.LIKES);
  var already = likes.some(function (l) { return String(l.Solution_ID) === solutionId && String(l.User_Email) === email; });
  if (already) throw new Error("คุณกดถูกใจข้อเสนอนี้แล้ว");

  appendByHeaders_(lsh, HEADERS.LIKES, {
    Like_ID: "LIKE-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
    Solution_ID: solutionId, Issue_ID: String(sObj.Issue_ID || ""), User_Email: email, Timestamp: nowStr_()
  });

  // ให้ XP กับเจ้าของข้อเสนอแนะ (เฉพาะ Like จากคนอื่น) ตามค่าที่แอดมินตั้งไว้
  if (owner && owner !== email) {
    awardXp_(owner, getXpConfig_().LIKE_RECEIVED, "like_received", solutionId, "");
    evaluateAchievements_(owner);
  }

  var count = likes.filter(function (l) { return String(l.Solution_ID) === solutionId; }).length + 1;
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
    if (solutionRemoved_(s)) return;
    var k = String(s.Issue_ID);
    (byIssue[k] = byIssue[k] || []).push({
      text: String(s.Solution_Text || ""), by: admin ? String(s.Proposer_Name || "เพื่อนร่วมงาน") : "เพื่อนร่วมงาน", time: String(s.Timestamp || ""),
      mine: !!me && String(s.Proposed_By || "") === String(me)
    });
  });

  var list = [];
  for (var i = iss.length - 1; i >= 0; i--) {
    var r = iss[i];
    var status = String(r.Status || "Pending");
    if (status === "Solved" || status === "Closed" || status === "Void" || status === "Removed") continue;
    var canResolve = !!me && (admin || String(r.User_Email) === me);
    var mySolution = null;
    if (me) {
      var mineArr = (byIssue[String(r.Issue_ID)] || []).filter(function (x) { return x.mine; });
      if (mineArr.length) mySolution = { text: mineArr[0].text };
    }
    list.push({
      id: String(r.Issue_ID || ""), time: String(r.Timestamp || ""), detail: String(r.Detail || ""),
      status: status, files: fileMetaList_(r), links: parseLinks_(r.Links), solutions: dedupeSolutionsByText_(byIssue[String(r.Issue_ID)] || [], function (x) { return x.text; }),
      canResolve: canResolve, mySolution: mySolution,
      author: admin ? String(r.User_Email || "") : ""
    }); // ไม่ส่ง User_Email ให้ผู้ใช้ทั่วไป (เห็นเฉพาะแอดมิน)
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
      return { type: "work", id: String(r.Log_ID), time: String(r.Timestamp), detail: String(r.Detail), category: String(r.Category || "work"), files: fileMetaList_(r), links: parseLinks_(r.Links),
        rejected: isRejected_(r), rejectReason: String(r.Reject_Reason || ""),
        removed: isVoided_(r) || isRemoved_(r), removeReason: String(r.Remove_Reason || r.Void_Reason || ""), removedBy: String(r.Removed_By || r.Voided_By || ""), removedAt: String(r.Removed_At || r.Voided_At || "") };
    });

  var issues = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
    .filter(function (r) { return String(r.User_Email) === email; })
    .map(function (r) {
      var kbRemoved = !isTruthy_(r.KB_Approved) && !!String(r.KB_Remove_Reason || "").trim();
      return { type: "issue", id: String(r.Issue_ID), time: String(r.Timestamp), detail: String(r.Detail), status: String(r.Status || "Pending"), category: String(r.Category || "issue"), files: fileMetaList_(r), links: parseLinks_(r.Links),
        rejected: isRejected_(r), rejectReason: String(r.Reject_Reason || ""),
        removed: isVoided_(r) || isRemoved_(r), removeReason: String(r.Remove_Reason || r.Void_Reason || ""), removedBy: String(r.Removed_By || r.Voided_By || ""), removedAt: String(r.Removed_At || r.Voided_At || ""),
        kbRemoved: kbRemoved, kbRemoveReason: String(r.KB_Remove_Reason || ""), kbRemovedBy: String(r.KB_Removed_By || ""), kbRemovedAt: String(r.KB_Removed_At || "") };
    });

  var solutions = readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS)
    .filter(function (s) { return String(s.Proposed_By) === email; })
    .map(function (s) {
      return { type: "solution", id: String(s.Solution_ID), issueId: String(s.Issue_ID), time: String(s.Timestamp), detail: String(s.Solution_Text || ""),
        removed: solutionRemoved_(s), removeReason: String(s.Remove_Reason || ""), removedBy: String(s.Removed_By || ""), removedAt: String(s.Removed_At || "") };
    });

  var all = works.concat(issues).concat(solutions).sort(function (a, b) { return a.time < b.time ? 1 : -1; });
  return { status: "ok", email: email, isAdmin: isAdmin_(email), count: all.length, items: all };
}

function knowledgeBase_(idToken, emailParam, includeRemoved) {
  var me = idToken ? verifyIdToken_(idToken).email : null;
  var admin = me ? isAdmin_(me) : false;
  var wantRemoved = admin && isTruthy_(includeRemoved);   // แอดมินขอดูข้อเสนอแนะที่ถูกลบด้วย (Phase 6.17)

  var iss = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES);
  var sols = readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS);
  var likes = readObjects_(getSheet_(SHEETS.LIKES, HEADERS.LIKES), HEADERS.LIKES);

  var byIssue = {};
  var removedByIssue = {};
  sols.forEach(function (s) {
    var k = String(s.Issue_ID);
    if (solutionRemoved_(s)) {
      if (!wantRemoved) return;
      (removedByIssue[k] = removedByIssue[k] || []).push({
        id: String(s.Solution_ID || ""), text: String(s.Solution_Text || ""), by: String(s.Proposer_Name || "เพื่อนร่วมงาน"),
        byEmail: String(s.Proposed_By || ""), removeReason: String(s.Remove_Reason || ""),
        removedBy: String(s.Removed_By || ""), removedAt: String(s.Removed_At || "")
      });
      return;
    }
    (byIssue[k] = byIssue[k] || []).push({ id: String(s.Solution_ID || ""), text: String(s.Solution_Text || ""), by: String(s.Proposer_Name || "เพื่อนร่วมงาน"), byEmail: String(s.Proposed_By || "") });
  });

  // นับถูกใจแยกตาม Solution_ID (Phase 6.16)
  var likesBySol = {};
  likes.forEach(function (l) {
    var sid = String(l.Solution_ID || "");
    if (!sid) return;
    (likesBySol[sid] = likesBySol[sid] || []).push(String(l.User_Email || ""));
  });

  var mapSol = function (x, removed) {
    var likers = likesBySol[x.id] || [];
    var o = {
      id: x.id, text: x.text, by: admin ? x.by : "เพื่อนร่วมงาน",
      mine: !!me && x.byEmail === me,
      likeCount: likers.length,
      likedByMe: !!me && likers.indexOf(me) !== -1
    };
    if (removed) { o.removed = true; o.removeReason = x.removeReason; o.removedBy = x.removedBy; o.removedAt = x.removedAt; }
    return o;
  };

  var list = [];
  iss.forEach(function (r) {
    if (isHidden_(r)) return;
    if (String(r.Status) !== "Solved") return;
    if (!isTruthy_(r.KB_Approved)) return;   // ต้องเข้าเกณฑ์คลัง (อนุมัติหรือ auto ตอนยืนยันแก้สำเร็จ)
    var id = String(r.Issue_ID);
    var solList = dedupeSolutionsByText_(byIssue[id] || [], function (x) { return x.text; }).map(function (x) { return mapSol(x, false); });
    if (wantRemoved) (removedByIssue[id] || []).forEach(function (x) { solList.push(mapSol(x, true)); });
    var articleLikes = solList.reduce(function (n, s) { return n + s.likeCount; }, 0);
    list.push({
      id: id, time: String(r.Timestamp || ""), detail: String(r.Detail || ""),
      files: fileMetaList_(r), links: parseLinks_(r.Links), solutions: solList,
      solver: admin ? String(r.Solved_By || "") : "", likeCount: articleLikes
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
  var xpAll = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.User_Email) === email && String(h.Reason || "").indexOf("rejected:") !== 0; });
  var history = xpAll
    .map(function (h) { return { time: String(h.Timestamp || ""), amount: Number(h.Amount || 0), reason: String(h.Reason || "") }; })
    .sort(function (a, b) { return a.time < b.time ? 1 : -1; })
    .slice(0, 50);

  var users = readObjects_(getSheet_(SHEETS.USERS, HEADERS.USERS), HEADERS.USERS);
  var rank = rankOfUser_(email, users);
  var counts = reasonCounts_(xpAll);

  return {
    status: "ok", email: email, name: name, totalXp: totalXp, isAdmin: isAdmin_(email),
    level: lv.level, title: lv.title, minXp: lv.minXp, nextXp: lv.nextMinXp, nextTitle: lv.nextTitle,
    history: history,
    rank: rank, totalUsers: users.length,
    counts: counts, solutionCount: counts.solution, streak: streakStats_(email)
  };
}

/* ======================================================================
 * [5c] Dashboard (ผู้ใช้ + จัดอันดับ) & ข้อมูลผู้ใช้รายคน (admin)
 * ==================================================================== */
var MONTHS_TH = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

function last6Months_() {
  var now = new Date();
  var out = [];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: Utilities.formatDate(d, TIMEZONE, "yyyy-MM"), month: d.getMonth(), label: MONTHS_TH[d.getMonth()], xp: 0 });
  }
  return out;
}

function reasonCounts_(rows) {
  var c = { work_log: 0, issue: 0, solution: 0, resolve_issue: 0, like_received: 0, bonus: 0 };
  rows.forEach(function (h) {
    var r = String(h.Reason || "");
    if (c[r] != null && r !== "void") c[r]++;
  });
  return c;
}

function rankOfUser_(email, users) {
  var ranked = users.slice().sort(function (a, b) { return (Number(b.Total_XP) || 0) - (Number(a.Total_XP) || 0); });
  for (var i = 0; i < ranked.length; i++) if (String(ranked[i].Email) === String(email)) return i + 1;
  return ranked.length + 1;
}

/* คำนวณอันดับของผู้ใช้ทุกคนครั้งเดียว → คืน { email: rank } */
function rankMap_(users) {
  var ranked = users.slice().sort(function (a, b) { return (Number(b.Total_XP) || 0) - (Number(a.Total_XP) || 0); });
  var map = {};
  for (var i = 0; i < ranked.length; i++) map[String(ranked[i].Email)] = i + 1;
  return map;
}

/* ---- RPG: Streak (จำนวนวันติดต่อกันที่บันทึกงาน/แจ้งปัญหา) ---- */
function ymdToDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function shiftYmd_(s, n) {
  var d = ymdToDate_(s);
  if (!d) return s;
  d.setUTCDate(d.getUTCDate() + n);
  return Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
}

/* ======================================================================
 * [5c-2] บันทึกงานย้อนหลัง (Phase 6.13)
 *   ผู้ใช้ระบุวันที่ทำงานย้อนหลังได้ (ระบุเวลาไม่บังคับ)
 *   ถ้าย้อนหลังเกิน 3 เดือน จะไม่ได้รับ XP
 * ==================================================================== */
var BACKDATE_NO_XP_MONTHS = 3;

/* แปลง logDate (yyyy-MM-dd) + logTime (HH:mm, ไม่บังคับ) → เก็บเป็น Timestamp ของงาน
   คืนค่า null ถ้าไม่ระบุ (แปลว่าบันทึกปกติ = ตอนนี้) */
function resolveLogDate_(logDate, logTime) {
  var s = String(logDate || "").trim();
  if (!s) return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error("รูปแบบวันที่ไม่ถูกต้อง (ต้องเป็น ปี-เดือน-วัน)");
  var y = +m[1], mo = +m[2], da = +m[3];
  var dt = new Date(Date.UTC(y, mo - 1, da));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) {
    throw new Error("วันที่ไม่ถูกต้อง");
  }
  var today = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
  if (s > today) throw new Error("ระบุวันในอนาคตไม่ได้");
  var out = s;
  var t = /^(\d{1,2}):(\d{2})/.exec(String(logTime || ""));
  if (t) {
    var hh = +t[1], mi = +t[2];
    if (hh > 23 || mi > 59) throw new Error("เวลาไม่ถูกต้อง");
    out = s + " " + pad2_(hh) + ":" + pad2_(mi) + ":00";
  }
  return out;
}

/* งานย้อนหลังวันนี้ ได้ XP หรือยัง? (ย้อนหลังเกิน BACKDATE_NO_XP_MONTHS เดือน → ไม่ได้) */
function backdateEligibleForXp_(logTs) {
  if (!logTs) return true;
  var today = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
  var y = +today.substring(0, 4), mo = +today.substring(5, 7), da = +today.substring(8, 10);
  var cy = y, cmo = mo - BACKDATE_NO_XP_MONTHS;
  while (cmo < 1) { cmo += 12; cy -= 1; }
  var daysInMonth = new Date(Date.UTC(cy, cmo, 0)).getUTCDate();
  var cda = Math.min(da, daysInMonth);
  var cutoff = cy + "-" + pad2_(cmo) + "-" + pad2_(cda);
  return String(logTs).substring(0, 10) >= cutoff;
}

/* วันที่ที่มีกิจกรรม (work_log / issue) ของผู้ใช้ เรียงจากเก่า → ใหม่ */
function activeDaysFor_(email) {
  var set = {};
  readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY).forEach(function (h) {
    if (String(h.User_Email) !== email) return;
    var r = String(h.Reason || "");
    if (r !== "work_log" && r !== "issue") return;
    var d = String(h.Timestamp || "").substring(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) set[d] = 1;
  });
  return Object.keys(set).sort();
}

function streakStats_(email) {
  var today = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
  var list = activeDaysFor_(email);
  var days = {};
  list.forEach(function (d) { days[d] = 1; });

  var longest = 0, run = 0, prev = null;
  list.forEach(function (d) {
    if (prev && shiftYmd_(prev, 1) === d) run++; else run = 1;
    if (run > longest) longest = run;
    prev = d;
  });

  var activeToday = !!days[today];
  var cursor = activeToday ? today : shiftYmd_(today, -1);
  var current = 0;
  while (days[cursor]) { current++; cursor = shiftYmd_(cursor, -1); }

  var ymp = today.substring(0, 7);
  return {
    current: current, longest: longest, activeToday: activeToday,
    daysThisMonth: list.filter(function (d) { return d.substring(0, 7) === ymp; }).length,
    totalDays: list.length
  };
}

/* ให้โบนัสสตรีคเมื่อบันทึกครั้งแรกของวัน (เรียกหลัง awardXp_ ของงานหลัก) */
function applyStreakBonus_(email, clientRef) {
  var today = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
  var hist = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY);
  var gotToday = hist.some(function (h) {
    return String(h.User_Email) === email && String(h.Reason) === "streak" && String(h.Timestamp || "").substring(0, 10) === today;
  });
  if (gotToday) return { awarded: 0, streak: streakStats_(email).current };
  var st = streakStats_(email);
  var cfg = getStreakConfig_();
  var bonus = cfg.daily + (cfg.milestones[String(st.current)] || 0);
  awardXp_(email, bonus, "streak", today, clientRef || "");
  return { awarded: bonus, streak: st.current, milestone: cfg.milestones[String(st.current)] || 0 };
}

/* ======================================================================
 * [5d] Achievements / เหรียญตรา (Phase 6.1)
 * ==================================================================== */
function achievementStats_(email) {
  var hist = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.User_Email) === email && String(h.Reason || "").indexOf("rejected:") !== 0; });
  var c = { work_log: 0, issue: 0, solution: 0, like_received: 0 };
  var nightOwl = false, earlyBird = false;
  hist.forEach(function (h) {
    var r = String(h.Reason || "");
    if (c[r] != null) c[r]++;
    if (r === "work_log" || r === "issue") {
      var hh = Number(String(h.Timestamp || "").substring(11, 13));
      if (hh >= 20) nightOwl = true;
      if (hh > 0 && hh < 8) earlyBird = true;
    }
  });

  var issues = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
    .filter(function (r) { return !isHidden_(r); });
  var solvedCount = issues.filter(function (r) {
    return String(r.Status) === "Solved" && String(r.Solved_By_Email) === email;
  }).length;

  var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
  var row = findRowByHeader_(ush, "Email", email);
  var map = headerMap_(ush);
  var totalXp = row === -1 ? 0 : Number(ush.getRange(row, map["Total_XP"]).getValue() || 0);

  return {
    work_count: c.work_log, issue_count: c.issue, solution_count: c.solution,
    like_count: c.like_received, solved_count: solvedCount,
    level: levelFor_(totalXp).level, total_xp: totalXp,
    streak: streakStats_(email).current,
    night_owl: nightOwl ? 1 : 0, early_bird: earlyBird ? 1 : 0
  };
}

function unlockedAchMap_(email) {
  var map = {};
  readObjects_(getSheet_(SHEETS.USER_ACHIEVEMENTS, HEADERS.USER_ACHIEVEMENTS), HEADERS.USER_ACHIEVEMENTS)
    .forEach(function (r) { if (String(r.Email) === email) map[String(r.Ach_ID)] = String(r.Unlocked_At || ""); });
  return map;
}

/* ตรวจและปลดล็อกความสำเร็จใหม่ → คืนรายการที่เพิ่งปลดล็อก (พร้อมให้ XP) */
function evaluateAchievements_(email) {
  var stats = achievementStats_(email);
  var have = unlockedAchMap_(email);
  var sh = getSheet_(SHEETS.USER_ACHIEVEMENTS, HEADERS.USER_ACHIEVEMENTS);
  var newly = [];
  var defs = getAchievements_();
  defs.forEach(function (a) {
    if (have[a.id]) return;
    if ((Number(stats[a.type]) || 0) >= a.goal) {
      appendByHeaders_(sh, HEADERS.USER_ACHIEVEMENTS, {
        UA_ID: "UA-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
        Email: email, Ach_ID: a.id, Unlocked_At: nowStr_()
      });
      if (a.xp) awardXp_(email, a.xp, "achievement", a.id, "");
      newly.push({ id: a.id, name: a.name, desc: a.desc, icon: a.icon, xp: a.xp, rarity: a.rarity });
    }
  });
  return newly;
}

function achievementsList_(idToken, emailParam) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  if (emailParam && emailParam !== email) throw new Error("email mismatch");

  var stats = achievementStats_(email);
  var have = unlockedAchMap_(email);
  var defs = getAchievements_();
  var items = defs.map(function (a) {
    var cur = Number(stats[a.type]) || 0;
    return {
      id: a.id, name: a.name, desc: a.desc, icon: a.icon, rarity: a.rarity, xp: a.xp,
      goal: a.goal, progress: Math.min(cur, a.goal),
      unlocked: !!have[a.id], unlockedAt: have[a.id] || ""
    };
  });
  return {
    status: "ok", items: items,
    unlockedCount: items.filter(function (i) { return i.unlocked; }).length,
    total: items.length
  };
}

function dashboard_(idToken, emailParam) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบใหม่เพื่อดู Dashboard");
  var info = verifyIdToken_(idToken);
  var email = info.email;
  if (emailParam && emailParam !== email) throw new Error("email mismatch");
  var isAdmin = isAdmin_(email);

  var users = readObjects_(getSheet_(SHEETS.USERS, HEADERS.USERS), HEADERS.USERS);
  var me = null;
  for (var i = 0; i < users.length; i++) if (String(users[i].Email) === email) { me = users[i]; break; }
  var totalXp = me ? Number(me.Total_XP || 0) : 0;
  var name = me ? String(me.Full_Name || "") : (info.name || "");
  var lv = levelFor_(totalXp);

  var xpRows = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.User_Email) === email && String(h.Reason || "").indexOf("rejected:") !== 0; });

  var counts = reasonCounts_(xpRows);
  var months = last6Months_();
  xpRows.forEach(function (h) {
    var rr = String(h.Reason || "");
    if (rr === "void" || rr === "remove") return;
    var k = String(h.Timestamp || "").substring(0, 7);
    for (var m = 0; m < months.length; m++) if (months[m].key === k) { months[m].xp += Number(h.Amount || 0); break; }
  });

  var works = readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
    .filter(function (r) { return String(r.User_Email) === email && !isHidden_(r); });
  var issues = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
    .filter(function (r) { return String(r.User_Email) === email && !isHidden_(r); });
  var solved = issues.filter(function (r) { return String(r.Status) === "Solved"; }).length;

  var recent = works.map(function (r) {
    return { type: "work", id: String(r.Log_ID), time: String(r.Timestamp), detail: String(r.Detail), category: String(r.Category || "work") };
  }).concat(issues.map(function (r) {
    return { type: "issue", id: String(r.Issue_ID), time: String(r.Timestamp), detail: String(r.Detail), category: String(r.Category || "issue"), status: String(r.Status || "Pending") };
  })).sort(function (a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 5);

  var rank = rankOfUser_(email, users);
  var ranks = rankMap_(users);
  var ui = getUiConfig_();
  var canSeeTop = isAdmin || ui.showTopScorers;       // แอดมินเห็นเสมอ
  var canSeeMembers = isAdmin || ui.showMemberRank;
  var top = canSeeTop
    ? users.slice()
        .sort(function (a, b) { return (Number(b.Total_XP) || 0) - (Number(a.Total_XP) || 0); })
        .slice(0, 5)
        .map(function (u, idx) {
          return { rank: idx + 1, email: String(u.Email), name: String(u.Full_Name || ""), totalXp: Number(u.Total_XP || 0), level: Number(u.Level || 1), role: String(u.Role || "User") };
        })
    : [];

  var resp = {
    status: "ok", email: email, name: name, isAdmin: isAdmin,
    totalXp: totalXp, level: lv.level, title: lv.title,
    minXp: lv.minXp, nextXp: lv.nextMinXp, nextTitle: lv.nextTitle,
    counts: counts, workCount: works.length, issueCount: issues.length, solvedCount: solved,
    months: months,
    mix: [
      { key: "งาน", value: works.length, color: "bg-emerald-500" },
      { key: "ปัญหา", value: issues.length, color: "bg-amber-500" },
      { key: "วิธีแก้", value: counts.solution, color: "bg-sky-500" },
      { key: "โบนัส", value: counts.bonus, color: "bg-violet-500" }
    ],
    recent: recent,
    rank: rank, totalUsers: users.length,
    streak: streakStats_(email),
    ui: { showTopScorers: ui.showTopScorers, showMemberRank: ui.showMemberRank },
    top: top,
    allUsers: canSeeMembers ? users.map(function (u) {
      return { rank: ranks[String(u.Email)] || 0, email: String(u.Email), name: String(u.Full_Name || ""), totalXp: Number(u.Total_XP || 0), level: Number(u.Level || 1), role: String(u.Role || "User") };
    }) : []
  };
  resp.allUsers.sort(function (a, b) { return a.rank - b.rank; });
  return resp;
}

/* ข้อมูลผู้ใช้รายบุคคล สำหรับแอดมิน (drill-down) */
function adminUserDetail_(idToken, targetEmail) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var adminEmail = verifyIdToken_(idToken).email;
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!targetEmail) throw new Error("missing email");

  var users = readObjects_(getSheet_(SHEETS.USERS, HEADERS.USERS), HEADERS.USERS);
  var me = null;
  for (var i = 0; i < users.length; i++) if (String(users[i].Email) === String(targetEmail)) { me = users[i]; break; }
  if (!me) throw new Error("ไม่พบผู้ใช้ " + targetEmail);

  var totalXp = Number(me.Total_XP || 0);
  var lv = levelFor_(totalXp);

  var xpRows = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.User_Email) === String(targetEmail) && String(h.Reason || "").indexOf("rejected:") !== 0; });
  var counts = reasonCounts_(xpRows);
  var months = last6Months_();
  xpRows.forEach(function (h) {
    if (String(h.Reason || "") === "void") return;
    var k = String(h.Timestamp || "").substring(0, 7);
    for (var m = 0; m < months.length; m++) if (months[m].key === k) { months[m].xp += Number(h.Amount || 0); break; }
  });

  var works = readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
    .filter(function (r) { return String(r.User_Email) === String(targetEmail) && !isHidden_(r); })
    .map(function (r) {
      return { type: "work", id: String(r.Log_ID), time: String(r.Timestamp), detail: String(r.Detail), category: String(r.Category || "work") };
    });
  var issues = readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
    .filter(function (r) { return String(r.User_Email) === String(targetEmail) && !isHidden_(r); })
    .map(function (r) {
      return { type: "issue", id: String(r.Issue_ID), time: String(r.Timestamp), detail: String(r.Detail), category: String(r.Category || "issue"), status: String(r.Status || "Pending") };
    });
  var items = works.concat(issues).sort(function (a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 30);

  var history = xpRows.map(function (h) {
    return { time: String(h.Timestamp || ""), amount: Number(h.Amount || 0), reason: String(h.Reason || "") };
  }).sort(function (a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 40);

  var rank = rankOfUser_(String(targetEmail), users);
  return {
    status: "ok", email: String(targetEmail), name: String(me.Full_Name || ""),
    role: String(me.Role || "User"), totalUsers: users.length, rank: rank, isAdmin: isAdmin_(String(targetEmail)),
    totalXp: totalXp, level: lv.level, title: lv.title, minXp: lv.minXp, nextXp: lv.nextMinXp, nextTitle: lv.nextTitle,
    counts: counts, count_items: { work: works.length, issue: issues.length, solved: issues.filter(function (r) { return String(r.Status) === "Solved"; }).length },
    months: months, history: history, items: items
  };
}

/* รายการบันทึกทั้งหมดของผู้ใช้รายคน (สำหรับแอดมิน) — รวมไฟล์/ลิงก์/สถานะยกเลิก */
function adminUserRecords_(idToken, targetEmail, type, includeVoided) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var adminEmail = verifyIdToken_(idToken).email;
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!targetEmail) throw new Error("missing email");
  var target = String(targetEmail);
  var wantVoided = isTruthy_(includeVoided);

  var list = [];
  if (type !== "issue") {
    readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
      .filter(function (r) { return String(r.User_Email || "") === target; })
      .forEach(function (r) {
        var v = isHidden_(r);
        if (v && !wantVoided) return;
        list.push({
          type: "work", id: String(r.Log_ID || ""), time: String(r.Timestamp || ""),
          detail: String(r.Detail || ""), category: String(r.Category || "work"),
          status: String(r.Status || ""),
          voided: isVoided_(r), voidReason: String(r.Void_Reason || ""), voidedBy: String(r.Voided_By || ""), voidedAt: String(r.Voided_At || ""),
          removed: isRemoved_(r), removeReason: String(r.Remove_Reason || ""), removedBy: String(r.Removed_By || ""), removedAt: String(r.Removed_At || ""),
          rejected: isRejected_(r), rejectReason: String(r.Reject_Reason || ""), rejectedBy: String(r.Rejected_By || ""), rejectedAt: String(r.Rejected_At || ""),
          files: fileMetaList_(r), links: parseLinks_(r.Links)
        });
      });
  }
  if (type !== "work") {
    readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
      .filter(function (r) { return String(r.User_Email || "") === target; })
      .forEach(function (r) {
        var v = isHidden_(r);
        if (v && !wantVoided) return;
        list.push({
          type: "issue", id: String(r.Issue_ID || ""), time: String(r.Timestamp || ""),
          detail: String(r.Detail || ""), category: String(r.Category || "issue"),
          status: String(r.Status || "Pending"), solution: String(r.Solution || ""), solvedBy: String(r.Solved_By || ""),
          voided: isVoided_(r), voidReason: String(r.Void_Reason || ""), voidedBy: String(r.Voided_By || ""), voidedAt: String(r.Voided_At || ""),
          removed: isRemoved_(r), removeReason: String(r.Remove_Reason || ""), removedBy: String(r.Removed_By || ""), removedAt: String(r.Removed_At || ""),
          rejected: isRejected_(r), rejectReason: String(r.Reject_Reason || ""), rejectedBy: String(r.Rejected_By || ""), rejectedAt: String(r.Rejected_At || ""),
          kbApproved: isTruthy_(r.KB_Approved), kbRemoved: (!isTruthy_(r.KB_Approved) && !!String(r.KB_Remove_Reason || "").trim()),
          kbRemoveReason: String(r.KB_Remove_Reason || ""), kbRemovedBy: String(r.KB_Removed_By || ""), kbRemovedAt: String(r.KB_Removed_At || ""),
          files: fileMetaList_(r), links: parseLinks_(r.Links)
        });
      });
  }
  if (type !== "work" && type !== "issue") {
    readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS)
      .filter(function (s) { return String(s.Proposed_By || "") === target; })
      .forEach(function (s) {
        var rem = solutionRemoved_(s);
        if (rem && !wantVoided) return;
        list.push({
          type: "solution", id: String(s.Solution_ID || ""), issueId: String(s.Issue_ID || ""), time: String(s.Timestamp || ""),
          detail: String(s.Solution_Text || ""), category: "solution",
          status: rem ? "Removed" : "Active",
          removed: rem, removeReason: String(s.Remove_Reason || ""), removedBy: String(s.Removed_By || ""), removedAt: String(s.Removed_At || ""),
          files: [], links: []
        });
      });
  }
  list.sort(function (a, b) { return a.time < b.time ? 1 : -1; });
  var cap = list.slice(0, 1000);
  return { status: "ok", count: list.length, shown: cap.length, items: cap };
}

/* ประวัติการจัดการของแอดมิน (Audit Log) — admin only */
function auditLog_(idToken, limit) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  if (!isAdmin_(email)) throw new Error("เฉพาะแอดมินเท่านั้น");
  var cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  var rows = readObjects_(getSheet_(SHEETS.AUDIT_LOG, HEADERS.AUDIT_LOG), HEADERS.AUDIT_LOG)
    .map(function (r) {
      var meta = {};
      try { meta = r.Meta ? JSON.parse(r.Meta) : {}; } catch (e) {}
      return {
        id: String(r.Audit_ID || ""), time: String(r.Timestamp || ""), actor: String(r.Actor_Email || ""),
        action: String(r.Action || ""), targetType: String(r.Target_Type || ""), targetId: String(r.Target_ID || ""),
        reason: String(r.Reason || ""), meta: meta
      };
    });
  rows.sort(function (a, b) { return a.time < b.time ? 1 : -1; });
  return { status: "ok", count: rows.length, items: rows.slice(0, cap) };
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

  var all = readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.Client_Ref) === String(clientRef) && String(h.User_Email) === email; });

  var rej = all.filter(function (h) { return String(h.Reason || "").indexOf("rejected:") === 0; })[0];
  if (rej) {
    return { status: "ok", found: true, rejected: true, message: String(rej.Reason).slice("rejected:".length).trim() };
  }

  var xpRow = all.filter(function (h) { var r = String(h.Reason || ""); return r === "work_log" || r === "issue"; })[0];
  if (!xpRow) return { status: "ok", found: false };

  var refId = String(xpRow.Ref_ID || "");
  var reason = String(xpRow.Reason || "");
  var type = reason === "issue" ? "issue" : "work";

  var timestamp = String(xpRow.Timestamp || "");
  var category = reason;
  var backdated = false;
  if (type === "work") {
    var w = readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
      .filter(function (r) { return String(r.Log_ID) === refId; })[0];
    if (w) { timestamp = String(w.Timestamp); category = String(w.Category || "work"); backdated = String(w.Backdated || "") === "TRUE"; }
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

  var streakRow = all.filter(function (h) { return String(h.Reason) === "streak"; })[0];
  var streakBonus = streakRow ? Number(streakRow.Amount || 0) : 0;

  return {
    status: "ok", found: true, type: type, category: category, refId: refId,
    amount: Number(xpRow.Amount || 0), timestamp: timestamp, backdated: backdated,
    totalXp: totalXp, level: lv.level, title: lv.title, nextXp: lv.nextMinXp,
    streakBonus: streakBonus, streakDays: streakBonus ? streakStats_(email).current : 0
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
  var pending = iss.filter(function (r) { return String(r.Status) === "Solved" && !isTruthy_(r.KB_Approved) && !String(r.KB_Remove_Reason || "").trim(); })
    .map(function (r) {
      return { id: String(r.Issue_ID), time: String(r.Timestamp || ""), detail: String(r.Detail || ""),
               solver: String(r.Solved_By || ""), files: fileMetaList_(r) };
    })
    .sort(function (a, b) { return a.time < b.time ? 1 : -1; });

  var usersRaw = readObjects_(getSheet_(SHEETS.USERS, HEADERS.USERS), HEADERS.USERS);
  var ranks = rankMap_(usersRaw);
  var workBy = {}, issueBy = {};
  readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
    .forEach(function (r) { if (isHidden_(r)) return; var e = String(r.User_Email || ""); workBy[e] = (workBy[e] || 0) + 1; });
  readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
    .forEach(function (r) { if (isHidden_(r)) return; var e = String(r.User_Email || ""); issueBy[e] = (issueBy[e] || 0) + 1; });
  var users = usersRaw.map(function (u) {
    var e = String(u.Email || "");
    return { rank: ranks[e] || 0, email: e, name: String(u.Full_Name || ""),
             totalXp: Number(u.Total_XP || 0), level: Number(u.Level || 1), role: String(u.Role || "User"),
             lastLogin: String(u.Last_Login || ""), workCount: workBy[e] || 0, issueCount: issueBy[e] || 0 };
  }).sort(function (a, b) { return a.rank - b.rank; });

  var notifs = readObjects_(getSheet_(SHEETS.NOTIFICATIONS, HEADERS.NOTIFICATIONS), HEADERS.NOTIFICATIONS)
    .filter(function (n) { return isTruthy_(n.Active); })
    .map(function (n) { return { id: String(n.Notif_ID), message: String(n.Message || ""), time: String(n.Created_At || "") }; })
    .sort(function (a, b) { return a.time < b.time ? 1 : -1; });

  var rules = getXpRules_().map(function (r) { return { level: r.level, title: r.title, min: r.min }; });
  var xpConfig = getXpConfig_();
  var xpLabels = {};
  Object.keys(XP_LABELS).forEach(function (k) { xpLabels[k] = XP_LABELS[k]; });
  var xpDefaults = {};
  Object.keys(XP_DEFAULTS).forEach(function (k) { xpDefaults[k] = XP_DEFAULTS[k]; });

  var streakCfg = getStreakConfig_();
  var streakDefaults = streakConfigDefaults_();

  return { status: "ok", pendingApprovals: pending, users: users, notifications: notifs, rules: rules,
           xpConfig: xpConfig, xpLabels: xpLabels, xpDefaults: xpDefaults,
           streakConfig: streakCfg, streakDefaults: streakDefaults, streakDays: STREAK_MILESTONE_DAYS };
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

  // รวมข้อเสนอแนะ (Solutions) ทั้งหมดต่อปัญหา เพื่อให้แอดมินเห็น/จัดการได้ครบ (Phase 6.23)
  var solByIssue = {};
  if (type !== "work") {
    readObjects_(getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS), HEADERS.SOLUTIONS)
      .forEach(function (s) {
        var k = String(s.Issue_ID || "");
        if (!k) return;
        (solByIssue[k] = solByIssue[k] || []).push({
          id: String(s.Solution_ID || ""),
          text: String(s.Solution_Text || ""),
          by: String(s.Proposer_Name || "") || String(s.Proposed_By || ""),
          email: String(s.Proposed_By || ""),
          time: String(s.Timestamp || ""),
          removed: solutionRemoved_(s),
          removeReason: String(s.Remove_Reason || ""),
          removedBy: String(s.Removed_By || ""),
          removedAt: String(s.Removed_At || "")
        });
      });
  }

  var list = [];
  if (type !== "issue") {
    readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS)
      .filter(matches).forEach(function (r) {
        if (isHidden_(r) && !wantVoided) return;
        list.push({
          type: "work", id: String(r.Log_ID || ""), time: String(r.Timestamp || ""),
          user: String(r.User_Email || ""), name: names[String(r.User_Email)] || "",
          detail: String(r.Detail || ""), category: String(r.Category || "work"),
          status: String(r.Status || ""),
          files: fileMetaList_(r), links: parseLinks_(r.Links),
          voided: isVoided_(r),
          voidReason: String(r.Void_Reason || ""), voidedBy: String(r.Voided_By || ""), voidedAt: String(r.Voided_At || ""),
          removed: isRemoved_(r), removeReason: String(r.Remove_Reason || ""), removedBy: String(r.Removed_By || ""), removedAt: String(r.Removed_At || ""),
          rejected: isRejected_(r), rejectReason: String(r.Reject_Reason || "")
        });
      });
  }
  if (type !== "work") {
    readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES)
      .filter(matches).forEach(function (r) {
        if (isHidden_(r) && !wantVoided) return;
        list.push({
          type: "issue", id: String(r.Issue_ID || ""), time: String(r.Timestamp || ""),
          user: String(r.User_Email || ""), name: names[String(r.User_Email)] || "",
          detail: String(r.Detail || ""), category: String(r.Category || "issue"),
          status: String(r.Status || "Pending"),
          solvedBy: String(r.Solved_By || ""), solution: String(r.Solution || ""),
          kbApproved: isTruthy_(r.KB_Approved),
          files: fileMetaList_(r), links: parseLinks_(r.Links),
          solutions: (solByIssue[String(r.Issue_ID)] || []).slice().sort(function (a, b) { return a.time < b.time ? -1 : 1; }),
          voided: isVoided_(r),
          voidReason: String(r.Void_Reason || ""), voidedBy: String(r.Voided_By || ""), voidedAt: String(r.Voided_At || ""),
          removed: isRemoved_(r), removeReason: String(r.Remove_Reason || ""), removedBy: String(r.Removed_By || ""), removedAt: String(r.Removed_At || ""),
          rejected: isRejected_(r), rejectReason: String(r.Reject_Reason || "")
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

  if (type === "serviceevals") {
    var srows = readObjects_(getSheet_(SHEETS.SERVICE_EVALS, HEADERS.SERVICE_EVALS), HEADERS.SERVICE_EVALS).map(function (r) {
      return {
        "วันที่-เวลา": String(r.Timestamp || ""),
        "หัวข้อ": String(r.Request_Title || ""),
        "สถานที่": String(r.Location || ""),
        "ผู้ประเมิน": String(r.Requester_Email || ""),
        "แก้ไขได้รวดเร็ว (0-5)": r.Rating_Fast,
        "ช่วยไม่ได้ แจ้งส่วนอื่น (0-2)": r.Rating_Unable,
        "ดาวรวม": r.Stars_Total,
        "ความเห็น": String(r.Comment || ""),
        "เจ้าหน้าที่": names[String(r.Officer_Email)] || String(r.Officer_Name || ""),
        "อีเมลเจ้าหน้าที่": String(r.Officer_Email || ""),
        "XP ที่ได้": r.XP_Awarded,
        "สถานะ": String(r.Status || "Active"),
        "เหตุผลที่ยกเลิก": String(r.Void_Reason || "")
      };
    });
    srows.sort(function (a, b) { return a["วันที่-เวลา"] < b["วันที่-เวลา"] ? 1 : -1; });
    return { status: "ok", type: "serviceevals", count: srows.length, rows: srows };
  }

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

/* ผู้ใช้ Export "ข้อมูลของตัวเอง" (งาน + ปัญหา) — เลือกช่วงวันที่ได้ (เว้นว่าง = ทั้งหมด) (Phase 6.20)
   - ตรวจสิทธิ์เจ้าของจาก idToken
   - type: all | work | issues  · from/to: "YYYY-MM-DD" (เทียบเฉพาะส่วนวันที่ของ Timestamp) */
function myExportRecords_(idToken, emailParam, from, to, type) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  if (emailParam && emailParam !== email) throw new Error("email mismatch");

  from = String(from || "").slice(0, 10);
  to   = String(to || "").slice(0, 10);
  type = String(type || "all").toLowerCase();
  var filtered = (from || to);
  var inRange = function (ts) {
    var d = String(ts || "").slice(0, 10);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };

  var rows = [];
  if (type === "all" || type === "work" || type === "worklogs") {
    readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS).forEach(function (r) {
      if (String(r.User_Email) !== email) return;
      if (filtered && !inRange(r.Timestamp)) return;
      rows.push({
        "ประเภท": "งาน",
        "วันที่-เวลา": String(r.Timestamp || ""),
        "รายละเอียด": String(r.Detail || ""),
        "หมวดหมู่ (AI)": String(r.Category || ""),
        "สถานะ": isVoided_(r) ? "ถูกยกเลิก" : (isRemoved_(r) ? "ถูกลบ" : "ปกติ"),
        "ไฟล์แนบ": splitUrls_(r.File_URLs).join("\n"),
        "ลิงก์เพิ่มเติม": formatLinks_(r.Links)
      });
    });
  }
  if (type === "all" || type === "issue" || type === "issues") {
    readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES).forEach(function (r) {
      if (String(r.User_Email) !== email) return;
      if (filtered && !inRange(r.Timestamp)) return;
      rows.push({
        "ประเภท": "ปัญหา",
        "วันที่-เวลา": String(r.Timestamp || ""),
        "รายละเอียด": String(r.Detail || ""),
        "หมวดหมู่ (AI)": String(r.Category || ""),
        "สถานะ": String(r.Status || "Pending"),
        "ไฟล์แนบ": splitUrls_(r.File_URLs).join("\n"),
        "ลิงก์เพิ่มเติม": formatLinks_(r.Links)
      });
    });
  }
  rows.sort(function (a, b) { return a["วันที่-เวลา"] < b["วันที่-เวลา"] ? 1 : -1; });
  return { status: "ok", email: email, count: rows.length, from: from, to: to, type: type, rows: rows };
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

/* ซ่อนวิธีแก้ไขที่ซ้ำ/ใกล้เคียงกัน (เทียบข้อความ — เก็บอันแรกไว้) (Phase 6.14) */
function dedupeSolutionsByText_(items, getText) {
  var kept = [];
  (items || []).forEach(function (it) {
    var n = normalizeText_(getText(it));
    if (n) {
      for (var i = 0; i < kept.length; i++) {
        var kn = normalizeText_(getText(kept[i]));
        if (!kn) continue;
        if (kn === n || textSimilarity_(n, kn) >= DUP_SIMILARITY) return; // ซ้ำ → ข้าม
      }
    }
    kept.push(it);
  });
  return kept;
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
/* เช็กว่ารายการถูกลบแบบซอฟต์โดยแอดมินหรือยัง (Status = "Removed") */
function isRemoved_(r) { return String(r && r.Status || "").trim() === "Removed"; }
/* ซ่อนจากมุมมองทั่วไป: ทั้งที่ถูกยกเลิก (Void) และที่ถูกลบ (Removed) */
function isHidden_(r) { return isVoided_(r) || isRemoved_(r); }
/* เช็กว่าข้อเสนอแนะ (Solutions) ถูกลบไปแล้ว */
function solutionRemoved_(s) { return String(s && s.Status || "").trim() === "Removed"; }
/* เช็กว่ารายการถูกตีกลับให้แก้ไขหรือยัง (Status = "Rejected") */
function isRejected_(r) { return String(r && r.Status || "").trim() === "Rejected"; }

/* บันทึกประวัติการจัดการของแอดมิน (Audit Log) */
function logAudit_(actor, action, targetType, targetId, reason, meta) {
  try {
    appendByHeaders_(getSheet_(SHEETS.AUDIT_LOG, HEADERS.AUDIT_LOG), HEADERS.AUDIT_LOG, {
      Audit_ID: "AU-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
      Timestamp: nowStr_(), Actor_Email: String(actor || ""), Action: String(action || ""),
      Target_Type: String(targetType || ""), Target_ID: String(targetId || ""),
      Reason: String(reason || "").slice(0, 300), Meta: meta ? JSON.stringify(meta) : ""
    });
  } catch (e) { /* การบันทึก log ต้องไม่ทำให้งานหลักล้มเหลว */ }
}

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
  if (cur === "Removed") throw new Error("รายการนี้ถูกลบไปแล้ว");

  var owner = String(sh.getRange(row, map["User_Email"]).getValue() || "");
  var ts = nowStr_();
  if (map["Prev_Status"]) sh.getRange(row, map["Prev_Status"]).setValue(cur);
  sh.getRange(row, map["Status"]).setValue("Void");
  if (map["Void_Reason"]) sh.getRange(row, map["Void_Reason"]).setValue(reason.slice(0, 200));
  if (map["Voided_By"])   sh.getRange(row, map["Voided_By"]).setValue(adminEmail);
  if (map["Voided_At"])   sh.getRange(row, map["Voided_At"]).setValue(ts);

  var reversed = reverseXpForRecord_(owner, recordId, reason, "void");
  if (map["Removed_XP"]) sh.getRange(row, map["Removed_XP"]).setValue(reversed);
  logAudit_(adminEmail, "void", type, recordId, reason, { owner: owner, reversedXp: reversed });
  return json_({ status: "ok", type: type, id: recordId, reversedXp: reversed, message: "ยกเลิกรายการเรียบร้อย" });
}

/* ======================================================================
 * [7d-0] ผู้ใช้ "ลบ" งาน/ปัญหาของตัวเองจากหน้าประวัติ (Phase 6.19)
 *   - อนุญาตเฉพาะเจ้าของรายการ (ตรวจจาก idToken ที่ doPost verify แล้ว)
 *   - ซอฟต์ดีลีต: Status="Removed" + เก็บเหตุผล/ผู้ลบ/เวลา + Prev_Status (แอดมินกู้คืนได้)
 *   - "หัก XP คืน" ที่รายการนี้เคยได้ (คิดจากยอดสุทธิ กันหักซ้ำ; ถ้าเคยถูกตีกลับแล้วจะไม่หักซ้ำ)
 *   - ถ้าเป็นปัญหาที่เคยขึ้นคลังองค์ความรู้ จะซ่อนออกจากคลังด้วย (กู้คืนได้ที่แผงคลัง)
 * ==================================================================== */
function handleDeleteMyRecord_(email, recordType, recordId, reason) {
  if (!recordId) throw new Error("ไม่พบรหัสรายการ");
  var type = (String(recordType) === "issue") ? "issue" : "work";
  var sh = type === "issue"
    ? getSheet_(SHEETS.ISSUES, HEADERS.ISSUES)
    : getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS);
  var idHeader = type === "issue" ? "Issue_ID" : "Log_ID";

  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("ไม่พบรายการนี้ (อาจถูกลบจากชีตไปแล้ว)");
  assertOwner_(sh, row, "User_Email", email);

  var map = headerMap_(sh);
  var cur = String(sh.getRange(row, map["Status"]).getValue() || "");
  if (cur === "Removed") throw new Error("รายการนี้ถูกลบไปแล้ว");
  if (cur === "Void") throw new Error("รายการนี้ถูกยกเลิกแล้ว");

  reason = String(reason || "").trim() || "ผู้ใช้ลบรายการเอง";
  var ts = nowStr_();
  if (map["Prev_Status"]) sh.getRange(row, map["Prev_Status"]).setValue(cur);
  sh.getRange(row, map["Status"]).setValue("Removed");
  if (map["Remove_Reason"]) sh.getRange(row, map["Remove_Reason"]).setValue(reason.slice(0, 200));
  if (map["Removed_By"])    sh.getRange(row, map["Removed_By"]).setValue(email);
  if (map["Removed_At"])    sh.getRange(row, map["Removed_At"]).setValue(ts);

  // ปัญหาที่เคยขึ้นคลังองค์ความรู้ → ซ่อนออกจากคลังด้วย (แอดมินกู้คืนได้)
  if (type === "issue" && map["KB_Approved"] && isTruthy_(sh.getRange(row, map["KB_Approved"]).getValue())) {
    sh.getRange(row, map["KB_Approved"]).setValue(false);
    if (map["KB_Remove_Reason"]) sh.getRange(row, map["KB_Remove_Reason"]).setValue(reason.slice(0, 200));
    if (map["KB_Removed_By"])    sh.getRange(row, map["KB_Removed_By"]).setValue(email);
    if (map["KB_Removed_At"])    sh.getRange(row, map["KB_Removed_At"]).setValue(ts);
  }

  var reversed = reverseXpForRecord_(email, recordId, reason, "remove");
  if (map["Removed_XP"]) sh.getRange(row, map["Removed_XP"]).setValue(reversed);
  logAudit_(email, "remove_self", type, recordId, reason, { owner: email, reversedXp: reversed });
  return json_({
    status: "ok", type: type, id: recordId, reversedXp: reversed,
    message: reversed > 0 ? ("ลบรายการแล้ว (หักคืน " + reversed + " XP)") : "ลบรายการแล้ว"
  });
}

/* หัก XP คืนสำหรับ record: เพิ่มแถว XP_History (Amount ติดลบ) + ลด Total_XP + recompute Level
   คิดจาก "ยอดสุทธิ" ของรายการ (positive จาก work_log/issue, negative จาก void/reject)
   กันหักซ้ำอัตโนมัติ (ถ้ายอดสุทธิ <= 0 จะไม่หัก) และรองรับหลายรอบ reject→resubmit
   หมายเหตุ: "solution" รวมถึง "like_received" ที่ผูกกับ Solution_ID นั้นด้วย (Phase 6.17) */
function netRecordXp_(recordId) {
  return readObjects_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY)
    .filter(function (h) { return String(h.Ref_ID) === String(recordId); })
    .reduce(function (sum, h) {
      var r = String(h.Reason);
      if (r === "work_log" || r === "issue" || r === "solution" || r === "like_received" || r === "void" || r === "reject" || r === "remove" || r === "restore") return sum + Number(h.Amount || 0);
      return sum;
    }, 0);
}

function reverseXpForRecord_(email, recordId, reason, tag) {
  tag = tag || "void";
  var xsh = getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY);
  var net = netRecordXp_(recordId);
  if (net <= 0) return 0;

  appendByHeaders_(xsh, HEADERS.XP_HISTORY, {
    XP_ID: "XP-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
    Timestamp: nowStr_(), User_Email: email, Amount: -net, Reason: tag,
    Ref_ID: recordId, Client_Ref: (tag + ": " + reason).slice(0, 100)
  });

  if (email) {
    var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
    var map = headerMap_(ush);
    var urow = findRowByHeader_(ush, "Email", email);
    if (urow !== -1) {
      var total = Number(ush.getRange(urow, map["Total_XP"]).getValue() || 0) - net;
      if (total < 0) total = 0;
      ush.getRange(urow, map["Total_XP"]).setValue(total);
      ush.getRange(urow, map["Level"]).setValue(levelFor_(total).level);
    }
  }
  return net;
}

/* ======================================================================
 * [7c-2] แอดมิน "ลบ" รายการแบบซอฟต์ (Phase 6.10)
 *   kind: work | issue | kb | solution
 *   - work/issue/solution: ทำเครื่องหมาย Status="Removed" + เก็บเหตุผล + หัก XP คืน
 *   - kb: ซ่อนออกจากคลังองค์ความรู้ (KB_Approved=false) โดยไม่ลบรายการต้นทาง
 *   ไม่ส่งแจ้งเตือนผู้ใช้ — ผู้ใช้เห็นสถานะ "ถูกลบ" ในประวัติของตัวเอง
 * ==================================================================== */
function handleAdminRemove_(adminEmail, kind, id, reason) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!id) throw new Error("ไม่พบรหัสรายการ");
  reason = String(reason || "").trim();
  if (!reason) throw new Error("กรุณาระบุเหตุผลในการลบ");
  kind = String(kind || "").toLowerCase();
  var ts = nowStr_();

  if (kind === "kb") {
    var ksh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
    var krow = findRowByHeader_(ksh, "Issue_ID", id);
    if (krow === -1) throw new Error("ไม่พบรายการในคลังองค์ความรู้");
    var kmap = headerMap_(ksh);
    if (kmap["KB_Approved"])    ksh.getRange(krow, kmap["KB_Approved"]).setValue(false);
    if (kmap["KB_Remove_Reason"]) ksh.getRange(krow, kmap["KB_Remove_Reason"]).setValue(reason.slice(0, 200));
    if (kmap["KB_Removed_By"])  ksh.getRange(krow, kmap["KB_Removed_By"]).setValue(adminEmail);
    if (kmap["KB_Removed_At"])  ksh.getRange(krow, kmap["KB_Removed_At"]).setValue(ts);
    logAudit_(adminEmail, "kb_remove", "kb", id, reason, {});
    return json_({ status: "ok", kind: "kb", id: id, message: "ลบออกจากคลังองค์ความรู้แล้ว" });
  }

  if (kind === "solution") {
    var ssh = getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS);
    var srow = findRowByHeader_(ssh, "Solution_ID", id);
    if (srow === -1) throw new Error("ไม่พบข้อเสนอแนะนี้");
    var smap = headerMap_(ssh);
    if (String(ssh.getRange(srow, smap["Status"]).getValue() || "") === "Removed") throw new Error("ข้อเสนอแนะนี้ถูกลบไปแล้ว");
    var proposer = String(ssh.getRange(srow, smap["Proposed_By"]).getValue() || "");
    var sprev = String(ssh.getRange(srow, smap["Status"]).getValue() || "");
    if (smap["Prev_Status"])   ssh.getRange(srow, smap["Prev_Status"]).setValue(sprev);
    if (smap["Status"])        ssh.getRange(srow, smap["Status"]).setValue("Removed");
    if (smap["Remove_Reason"]) ssh.getRange(srow, smap["Remove_Reason"]).setValue(reason.slice(0, 200));
    if (smap["Removed_By"])    ssh.getRange(srow, smap["Removed_By"]).setValue(adminEmail);
    if (smap["Removed_At"])    ssh.getRange(srow, smap["Removed_At"]).setValue(ts);
    var srev = reverseXpForRecord_(proposer, id, reason, "remove");
    if (smap["Removed_XP"])    ssh.getRange(srow, smap["Removed_XP"]).setValue(srev);
    logAudit_(adminEmail, "remove", "solution", id, reason, { owner: proposer, reversedXp: srev });
    return json_({ status: "ok", kind: "solution", id: id, reversedXp: srev, message: "ลบข้อเสนอแนะแล้ว" });
  }

  var type = (kind === "issue") ? "issue" : "work";
  var t = recordSheet_(type);
  var sh = t.sh, idHeader = t.idHeader;
  var row = findRowByHeader_(sh, idHeader, id);
  if (row === -1) throw new Error("ไม่พบรายการนี้ (อาจถูกลบจากชีตไปแล้ว)");
  var map = headerMap_(sh);
  var cur = String(sh.getRange(row, map["Status"]).getValue() || "");
  if (cur === "Removed") throw new Error("รายการนี้ถูกลบไปแล้ว");
  if (cur === "Void") throw new Error("รายการนี้ถูกยกเลิกไปแล้ว");

  var owner = String(sh.getRange(row, map["User_Email"]).getValue() || "");
  if (map["Prev_Status"]) sh.getRange(row, map["Prev_Status"]).setValue(cur);
  sh.getRange(row, map["Status"]).setValue("Removed");
  if (map["Remove_Reason"]) sh.getRange(row, map["Remove_Reason"]).setValue(reason.slice(0, 200));
  if (map["Removed_By"])    sh.getRange(row, map["Removed_By"]).setValue(adminEmail);
  if (map["Removed_At"])    sh.getRange(row, map["Removed_At"]).setValue(ts);

  var rev = reverseXpForRecord_(owner, id, reason, "remove");
  if (map["Removed_XP"]) sh.getRange(row, map["Removed_XP"]).setValue(rev);
  logAudit_(adminEmail, "remove", type, id, reason, { owner: owner, reversedXp: rev });
  return json_({ status: "ok", kind: type, id: id, reversedXp: rev, message: "ลบรายการเรียบร้อย" });
}

/* ======================================================================
 * [7c-3] แอดมิน "กู้คืน" รายการที่ถูกลบ/ยกเลิก (Phase 6.11)
 *   kind: work | issue | solution | kb
 *   - work/issue/solution: คืนสถานะเดิม (Prev_Status) + คืน XP ที่เคยหักไป
 *   - kb: คืนเข้าคลังองค์ความรู้ (KB_Approved=true)
 * ==================================================================== */
function handleAdminRestore_(adminEmail, kind, id, reason) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!id) throw new Error("ไม่พบรหัสรายการ");
  reason = String(reason || "").trim() || "กู้คืนรายการ";
  kind = String(kind || "").toLowerCase();
  var ts = nowStr_();

  if (kind === "kb") {
    var ksh = getSheet_(SHEETS.ISSUES, HEADERS.ISSUES);
    var krow = findRowByHeader_(ksh, "Issue_ID", id);
    if (krow === -1) throw new Error("ไม่พบรายการในคลังองค์ความรู้");
    var kmap = headerMap_(ksh);
    if (kmap["KB_Approved"])       ksh.getRange(krow, kmap["KB_Approved"]).setValue(true);
    if (kmap["KB_Remove_Reason"])  ksh.getRange(krow, kmap["KB_Remove_Reason"]).setValue("");
    if (kmap["KB_Removed_By"])     ksh.getRange(krow, kmap["KB_Removed_By"]).setValue("");
    if (kmap["KB_Removed_At"])     ksh.getRange(krow, kmap["KB_Removed_At"]).setValue("");
    logAudit_(adminEmail, "kb_restore", "kb", id, reason, {});
    return json_({ status: "ok", kind: "kb", id: id, message: "คืนเข้าคลังองค์ความรู้แล้ว" });
  }

  if (kind === "solution") {
    var ssh = getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS);
    var srow = findRowByHeader_(ssh, "Solution_ID", id);
    if (srow === -1) throw new Error("ไม่พบข้อเสนอแนะนี้");
    var smap = headerMap_(ssh);
    var srem = String(ssh.getRange(srow, smap["Status"]).getValue() || "");
    if (srem !== "Removed") throw new Error("ข้อเสนอแนะนี้ไม่ได้ถูกลบ");
    var proposer = String(ssh.getRange(srow, smap["Proposed_By"]).getValue() || "");
    var sprev = smap["Prev_Status"] ? String(ssh.getRange(srow, smap["Prev_Status"]).getValue() || "") : "";
    if (smap["Status"])        ssh.getRange(srow, smap["Status"]).setValue(sprev);
    if (smap["Remove_Reason"]) ssh.getRange(srow, smap["Remove_Reason"]).setValue("");
    if (smap["Removed_By"])    ssh.getRange(srow, smap["Removed_By"]).setValue("");
    if (smap["Removed_At"])    ssh.getRange(srow, smap["Removed_At"]).setValue("");
    var sback = smap["Removed_XP"] ? Number(ssh.getRange(srow, smap["Removed_XP"]).getValue() || 0) : 0;
    if (sback > 0 && proposer) awardXp_(proposer, sback, "restore", id, "");
    if (smap["Removed_XP"]) ssh.getRange(srow, smap["Removed_XP"]).setValue(0);
    logAudit_(adminEmail, "restore", "solution", id, reason, { owner: proposer, restoredXp: sback });
    return json_({ status: "ok", kind: "solution", id: id, restoredXp: sback, message: "กู้คืนข้อเสนอแนะแล้ว" });
  }

  var type = (kind === "issue") ? "issue" : "work";
  var t = recordSheet_(type);
  var sh = t.sh, idHeader = t.idHeader;
  var row = findRowByHeader_(sh, idHeader, id);
  if (row === -1) throw new Error("ไม่พบรายการนี้");
  var map = headerMap_(sh);
  var cur = String(sh.getRange(row, map["Status"]).getValue() || "");
  if (cur !== "Removed" && cur !== "Void") throw new Error("รายการนี้ไม่ได้ถูกลบหรือยกเลิก");

  var owner = String(sh.getRange(row, map["User_Email"]).getValue() || "");
  var prev = map["Prev_Status"] ? String(sh.getRange(row, map["Prev_Status"]).getValue() || "") : "";
  sh.getRange(row, map["Status"]).setValue(prev);
  if (map["Remove_Reason"]) sh.getRange(row, map["Remove_Reason"]).setValue("");
  if (map["Removed_By"])    sh.getRange(row, map["Removed_By"]).setValue("");
  if (map["Removed_At"])    sh.getRange(row, map["Removed_At"]).setValue("");
  if (map["Void_Reason"])   sh.getRange(row, map["Void_Reason"]).setValue("");
  if (map["Voided_By"])     sh.getRange(row, map["Voided_By"]).setValue("");
  if (map["Voided_At"])     sh.getRange(row, map["Voided_At"]).setValue("");

  var back = map["Removed_XP"] ? Number(sh.getRange(row, map["Removed_XP"]).getValue() || 0) : 0;
  if (back > 0 && owner) awardXp_(owner, back, "restore", id, "");
  if (map["Removed_XP"]) sh.getRange(row, map["Removed_XP"]).setValue(0);
  logAudit_(adminEmail, "restore", type, id, reason, { owner: owner, restoredXp: back, toStatus: prev });
  return json_({ status: "ok", kind: type, id: id, restoredXp: back, message: "กู้คืนรายการเรียบร้อย" });
}

/* ======================================================================
 * [7c-4] แอดมินแก้ไข/ลบรายละเอียดย่อยในแผง "รายการส่งข้อมูล" (Phase 6.23)
 *   - adminEditSolution : แก้ข้อความข้อเสนอแนะ (XP ไม่เปลี่ยน)
 *   - adminRemoveFile   : ลบไฟล์แนบออกจากรายการ (ไม่ลบไฟล์จริงใน Drive)
 *   - adminRemoveLink   : ลบ "ลิงก์ข้อมูลเพิ่มเติม" ออก 1 รายการ
 * ==================================================================== */
function handleAdminEditSolution_(adminEmail, solutionId, text) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!solutionId) throw new Error("ไม่พบข้อเสนอแนะนี้");
  text = String(text || "").trim();
  if (!text) throw new Error("ไม่มีข้อความ");
  if (text.length < MIN_DETAIL_CHARS) throw new Error("ข้อความต้องมีอย่างน้อย " + MIN_DETAIL_CHARS + " ตัวอักษร");
  if (text.length > 5000) throw new Error("ข้อความยาวเกินไป (สูงสุด 5000 ตัวอักษร)");

  var ssh = getSheet_(SHEETS.SOLUTIONS, HEADERS.SOLUTIONS);
  var row = findRowByHeader_(ssh, "Solution_ID", solutionId);
  if (row === -1) throw new Error("ไม่พบข้อเสนอแนะนี้");
  var map = headerMap_(ssh);
  if (String(ssh.getRange(row, map["Status"]).getValue() || "") === "Removed") throw new Error("ข้อเสนอแนะนี้ถูกลบอยู่ แก้ไขไม่ได้ (กู้คืนก่อน)");
  var oldText = String(ssh.getRange(row, map["Solution_Text"]).getValue() || "");
  ssh.getRange(row, map["Solution_Text"]).setValue(text);
  logAudit_(adminEmail, "edit", "solution", solutionId, "", { oldText: oldText.slice(0, 120), newText: text.slice(0, 120) });
  return json_({ status: "ok", id: solutionId, solution: text, message: "แก้ไขข้อเสนอแนะแล้ว" });
}

/* แอดมินลบไฟล์แนบออกจากรายการ (ลบเฉพาะการอ้างอิงในรายการ — ไฟล์ใน Drive คงอยู่) */
function handleAdminRemoveFile_(adminEmail, recordType, recordId, url) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!recordId) throw new Error("ไม่พบรหัสรายการ");
  url = String(url || "").trim();
  if (!url) throw new Error("ไม่พบไฟล์ที่จะลบ");
  var t = recordSheet_(recordType);
  var sh = t.sh, idHeader = t.idHeader;
  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("ไม่พบรายการนี้");
  var map = headerMap_(sh);

  var urls = splitUrls_(sh.getRange(row, map["File_URLs"]).getValue()).filter(function (u) { return String(u) !== url; });
  sh.getRange(row, map["File_URLs"]).setValue(urls.join("\n"));

  if (map["File_Meta"]) {
    var metas = [];
    try { metas = JSON.parse(String(sh.getRange(row, map["File_Meta"]).getValue() || "") || "[]"); } catch (e) { metas = []; }
    if (!Array.isArray(metas)) metas = [];
    metas = metas.filter(function (m) { return String(m && m.url) !== url; });
    sh.getRange(row, map["File_Meta"]).setValue(metas.length ? JSON.stringify(metas) : "");
  }
  logAudit_(adminEmail, "remove_file", (String(recordType) === "issue" ? "issue" : "work"), recordId, "", { url: url });
  return json_({ status: "ok", id: recordId, remaining: urls.length, message: "ลบไฟล์แนบออกจากรายการแล้ว" });
}

/* แอดมินลบ "ลิงก์ข้อมูลเพิ่มเติม" ออก 1 รายการ */
function handleAdminRemoveLink_(adminEmail, recordType, recordId, url) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!recordId) throw new Error("ไม่พบรหัสรายการ");
  url = String(url || "").trim();
  if (!url) throw new Error("ไม่พบลิงก์ที่จะลบ");
  var t = recordSheet_(recordType);
  var sh = t.sh, idHeader = t.idHeader;
  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("ไม่พบรายการนี้");
  var map = headerMap_(sh);
  var col = map["Links"];
  if (!col) throw new Error("ยังไม่มีคอลัมน์ Links");

  var links = parseLinks_(sh.getRange(row, col).getValue()).filter(function (l) { return String(l && l.u) !== url; });
  sh.getRange(row, col).setValue(serializeLinks_(links));
  logAudit_(adminEmail, "remove_link", (String(recordType) === "issue" ? "issue" : "work"), recordId, "", { url: url });
  return json_({ status: "ok", id: recordId, remaining: links.length, message: "ลบลิงก์แล้ว" });
}

/* ======================================================================
 * [7d] แอดมินแก้ไข/ตีกลับรายการ + ผู้ใช้ส่งใหม่ (Phase 6.7)
 * ==================================================================== */
/* หา sheet/หัวข้อคอลัมน์ ตามประเภทรายการ */
function recordSheet_(recordType) {
  if (String(recordType) === "issue") return { sh: getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), idHeader: "Issue_ID" };
  return { sh: getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), idHeader: "Log_ID" };
}

/* แอดมินแก้ไข Detail / Category / Status ของรายการผู้ใช้ */
function handleAdminEditRecord_(adminEmail, recordType, recordId, detail, category, status) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!recordId) throw new Error("ไม่พบรหัสรายการ");

  var t = recordSheet_(recordType);
  var sh = t.sh, idHeader = t.idHeader;
  var type = idHeader === "Issue_ID" ? "issue" : "work";
  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("ไม่พบรายการนี้ (อาจถูกลบจากชีตไปแล้ว)");
  var map = headerMap_(sh);

  var curStatus = String(sh.getRange(row, map["Status"]).getValue() || "");
  if (curStatus === "Void") throw new Error("รายการนี้ถูกยกเลิกแล้ว แก้ไขไม่ได้");
  if (curStatus === "Removed") throw new Error("รายการนี้ถูกลบโดยแอดมิน แก้ไขไม่ได้");

  if (detail != null && String(detail).trim()) {
    var d = String(detail).trim();
    if (d.length < MIN_DETAIL_CHARS) throw new Error("ข้อความต้องมีอย่างน้อย " + MIN_DETAIL_CHARS + " ตัวอักษร");
    if (d.length > 5000) throw new Error("ข้อความยาวเกินไป (สูงสุด 5000 ตัวอักษร)");
    sh.getRange(row, map["Detail"]).setValue(d);
  }

  if (category != null && String(category).trim() && map["Category"]) {
    sh.getRange(row, map["Category"]).setValue(String(category).trim().slice(0, 40));
  }

  if (status != null && String(status).trim() && map["Status"]) {
    var s = String(status).trim();
    var allowed = ["Pending", "In-Progress", "Solved", "Closed"];
    if (allowed.indexOf(s) === -1) throw new Error("สถานะไม่ถูกต้อง");
    if (curStatus === "Rejected") throw new Error("รายการที่ถูกตีกลับให้ผู้ใช้ส่งใหม่ (แก้สถานะผ่านการส่งใหม่)");
    sh.getRange(row, map["Status"]).setValue(s);
  }

  return json_({ status: "ok", type: type, id: recordId, message: "บันทึกการแก้ไขแล้ว" });
}

/* แอดมินตีกลับรายการ (Status="Rejected") + หัก XP คืน + เก็บเหตุผล ให้ผู้ใช้แก้แล้วส่งใหม่ */
function handleAdminRejectRecord_(adminEmail, recordType, recordId, reason) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!recordId) throw new Error("ไม่พบรหัสรายการ");
  reason = String(reason || "").trim();
  if (!reason) throw new Error("กรุณาระบุเหตุผลในการปฏิเสธ");

  var t = recordSheet_(recordType);
  var sh = t.sh, idHeader = t.idHeader;
  var type = idHeader === "Issue_ID" ? "issue" : "work";
  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("ไม่พบรายการนี้ (อาจถูกลบจากชีตไปแล้ว)");
  var map = headerMap_(sh);

  var cur = String(sh.getRange(row, map["Status"]).getValue() || "");
  if (cur === "Void") throw new Error("รายการนี้ถูกยกเลิกไปแล้ว");
  if (cur === "Removed") throw new Error("รายการนี้ถูกลบไปแล้ว");
  if (cur === "Rejected") throw new Error("รายการนี้ถูกตีกลับไปแล้ว");

  var owner = String(sh.getRange(row, map["User_Email"]).getValue() || "");
  var ts = nowStr_();
  sh.getRange(row, map["Status"]).setValue("Rejected");
  if (map["Reject_Reason"]) sh.getRange(row, map["Reject_Reason"]).setValue(reason.slice(0, 200));
  if (map["Rejected_By"])   sh.getRange(row, map["Rejected_By"]).setValue(adminEmail);
  if (map["Rejected_At"])   sh.getRange(row, map["Rejected_At"]).setValue(ts);

  var reversed = reverseXpForRecord_(owner, recordId, reason, "reject");
  logAudit_(adminEmail, "reject", type, recordId, reason, { owner: owner, reversedXp: reversed });
  return json_({ status: "ok", type: type, id: recordId, reversedXp: reversed, message: "ตีกลับรายการเรียบร้อย (หัก XP คืนแล้ว)" });
}

/* ผู้ใช้แก้ไขแล้วส่งรายการที่ถูกตีกลับใหม่ — ล้างสถานะ Rejected + คืน XP ตามปกติ */
function handleResubmitRecord_(email, recordType, recordId, detail) {
  if (!recordId) throw new Error("ไม่พบรหัสรายการ");

  var t = recordSheet_(recordType);
  var sh = t.sh, idHeader = t.idHeader;
  var type = idHeader === "Issue_ID" ? "issue" : "work";
  var row = findRowByHeader_(sh, idHeader, recordId);
  if (row === -1) throw new Error("ไม่พบรายการนี้");
  var map = headerMap_(sh);

  assertOwner_(sh, row, "User_Email", email);

  if (String(sh.getRange(row, map["Status"]).getValue() || "") !== "Rejected") {
    throw new Error("รายการนี้ไม่ได้อยู่ในสถานะถูกตีกลับ");
  }

  if (detail != null && String(detail).trim()) {
    var d = String(detail).trim();
    if (d.length < MIN_DETAIL_CHARS) throw new Error("ข้อความต้องมีอย่างน้อย " + MIN_DETAIL_CHARS + " ตัวอักษร");
    if (d.length > 5000) throw new Error("ข้อความยาวเกินไป (สูงสุด 5000 ตัวอักษร)");
    sh.getRange(row, map["Detail"]).setValue(d);
  }

  sh.getRange(row, map["Status"]).setValue(type === "issue" ? "Pending" : "");
  if (map["Reject_Reason"]) sh.getRange(row, map["Reject_Reason"]).setValue("");
  if (map["Rejected_By"])   sh.getRange(row, map["Rejected_By"]).setValue("");
  if (map["Rejected_At"])   sh.getRange(row, map["Rejected_At"]).setValue("");

  var xp = type === "issue" ? getXpConfig_().ISSUE : getXpConfig_().WORK_LOG;
  var lv = awardXp_(email, xp, type === "issue" ? "issue" : "work_log", recordId, "");
  evaluateAchievements_(email);
  return json_({ status: "ok", type: type, id: recordId, xp: xp, totalXp: lv.totalXp, level: lv.level, title: lv.title, message: "ส่งรายการใหม่เรียบร้อย" });
}

/* รายการที่ถูกตีกลับของผู้ใช้ (หน้าต่าง "รอส่ง") */
function myRejected_(idToken) {
  if (!idToken) return { status: "ok", count: 0, items: [] };
  var email = verifyIdToken_(idToken).email;
  var out = [];

  readObjects_(getSheet_(SHEETS.WORK_LOGS, HEADERS.WORK_LOGS), HEADERS.WORK_LOGS).forEach(function (r) {
    if (String(r.User_Email || "") !== email || String(r.Status || "") !== "Rejected") return;
    out.push({
      type: "work", id: String(r.Log_ID || ""), time: String(r.Timestamp || ""),
      detail: String(r.Detail || ""), category: String(r.Category || "work"),
      reason: String(r.Reject_Reason || ""), rejectedBy: String(r.Rejected_By || ""), rejectedAt: String(r.Rejected_At || ""),
      files: fileMetaList_(r), links: parseLinks_(r.Links)
    });
  });
  readObjects_(getSheet_(SHEETS.ISSUES, HEADERS.ISSUES), HEADERS.ISSUES).forEach(function (r) {
    if (String(r.User_Email || "") !== email || String(r.Status || "") !== "Rejected") return;
    out.push({
      type: "issue", id: String(r.Issue_ID || ""), time: String(r.Timestamp || ""),
      detail: String(r.Detail || ""), category: String(r.Category || "issue"),
      reason: String(r.Reject_Reason || ""), rejectedBy: String(r.Rejected_By || ""), rejectedAt: String(r.Rejected_At || ""),
      files: fileMetaList_(r), links: parseLinks_(r.Links)
    });
  });

  out.sort(function (a, b) { return a.time < b.time ? 1 : -1; });
  return { status: "ok", count: out.length, items: out };
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
  var infos = [];
  files.forEach(function (f, i) {
    try {
      if (!f || !f.base64) return;
      var bytes = Utilities.base64Decode(f.base64);
      var blob = Utilities.newBlob(bytes, f.mimeType || "application/octet-stream", f.name || ("file-" + (i + 1)));
      var file = folder.createFile(blob);
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (ignore) {}
      infos.push({ url: file.getUrl(), id: file.getId(), name: f.name || ("file-" + (i + 1)), mimeType: f.mimeType || "" });
    } catch (err) { infos.push({ url: "upload failed: " + err, id: "", name: "error", mimeType: "" }); }
  });
  return infos;
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

/* หาแถวแนวทางแก้ไขของผู้ใช้คนหนึ่งในรายการหนึ่ง (คืนเลขแถว หรือ -1) */
function findSolutionRow_(sh, issueId, email) {
  var map = headerMap_(sh);
  if (!map["Issue_ID"] || !map["Proposed_By"]) return -1;
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][map["Issue_ID"] - 1]) === String(issueId) &&
        String(vals[i][map["Proposed_By"] - 1] || "") === email) return i + 2;
  }
  return -1;
}

function assertOwner_(sh, row, emailHeader, email) {
  var map = headerMap_(sh);
  if (String(sh.getRange(row, map[emailHeader]).getValue() || "") !== email) throw new Error("ไม่มีสิทธิ์แก้ไขรายการนี้");
}

function appendFileUrls_(sh, row, infos) {
  if (!infos || !infos.length) return;
  var map = headerMap_(sh);

  // Append URLs to File_URLs
  var col = map["File_URLs"];
  var cur = String(sh.getRange(row, col).getValue() || "");
  var newUrls = infos.map(function (fi) { return fi.url; }).join("\n");
  sh.getRange(row, col).setValue((cur ? cur + "\n" : "") + newUrls);

  // Append meta to File_Meta (JSON array merge)
  var metaCol = map["File_Meta"];
  if (metaCol) {
    var curMeta = String(sh.getRange(row, metaCol).getValue() || "").trim();
    var existing = [];
    if (curMeta) { try { existing = JSON.parse(curMeta); } catch (e) {} }
    var merged = existing.concat(infos);
    sh.getRange(row, metaCol).setValue(JSON.stringify(merged));
  }
}

function splitUrls_(v) {
  var s = String(v || "").trim();
  return s ? s.split(/\s*\n\s*/).filter(function (x) { return x; }) : [];
}

/* อ่าน File_Meta (JSON array) ถ้าไม่มี → fallback เป็น splitUrls_ + ชื่อ/ชนิดว่าง */
function fileMetaList_(r) {
  var meta = String(r.File_Meta || "").trim();
  if (meta) {
    try {
      var parsed = JSON.parse(meta);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {}
  }
  // fallback: อ่านจาก File_URLs (ข้อมูลเก่า), สร้างชื่อ generic
  var urls = splitUrls_(r.File_URLs);
  return urls.map(function (u) { return { url: u, id: "", name: "", mimeType: "" }; });
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
function pad2_(n) { n = Number(n) || 0; return (n < 10 ? "0" : "") + n; }

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
    "• Notifications, Notif_Acks, User_Achievements"
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

/* ======================================================================
 * [11] Service Evaluation (QR-based) — Phase 6.24
 *   - serviceToken_       : สร้าง/คืน token ประจำตัวเจ้าหน้าที่ (ต้อง login)
 *   - serviceEvalInfo_    : ตรวจสอบ token ฝั่งสาธารณะ (ไม่ต้อง login)
 *   - handleSubmitEvaluation_ : บันทึกผลประเมิน + ให้ XP = ดาวรวม (doPost, สาธารณะ)
 *   - myServiceEvals_     : ประวัติการประเมินที่เจ้าหน้าที่ได้รับ
 *   - adminServiceEvals_  : รายการประเมินทั้งหมด (แอดมิน)
 * ==================================================================== */
function serviceToken_(idToken) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  var profile = myProfile_(idToken, email);
  var officerName = String((profile && profile.name) || "").trim() || email;

  var tsh = getSheet_(SHEETS.SERVICE_TOKENS, HEADERS.SERVICE_TOKENS);
  var last = tsh.getLastRow();
  if (last >= 2) {
    var vals = tsh.getRange(2, 1, last - 1, tsh.getLastColumn()).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][1] || "") === email) {
        var existing = String(vals[i][0] || "");
        if (existing) return { status: "ok", token: existing, email: email, name: officerName };
      }
    }
  }

  var token = "SV-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMddHHmmss") + "-" + rand3_();
  appendByHeaders_(tsh, HEADERS.SERVICE_TOKENS, {
    Token: token, Officer_Email: email, Officer_Name: officerName, Created_At: nowStr_()
  });
  return { status: "ok", token: token, email: email, name: officerName };
}

function serviceEvalInfo_(token) {
  if (!token) return { status: "error", message: "ไม่พบรหัสประเมิน" };
  var objs = readObjects_(getSheet_(SHEETS.SERVICE_TOKENS, HEADERS.SERVICE_TOKENS), HEADERS.SERVICE_TOKENS);
  for (var i = 0; i < objs.length; i++) {
    if (String(objs[i].Token) === String(token)) {
      return { status: "ok", name: objs[i].Officer_Name || objs[i].Officer_Email };
    }
  }
  return { status: "error", message: "ลิงก์ไม่ถูกต้องหรือหมดอายุ" };
}

function handleSubmitEvaluation_(token, title, location, requesterEmail, ratingFast, ratingUnable, comment) {
  if (!token) return json_({ status: "error", message: "ไม่พบรหัสประเมิน" });
  var t = String(title || "").trim();
  if (!t) return json_({ status: "error", message: "ต้องกรอกชื่อเรื่องที่ขอใช้บริการ" });

  var tokObjs = readObjects_(getSheet_(SHEETS.SERVICE_TOKENS, HEADERS.SERVICE_TOKENS), HEADERS.SERVICE_TOKENS);
  var officerEmail = null, officerName = null;
  for (var i = 0; i < tokObjs.length; i++) {
    if (String(tokObjs[i].Token) === String(token)) {
      officerEmail = tokObjs[i].Officer_Email;
      officerName = tokObjs[i].Officer_Name;
      break;
    }
  }
  if (!officerEmail) return json_({ status: "error", message: "ลิงก์ไม่ถูกต้องหรือหมดอายุ" });

  var fast = Math.max(0, Math.min(5, Number(ratingFast) || 0));
  var unable = Math.max(0, Math.min(2, Number(ratingUnable) || 0));
  var stars = fast + unable;

  var esh = getSheet_(SHEETS.SERVICE_EVALS, HEADERS.SERVICE_EVALS);
  var evalId = "EVAL-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMddHHmmss") + "-" + rand3_();
  var ts = nowStr_();
  appendByHeaders_(esh, HEADERS.SERVICE_EVALS, {
    Eval_ID: evalId, Timestamp: ts, Request_Title: t, Location: String(location || ""),
    Requester_Email: String(requesterEmail || ""), Rating_Fast: fast, Rating_Unable: unable,
    Stars_Total: stars, Comment: String(comment || ""), Officer_Email: officerEmail,
    Officer_Name: officerName, XP_Awarded: stars
  });

  if (stars > 0) awardXp_(officerEmail, stars, "service_eval", evalId, "");
  evaluateAchievements_(officerEmail);
  return json_({ status: "ok", stars: stars, xp: stars });
}

function myServiceEvals_(idToken, emailParam) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  if (emailParam && emailParam !== email) throw new Error("email mismatch");

  var objs = readObjects_(getSheet_(SHEETS.SERVICE_EVALS, HEADERS.SERVICE_EVALS), HEADERS.SERVICE_EVALS);
  var res = [];
  for (var i = objs.length - 1; i >= 0; i--) {
    if (String(objs[i].Officer_Email) === email) {
      res.push({
        id: objs[i].Eval_ID, time: objs[i].Timestamp, title: objs[i].Request_Title,
        location: objs[i].Location, requester: objs[i].Requester_Email,
        fast: objs[i].Rating_Fast, unable: objs[i].Rating_Unable,
        stars: objs[i].Stars_Total, comment: objs[i].Comment, xp: objs[i].XP_Awarded,
        status: String(objs[i].Status || "Active"), voidReason: objs[i].Void_Reason
      });
    }
  }
  return { status: "ok", count: res.length, items: res };
}

function adminServiceEvals_(idToken) {
  if (!idToken) throw new Error("ต้องเข้าสู่ระบบ");
  var email = verifyIdToken_(idToken).email;
  if (!isAdmin_(email)) throw new Error("เฉพาะแอดมินเท่านั้น");

  var objs = readObjects_(getSheet_(SHEETS.SERVICE_EVALS, HEADERS.SERVICE_EVALS), HEADERS.SERVICE_EVALS);
  var res = [];
  for (var i = objs.length - 1; i >= 0; i--) {
    res.push({
      id: objs[i].Eval_ID, time: objs[i].Timestamp, title: objs[i].Request_Title,
      location: objs[i].Location, requester: objs[i].Requester_Email,
      fast: objs[i].Rating_Fast, unable: objs[i].Rating_Unable,
      stars: objs[i].Stars_Total, comment: objs[i].Comment, xp: objs[i].XP_Awarded,
      officer: objs[i].Officer_Email, officerName: objs[i].Officer_Name,
      status: String(objs[i].Status || "Active"), voidReason: objs[i].Void_Reason,
      voidedBy: objs[i].Voided_By, voidedAt: objs[i].Voided_At
    });
  }
  return { status: "ok", count: res.length, items: res };
}

/* แอดมิน "ยกเลิก" ผลประเมินบริการ + หัก XP คืนเจ้าหน้าที่ (Phase 6.25)
 *   - หา eval จาก Eval_ID, ป้องกันยกเลิกซ้ำ
 *   - คืน XP = XP_Awarded ของรายการนั้น (คืนครั้งเดียว) แล้วปรับ Total_XP/Level
 *   - ซอฟต์ดีลีต: Status="Void" + เก็บเหตุผล/ผู้ยกเลิก/เวลา (กู้คืน = เฟสถัดไป) */
function handleVoidServiceEval_(adminEmail, evalId, reason) {
  if (!isAdmin_(adminEmail)) throw new Error("เฉพาะแอดมินเท่านั้น");
  if (!evalId) throw new Error("ไม่พบรหัสผลประเมิน");
  reason = String(reason || "").trim();
  if (!reason) throw new Error("กรุณาระบุเหตุผลในการยกเลิก");

  var esh = getSheet_(SHEETS.SERVICE_EVALS, HEADERS.SERVICE_EVALS);
  var row = findRowByHeader_(esh, "Eval_ID", evalId);
  if (row === -1) throw new Error("ไม่พบผลประเมินนี้");

  var map = headerMap_(esh);
  var cur = String(esh.getRange(row, map["Status"]).getValue() || "Active");
  if (cur === "Void") throw new Error("ผลประเมินนี้ถูกยกเลิกไปแล้ว");

  var officerEmail = String(esh.getRange(row, map["Officer_Email"]).getValue() || "");
  var amount = Number(esh.getRange(row, map["XP_Awarded"]).getValue() || 0);
  var ts = nowStr_();

  if (map["Status"])      esh.getRange(row, map["Status"]).setValue("Void");
  if (map["Void_Reason"]) esh.getRange(row, map["Void_Reason"]).setValue(reason.slice(0, 200));
  if (map["Voided_By"])   esh.getRange(row, map["Voided_By"]).setValue(adminEmail);
  if (map["Voided_At"])   esh.getRange(row, map["Voided_At"]).setValue(ts);

  var reversed = 0;
  if (amount > 0 && officerEmail) {
    appendByHeaders_(getSheet_(SHEETS.XP_HISTORY, HEADERS.XP_HISTORY), HEADERS.XP_HISTORY, {
      XP_ID: "XP-" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss") + "-" + rand3_(),
      Timestamp: ts, User_Email: officerEmail, Amount: -amount, Reason: "service_eval_void",
      Ref_ID: evalId, Client_Ref: ("service_eval_void: " + reason).slice(0, 100)
    });
    var ush = getSheet_(SHEETS.USERS, HEADERS.USERS);
    var umap = headerMap_(ush);
    var urow = findRowByHeader_(ush, "Email", officerEmail);
    if (urow !== -1) {
      var total = Number(ush.getRange(urow, umap["Total_XP"]).getValue() || 0) - amount;
      if (total < 0) total = 0;
      ush.getRange(urow, umap["Total_XP"]).setValue(total);
      ush.getRange(urow, umap["Level"]).setValue(levelFor_(total).level);
    }
    reversed = amount;
  }

  logAudit_(adminEmail, "service_eval_void", "service_eval", evalId, reason, { officer: officerEmail, reversedXp: reversed });
  return { status: "ok", id: evalId, reversedXp: reversed, message: "ยกเลิกผลประเมินแล้ว" };
}
