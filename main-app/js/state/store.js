/**
 * store.js — Centralized state management layer (AppState singleton)
 *
 * Provides a single, authoritative accessor for all localStorage keys
 * used across the QuantReflex app.  Every read/write goes through this
 * module so that:
 *   1. JSON parse/stringify + error handling is DRY.
 *   2. Future key migrations live in one place.
 *   3. Callers never touch raw localStorage directly for app state.
 *
 * All existing global functions (loadSettings, loadProgress, etc.)
 * remain as thin wrappers — this module is purely additive.
 *
 * Key migration strategy (lazy, read-time):
 *   On READ:  check canonical qr_ key first → fallback to legacy key → migrate
 *   On WRITE: always write to canonical qr_ key only
 *
 * Key mapping (legacy → canonical):
 *   quant_reflex_settings      → qr_settings
 *   quant_reflex_progress      → qr_progress
 *   quant_quick_links          → qr_quick_links
 *   quant_custom_topics        → qr_custom_topics
 *   quant_custom_formulas      → qr_custom_formulas
 *   quant_bookmarks            → qr_bookmarks
 *   quant_notifications_enabled→ qr_notif_enabled
 *
 * Per-user purge + ownership of every persisted key lives in js/state/storage-registry.js (ADR-119).
 */

var AppState = (function () {
  'use strict';

  /* ---- Key constants ---- */
  /* Canonical keys (new standard) */
  var KEYS = {
    settings:       'qr_settings',
    progress:       'qr_progress',
    quickLinks:     'qr_quick_links',
    customTopics:   'qr_custom_topics',
    customFormulas: 'qr_custom_formulas',
    bookmarks:      'qr_bookmarks',
    notifEnabled:   'qr_notif_enabled'
  };

  /* Legacy → canonical map (ADR-095): the module always documented a lazy read-time migration but never implemented
     it, so a user upgrading from a build that wrote the old `quant_*`/`premiumStatus` keys would read DEFAULTS
     offline / before Firestore hydration — a real data-loss window. The read helpers below now migrate on first
     read (only when the canonical key is absent AND a legacy key exists — so current canonical users are untouched). */
  var LEGACY = {
    'qr_settings':        'quant_reflex_settings',
    'qr_progress':        'quant_reflex_progress',
    'qr_quick_links':     'quant_quick_links',
    'qr_custom_topics':   'quant_custom_topics',
    'qr_custom_formulas': 'quant_custom_formulas',
    'qr_bookmarks':       'quant_bookmarks',
    'qr_notif_enabled':   'quant_notifications_enabled'
  };

  /* Return the stored raw string for a canonical key, migrating a legacy value into it on first read. */
  function _rawWithMigration(key) {
    var raw = localStorage.getItem(key);
    if (raw === null && LEGACY[key]) {
      var legacyRaw = localStorage.getItem(LEGACY[key]);
      if (legacyRaw !== null) { try { localStorage.setItem(key, legacyRaw); } catch (_) { /* quota — still return the value */ } raw = legacyRaw; }
    }
    return raw;
  }



  /* ---- Defaults ---- */
  var DEFAULT_SETTINGS = {
    darkMode: false, sound: true, vibration: true, difficulty: 'medium',
    dailyGoal: 20, reducedMotion: false, skipEnabled: false,
    notificationsEnabled: false, theme: 'classic',
    appLanguage: 'en', studyLanguage: 'en' /* ADR-111: UI chrome vs study content channels */
  };

  var DEFAULT_PROGRESS = {
    totalAttempted: 0, totalCorrect: 0,
    bestStreak: 0, currentStreak: 0,
    drillSessions: 0, timedTestSessions: 0,
    dailyStreak: 0, bestDailyStreak: 0,
    lastActiveDate: null, lastPracticeDate: null,
    todayAttempted: 0, todayCorrect: 0,
    categoryStats: {}, mistakes: [],
    responseTimes: [], dailyHistory: {}
  };

  var DEFAULT_QUICK_LINKS = ['fractionTable', 'tablesContainer', 'formulaSections', 'mentalTricks'];

  /* ---- Cross-Tab Synchronization ----
     REMOVED (ADR-119): this block claimed to implement cross-tab sync but only dispatched a
     `qr_storage_sync` CustomEvent that NOTHING in the repository listened for — a comment asserting a
     behaviour the code did not provide, on every cross-tab write. It is also unnecessary: Firebase Auth
     persistence is shared across tabs of one origin, so a sign-in in another tab already fires this
     tab's onAuthStateChanged, which drives the canonical account-change lifecycle (Auth.onStateChange →
     QRIdentity.beginTransition). That is the supported multi-tab contract; a storage-event side channel
     would only add a second, weaker one. */

  /* ---- Generic helpers ---- */

  /**
   * Safely read and parse JSON from localStorage.
   * @param {string} key
   * @param {*} fallback - returned on miss or parse error
   * @returns {*}
   */
  function _readJSON(key, fallback) {
    try {
      var raw = _rawWithMigration(key);
      if (raw !== null) return JSON.parse(raw);
    } catch (_) { /* ignore */ }
    return (typeof fallback === 'function') ? fallback() : fallback;
  }

  /**
   * Safely stringify and write JSON to localStorage.
   * @param {string} key
   * @param {*} value
   */
  function _writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('[AppState] write failed for key "' + key + '":', e);
    }
  }

  /**
   * Safely read a plain string from localStorage.
   * @param {string} key
   * @param {string} fallback
   * @returns {string}
   */
  function _readString(key, fallback) {
    try {
      var val = _rawWithMigration(key);
      if (val !== null) return val;
    } catch (_) { /* ignore */ }
    return fallback;
  }

  /**
   * Safely write a plain string to localStorage.
   * @param {string} key
   * @param {string} value
   */
  function _writeString(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('[AppState] write failed for key "' + key + '":', e);
    }
  }



  /* ---- Settings ---- */

  function getSettings() {
    var s = _readJSON(KEYS.settings, null);
    if (s && typeof s === 'object') return s;
    return _clone(DEFAULT_SETTINGS);
  }

  function setSettings(s) {
    _writeJSON(KEYS.settings, s);
  }

  /* ---- Progress ---- */

  function getProgress() {
    var p = _readJSON(KEYS.progress, null);
    if (p && typeof p === 'object') return p;
    return _clone(DEFAULT_PROGRESS);
  }

  function setProgress(p) {
    _writeJSON(KEYS.progress, p);
  }

  /* ---- Quick Links ---- */

  function getQuickLinks() {
    var links = _readJSON(KEYS.quickLinks, null);
    if (Array.isArray(links) && links.length > 0) return links;
    return DEFAULT_QUICK_LINKS.slice();
  }

  function setQuickLinks(links) {
    _writeJSON(KEYS.quickLinks, links);
  }

  /* ---- Custom Topics ---- */

  function getCustomTopics() {
    var topics = _readJSON(KEYS.customTopics, null);
    return Array.isArray(topics) ? topics : [];
  }

  function setCustomTopics(topics) {
    _writeJSON(KEYS.customTopics, topics);
  }

  /* ---- Custom Formulas ---- */

  function getCustomFormulas() {
    var formulas = _readJSON(KEYS.customFormulas, null);
    return (formulas && typeof formulas === 'object' && !Array.isArray(formulas)) ? formulas : {};
  }

  function setCustomFormulas(formulas) {
    _writeJSON(KEYS.customFormulas, formulas);
  }

  /* ---- Bookmarks ---- */

  function getBookmarks() {
    var bm = _readJSON(KEYS.bookmarks, null);
    return Array.isArray(bm) ? bm : [];
  }

  function setBookmarks(bookmarks) {
    _writeJSON(KEYS.bookmarks, bookmarks);
  }

  /* ---- Notifications Enabled ---- */

  function getNotifEnabled() {
    var val = _readString(KEYS.notifEnabled, null);
    if (val !== null) return val === 'true';
    /* Fallback: check settings object for Firestore-synced state */
    var s = getSettings();
    return s.notificationsEnabled === true;
  }

  function setNotifEnabled(enabled) {
    _writeString(KEYS.notifEnabled, enabled ? 'true' : 'false');
  }

  /* ---- Onboarding ----
     REMOVED (ADR-119): getOnboardingDone/setOnboardingDone + KEYS.onboardingDone +
     LEGACY['qr_onboarding_done'] were a dead parallel onboarding-state API with ZERO callers. The live
     gate is `settings.onboardingCompleted` (js/onboarding.js shouldShow), which rides the synced
     `qr_settings` object and is therefore per-user correct.
     It was not merely dead, it was armed: `quant_onboarding_complete` was the one LEGACY twin missing
     from the purge list, so _rawWithMigration would RESURRECT user A's completed-onboarding flag into
     the canonical key after an account purge. Harmless only because nothing read it — a trap for
     whoever wired it up next. Deleted rather than purge-listed so it cannot be revived by accident. */

  /* ---- Utility ---- */

  /**
   * Remove ALL user-specific localStorage keys (both canonical AND legacy).
   * Called on logout and user-switch to guarantee zero cross-user data leakage.
   */
  /**
   * Purge every user-scoped persisted key (ADR-119).
   *
   * This used to enumerate the 8 names in KEYS plus two legacy premium flags plus a `quant_ai_`
   * prefix sweep — a hand-maintained list that a dozen other modules never registered with, so 15
   * live keys (target exam, free-hint credits, best scores, queued reports, the `qr_ai_` generation
   * the old sweep did not match, …) survived an account change and became the next user's state.
   *
   * Ownership now lives in ONE place (`js/state/storage-registry.js`) and the sweep is prefix-driven
   * with an explicit survivor allow-list, so a key nobody classified is purged rather than inherited.
   * The registry is a hard dependency: silently falling back to the old partial list would recreate
   * exactly the leak this replaced, so its absence is loud.
   */
  /* ADR-120 fail-closed fallback. Mirrors storage-registry's survivor set; a check asserts the two stay
     in lockstep, so this list cannot silently drift from the real model. */
  var FALLBACK_SURVIVORS = [
    'qr_session_id', 'qr_session_uid', 'qr_session_replaced', 'qr_last_uid',
    'qr_i18n_preview', 'qr_appUpdating', 'qr_src_play', 'qr_pending_writes'
  ];
  var FALLBACK_SURVIVOR_PREFIXES = ['qr_update_', 'qr_pending_writes_'];

  function clearAll() {
    try {
      if (typeof QRDiagnostic !== 'undefined') {
        QRDiagnostic.log('app_state', 'clearAll:called', {
          stack: (new Error().stack || '').split('\n').slice(1, 6).join('\n')
        });
      }
    } catch (_) {}
    if (typeof QRStorage !== 'undefined' && typeof QRStorage.purgeUserScoped === 'function') {
      var out = QRStorage.purgeUserScoped();
      /* ADR-120 (R7): sessionStorage is part of the same ownership model — the purge used to cover
         localStorage only, so the model documented more than it enforced. Today this is just the
         transient Google-redirect flag, but the sweep must not depend on that staying true. */
      try {
        if (typeof sessionStorage !== 'undefined') out = out.concat(QRStorage.purgeUserScoped(sessionStorage));
      } catch (_) { /* sessionStorage unavailable — nothing to purge */ }
      return out;
    }
    /* ADR-120: this used to log and return [], purging NOTHING — which silently switched account
       isolation off. That is reachable in production, not theoretical: the service worker pre-caches with
       Promise.allSettled and a swallowing per-file catch ("one failing asset won't abort install"), so a
       single failed fetch activates a worker with this dependency missing; a later offline session then
       serves 503 for the script while the rest of the app runs from cache. The result was the entire
       leak set returning, plus the qr_last_uid cold-boot defence going dead — with only a console error.
       So: degrade, never skip. Same prefix sweep + survivor allow-list as the registry. */
    console.error('[AppState.clearAll] storage-registry unavailable — using the inline fallback purge. ' +
      'js/state/storage-registry.js should load before js/state/store.js.');
    var removed = [];
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k) keys.push(k); }
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var isOurs = key.indexOf('qr_') === 0 || key.indexOf('quant_') === 0 || key === 'premiumStatus';
        if (!isOurs) continue;
        var survives = false;
        for (var s = 0; s < FALLBACK_SURVIVORS.length; s++) { if (FALLBACK_SURVIVORS[s] === key) { survives = true; break; } }
        for (var p = 0; !survives && p < FALLBACK_SURVIVOR_PREFIXES.length; p++) {
          if (key.indexOf(FALLBACK_SURVIVOR_PREFIXES[p]) === 0) survives = true;
        }
        if (survives) continue;
        try { localStorage.removeItem(key); removed.push(key); } catch (_) {}
      }
    } catch (_) { /* storage disabled — nothing to purge */ }
    return removed;
  }

  function _clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }





  /* ---- Public API ---- */
  return {
    /* Settings */
    getSettings: getSettings,
    setSettings: setSettings,

    /* Progress */
    getProgress: getProgress,
    setProgress: setProgress,

    /* Quick Links */
    getQuickLinks: getQuickLinks,
    setQuickLinks: setQuickLinks,

    /* Custom Topics */
    getCustomTopics: getCustomTopics,
    setCustomTopics: setCustomTopics,

    /* Custom Formulas */
    getCustomFormulas: getCustomFormulas,
    setCustomFormulas: setCustomFormulas,

    /* Bookmarks */
    getBookmarks: getBookmarks,
    setBookmarks: setBookmarks,

    /* Notifications */
    getNotifEnabled: getNotifEnabled,
    setNotifEnabled: setNotifEnabled,

    /* Onboarding */

    /* Utility */
    clearAll: clearAll,

    /* Expose defaults for reset operations */
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_PROGRESS: DEFAULT_PROGRESS,
    DEFAULT_QUICK_LINKS: DEFAULT_QUICK_LINKS
  };
})();
