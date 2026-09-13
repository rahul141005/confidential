/**
 * Service Worker for QuantReflex (SPA)
 * Caches all assets for offline use.
 */

const APP_VERSION = 'v296';
const CACHE_NAME = 'qr-cache-' + APP_VERSION;   /* derived so the two version strings can never drift (ADR-095) */
const NET_FIRST_TIMEOUT_MS = 3000;              /* network-first JS/CSS falls back to cache after this on "lie-fi" (ADR-095) */

var ASSETS = [
  './',
  './index.html',
  './css/style.css',
  /* ADR-150: the self-hosted Firebase SDK. These MUST be precached — the app cannot boot without them,
     and the whole point of vendoring them was to stop a cold boot depending on a third-party CDN. */
  './vendor/firebase/firebase-app-compat.js',
  './vendor/firebase/firebase-auth-compat.js',
  './vendor/firebase/firebase-firestore-compat.js',
  './vendor/firebase/firebase-messaging-compat.js',
  './js/state/storage-registry.js',
  './js/state/store.js',
  /* Localization (ADR-111): core + all three UI catalogs precached so every language works offline;
     .js entries stay network-first, so translation fixes ship without a version bump. The bundled
     Devanagari face is cache-first like other fonts. */
  './js/i18n.js',
  './locales/en.js',
  './locales/hi.js',
  './locales/mr.js',
  './fonts/noto-sans-devanagari.woff2',
  './fonts/inter-var-latin.woff2',
  './js/firebase.js',
  './js/session.js',
  './js/security-events.js',
  './js/maintenance-gate.js',
  './js/identity.js',
  './js/auth.js',
  './js/firestore-sync.js',
  './js/app.js',
  './js/router.js',
  './js/quota-policy.js',
  './js/drill-engine.js',
  './js/onboarding.js',
  './js/utils/generative-helpers.js',
  './js/gen-i18n.js',
  './js/i18n-packs.js',
  './js/i18n-transition.js',
  './locales/gen/en.quant.js',
  './locales/gen/en.di.js',
  './locales/gen/en.lr.js',
  './locales/gen/en.lrv.js',
  './locales/gen/hi.quant.js',
  './locales/gen/hi.di.js',
  './locales/gen/hi.lr.js',
  './locales/gen/hi.lrv.js',
  './locales/gen/mr.quant.js',
  './locales/gen/mr.di.js',
  './locales/gen/mr.lr.js',
  './locales/gen/mr.lrv.js',
  './data/knowledge/i18n/hi/numbers.js',
  './data/knowledge/i18n/mr/numbers.js',
  './data/knowledge/i18n/hi/arithmetic.js',
  './data/knowledge/i18n/mr/arithmetic.js',
  './data/knowledge/i18n/hi/commercial.js',
  './data/knowledge/i18n/mr/commercial.js',
  './data/knowledge/i18n/hi/algebra.js',
  './data/knowledge/i18n/mr/algebra.js',
  './data/knowledge/i18n/hi/modern.js',
  './data/knowledge/i18n/mr/modern.js',
  './data/knowledge/i18n/hi/geometry.js',
  './data/knowledge/i18n/mr/geometry.js',
  './data/knowledge/i18n/hi/mensuration.js',
  './data/knowledge/i18n/mr/mensuration.js',
  './data/knowledge/i18n/hi/di.js',
  './data/knowledge/i18n/mr/di.js',
  './data/knowledge/i18n/hi/lr.js',
  './data/knowledge/i18n/mr/lr.js',
  './js/questions.js',
  './js/answer-format.js',
  './js/di-engine.js',
  './js/ui/di-charts.js',
  './js/di-set-engine.js',
  './js/lr-engine.js',
  './js/lr-set-engine.js',
  './data/lr-authored/schema.js',
  './data/lr-authored/critical.js',
  './data/lr-authored/statement.js',
  './data/lr-authored/cause.js',
  './data/lr-authored/course.js',
  './data/lr-authored/decision.js',
  './js/lr-authored-i18n.js',
  './js/lr-authored-engine.js',
  // Phase G — authored-LR study-language overlays (G-M10; lazy-loaded via QRPacks, precached for offline)
  './data/lr-authored/i18n/hi/critical.js',
  './data/lr-authored/i18n/hi/statement.js',
  './data/lr-authored/i18n/hi/cause.js',
  './data/lr-authored/i18n/hi/course.js',
  './data/lr-authored/i18n/hi/decision.js',
  './data/lr-authored/i18n/mr/critical.js',
  './data/lr-authored/i18n/mr/statement.js',
  './data/lr-authored/i18n/mr/cause.js',
  './data/lr-authored/i18n/mr/course.js',
  './data/lr-authored/i18n/mr/decision.js',
  './js/ui/lr-figures.js',
  './js/lr-visual-engine.js',
  './data/syllabus.js',
  './js/mock-engine.js',
  './data/statMath.js',
  './data/entitlement-core.js',
  './services/quantTopics.js',
  './data/subjects.js',
  './js/mistake-archive.js',
  './js/progress.js',
  './js/tables.js',
  './js/learn-manager.js',
  './js/knowledge/schema.js',
  './js/knowledge/registry.js',
  './js/knowledge/blocks.js',
  './data/knowledge/categories.js',
  './data/knowledge/numbers.js',
  './data/knowledge/arithmetic.js',
  './data/knowledge/commercial.js',
  './data/knowledge/algebra.js',
  './data/knowledge/modern.js',
  './data/knowledge/geometry.js',
  './data/knowledge/mensuration.js',
  './data/knowledge/di.js',
  './data/knowledge/lr.js',
  './data/knowledge/exam-relevance.js',
  './js/learn/learn-search.js',
  './js/learn/learn-progress.js',
  './js/learn/revise-flow.js',
  './js/quick-reference/quick-ref-data.js',
  './js/quick-reference/quick-ref-i18n.js',
  './js/quick-reference/quick-ref-renderer.js',
  './js/quick-reference/i18n/hi.js',
  './js/quick-reference/i18n/mr.js',
  './js/settings.js',
  './js/notifications.js',
  './js/soundEngine.js',
  './js/platform.js',
  './js/payments/gateway.js',
  './js/payments/razorpay-provider.js',
  './js/payments/play-provider.js',
  './js/paywall.js',
  './js/ai-features.js',
  './js/session-manager.js',
  './js/services/adaptive-state.js',
  './js/services/scoring-service.js',
  './js/services/share-service.js',
  './js/services/target-exam.js',
  './js/services/quick-links-registry.js',
  './js/services/ai-analytics.js',
  './js/utils/auth-validators.js',
  './js/ui/report-taxonomy.js',
  './js/services/report-context.js',
  './js/services/report-queue.js',
  './js/services/update-manager.js',
  './js/ui/report-modal.js',
  './js/companion-ui.js',
  './js/controllers/practice-config.js',
  './js/controllers/practice-modes.js',
  './js/ui/practice-subject-modal.js',
  './js/ui/category-picker.js',
  './js/ui/overlay.js',
  './js/ui/numpad.js',
  './js/ui/swipe-nav.js',
  './js/learn-entitlements.js',
  './js/views/home-view.js',
  './js/views/learn-view.js',
  './js/views/stats-view.js',
  './js/views/inbox-view.js',
  './js/views/planner-view.js',
  './js/duel-core.js',
  './js/duel-manager.js',
  './js/duel-ui.js',
  './js/duel-archive.js',
  './js/utils/event-registry.js',
  './js/services/question-bank-service.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './appicons/splashQ.svg',
  './sounds/correctanswer.wav',
  './sounds/drillend.mp3',
  './sounds/settingstoggle.mp3',
  './sounds/tablemodalopeningandclosing.mp3',
  './sounds/tabswitching.mp3',
  './sounds/wronganswer.mp3'
];

/* Firebase CDN scripts are cached dynamically on first fetch for offline support */

/* Promise.allSettled polyfill for Safari < 13 and older Android WebViews */
if (typeof Promise.allSettled !== 'function') {
  Promise.allSettled = function (promises) {
    return Promise.all(promises.map(function (p) {
      return Promise.resolve(p).then(
        function (value) { return { status: 'fulfilled', value: value }; },
        function (reason) { return { status: 'rejected', reason: reason }; }
      );
    }));
  };
}

/* Install: pre-cache all assets — resilient: one failing asset won't abort install */
self.addEventListener('install', function (event) {
  self.skipWaiting();   // activate the new SW immediately — a deploy shouldn't wait for every old tab to close
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.allSettled(
        ASSETS.map(function (url) {
          return fetch(url, { cache: 'no-cache' })
            .then(function (response) {
              if (!response.ok) throw new Error('Bad status ' + response.status + ' for ' + url);
              return cache.put(url, response);
            })
            .catch(function (err) {
              console.warn('[SW] Pre-cache skipped:', url, err.message);
            });
        })
      );
    })
  );
});

/* Activate: clean up old caches */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

/* Fetch: serve from cache, fall back to network.
   For Firebase CDN scripts, cache them on first fetch for offline use.
   For Firebase API requests (auth/firestore), always go to network.
   For SPA navigation requests, fall back to cached index.html. */
self.addEventListener('fetch', function (event) {
  var url = event.request.url;

  /* Let Firebase SDK handle its own API requests — don't intercept.
     Use hostname-based checks to avoid substring false positives. */
  try {
    var reqUrl = new URL(url);
    var host = reqUrl.hostname;
    if (host.endsWith('.googleapis.com') ||
        host.endsWith('.firebaseio.com') ||
        host.endsWith('.firebaseinstallations.googleapis.com')) {
      return;
    }
  } catch (e) { /* non-HTTP requests — proceed normally */ }

  /* Never cache backend API calls — always go to network */
  try {
    var apiPath = new URL(url).pathname;
    if (apiPath.startsWith('/api/')) {
      return;
    }
  } catch (e) { /* proceed normally */ }

  /* SPA navigation fallback: serve cached index.html for HTML navigation requests
     so that deep links and browser refresh work offline */
  if (event.request.mode === 'navigate') {
    /* ADR-161 — ONLY THE SHELL MAY BE STORED UNDER THE SHELL KEY.
       This used to cache EVERY successful in-scope navigation as './index.html'. The canonical-key part
       was right (audit network-recovery-03: never key on the full URL, or every ?duel=CODE deep link
       fragments the shell and grows the cache without bound) — but "every navigation" is not "the shell".
       This origin also serves real static documents, and they are the ones Play REQUIRES a user to be
       able to open: /legal/privacy.html, /legal/terms.html, /legal/delete-account.html. Opening one
       replaced the offline app shell with an 8 KB legal page. Verified in headless Chromium: after
       visiting the privacy page the cached shell was 8,932 bytes titled "Privacy Policy — QuantReflex",
       and the next OFFLINE launch of "/" rendered the privacy policy instead of the app.
       In a browser that is recoverable — the next online visit re-caches the real shell. In the TWA it is
       not: there is no URL bar, no reload button and no tab switcher, so the user is left staring at a
       privacy policy where their app should be. And because the TWA and Chrome share one origin and one
       CacheStore, poisoning it from an ordinary tab reaches the installed app.
       The app is hash-routed with scope "/" and start_url "/", so the shell's pathname is ALWAYS "/" —
       `?duel=CODE` and `#practice` deep links included. Anything with a different pathname is a real
       document and must never be written to the shell key. */
    var _navPath = '/';
    try { _navPath = new URL(event.request.url).pathname; } catch (_) { /* keep the default */ }
    var _isShellNav = (_navPath === '/' || _navPath === '/index.html');

    event.respondWith(
      fetch(event.request, { cache: 'no-cache' }).then(function (response) {
        if (response.ok && _isShellNav) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put('./index.html', clone);
          });
        }
        return response;
      }).catch(function () {
        /* Offline. Serve the exact document if we happen to hold it, and only then fall back to the
           shell — so an offline legal page shows the app rather than nothing, while a shell navigation
           still gets the shell. */
        return caches.match(event.request).then(function (exact) {
          return exact || caches.match('./index.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var isAppAsset = url.endsWith('.js') || url.endsWith('.css');
      
      var fetchPromise = fetch(event.request).then(function (response) {
        /* Update cache on successful fetch for assets and Firebase CDN */
        if (response.ok) {
          var urlBase = url.split('?')[0];
          /* ADR-150: the gstatic prefix is retained deliberately. It costs nothing, and it keeps a
             browser that still holds a cached index.html referencing the old CDN URLs working through
             the changeover instead of failing to cache its SDK. */
          if (urlBase.startsWith('https://www.gstatic.com/firebasejs/') || isAppAsset) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
        }
        return response;
      }).catch(function () {
        if (!cached) {
          return new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
        }
      });

      /* App JS/CSS: NETWORK-FIRST so a new deploy is picked up on the very next load (the cache stays as the
         offline fallback). Other assets (images / sounds / fonts): cache-first for speed + offline.
         This stops a deploy from being masked by a stale cached bundle.
         ADR-095: bound the network wait. On "lie-fi" (connected but hanging) an unbounded fetch would stall first
         paint even though a cached copy exists. When we HAVE a cached copy, race the fetch against a short timeout and
         fall back to cache; the fetch still runs and refreshes the cache for the next load (stale-while-revalidate).
         With no cache we must wait for the network. */
      if (isAppAsset) {
        var netFirst = fetchPromise.then(function (resp) { return resp || cached; });
        if (!cached) return netFirst;
        var timed = new Promise(function (resolve) { setTimeout(function () { resolve(cached); }, NET_FIRST_TIMEOUT_MS); });
        return Promise.race([netFirst, timed]);
      }
      return cached || fetchPromise;
    })
  );
});

/* ---- Push Notification Handling ---- */

/* Handle postMessage from app to skip waiting (update flow) + version handshake (ADR-102: the
   client's QRUpdateManager asks the INCOMING worker for its version to key the update toast). */
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data && event.data.type === 'GET_VERSION') {
    try { if (event.ports && event.ports[0]) event.ports[0].postMessage({ version: APP_VERSION }); } catch (_) {}
  }
});

/* Fallback body if a push ever arrives without one. The unified pipeline (ADR-066) always supplies a
   title + body, so this is only a defensive default — the per-app-open motivational bank was retired. */
var FALLBACK_BODY = 'Time to practice mental math!';

/* Handle push events (background notifications from FCM).
   The unified pipeline sends { notification:{title,body}, data:{ url, type, category } } — we honour BOTH:
   the deep-link (data.url) drives where a tap lands, and the type gives each notification a distinct tag. */
self.addEventListener('push', function (event) {
  var data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { notification: { title: 'QuantReflex', body: event.data.text() } };
    }
  }

  var notif = data.notification || {};
  var payload = data.data || {};
  var title = notif.title || 'QuantReflex';
  var body = notif.body || FALLBACK_BODY;

  var options = {
    body: body,
    icon: './icons/icon-192.svg',
    badge: './icons/icon-192.svg',
    /* Unique per-notification tag so distinct notifications COEXIST in the tray. A shared static tag
       (the old 'quant-motivation') made each new push REPLACE the previous one — users only ever saw the
       latest. Keying on type + time keeps a duel push and a billing push both visible. */
    tag: 'qr-' + (payload.type || 'general') + '-' + Date.now(),
    renotify: true,
    /* Honour the deep-link the pipeline sent (e.g. ./index.html#duel); fall back to home. */
    data: { url: payload.url || './index.html#home' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* Handle notification click — open/focus the app AND route it to the notification's deep-link */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var urlToOpen = './index.html#home';
  if (event.notification.data && event.notification.data.url) {
    urlToOpen = event.notification.data.url;
  }
  /* Derive the hash (e.g. #duel) so an already-open client can be routed to it without a full reload. */
  var hashIndex = urlToOpen.indexOf('#');
  var targetHash = hashIndex >= 0 ? urlToOpen.slice(hashIndex) : '';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client.url.indexOf('index.html') !== -1 || client.url.endsWith('/')) {
          /* App already open: navigate it to the deep-link (focus alone would ignore the target), then focus.
             Falls back to a plain focus if navigate() is unsupported or rejects. */
          if (targetHash && 'navigate' in client) {
            return client.navigate(client.url.split('#')[0] + targetHash)
              .then(function (navigated) { return (navigated || client).focus(); })
              .catch(function () { return client.focus(); });
          }
          return client.focus();
        }
      }
      /* Otherwise open a new window at the deep-link */
      return self.clients.openWindow(urlToOpen);
    })
  );
});
