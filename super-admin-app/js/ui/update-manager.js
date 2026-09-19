/**
 * update-manager.js — QRUpdateManager (ADR-102)
 *
 * The single, shared in-app "update available → Update App" engine for the QuantReflex ecosystem
 * (main app + Super-Admin + Coaching-Admin). It owns ALL update mechanics — service-worker
 * registration, update detection, version checking, skip-waiting, cache purge, the one-shot reload,
 * race/loop avoidance and dedup state — and exposes only STATE + ACTIONS. Each app renders its own
 * themed toast/button from the callbacks; NO presentation lives here.
 *
 * Contract:
 *   QRUpdateManager.init({
 *     swUrl,               // './service-worker.js' (main) | 'sw.js' (admins)
 *     appKey,              // localStorage namespace: 'qr' | 'qr_admin' | 'qr_coach'
 *     onUpdateAvailable,   // fn(shouldToast): an update is pending — reveal your Update button
 *                          //   always; show your themed toast only when shouldToast is true (dedup).
 *     onUpdated            // fn(): the app just reloaded onto a freshly-applied update — show your
 *                          //   themed "✅ App updated successfully".
 *   })
 *   QRUpdateManager.isUpdateAvailable() -> bool   // drives the conditional Update button
 *   QRUpdateManager.applyUpdate()       -> Promise; normally never settles (the page reloads),
 *                                          but resolves {applied:false, reason:'offline'} rather than
 *                                          purging the only copy of the app while offline (ADR-162)
 *
 * CANONICAL SOURCE: shared/update/update-manager.js. Because shared/ is OUTSIDE every app's Vercel
 * deploy root (the ADR-099 P0), each app loads a BYTE-IDENTICAL local copy instead of cross-root:
 *   main-app/js/services/update-manager.js · super-admin-app/js/ui/update-manager.js ·
 *   coaching-admin-app/js/ui/update-manager.js.
 * scripts/update.check.js fails the test suite if any copy drifts; scripts/sync-update-manager.js
 * regenerates the copies from this file.
 *
 * Global: window.QRUpdateManager (+ module.exports for the checker/tests).
 */
(function (root) {
  'use strict';

  var _cfg = { appKey: 'qr', swUrl: './service-worker.js' };
  var _available = false;          /* a new version is installed & pending (drives the button) */
  var _newVersion = null;          /* version string reported by the incoming worker (for dedup) */
  var _notifiedThisLoad = false;   /* onUpdateAvailable is called at most once per page load */
  var _reg = null;

  /* ---- storage helpers (all guarded — the module also loads under Node for the checker) ---- */
  function _ls() { try { return root.localStorage; } catch (_) { return null; } }
  function _get(k) { var s = _ls(); if (!s) return null; try { return s.getItem(k); } catch (_) { return null; } }
  function _set(k, v) { var s = _ls(); if (!s) return; try { s.setItem(k, v); } catch (_) {} }
  function _del(k) { var s = _ls(); if (!s) return; try { s.removeItem(k); } catch (_) {} }

  function _prefix() { return (_cfg && _cfg.appKey) || 'qr'; }
  function _updatingKey() { return _prefix() + '_appUpdating'; }
  function _dedupPrefix() { return _prefix() + '_update_'; }

  function _todayStamp() {
    var d = new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return '' + d.getFullYear() + (m < 10 ? '0' + m : m) + (day < 10 ? '0' + day : day);
  }

  /* Sweep every dedup key for this app — bounds localStorage growth AND resets the "already shown"
     state so the NEXT genuine update surfaces a fresh toast. */
  function _sweepDedup() {
    var s = _ls(); if (!s) return;
    try {
      var pre = _dedupPrefix(), kill = [];
      for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && k.indexOf(pre) === 0) kill.push(k); }
      for (var j = 0; j < kill.length; j++) _del(kill[j]);
    } catch (_) {}
  }

  /* Ask the incoming (waiting/installing) worker for its APP_VERSION via a MessageChannel round-trip.
     The page's own window.*_APP_VERSION is the OLD loaded version and must NOT be used for the key. */
  function _askVersion(worker) {
    return new Promise(function (resolve) {
      if (!worker || !root.MessageChannel) { resolve(null); return; }
      var settled = false;
      var done = function (v) { if (settled) return; settled = true; resolve(v || null); };
      try {
        var ch = new root.MessageChannel();
        ch.port1.onmessage = function (e) { done(e && e.data && e.data.version); };
        worker.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
        root.setTimeout(function () { done(null); }, 1500);
      } catch (_) { done(null); }
    });
  }

  /* A genuinely new version is installed and waiting to take over. Set state (drives the button) and
     decide whether the toast should show (version-scoped, per-day dedup). */
  function _becameAvailable(worker) {
    _available = true;
    _askVersion(worker).then(function (ver) {
      /* Re-notify at most once per DISTINCT incoming version this load: the same waiting worker must
         not re-fire (prong B + C both see it), but a NEWER worker replacing it in a long-lived admin
         session should still nudge. */
      if (_notifiedThisLoad && ver === _newVersion) return;
      _notifiedThisLoad = true;
      _newVersion = ver;
      var shouldToast;
      if (!ver) {
        /* Version unknown (GET_VERSION timed out): we can't tell a new build from an already-seen one,
           so ALWAYS toast and never write a shared version-less dedup key (which would wrongly suppress
           a genuinely different next version that also times out the same day). */
        shouldToast = true;
      } else {
        var key = _dedupPrefix() + 'v' + ver + '_' + _todayStamp();
        shouldToast = (_get(key) !== '1');
        if (shouldToast) _set(key, '1');
      }
      if (typeof _cfg.onUpdateAvailable === 'function') {
        try { _cfg.onUpdateAvailable(shouldToast); } catch (_) {}
      }
    });
  }

  function _watch(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', function () {
      /* controller present ⇒ this is an UPDATE, not the first-ever install (which has no controller) */
      if (worker.state === 'installed' && root.navigator && root.navigator.serviceWorker &&
          root.navigator.serviceWorker.controller) {
        _becameAvailable(worker);
      }
    });
  }

  function _register(nav) {
    nav.serviceWorker.register(_cfg.swUrl).then(function (reg) {
      _reg = reg;
      /* No pending update AT ALL on this load (nothing waiting, nothing installing) → clear stale dedup
         so a future update surfaces cleanly. Guarded on installing too, so we never wipe the dedup key
         for an update that is merely mid-download when the page loads. */
      if (!reg.waiting && !reg.installing) _sweepDedup();
      /* Prong A: a worker is mid-install at register time (updatefound may already have fired). */
      if (reg.installing) _watch(reg.installing);
      /* Prong B: a worker is already installed & waiting from a previous load. */
      if (reg.waiting && nav.serviceWorker.controller) _becameAvailable(reg.waiting);
      /* Prong C: a future update lands this session. */
      reg.addEventListener('updatefound', function () { if (reg.installing) _watch(reg.installing); });
      /* NOTE: deliberately NO 'controllerchange' listener — the reload is a single explicit
         navigation in applyUpdate(), so there is no auto-reload trigger and no infinite-loop risk. */
    }).catch(function (err) { try { console.warn('SW registration failed:', err); } catch (_) {} });
  }

  /* If we just reloaded as the result of an Update tap, surface the success state exactly once. */
  function _handlePostReload() {
    var flagged = _get(_updatingKey()) === 'true';
    /* Also consume the legacy unprefixed key from the pre-module main-app build, so the one-time
       upgrade INTO the shared module still shows "App updated successfully" (ADR-102 transition). */
    var legacy = _prefix() === 'qr' && _get('appUpdating') === 'true';
    if (!flagged && !legacy) return;
    _del(_updatingKey());     /* consumed once */
    if (legacy) _del('appUpdating');
    _sweepDedup();            /* the update is applied — forget "already shown" flags */
    var fire = function () {
      root.setTimeout(function () {
        if (typeof _cfg.onUpdated === 'function') { try { _cfg.onUpdated(); } catch (_) {} }
      }, 1500);
    };
    if (root.document && root.document.readyState === 'complete') fire();
    else if (root.addEventListener) root.addEventListener('load', fire);
    else fire();
  }

  function init(cfg) {
    cfg = cfg || {};
    _cfg = {
      appKey: cfg.appKey || 'qr',
      swUrl: cfg.swUrl || './service-worker.js',
      onUpdateAvailable: cfg.onUpdateAvailable,
      onUpdated: cfg.onUpdated
    };
    _handlePostReload();
    var nav = root.navigator;
    if (!nav || !('serviceWorker' in nav)) return;
    var start = function () { _register(nav); };
    if (root.document && root.document.readyState === 'complete') start();
    else if (root.addEventListener) root.addEventListener('load', start);
    else start();
  }

  function isUpdateAvailable() { return _available; }

  /* One-shot: purge ALL caches, activate the waiting worker, then hard-reload to the app root.
     The cache purge makes the reload safe regardless of which worker controls the reloaded page
     (empty cache ⇒ every asset comes from the network in a single load — no stale/partial state). */
  function applyUpdate() {
    var nav = root.navigator;
    /* ADR-162 — REFUSE TO PURGE THE ONLY COPY OF THE APP WHILE OFFLINE.
       The steps below delete EVERY cache and then navigate. That is correct when the network can supply a
       replacement and catastrophic when it cannot: offline, the purge removes the precached shell and every
       asset, the navigation then has nothing to fall back on, and the user is left on a browser error page.
       In a browser that is merely annoying — reload when you reconnect. In the Play build there is no URL
       bar, no reload button and no tab switcher, so the app is simply broken until connectivity returns.
       The trigger is not exotic: the button is ALWAYS visible in Settings and reads "Update App / Refresh
       app to latest version", which sounds like a harmless thing to try when something looks stale — and
       looking stale is exactly what being offline feels like.
       Resolving with a value rather than throwing keeps every existing caller working; those that inspect
       it can restore their button and say why. */
    if (nav && nav.onLine === false) {
      return Promise.resolve({ applied: false, reason: 'offline' });
    }
    var done = function () {
      _set(_updatingKey(), 'true');
      var pathname = (root.location && root.location.pathname) || '/';
      /* ADR-174: this navigation drops the query string, and in the main app one of those parameters is
         the Play-distribution marker. Losing it leaves the verdict resting on a sessionStorage latch
         alone — which a browser with site data blocked does not provide, at which point the Play build
         relaunches as a web build and offers Razorpay. Ask the platform module for the marker it needs
         carried; it answers '' outside a Play build, and the admin/coaching apps have no QRPlatform at
         all, so for them this is byte-for-byte the old behaviour. Deliberately NOT the whole of
         location.search: ?duel=CODE is a one-shot deep link and replaying it would re-join a duel. */
      var q = '';
      try {
        if (root.QRPlatform && typeof root.QRPlatform.launchQuery === 'function') q = root.QRPlatform.launchQuery();
      } catch (_) { q = ''; }
      try { root.location.href = pathname + q; } catch (_) {}
    };
    /* Flush pending Firestore updates before reload so in-flight work reaches server (Bug D) */
    var flushPromise = Promise.resolve();
    try {
      var fs = root.FirestoreSync || (typeof window !== 'undefined' && window.FirestoreSync);
      if (fs && typeof fs.flushUpdatesAsync === 'function') {
        flushPromise = new Promise(function (resolve) {
          var settled = false;
          var timer = setTimeout(function () {
            if (!settled) { settled = true; resolve(); }
          }, 2000); /* bounded 2s fallback to prevent trapping user */
          try {
            fs.flushUpdatesAsync(function () {
              if (!settled) { settled = true; clearTimeout(timer); resolve(); }
            });
          } catch (_) {
            if (!settled) { settled = true; clearTimeout(timer); resolve(); }
          }
        });
      }
    } catch (_) {
      flushPromise = Promise.resolve();
    }

    return flushPromise.then(function () {
      if (root.caches && root.caches.keys) {
        return root.caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return root.caches.delete(k); }));
        }).then(function () {
          if (nav && nav.serviceWorker && nav.serviceWorker.getRegistrations) {
            return nav.serviceWorker.getRegistrations().then(function (regs) {
              for (var i = 0; i < regs.length; i++) {
                if (regs[i].waiting) regs[i].waiting.postMessage({ type: 'SKIP_WAITING' });
                try { regs[i].update(); } catch (_) {}
              }
            });
          }
        }).then(done, done);
      }
      done();
      return Promise.resolve({ applied: true, reason: 'no-cache-api' });
    });
  }

  var QRUpdateManager = { init: init, isUpdateAvailable: isUpdateAvailable, applyUpdate: applyUpdate };

  if (typeof module !== 'undefined' && module.exports) module.exports = QRUpdateManager;
  if (typeof window !== 'undefined') window.QRUpdateManager = QRUpdateManager;
  else if (root) root.QRUpdateManager = QRUpdateManager;
})(typeof globalThis !== 'undefined' ? globalThis : this);
