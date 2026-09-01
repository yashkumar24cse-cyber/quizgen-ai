const CACHE_NAME = "quizgen-cache-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./script.js",
  "./index.css"
];

// Install service worker and cache assets
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log("[Service Worker] Pre-caching offline assets");
      return cache.addAll(ASSETS).catch(err => {
        console.warn("[Service Worker] Pre-cache failed (likely assets missing):", err);
      });
    })
  );
  self.skipWaiting();
});

// Activate service worker and clean up old caches
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log("[Service Worker] Removing old cache", key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch events: Cache first, fallback to network
self.addEventListener("fetch", event => {
  // Only cache GET requests (skip POSTs like API calls)
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then(networkResponse => {
        // Cache new static resources on the fly
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Return index.html as a fallback for page navigation requests
        if (event.request.mode === "navigate") {
          return caches.match("./index.html");
        }
      });
    })
  );
});
