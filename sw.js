// İbrahim ToDo service worker: lets the home-screen app open without internet.
// Notes themselves live in localStorage on each device; this only caches the app files.
const CACHE = "ibrahim-todo-cache-v2";
const CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // the page itself: network first so updates show up, cached copy when offline.
  // Only a successful load replaces the cached copy; if GitHub Pages answers with an
  // error page (404/5xx), keep showing the last good version instead of caching the error.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put("./index.html", copy));
          return res;
        }
        return (await caches.match("./index.html")) || res;
      } catch (err) {
        return (await caches.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  // app files + Google Fonts: serve from cache, refresh in the background
  const cacheable = url.origin === self.location.origin ||
    url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!cacheable) return;
  e.respondWith(
    caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req)
        .then(res => {
          if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});

// alarm notifications from the push service (push-worker/), also while the app is closed.
// iOS requires every push to show a notification, so even an unreadable message shows one.
// The title is the note itself: iOS adds "from İbrahim ToDo" on its own.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Hatırlatma", {
    body: d.body || "",
    tag: d.tag || "ibrahim-todo",
    icon: "./icons/icon-192.png",
    data: { url: d.url || "./" }
  }));
});

// tapping the notification brings the app to the front, or opens it
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) if ("focus" in w) return w.focus();
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
