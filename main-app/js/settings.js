/**
 * settings.js — User settings management
 *
 * Manages: dark mode, sound, vibration, difficulty, reduced motion,
 *          skip questions, notifications, profile, account deletion.
 * Stores settings in localStorage and syncs to Firestore.
 */

var SETTINGS_KEY = 'quant_reflex_settings';
var _logoutInFlight = false;
/* ADR-123 (S3-V3): how long logout waits on the farewell flush before proceeding anyway. The durable
   pending-writes buffer is persisted synchronously before the network write, so the wait is a courtesy
   (let the write land and clear the buffer), never a correctness requirement. */
var LOGOUT_FLUSH_TIMEOUT_MS = 3000;

function loadSettings() {
  if (typeof AppState !== 'undefined') return AppState.getSettings();
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return {
    darkMode: false, sound: true, vibration: true, difficulty: 'medium',
    dailyGoal: 20, reducedMotion: false, skipEnabled: false, notificationsEnabled: false,
    theme: 'classic', practiceAskSubject: true, practiceLastSubject: 'quant',
    appLanguage: 'en', studyLanguage: 'en'
  };
}

function saveSettings(s) {
  try {
    if (typeof AppState !== 'undefined') {
      AppState.setSettings(s);
    } else {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    }
    if (typeof FirestoreSync !== 'undefined') {
      FirestoreSync.syncSettings(s);
    }
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
}

/* ─────────────────────── Theme entitlement (ADR-137) ───────────────────────
   Playful Professional is premium. Before this, the ONLY enforcement lived in initSettingsView(), so
   the gate ran when — and only when — the user opened the Settings tab. Every other path applied the
   theme straight from persisted settings: the pre-paint head script, the boot IIFE in app.js, and the
   post-hydration applyTheme() call. A user whose subscription lapsed therefore kept the premium theme
   through every cold start, warm start, offline launch and restore, indefinitely.

   applyTheme() is now the single enforcement point, and it is TRI-STATE. That distinction is the whole
   design: entitlement is unknowable before Firestore hydration (getAccessState() returns null, so
   canAccessFeature() correctly fails closed to "free"). Treating unknown as "not entitled" would
   downgrade and PERSIST classic on every launch, stripping a paying user's theme — a worse bug than
   the one being fixed. So:

     yes      → render Playful, refresh the hint
     no       → render Classic, silently migrate the saved theme, clear the hint
     unknown  → render from the HINT, and persist nothing

   The hint is one key holding the confirmed entitlement's expiry in millis. It exists so the pre-paint
   script — which runs before any module — has something synchronous to consult, and it is deliberately
   powerless: it gates ONE CSS class. Every real premium gate still calls canAccessFeature() → Firestore,
   so a forged hint buys a colour scheme and nothing else, it can only ever WITHHOLD the theme (an
   absent/stale/garbage value falls to Classic), and applyTheme() overwrites it against live entitlement
   on every boot. `qr_theme_ent` is unregistered in storage-registry.js, whose fail-safe default
   classifies unknown `qr_` keys as user-scoped — so logout and account switch purge it automatically. */
var THEME_ENT_KEY = 'qr_theme_ent';

/** 'yes' | 'no' | 'unknown' — never throws, never guesses entitled. */
function themeEntitlement() {
  try {
    var st = (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.getAccessState === 'function')
      ? FirestoreSync.getAccessState() : null;
    if (!st) return 'unknown';                       /* pre-hydration / signed out */
    return (typeof canAccessFeature === 'function' && canAccessFeature('advanced_theme')) ? 'yes' : 'no';
  } catch (_) { return 'unknown'; }
}

/** The pre-paint predicate, in ONE place. index.html inlines this exact rule — keep them in lockstep
    (scripts/theme-entitlement.check.js asserts it). */
function themeHintValid() {
  try {
    var v = parseInt(localStorage.getItem(THEME_ENT_KEY) || '0', 10);
    return v > Date.now();
  } catch (_) { return false; }
}

/* The hint is capped as well as expiry-bound. On the ordinary expiry path the two coincide — the hint
   dies at exactly the moment entitlement does, so that path never shows a premium frame at all. The
   cap exists for the paths where the stored expiry OUTLIVES the real entitlement: an early revoke,
   refund or chargeback, or a hand-edited value. Those cannot be detected before the first sync, so the
   pre-paint script will honour the hint once; the cap bounds how long "once" can keep recurring if the
   device never syncs again. 30 days is chosen to sit far beyond any realistic offline stretch — a
   premium user offline for a month keeps their theme — while stopping a forged value asserting years. */
var THEME_ENT_MAX_MS = 30 * 24 * 60 * 60 * 1000;

function _writeThemeHint(entitled) {
  try {
    if (!entitled) { localStorage.removeItem(THEME_ENT_KEY); return; }
    var st = (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.getAccessState === 'function')
      ? FirestoreSync.getAccessState() : null;
    var core = (typeof QR_ENTITLEMENT !== 'undefined') ? QR_ENTITLEMENT : null;
    var exp = (st && core) ? core.toMillis(st.planExpiry) : 0;
    var now = Date.now();
    var capped = Math.min(exp, now + THEME_ENT_MAX_MS);
    /* entitlement-core guarantees an active plan carries a real future expiry; anything else is
       illegitimate data, so writing no hint (⇒ Classic next boot) is the fail-safe answer. */
    if (capped > now) localStorage.setItem(THEME_ENT_KEY, String(capped));
    else localStorage.removeItem(THEME_ENT_KEY);
  } catch (_) { /* storage disabled — the theme simply falls back to Classic next boot */ }
}

/**
 * Apply a theme by class name — and enforce entitlement while doing it.
 * Removes all theme classes and applies the selected one.
 * @param {string} theme - 'classic' or 'playful'
 * @returns {string} the theme actually applied
 */
function applyTheme(theme) {
  /* UI Phase 1: theme classes live on <html> — the pre-paint head script sets them before <body>
     parses (no flash), and every selector keys off html.*. (The transitional body-level toggle was
     removed once zero selectors/readers consumed it.) */
  var wanted = (theme === 'playful') ? 'playful' : 'classic';
  var ent = themeEntitlement();
  var on = (wanted === 'playful') && (ent === 'yes' || (ent === 'unknown' && themeHintValid()));

  document.documentElement.classList.toggle('theme-playful', on);
  /* Icons are theme-driven purely in CSS (QR icon system) — toggling the class is enough. */

  if (ent === 'yes') {
    _writeThemeHint(true);
  } else if (ent === 'no') {
    _writeThemeHint(false);
    /* Silently migrate a saved premium theme the user is no longer entitled to, so the next pre-paint
       reads 'classic' and no launch can ever show an expired premium theme. Only ever writes when
       entitlement is KNOWN — never on the unknown branch. */
    if (wanted === 'playful') {
      try {
        var s = loadSettings();
        if (s && s.theme && s.theme !== 'classic') { s.theme = 'classic'; saveSettings(s); }
      } catch (_) { /* never block rendering on a settings write */ }
    }
  }
  return on ? 'playful' : 'classic';
}

/* ---- Appearance: System / Light / Dark (ADR-091; default→Light in UI Phase 1) ----
   ONE resolver owns the light/dark decision. `settings.appearance` is canonical
   ('system' | 'light' | 'dark'); when absent, the legacy boolean migrates lazily:
   darkMode:true → 'dark' (an explicit choice stays), darkMode:false → 'light'.
   UI Phase 1 mandate: the default is now LIGHT, not System — a fresh install (no
   `appearance`, no `darkMode`) starts light. Users who explicitly chose Dark or
   System keep it (the stored `appearance` wins; legacy darkMode:true users stay
   dark via the middle term). Theme classes live on <html> (pre-paint, no flash);
   this resolver only decides the OS branch for System mode. The inline head script
   in index.html mirrors THIS EXACT fallback chain — keep them in lockstep. */
function appearanceMode(s) {
  return s.appearance || (s.darkMode ? 'dark' : 'light');
}

function resolveDarkMode(s) {
  var mode = appearanceMode(s || {});
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) { return false; }
}

/* Keep the browser/OS status-bar tint (theme-color meta) in sync with the resolved mode. */
function _syncThemeColor(dark) {
  try {
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', dark ? '#0f172a' : '#2563eb');
  } catch (_) {}
}

function applyAppearance(s) {
  var dark = resolveDarkMode(s || loadSettings());
  /* Theme class on <html> (lockstep with the pre-paint script). */
  document.documentElement.classList.toggle('dark-mode', dark);
  _syncThemeColor(dark);
}

/* Follow live OS scheme changes while in System mode (e.g. sunset auto-dark). */
(function () {
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      var s = loadSettings();
      if (appearanceMode(s) === 'system') applyAppearance(s);
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange); /* older Safari */
  } catch (_) { /* matchMedia unavailable — fixed light default */ }
})();

function getDifficulty() {
  return loadSettings().difficulty || 'medium';
}

/**
 * Show a toast notification.
 * @param {string} message - text to display
 * @param {number} [duration=3000] - ms before auto-dismiss
 */
function showToast(message, opts) {
  var container = document.getElementById('toastContainer');
  if (!container) return;
  /* Backward-compatible: showToast(msg) / showToast(msg, 4000) still work; the new form is
     showToast(msg, { duration, type:'success'|'error'|'info', action:{ label, onClick } }). */
  if (typeof opts === 'number') opts = { duration: opts };
  opts = opts || {};
  var duration = opts.duration || 3000;
  var toast = document.createElement('div');
  toast.className = 'toast' + (opts.type ? ' is-' + opts.type : '');
  /* Errors are announced assertively; everything else politely (container is aria-live=polite). */
  toast.setAttribute('role', opts.type === 'error' ? 'alert' : 'status');
  toast.appendChild(document.createTextNode(message));
  var remove = function () {
    toast.classList.remove('toast-visible');
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  };
  if (opts.action && opts.action.label) {
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'toast-action'; btn.textContent = opts.action.label;
    btn.addEventListener('click', function () { try { if (opts.action.onClick) opts.action.onClick(); } finally { remove(); } });
    toast.appendChild(btn);
  }
  /* Cap the stack at 2 so a burst never buries the screen (oldest drops). */
  while (container.children.length >= 2) container.removeChild(container.firstChild);
  container.appendChild(toast);
  requestAnimationFrame(function () { toast.classList.add('toast-visible'); });
  setTimeout(remove, duration);
}

/**
 * Initialize settings view controls.
 * Called when settings view is shown.
 */
function initSettingsView() {
  var settings = loadSettings();
  var accessState = (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.getAccessState === 'function')
    ? FirestoreSync.getAccessState()
    : {};
  /* ADR-117: resolve through THE canonical decision rather than a raw plan-string read, so Settings
     can never disagree with the gates (getAccessState now also normalises, so both agree twice over). */
  var isPremiumUser = (typeof hasActivePremium === 'function')
    ? hasActivePremium(accessState)
    : !!(accessState && accessState.plan === 'premium');

  var appearanceSelect = document.getElementById('appearanceSelect');
  var soundToggle = document.getElementById('soundToggle');
  var vibrationToggle = document.getElementById('vibrationToggle');
  var difficultySelect = document.getElementById('difficultySelect');

  if (!appearanceSelect) return;

  /* Remove old listeners by cloning */
  function rebind(el, event, handler) {
    if (!el) return null;
    var newEl = el.cloneNode(true);
    el.parentNode.replaceChild(newEl, el);
    newEl.addEventListener(event, handler);
    return newEl;
  }

  /* Appearance select (ADR-091): writes the canonical mode + keeps settings.darkMode as the
     derived resolved boolean so every legacy reader (incl. the synced settings blob the coaching
     app sees) stays correct. */
  appearanceSelect = rebind(appearanceSelect, 'change', function () {
    settings.appearance = this.value;
    settings.darkMode = resolveDarkMode(settings);
    applyAppearance(settings);
    saveSettings(settings);
    SoundEngine.play('settingsToggle');
    if (typeof triggerHaptic === 'function') triggerHaptic(15);
  });
  appearanceSelect.value = appearanceMode(settings);

  /* Language rows (ADR-111): hidden until the i18n feature flag (or qr_i18n_preview) is on.
     App language drives UI chrome; Study language follows it until the user explicitly picks a
     different one (linked-defaults rule — a CAT aspirant can study in English with a Hindi app). */
  var langBlock = document.getElementById('languageSettingsBlock');
  if (langBlock && typeof QRI18n !== 'undefined' && QRI18n.isOn()) {
    langBlock.style.display = '';
    function _applyLanguageChange() {
      saveSettings(settings);
      /* Tactile feedback fires NOW, on the tap — not after the transition. Direct manipulation should
         answer the finger immediately; the visual/language change follows. */
      try { SoundEngine.play('settingsToggle'); } catch (_) {}
      if (typeof triggerHaptic === 'function') { try { triggerHaptic(15); } catch (_) {} }

      /* Everything else is owned by QRI18nTransition (ADR-126): it loads the study pack before touching
         the screen, dims the content, runs QRI18n.init + the view re-render as ONE commit pass (this used
         to be a double render costing 88-196 ms), restores scroll and focus across it — both of which were
         silently lost before — reveals with a staggered settle, and announces the change to assistive tech.
         `_commit` is the Settings-specific extra work; it runs inside that single pass, after
         QRI18n.init, so QRI18n.t() here already returns the NEW language. */
      function _commit() {
        if (typeof updateAboutUserStatus === 'function') { try { updateAboutUserStatus(); } catch (_) {} }
        try { showToast(QRI18n.t('settings.languageUpdated')); } catch (_) {}
      }
      if (typeof QRI18nTransition !== 'undefined' && QRI18nTransition.switchTo) {
        QRI18nTransition.switchTo(settings, _commit);
        return;
      }
      /* Fallback if the coordinator failed to load (a missing script must never strand the user in a
         half-switched state): commit directly, preserving the original ordering. */
      QRI18n.init(settings);
      function _repaint() {
        _commit();
        if (typeof Router !== 'undefined' && Router.getCurrentView && Router.showView) {
          try { Router.showView(Router.getCurrentView() || 'settings'); } catch (_) {}
        }
      }
      if (typeof QRPacks !== 'undefined' && QRPacks.ensure) QRPacks.ensure(settings.studyLanguage || 'en', _repaint);
      else _repaint();
    }
    /* Warm the other two study packs while the user is looking at Settings, so committing a switch is
       never gated on the network. Bounded: two small files, and ensure() is a no-op once loaded. */
    if (typeof QRI18nTransition !== 'undefined' && QRI18nTransition.warm) {
      QRI18nTransition.warm(settings.studyLanguage || settings.appLanguage || 'en');
    }
    var appLanguageSelect = rebind(document.getElementById('appLanguageSelect'), 'change', function () {
      settings.appLanguage = this.value;
      if (!settings.studyLanguageDiverged) {
        settings.studyLanguage = this.value;
        var st = document.getElementById('studyLanguageSelect');
        if (st) st.value = this.value;
      }
      _applyLanguageChange();
    });
    if (appLanguageSelect) appLanguageSelect.value = settings.appLanguage || 'en';
    var studyLanguageSelect = rebind(document.getElementById('studyLanguageSelect'), 'change', function () {
      settings.studyLanguage = this.value;
      settings.studyLanguageDiverged = this.value !== (settings.appLanguage || 'en');
      _applyLanguageChange();
    });
    if (studyLanguageSelect) studyLanguageSelect.value = settings.studyLanguage || settings.appLanguage || 'en';
  }

  /* Theme selector */
  var themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect = rebind(themeSelect, 'change', function () {
      if (this.value !== 'classic' && !canAccessFeature('advanced_theme')) {
        this.value = settings.theme || 'classic';
        showPaywall('advanced_theme');
        return;
      }
      settings.theme = this.value;
      applyTheme(this.value);
      saveSettings(settings);
      SoundEngine.play('settingsToggle');
    });
    /* ADR-137: this used to BE the enforcement point, and was the only one. applyTheme() now owns the
       decision for every path, so this just runs it and reflects the result — one rule, no second
       implementation to drift. The downgrade write lives inside applyTheme(). */
    var applied = applyTheme(settings.theme || 'classic');
    if (applied !== (settings.theme || 'classic')) settings.theme = applied;
    themeSelect.value = applied;
  }

  soundToggle = rebind(soundToggle, 'change', function () {
    settings.sound = this.checked;
    saveSettings(settings);
    /* Only play confirmation sound when enabling sound */
    if (this.checked) {
      SoundEngine.play('settingsToggle');
    }
    if (typeof triggerHaptic === 'function') triggerHaptic(15);
  });
  soundToggle.checked = settings.sound !== false;

  vibrationToggle = rebind(vibrationToggle, 'change', function () {
    settings.vibration = this.checked;
    saveSettings(settings);
    SoundEngine.play('settingsToggle');
    /* Provide feedback vibration when turning on; skip check since user is toggling this */
    if (this.checked && typeof navigator.vibrate === 'function') navigator.vibrate(15);
  });
  vibrationToggle.checked = settings.vibration !== false;

  /* Reduced Motion toggle */
  var reducedMotionToggle = document.getElementById('reducedMotionToggle');
  if (reducedMotionToggle) {
    reducedMotionToggle = rebind(reducedMotionToggle, 'change', function () {
      settings.reducedMotion = this.checked;
      document.body.classList.toggle('reduced-motion', this.checked);
      saveSettings(settings);
      SoundEngine.play('settingsToggle');
    });
    reducedMotionToggle.checked = !!settings.reducedMotion;
  }

  /* Skip Question toggle */
  var skipToggle = document.getElementById('skipToggle');
  if (skipToggle) {
    skipToggle = rebind(skipToggle, 'change', function () {
      var toggle = this;
      if (toggle.checked && !canAccessFeature('skip_question')) {
        toggle.checked = false;
        settings.skipEnabled = false;
        saveSettings(settings);
        showPaywall('skip_question');
        return;
      }
      if (toggle.checked && settings.difficulty === 'hard') {
        /* Revert toggle immediately */
        toggle.checked = false;
        showToast(QRI18n.t('settings.skipHardToast'));
        return;
      }
      settings.skipEnabled = toggle.checked;
      saveSettings(settings);
      SoundEngine.play('settingsToggle');
    });
    skipToggle.checked = !!(settings.skipEnabled && settings.difficulty !== 'hard');
  }

  /* ADR-080: ask which subject before a Quick-Start session. Default ON (practiceAskSubject !== false). */
  var askSubjectToggle = document.getElementById('askSubjectToggle');
  if (askSubjectToggle) {
    askSubjectToggle = rebind(askSubjectToggle, 'change', function () {
      settings.practiceAskSubject = this.checked;
      saveSettings(settings);
      SoundEngine.play('settingsToggle');
      if (typeof triggerHaptic === 'function') triggerHaptic(15);
    });
    askSubjectToggle.checked = settings.practiceAskSubject !== false;
  }

  /* Target exam select — options from the QR_SYLLABUS catalog grouped by tier; canonical write via TargetExam. */
  var targetExamSelect = document.getElementById('targetExamSelect');
  if (targetExamSelect && typeof QR_SYLLABUS !== 'undefined' && typeof TargetExam !== 'undefined') {
    if (targetExamSelect.options.length <= 1) {
      (QR_SYLLABUS.TIERS || []).forEach(function (tier) {
        var group = document.createElement('optgroup');
        group.label = tier.label;
        (QR_SYLLABUS.examsByTier(tier.id) || []).forEach(function (ex) {
          var opt = document.createElement('option');
          opt.value = ex.id;
          opt.textContent = ex.name;
          group.appendChild(opt);
        });
        if (group.children.length) targetExamSelect.appendChild(group);
      });
    }
    targetExamSelect = rebind(targetExamSelect, 'change', function () {
      TargetExam.set(this.value || null);
      settings = loadSettings(); /* TargetExam.set wrote settings — refresh the local copy so later saves don't clobber it */
      SoundEngine.play('settingsToggle');
      if (this.value) showToast(QRI18n.t('settings.targetSetToast', { label: TargetExam.label(this.value) || this.value }));
    });
    targetExamSelect.value = TargetExam.get() || '';
  }

  difficultySelect = rebind(difficultySelect, 'change', function () {
    if (this.value === 'hard' && !canAccessFeature('hard_mode')) {
      this.value = settings.difficulty || 'medium';
      showPaywall('hard_mode');
      return;
    }
    settings.difficulty = this.value;
    /* If switching to Hard, disable skip */
    if (this.value === 'hard' && settings.skipEnabled) {
      settings.skipEnabled = false;
      var st = document.getElementById('skipToggle');
      if (st) st.checked = false;
      showToast(QRI18n.t('settings.skipHardToast'));
    }
    saveSettings(settings);
    SoundEngine.play('settingsToggle');
  });
  difficultySelect.value = settings.difficulty || 'medium';

  /* Daily goal input */
  var dailyGoalInput = document.getElementById('dailyGoalInput');
  if (dailyGoalInput) {
    dailyGoalInput = rebind(dailyGoalInput, 'change', function () {
      var val = parseInt(this.value);
      if (val >= 10 && val <= 100) {
        if (val > 20 && !canAccessFeature('daily_goal_limit')) {
          this.value = String(settings.dailyGoal || 20);
          showPaywall('daily_goal_limit');
          return;
        }
        settings.dailyGoal = val;
        saveSettings(settings);
      }
    });
    if ((settings.dailyGoal || 20) > 20 && !canAccessFeature('daily_goal_limit')) {
      settings.dailyGoal = 20;
      saveSettings(settings);
    }
    dailyGoalInput.value = settings.dailyGoal || 20;
  }

  /* Notifications toggle */
  var notifToggle = document.getElementById('notificationsToggle');
  if (notifToggle) {
    var notifEnabled = typeof NotificationManager !== 'undefined' && NotificationManager.isEnabled();
    notifToggle = rebind(notifToggle, 'change', function () {
      var toggle = this;
      if (typeof NotificationManager === 'undefined') return;
      if (toggle.checked) {
        NotificationManager.enable(function (err) {
          if (err) {
            toggle.checked = false;
            console.warn('Notifications could not be enabled:', err);
            if (typeof showToast === 'function') showToast(QRI18n.t('settings.notifEnableFailed'));
          }
        });
      } else {
        NotificationManager.disable();
      }
      SoundEngine.play('settingsToggle');
    });
    notifToggle.checked = notifEnabled;
  }

  /* Report a Problem (ADR-096) — opens the reporting modal (full type set from Settings). */
  var reportBtn = document.getElementById('openReportProblem');
  if (reportBtn) {
    rebind(reportBtn, 'click', function () {
      if (typeof ReportModal !== 'undefined' && ReportModal.open) ReportModal.open({ source: 'settings' });
    });
  }

  /* Contact card (ADR-100) — the email is a real mailto: anchor (keyboard + semantics for free); the copy button
     writes the address to the clipboard with a toast + brief "copied" state. Idempotent via rebind (Settings re-inits).
     ADR-110: generalized to wire BOTH copy buttons (Settings card + the About modal's contact card) identically. */
  var CONTACT_EMAIL = 'quantreflex@gmail.com';
  function _wireEmailCopy(btnId) {
    var copyBtn = document.getElementById(btnId);
    if (!copyBtn) return;
    /* Legacy synchronous copy — returns true only if it actually copied (so we never claim false success). */
    function _execCopy() {
      try {
        var ta = document.createElement('textarea'); ta.value = CONTACT_EMAIL;
        ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var okc = document.execCommand('copy'); document.body.removeChild(ta); return !!okc;
      } catch (_) { return false; }
    }
    function _copied() {
      try { if (typeof showToast === 'function') showToast(QRI18n.t('settings.emailCopied')); } catch (_) {}
      var b = document.getElementById(btnId);
      if (b) { b.classList.add('is-copied'); b.setAttribute('aria-label', QRI18n.t('settings.emailCopiedAria')); setTimeout(function () { var bb = document.getElementById(btnId); if (bb) { bb.classList.remove('is-copied'); bb.setAttribute('aria-label', QRI18n.t('settings.copyEmailAria')); } }, 1600); }
    }
    /* Copy failed on every path — don't fake success; point the user at the address they can still tap to email. */
    function _copyFailed() { try { if (typeof showToast === 'function') showToast(QRI18n.t('settings.emailCopyFailed', { email: CONTACT_EMAIL })); } catch (_) {} }
    rebind(copyBtn, 'click', function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          /* On async rejection (denied permission / insecure context) fall back to execCommand; only THEN report. */
          navigator.clipboard.writeText(CONTACT_EMAIL).then(_copied, function () { if (_execCopy()) _copied(); else _copyFailed(); });
        } else { if (_execCopy()) _copied(); else _copyFailed(); }
      } catch (_) { if (_execCopy()) _copied(); else _copyFailed(); }
    });
  }
  _wireEmailCopy('contactEmailCopy');
  _wireEmailCopy('aboutContactEmailCopy');

  /* App Guide button — opens modal */
  var appGuideBtn = document.getElementById('openAppGuide');
  if (appGuideBtn) {
    rebind(appGuideBtn, 'click', function () {
      openInfoModal('appGuideModal');
    });
  }

  /* About button — opens modal */
  var aboutBtn = document.getElementById('openAbout');
  if (aboutBtn) {
    rebind(aboutBtn, 'click', function () {
      updateAboutUserStatus();
      openInfoModal('aboutModal');
    });
  }

  /* Clear Data button — opens modal */
  var clearDataBtn = document.getElementById('clearDataBtn');
  if (clearDataBtn) {
    rebind(clearDataBtn, 'click', function () {
      openClearDataModal();
    });
  }

  /* Profile button — opens profile modal */
  var profileBtn = document.getElementById('openProfileModal');
  if (profileBtn) {
    rebind(profileBtn, 'click', function () {
      openProfileModal();
    });
  }

  /* Logout button */
  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    rebind(logoutBtn, 'click', function () {
      if (_logoutInFlight) return;
      if (typeof Auth !== 'undefined') {
        _logoutInFlight = true;
        this.disabled = true;

        /* Hide the authenticated UI immediately to prevent stale visual flashes */
        if (typeof Router !== 'undefined' && typeof Router.teardown === 'function') {
          Router.teardown();
        }
        document.body.classList.remove('auth-resolved');
        var container = document.querySelector('.container');
        var authScreen = document.getElementById('authScreen');
        var bottomNav = document.querySelector('.bottom-nav');
        if (container) container.style.display = 'none';
        if (bottomNav) bottomNav.style.display = 'none';
        if (authScreen) authScreen.style.display = 'flex';

        /* Flush pending Firestore writes and clear local state BEFORE
           signing out, while the user context is still valid */
        if (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.flushUpdatesAsync === 'function') {
          /* ADR-123 (S3-V3): this callback is the ONLY thing gating the rest of logout, and it fires from a
             Firestore set() promise — which never settles while offline (the write stays locally pending).
             Without a fallback, an offline logout left the user signed IN while the UI above had already
             hidden the app and shown the auth screen, with _logoutInFlight and the disabled button blocking
             every retry: a wedge recoverable only by a manual reload. Proceeding after a short wait is safe
             because flushUpdatesAsync persists the durable uid-scoped buffer synchronously BEFORE the network
             write, so the queued data replays on this user's next load either way. Once-only: whichever of
             the callback and the watchdog arrives first wins. */
          var _logoutDone = false;
          var _logoutWatchdog = null;
          var _finishLogout = function () {
            if (_logoutDone) return;
            _logoutDone = true;
            if (_logoutWatchdog) { clearTimeout(_logoutWatchdog); _logoutWatchdog = null; }
            FirestoreSync.resetSyncState();
            Auth.logout(function (err) {
              _logoutInFlight = false;
              if (err) {
                var lb = document.getElementById('logoutBtn');
                if (lb) lb.disabled = false;
                alert(QRI18n.t('settings.logoutFailed', { error: err }));
                window.location.reload(); /* Force reload to recover state */
              } else {
                window.location.reload();
              }
            });
          };
          _logoutWatchdog = setTimeout(_finishLogout, LOGOUT_FLUSH_TIMEOUT_MS);
          FirestoreSync.flushUpdatesAsync(_finishLogout);
          return;
        } else if (typeof FirestoreSync !== 'undefined') {
          FirestoreSync.resetSyncState();
        }
        Auth.logout(function (err) {
          _logoutInFlight = false;
          if (err) {
            var lb = document.getElementById('logoutBtn');
            if (lb) lb.disabled = false;
            alert(QRI18n.t('settings.logoutFailed', { error: err }));
          } else {
            /* Reload page for clean state — auth persistence keeps
               the user logged out, and all JS state is reset */
            window.location.reload();
          }
        });
      }
    });
  }

  /* Delete Account button */
  var deleteBtn = document.getElementById('deleteAccountBtn');
  if (deleteBtn) {
    rebind(deleteBtn, 'click', function () {
      openDeleteAccountModal();
    });
  }

  var updateAppBtn = document.getElementById('updateAppBtn');
  if (updateAppBtn) {
    rebind(updateAppBtn, 'click', function () {
      try {
        var rawProg = localStorage.getItem('qr_progress') || localStorage.getItem('quant_reflex_progress');
        var parsedProg = rawProg ? JSON.parse(rawProg) : null;
        if (typeof QRDiagnostic !== 'undefined') {
          QRDiagnostic.log('settings', 'updateAppBtn:click', {
            appVersion: window.QR_APP_VERSION,
            lastUid: localStorage.getItem('qr_last_uid'),
            preUpdateTodayAttempted: parsedProg ? parsedProg.todayAttempted : null,
            preUpdateTodayCorrect: parsedProg ? parsedProg.todayCorrect : null,
            preUpdateLastActiveDate: parsedProg ? parsedProg.lastActiveDate : null,
            preUpdateTotalAttempted: parsedProg ? parsedProg.totalAttempted : null
          });
        }
      } catch (_) {}
      updateAppBtn.disabled = true;
      var labelEl = updateAppBtn.querySelector('.settings-btn-label');
      var _origLabel = labelEl ? labelEl.textContent : updateAppBtn.textContent;   /* ADR-162 restore point */
      if (labelEl) {
        labelEl.textContent = QRI18n.t('settings.updatingApp');
      } else {
        updateAppBtn.textContent = QRI18n.t('settings.updatingApp');
      }
      if (typeof showToast === 'function') showToast(QRI18n.t('settings.updatingAppToast'));
      /* ADR-102: the shared QRUpdateManager owns cache-purge + skip-waiting + the one-shot reload
         (identical sequence to before). This handler is now pure presentation + the action call. */
      if (typeof QRUpdateManager !== 'undefined') {
        /* ADR-162: applyUpdate normally never settles — the page navigates out from under us. It DOES
           resolve when it declined to run, which today means the device is offline: purging every cache
           without a network to refill them would leave the app with nothing to load. Restore the button
           and say why, rather than leaving it stuck on "Updating…" forever. */
        QRUpdateManager.applyUpdate().then(function (res) {
          if (res && res.applied === false) {
            updateAppBtn.disabled = false;
            if (labelEl) labelEl.textContent = _origLabel;
            else updateAppBtn.textContent = _origLabel;
            if (typeof showToast === 'function') showToast(QRI18n.t('settings.updateOfflineToast'));
          }
        }, function () { /* a rejection still means the page is on its way out — leave the button as is */ });
      } else {
        /* ADR-174: same reasoning as the update-manager path above — carry the Play marker across the
           relaunch so a Play build cannot come back as a web build and offer Razorpay. Empty outside a
           Play build. */
        var _q = '';
        try {
          if (window.QRPlatform && typeof window.QRPlatform.launchQuery === 'function') _q = window.QRPlatform.launchQuery();
        } catch (_) { _q = ''; }
        window.location.href = window.location.pathname + _q;
      }
    });
  }

  var trialUpgradeSection = document.getElementById('trialUpgradeSection');
  if (trialUpgradeSection) {
    /* ADR-117: an ACTIVE entitlement of any kind — purchased, admin-granted, or a trial — must never
       be shown a purchase surface. This used to include `|| isTrialUser`, so trial users saw a full
       "Unlock Premium" card whose button called showPaywall() → which early-returns for anyone with
       active premium. The result was a completely inert CTA: no modal, no toast, not even telemetry.
       Trials now see their plan-status card ("Trial — N days left") instead, and the server agrees
       (create-order answers ALREADY_PREMIUM until the entitlement genuinely lapses). */
    trialUpgradeSection.style.display = isPremiumUser ? 'none' : 'block';
  }
  var trialUpgradeBtn = document.getElementById('trialUpgradeBtn');
  if (trialUpgradeBtn) {
    rebind(trialUpgradeBtn, 'click', function () {
      showPaywall('upgrade');
    });
  }

  /* Refund (ADR-143) — a request, never a refund. The app cannot issue one; this only asks.
     Everything shown here is DISPLAY state. The server recomputes eligibility from the stored gateway
     capture time on submit, so a tab left open past the window closing cannot slip a request through:
     the button may still look enabled, and the server answers REFUND_WINDOW_EXPIRED. */
  _wireRefundSection(isPremiumUser);

  /* PWA install button */
  var installCard = document.getElementById('installCard');
  var installBtn = document.getElementById('installBtn');
  if (installCard && installBtn && window._deferredPrompt) {
    installCard.style.display = 'block';
    rebind(installBtn, 'click', function () {
      window._deferredPrompt.prompt();
      window._deferredPrompt.userChoice.then(function () {
        window._deferredPrompt = null;
        installCard.style.display = 'none';
      });
    });
  }

  /* Apply reduced motion on load */
  document.body.classList.toggle('reduced-motion', !!settings.reducedMotion);
  updateAboutUserStatus();
}

/* ── Refund request (ADR-143) ────────────────────────────────────────────────────────────────────
   The app NEVER issues a refund. This surface only creates a REQUEST, which a Super Admin reviews;
   the entitlement is revoked later, and only when the payment provider confirms the money moved.

   The 24-hour window is recomputed SERVER-SIDE from the gateway capture time on every call. What is
   rendered here is display state and is deliberately not trusted: a tab left open past the deadline
   still gets REFUND_WINDOW_EXPIRED from the server. */
function _refundApi(action, body) {
  return Auth.getIdToken().then(function (idToken) {
    return fetch('/api/payment?action=' + action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken,
        'X-Session-Id': (window.Session ? Session.id() : '')
      },
      body: JSON.stringify(body || {})
    });
  }).then(function (resp) {
    return resp.json().then(function (data) { return { ok: resp.ok, status: resp.status, data: data }; });
  });
}

function _wireRefundSection(isPremiumUser) {
  var section = document.getElementById('refundSection');
  if (!section) return;
  /* Hidden by default and only revealed once the server confirms a refundable purchase exists — never
     shown speculatively, because offering a refund to someone who never paid is worse than silence. */
  section.style.display = 'none';
  if (!isPremiumUser || typeof Auth === 'undefined' || !Auth.getIdToken) return;

  var statusEl = document.getElementById('refundStatusText');
  var btn = document.getElementById('refundRequestBtn');
  var form = document.getElementById('refundForm');
  var reasonEl = document.getElementById('refundReason');
  var submitBtn = document.getElementById('refundSubmitBtn');
  var cancelBtn = document.getElementById('refundCancelBtn');
  if (!statusEl || !btn || !form || !submitBtn) return;

  function t(k, vars) { return (typeof QRI18n !== 'undefined') ? QRI18n.t(k, vars) : k; }
  function show(msg, canRequest) {
    section.style.display = 'block';
    statusEl.textContent = msg;
    /* EXPIRED KEEPS THE BUTTON VISIBLE AND DISABLED. Hiding it would look like a bug and leave the
       customer with no explanation; the disabled control plus the sentence above it is the answer. */
    btn.disabled = !canRequest;
    btn.style.display = 'inline-flex';
    form.style.display = 'none';
  }

  _refundApi('refund-eligibility', {}).then(function (r) {
    if (!r.ok || !r.data) return;                       /* stay hidden rather than guess */
    var d = r.data;
    if (d.state === 'no_purchase') return;
    if (d.alreadyRefunded) { show(t('settings.refundDone'), false); return; }

    if (d.openRequest) {
      /* A request already exists — show where it stands instead of inviting a duplicate. */
      var byStatus = { pending: 'settings.refundPending', approved: 'settings.refundApproved' };
      show(t(byStatus[d.openRequest.status] || 'settings.refundPending'), false);
      return;
    }

    if (d.state === 'eligible') {
      var ends = d.windowEndsAtMs ? new Date(d.windowEndsAtMs).toLocaleString() : '';
      show(t('settings.refundEligible', { time: ends }), true);
    } else if (d.state === 'unknown_capture_time') {
      /* We could not establish when this was captured, so the policy refuses to decide and a human
         reviews it. Never silently denied — that would punish a customer for our missing data. */
      show(t('settings.refundUnknown'), true);
    } else {
      show(t('settings.refundExpired'), false);
    }
  }).catch(function () { /* network trouble — leave the section hidden */ });

  /* `onclick =` rather than addEventListener: settings re-runs its wiring on every render, so the
     binding has to REPLACE the previous one rather than stack. Node-cloning (the pattern used
     elsewhere in this file) would detach the very elements the `show()` closure above holds. */
  btn.onclick = function () { form.style.display = 'block'; btn.style.display = 'none'; if (reasonEl) reasonEl.focus(); };
  if (cancelBtn) cancelBtn.onclick = function () { form.style.display = 'none'; btn.style.display = 'inline-flex'; };

  submitBtn.onclick = function () {
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    _refundApi('refund-request', { reason: reasonEl ? reasonEl.value : '' }).then(function (r) {
      submitBtn.disabled = false;
      if (r.ok && r.data && r.data.success) {
        showToast(t('settings.refundSubmitted'));
        show(t('settings.refundPending'), false);
        return;
      }
      var code = r.data && r.data.error && r.data.error.code;
      if (code === 'REFUND_WINDOW_EXPIRED') { show(t('settings.refundExpired'), false); return; }
      if (code === 'REFUND_REQUEST_EXISTS') { show(t('settings.refundPending'), false); return; }
      if (code === 'ALREADY_REFUNDED') { show(t('settings.refundDone'), false); return; }
      showToast(t('settings.refundFailedToast'));
    }).catch(function () {
      submitBtn.disabled = false;
      showToast(t('settings.refundFailedToast'));
    });
  };
}

function updateAboutUserStatus() {
  var statusEl = document.getElementById('aboutUserStatusMessage');
  var settingsStatusEl = document.getElementById('settingsUserStatusMessage');
  /* ADR-103: source the displayed version from the single build tag (QR_APP_VERSION) so it can never
     drift from the shipped build (the old hard-coded "Version 2.1.0" was disconnected from it). */
  try {
    var _verEl = document.getElementById('aboutVersionLine');
    if (_verEl && typeof window !== 'undefined' && window.QR_APP_VERSION) {
      _verEl.textContent = QRI18n.t('settings.versionLine', { version: window.QR_APP_VERSION });
    }
  } catch (_) {}
  /* ADR-110: live update status in About. isUpdateAvailable() is the shared UpdateManager's synchronous flag —
     true only when a genuinely newer service worker is installed and waiting. */
  try {
    var _updEl = document.getElementById('aboutUpdateStatus');
    if (_updEl) {
      var _updAvail = (typeof QRUpdateManager !== 'undefined' && QRUpdateManager.isUpdateAvailable)
        ? QRUpdateManager.isUpdateAvailable() : false;
      _updEl.textContent = _updAvail
        ? QRI18n.t('settings.updateReadyLine')
        : QRI18n.t('settings.upToDateLine');
    }
  } catch (_) {}
  var accessState = (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.getAccessState === 'function')
    ? (FirestoreSync.getAccessState() || {})
    : {};
  function _fmtDate(value) {
    var ms = 0;
    if (typeof value === 'number') ms = value;
    else if (typeof value === 'string') ms = new Date(value).getTime();
    else if (value && typeof value.toDate === 'function') { try { ms = value.toDate().getTime(); } catch (_) {} }
    if (!ms || isNaN(ms)) return '';
    return new Intl.DateTimeFormat((typeof QRI18n !== 'undefined') ? QRI18n.localeTag() : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
  }

  var message = QRI18n.t('settings.planFree');
  if (accessState.plan === 'premium') {
    if (accessState.isTrial === true) {
      /* Trial — N days left */
      var trialDaysLabel = '';
      if (accessState.trialDays != null && accessState.trialDays > 0) {
        trialDaysLabel = QRI18n.t('settings.trialDaysLeft', { count: accessState.trialDays });
      } else {
        var tStr = _fmtDate(accessState.trialEnd);
        if (tStr) trialDaysLabel = QRI18n.t('settings.trialExpires', { date: tStr });
      }
      message = QRI18n.t('settings.planTrial') + trialDaysLabel;
    } else {
      var planLabel = accessState.planType === 'premium_12m' ? QRI18n.t('settings.plan12m')
                    : accessState.planType === 'premium_6m' ? QRI18n.t('settings.plan6m') : '';
      var expStr = _fmtDate(accessState.planExpiry);
      message = QRI18n.t('settings.planPremium') + (planLabel ? ' (' + planLabel + ')' : '') + (expStr ? QRI18n.t('settings.planExpiresFrag', { date: expStr }) : '');
    }
  }
  if (statusEl) {
    statusEl.textContent = message;
  }
  if (settingsStatusEl) {
    settingsStatusEl.textContent = message;
  }
}

/**
 * Open the Clear Data modal with options.
 */
function openClearDataModal() {
  var modal = document.getElementById('clearDataModal');
  if (!modal) return;
  /* Prevent duplicate overlays */
  var confirmModal = document.getElementById('clearConfirmModal');
  if (confirmModal) confirmModal.style.display = 'none';

  modal.style.display = 'flex';
  /* FW-W1: shared overlay lifecycle (lock/Escape/trap/restore); static markup unchanged. */
  var handle = QROverlay.open(modal, {
    dialogEl: modal.querySelector('.modal-content'),
    removeOnClose: false, closingClass: null, closeMs: 0,
    initialFocus: document.getElementById('clearDataCancel')
  });

  var cancelBtn = document.getElementById('clearDataCancel');
  var optionBtns = modal.querySelectorAll('.clear-option-btn');
  cancelBtn.onclick = function () { handle.close(); };

  /* Option handlers — close the chooser, then chain into the type-specific confirm. */
  for (var i = 0; i < optionBtns.length; i++) {
    optionBtns[i].onclick = function () {
      var type = this.getAttribute('data-clear');
      handle.close();
      openClearConfirmModal(type);
    };
  }
}

/**
 * Open a confirmation dialog before clearing data.
 * @param {string} type - 'stats', 'streaks', 'formulas', or 'all'
 */
function openClearConfirmModal(type) {
  var modal = document.getElementById('clearConfirmModal');
  var textEl = document.getElementById('clearConfirmText');
  var cancelBtn = document.getElementById('clearConfirmCancel');
  var okBtn = document.getElementById('clearConfirmOk');
  if (!modal || !textEl) return;

  var messages = {
    stats: QRI18n.t('settings.clearStatsConfirm'),
    streaks: QRI18n.t('settings.clearStreaksConfirm'),
    formulas: QRI18n.t('settings.clearFormulasConfirm'),
    all: QRI18n.t('settings.clearAllConfirm')
  };
  textEl.textContent = messages[type] || QRI18n.t('settings.confirmFallback');
  modal.style.display = 'flex';
  /* FW-W1: shared lifecycle; static markup kept (it doubles as app.js showCustomConfirm's
     no-QROverlay fallback shell). Focus lands on the SAFE cancel — this is destructive. */
  var handle = QROverlay.open(modal, {
    dialogEl: modal.querySelector('.modal-content'),
    removeOnClose: false, closingClass: null, closeMs: 0,
    initialFocus: cancelBtn
  });
  function closeModal() { handle.close(); }
  cancelBtn.onclick = closeModal;

  okBtn.onclick = function () {
    closeModal();
    if (type === 'streaks') {
      /* Handle streaks clearing through the proper AppState chain */
      try {
        var progress = loadProgress();
        progress.currentStreak = 0;
        progress.bestStreak = 0;
        progress.dailyStreak = 0;
        progress.bestDailyStreak = 0;
        progress.lastPracticeDate = null;
        saveProgress(progress);
      } catch (_) {}
      showToast(QRI18n.t('settings.streaksReset'));
      if (typeof Router !== 'undefined') {
        Router.showView('settings');
      }
      return;
    }

    if (typeof FirestoreSync !== 'undefined') {
      FirestoreSync.clearUserData(type, function (err) {
        if (err) {
          alert(QRI18n.t('settings.clearFailed', { error: err }));
        } else {
          if (type === 'stats') {
            /* Stats only — re-render settings view without reload */
            showToast(QRI18n.t('settings.statsReset'));
            if (typeof Router !== 'undefined') {
              Router.showView('settings');
            }
          } else {
            /* Formulas or all — reload page for clean DOM state.
               Auth persistence keeps the user logged in. */
            showToast(QRI18n.t('settings.dataCleared'));
            setTimeout(function () { window.location.reload(); }, 500);
          }
        }
      });
    } else {
      /* Fallback: clear local data only */
      if (type === 'stats') {
        resetProgress();
      } else if (type === 'formulas') {
        if (typeof AppState !== 'undefined') {
          AppState.setCustomFormulas({});
          AppState.setCustomTopics([]);
          AppState.setBookmarks([]);
        }
      } else if (type === 'all') {
        resetProgress();
        var defaultSettings = {
          darkMode: false, sound: true, vibration: true, difficulty: 'medium',
          dailyGoal: 20, reducedMotion: false, skipEnabled: false, notificationsEnabled: false,
          theme: 'classic'
        };
        /* Write to canonical AppState keys — single source of truth */
        if (typeof AppState !== 'undefined') {
          AppState.setSettings(defaultSettings);
          AppState.setCustomFormulas({});
          AppState.setCustomTopics([]);
          AppState.setBookmarks([]);
          AppState.setQuickLinks(['fractionTable', 'tablesContainer', 'formulaSections', 'mentalTricks']);
          AppState.setNotifEnabled(false);
        }
        if (typeof NotificationManager !== 'undefined') {
          NotificationManager.cancelScheduledNotifications();
        }
      }
      if (type === 'stats') {
        showToast(QRI18n.t('settings.statsReset'));
        if (typeof Router !== 'undefined') {
          Router.showView('settings');
        }
      } else {
        showToast(QRI18n.t('settings.dataCleared'));
        setTimeout(function () { window.location.reload(); }, 500);
      }
    }
  };
}

/**
 * Normalise any stored date (Firestore Timestamp | ISO string | epoch ms) to a valid Date, or null.
 * Guards against Invalid Date so callers never render "Invalid Date"/null/undefined.
 */
function _toDate(v) {
  if (v == null) return null;
  var d = null;
  try {
    if (typeof v === 'object') {
      if (typeof v.toDate === 'function') d = v.toDate();              // Firestore Timestamp (compat SDK)
      else if (typeof v.seconds === 'number') d = new Date(v.seconds * 1000); // raw {seconds,nanoseconds}
    } else if (typeof v === 'number') {
      d = new Date(v);                                                 // epoch ms
    } else if (typeof v === 'string') {
      d = new Date(v);                                                 // ISO string
    }
  } catch (_) { return null; }
  return (d && !isNaN(d.getTime())) ? d : null;
}

/**
 * Open the profile modal showing user details.
 */
function openProfileModal() {
  var modal = document.getElementById('profileModal');
  if (!modal) return;
  modal.style.display = 'flex';
  /* FW-W2: shared lifecycle (gains Escape + focus-trap + focus-restore); static markup unchanged. */
  var _pmHandle = QROverlay.open(modal, {
    dialogEl: modal.querySelector('.modal-content'),
    removeOnClose: false, closingClass: null, closeMs: 0,
    initialFocus: document.getElementById('profileName')
  });

  var nameInput = document.getElementById('profileName');
  var handleInput = document.getElementById('profileHandle');
  var bannerEl = document.getElementById('profileBanner');
  var cancelBtn = document.getElementById('profileCancel');
  var saveBtn = document.getElementById('profileSave');

  /* Populate fields from Firestore cache or localStorage */
  var profile = {};
  var coachingId = null;
  try {
    if (typeof FirestoreSync !== 'undefined' && FirestoreSync._getCache) {
      var cache = FirestoreSync._getCache();
      if (cache && cache.profile) profile = cache.profile;
      if (cache && cache.coachingId) coachingId = cache.coachingId;
    }
  } catch (_) {}

  if (nameInput) nameInput.value = profile.name || '';
  if (handleInput) {
    /* Show handle (email prefix) — read-only */
    var handleStr = '';
    try {
      var currentUser = (typeof Auth !== 'undefined' && Auth.getCurrentUser()) ? Auth.getCurrentUser() : null;
      if (currentUser && currentUser.email) handleStr = '@' + currentUser.email.split('@')[0];
    } catch (_) {}
    handleInput.value = handleStr;
  }

  /* Coaching ID: bound → read-only display; unbound → editable ONCE (bind-once, server-enforced).
     This surfaces the existing claim-coaching path for Google sign-ups (no coaching field at signup)
     and for email users who skipped it. */
  var coachingIdInput = document.getElementById('profileCoachingId');
  var coachingHelper = document.getElementById('profileCoachingHelper');
  if (coachingIdInput) {
    if (coachingId) {
      coachingIdInput.value = coachingId;
      coachingIdInput.readOnly = true;
      coachingIdInput.disabled = true;
      if (coachingHelper) coachingHelper.style.display = 'none';
    } else {
      coachingIdInput.value = '';
      coachingIdInput.readOnly = false;
      coachingIdInput.disabled = false;
      coachingIdInput.placeholder = QRI18n.t('settings.coachingPlaceholder');
      coachingIdInput.maxLength = 50;
      if (coachingHelper) coachingHelper.style.display = '';
    }
  }

  /* Profile banner: "{Name} started mathing on {Date}".
     Resolve the start date robustly so it NEVER renders "unknown date": onboarding completion (the day the user
     started here) → client profile.createdAt → server-side root createdAt (a Firestore Timestamp). Each source may
     be a Firestore Timestamp, an ISO string, or epoch ms — _toDate() normalises all of them. */
  if (bannerEl) {
    var displayName = profile.name || QRI18n.t('settings.profileYou');
    var startSettings = {};
    try { if (typeof AppState !== 'undefined' && AppState.getSettings) startSettings = AppState.getSettings() || {}; } catch (_) {}
    var joinedDate = _toDate(startSettings.onboardingCompletedAt) || _toDate(profile.createdAt) || _toDate(cache && cache.createdAt);
    if (joinedDate) {
      var dateStr = joinedDate.toLocaleDateString((typeof QRI18n !== 'undefined') ? QRI18n.localeTag() : 'en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      bannerEl.textContent = QRI18n.t('settings.profileJoined', { name: displayName, date: dateStr });
    } else {
      // No reliable date anywhere — use a graceful, dateless line rather than "an unknown date".
      bannerEl.textContent = QRI18n.t('settings.profileSharpening', { name: displayName });
    }
  }

  function closeModal() { _pmHandle.close(); }

  cancelBtn.onclick = closeModal;

  saveBtn.onclick = function () {
    var newName = nameInput ? nameInput.value.trim() : '';

    /* Update name in Firestore */
    if (newName && typeof FirestoreSync !== 'undefined') {
      FirestoreSync.updateProfileName(newName);
      showToast(QRI18n.t('settings.profileSaved'));
    }

    /* One-time coaching claim (only when unbound and a code was typed) */
    var codeVal = (coachingIdInput && !coachingIdInput.disabled) ? coachingIdInput.value.trim().toUpperCase() : '';
    if (codeVal && typeof FirestoreSync !== 'undefined' && FirestoreSync.claimCoaching) {
      FirestoreSync.claimCoaching(codeVal, function (err) {
        if (err) {
          showToast(err.message || QRI18n.t('settings.coachingJoinFailed'));
        } else {
          showToast(QRI18n.t('settings.coachingJoined', { code: codeVal }));
        }
      });
    }

    closeModal();
  };
}

/**
 * Open the delete account confirmation modal.
 * Uses server-side API for safe, complete data deletion.
 */
function openDeleteAccountModal() {
  var modal = document.getElementById('deleteAccountModal');
  if (!modal) return;
  modal.style.display = 'flex';

  var cancelBtn = document.getElementById('deleteAccountCancel');
  var confirmBtn = document.getElementById('deleteAccountConfirm');

  /* FW-W2: shared lifecycle; destructive flow — initial focus on the SAFE cancel, and a closeGuard
     blocks backdrop/Escape while the re-auth + server deletion is in flight. */
  var _deleting = false;
  var _daHandle = QROverlay.open(modal, {
    dialogEl: modal.querySelector('.modal-content'),
    removeOnClose: false, closingClass: null, closeMs: 0,
    initialFocus: cancelBtn,
    closeGuard: function () { return _deleting; }
  });
  var passInput = document.getElementById('deleteAccountPassword');
  var errDiv = document.getElementById('deleteAccountError');

  if (passInput) passInput.value = '';
  if (errDiv) errDiv.style.display = 'none';

  /* Provider-aware re-auth: a Google-only user has no password — show the popup-confirm note
     instead of the password field, and re-authenticate via the provider on confirm. */
  var _delUser = (typeof Auth !== 'undefined') ? Auth.getCurrentUser() : null;
  var _hasPasswordProvider = !!(_delUser && (_delUser.providerData || []).some(function (p) { return p && p.providerId === 'password'; }));
  var passLabel = document.getElementById('deleteAccountPasswordLabel');
  var providerNote = document.getElementById('deleteAccountProviderNote');
  if (passInput) passInput.style.display = _hasPasswordProvider ? '' : 'none';
  if (passLabel) passLabel.style.display = _hasPasswordProvider ? '' : 'none';
  if (providerNote) providerNote.style.display = _hasPasswordProvider ? 'none' : '';

  function closeModal() { _daHandle.close(); }

  function _setDeleteLoading(loading) {
    _deleting = loading;   // closeGuard reads this — no dismissal mid-deletion
    if (confirmBtn) {
      confirmBtn.disabled = loading;
      confirmBtn.textContent = loading ? QRI18n.t('settings.deleting') : QRI18n.t('settings.deleteForever');
      if (loading) confirmBtn.classList.add('btn-loading');
      else confirmBtn.classList.remove('btn-loading');
    }
    if (cancelBtn) cancelBtn.disabled = loading;
    if (passInput) passInput.disabled = loading;
  }

  /* Map Firebase/server error codes to user-friendly messages */
  function _getDeleteErrorMessage(err) {
    if (!err) return QRI18n.t('settings.deleteFailed');
    var msg = err.message || err;
    if (typeof msg === 'string') {
      if (msg.indexOf('auth/requires-recent-login') !== -1) {
        return QRI18n.t('settings.deleteReauth');
      }
      if (msg.indexOf('auth/popup-closed-by-user') !== -1 || msg.indexOf('auth/cancelled-popup-request') !== -1) {
        return QRI18n.t('settings.deleteCancelled');
      }
      if (msg.indexOf('auth/user-mismatch') !== -1) {
        return QRI18n.t('settings.deleteMismatch');
      }
      if (msg.indexOf('auth/popup-blocked') !== -1) {
        return QRI18n.t('settings.deletePopupBlocked');
      }
      if (msg.indexOf('UNAUTHORIZED') !== -1 || msg.indexOf('token') !== -1) {
        return QRI18n.t('settings.deleteSessionExpired');
      }
      if (msg.indexOf('DELETION_FAILED') !== -1) {
        return QRI18n.t('settings.deletePartial');
      }
      if (msg.indexOf('network') !== -1 || msg.indexOf('fetch') !== -1 || msg.indexOf('Failed to fetch') !== -1) {
        return QRI18n.t('settings.deleteNetwork');
      }
    }
    return QRI18n.t('settings.deleteUnable');
  }

  cancelBtn.onclick = closeModal;

  confirmBtn.onclick = function () {
    var passInput = document.getElementById('deleteAccountPassword');
    var errDiv = document.getElementById('deleteAccountError');
    var password = passInput ? passInput.value.trim() : '';

    if (_hasPasswordProvider && passInput && !password) {
      if (errDiv) { errDiv.textContent = QRI18n.t('settings.deletePasswordRequired'); errDiv.style.display = 'block'; }
      return;
    }

    if (typeof Auth === 'undefined' || !Auth.getCurrentUser()) {
      showToast(QRI18n.t('settings.signInToManage'));
      closeModal();
      return;
    }

    _setDeleteLoading(true);
    if (errDiv) errDiv.style.display = 'none';

    var user = Auth.getCurrentUser();
    var reauthPromise;
    if (_hasPasswordProvider) {
      var credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
      reauthPromise = user.reauthenticateWithCredential(credential);
    } else {
      reauthPromise = user.reauthenticateWithPopup(new firebase.auth.GoogleAuthProvider());
    }

    reauthPromise.then(function() {
      return Auth.getIdToken();
    }).then(function (idToken) {
      return fetch('/api/account?action=delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + idToken,
          'X-Session-Id': (window.Session ? Session.id() : '')
        }
      });
    }).then(function (resp) {
      return resp.json().then(function (data) {
        return { ok: resp.ok, status: resp.status, data: data };
      });
    }).then(function (result) {
      _setDeleteLoading(false);

      if (!result.ok || !result.data.success) {
        var serverMsg = (result.data && result.data.error && result.data.error.message)
          ? result.data.error.message
          : null;
        if (errDiv) { 
          errDiv.textContent = _getDeleteErrorMessage({ message: serverMsg || 'DELETION_FAILED' });
          errDiv.style.display = 'block';
        }
        return;
      }

      /* Server confirmed complete deletion — clear all local data */
      try {
        if (typeof AppState !== 'undefined' && typeof AppState.clearAll === 'function') {
          AppState.clearAll();
        }
        localStorage.removeItem('quant_reflex_user');
        localStorage.removeItem('quant_reflex_settings');
      } catch (_) {}

      closeModal();
      showToast(QRI18n.t('settings.accountDeleted'));

      setTimeout(function () {
        window.location.reload();
      }, 1500);

    }).catch(function (err) {
      _setDeleteLoading(false);
      console.error('[Settings] Account deletion error:', err);
      if (errDiv) { 
        errDiv.textContent = _getDeleteErrorMessage(err);
        errDiv.style.display = 'block';
      }
    });
  };
}

/**
 * Open a full-screen info modal (App Guide or About).
 * @param {string} modalId - DOM id of the modal overlay
 */
function openInfoModal(modalId) {
  var modal = document.getElementById(modalId);
  if (!modal) return;
  modal.style.display = 'flex';   /* overlay flex-centers the card (matches .info-modal-overlay) */
  modal.classList.remove('closing');

  /* FW-W1: lifecycle (scroll-lock, Escape, focus-trap, title-focus, focus-restore, 200ms closing
     animation) now comes from the shared controller — this used to be ~40 bespoke lines. */
  _infoModalHandle = QROverlay.open(modal, {
    dialogEl: modal.querySelector('.info-modal-content') || modal.firstElementChild,
    removeOnClose: false,
    closingClass: 'closing',
    closeMs: 200,
    initialFocus: modal.querySelector('.info-modal-title'),
    sound: 'tableModal',
    onClose: function () { SoundEngine.play('tableModal'); _infoModalHandle = null; }
  });

  var closeBtn = modal.querySelector('.info-modal-close');
  if (closeBtn) closeBtn.onclick = function () { if (_infoModalHandle) _infoModalHandle.close(); };

  modal.onclick = function (e) {
    /* ADR-110: TOC chips (App Guide) scroll their target section within .info-modal-scroll. Delegated here so the
       chips need no per-chip wiring; honours reduced motion (instant jump instead of smooth scroll). Backdrop
       close itself is the controller's job now. */
    var chip = e.target && e.target.closest ? e.target.closest('.info-toc-chip') : null;
    if (chip && modal.contains(chip)) {
      var targetEl = document.getElementById(chip.getAttribute('data-target') || '');
      if (targetEl) {
        var _instant = document.body.classList.contains('reduced-motion') ||
          (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        try { targetEl.scrollIntoView({ behavior: _instant ? 'auto' : 'smooth', block: 'start' }); }
        catch (_) { targetEl.scrollIntoView(); }
      }
    }
  };
}

/* Handle of the currently-open info modal (App Guide / About) — lets _closeAllInfoModals tear it down. */
var _infoModalHandle = null;
