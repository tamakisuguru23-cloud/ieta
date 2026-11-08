// スマホの裏側で動く係。オフライン対応と、通知の表示を担当する。
const CACHE = "ieta-v3";
const FILES = [
  "./", "./index.html", "./style.css", "./vendor/ts-fsrs.umd.js", "./config.js", "./logic.js", "./app.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 通信できるときは最新を取り、できないときは保存しておいた分を返す。
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

const MESSAGES = [
  "🔥 連続記録が消えそう！今日の英語、まだです。",
  "今日の分が待っています。5分だけやろう。",
  "寝る前の5分で、今日の英語を終わらせよう。",
  "このままだと、連続記録が0に戻ります。",
];

self.addEventListener("push", (e) => {
  e.waitUntil(self.registration.showNotification("言えた", {
    body: MESSAGES[Math.floor(Math.random() * MESSAGES.length)],
    icon: "icons/icon-192.png",
    tag: "daily",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => {
      if (list.length > 0) return list[0].focus();
      return self.clients.openWindow("./index.html");
    })
  );
});
