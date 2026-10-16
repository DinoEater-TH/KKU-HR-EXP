/* ============================================================
   KKU HR Exp — Service Worker (PWA shell cache)
   - แคชเฉพาะไฟล์ในเว็บ (same-origin): index.html, manifest, ไอคอน
   - ปล่อยให้ CDN (Tailwind/Google) และ Apps Script API ผ่านเครือข่ายตามปกติ
   - หน้าเว็บ = network-first (ได้เวอร์ชันใหม่เสมอเมื่อออนไลน์, ออฟไลน์ใช้แคช)
   ============================================================ */
const CACHE = "hrx-shell-v6.27";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // same-origin เท่านั้น — ที่เหลือปล่อยผ่านเครือข่าย (CDN, Google, Apps Script)
  if (url.origin !== self.location.origin) return;

  // เปิดหน้าเว็บ → network-first (ได้ของใหม่เมื่อออนไลน์ / ออฟไลน์ใช้แคช)
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put("./index.html", res.clone()));
          return res;
        })
        .catch(() => caches.match("./index.html").then((hit) => hit || caches.match("./")))
    );
    return;
  }

  // ไฟล์อื่น (ไอคอน ฯลฯ) → cache-first แล้วค่อยดึงใหม่
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
    })
  );
});
