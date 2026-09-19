/**
 * practice-modes.js — Practice drill mode launcher
 *
 * Extracted from app.js. Manages:
 *   - startDrillFromPractice() — mode config + launch
 *   - _startPracticeEngine() — engine instantiation
 *   - Practice view Router.onShow / onInit callbacks
 *
 * Dependencies (expected globals):
 *   Router, SoundEngine, FirestoreSync, AIFeatures,
 *   createDrillEngine, canAccessFeature, showPaywall, hasReachedDailyLimit,
 *   _activeDrillEngine, _drillSessionActive, _enterDrillSession, _exitDrillSession,
 *   _resetPracticeUiToModes, _getTimerConfig, _initTimerControls, _initAdaptiveToggle,
 *   _resetTimerSelection, _resetAdaptiveToggle, _resetCustomPracticeState,
 *   _syncCustomPracticeSelectionUi, _toggleCustomPracticeTopic, _updateCustomQuestionCountUI,
 *   _customPracticeActive, _focusModeActive, _adaptiveModeActive,
 *   _customPracticeState, _customPracticeDom, selectedTopics, showToast,
 *   _focusSelectedCategory, _focusSelectedCategoryLabel,
 *   _tryPracticeAction, _CUSTOM_DEFAULT_QUESTIONS, _CUSTOM_MIN_QUESTIONS, _CUSTOM_MAX_QUESTIONS
 */

/* ---- Practice drill starter ---- */
/* Mixed Aptitude (ADR-076, Phase 4): a balanced cross-subject sprint — the clearest "one platform" practice. Picks a
   fresh random spread each launch (Quant-heavy, mirroring a real sectional test). Falls back to null (→ Quant random)
   if the subject layer isn't present. */
function _mixedAptitudeTopics() {
  if (typeof QR_SUBJECTS === 'undefined') return null;
  function _shuf(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function _take(sid, n) { try { return _shuf(QR_SUBJECTS.subjectToCategories(sid)).slice(0, n); } catch (_) { return []; } }
  var t = [].concat(_take('quant', 4), _take('di', 2), _take('lr', 2));
  return t.length ? t : null;
}

/* ADR-080: resolve a chosen subject id to a topic pool + human label, then launch the Quick-Start session scoped to
   it. 'mixed' reuses the balanced cross-subject pool; a missing/unknown subject (or absent subject layer) falls back
   to Quant-default behaviour (no topics → the engine's Quant random), so nothing breaks. */
function _subjectScope(subjectId) {
  if (typeof QR_SUBJECTS === 'undefined') return { topics: null, label: null };
  if (subjectId === 'mixed') return { topics: _mixedAptitudeTopics(), label: 'Mixed' };
  try {
    var cats = QR_SUBJECTS.subjectToCategories(subjectId) || [];
    return { topics: cats.length ? cats : null, label: QR_SUBJECTS.label(subjectId) || null };
  } catch (_) { return { topics: null, label: null }; }
}

function _startQuickWithSubject(modeKey, subjectId) {
  var s = _subjectScope(subjectId);
  startDrillFromPractice(modeKey, null, null, { topics: s.topics, subjectLabel: s.label });
}

function _launchQuickStart(modeKey) {
  /* If the user can't practise right now (free daily limit reached), don't tease the subject picker — go straight to
     startDrillFromPractice, which surfaces the limit banner + paywall. */
  if (typeof hasReachedDailyLimit === 'function' && hasReachedDailyLimit()) { startDrillFromPractice(modeKey); return; }
  /* Honour the saved preference: if the user turned the prompt off, launch straight into the remembered subject. */
  if (typeof PracticeSubjectModal !== 'undefined' && PracticeSubjectModal.shouldAsk && PracticeSubjectModal.shouldAsk()) {
    PracticeSubjectModal.open(function (subjectId) { _startQuickWithSubject(modeKey, subjectId); });
  } else {
    var last = (typeof PracticeSubjectModal !== 'undefined' && PracticeSubjectModal.lastSubject) ? PracticeSubjectModal.lastSubject() : 'quant';
    _startQuickWithSubject(modeKey, last || 'quant');
  }
}

function startDrillFromPractice(modeKey, category, categoryLabel, opts) {
  opts = opts || {};
  if (modeKey !== 'custom') _customPracticeActive = false;
  if (modeKey === 'custom' && !canAccessFeature('custom_training')) {
    showPaywall('custom_training');
    return;
  }
  if (modeKey === 'review' && !canAccessFeature('review_mistakes')) {
    showPaywall('review_mistakes');
    return;
  }
  /* ADR-109: Mixed Aptitude is Premium. Head gate here (PREM-5 pattern) — not only the card UI — so the companion-ui
     deepLink path (server-supplied `mode`) and any future direct caller can't bypass it. Fail-closed: if the
     entitlement API is unavailable, deny. requirePremium() opens the paywall + records telemetry. */
  if (modeKey === 'mixed' && !(typeof requirePremium === 'function' && requirePremium('mixed_aptitude'))) {
    return;
  }
  /* Secondary explicit guard against console UI bypass for premium modes */
  if (modeKey === 'custom' || modeKey === 'review') {
    var isPrem = (typeof hasPremiumAccess === 'function') ? hasPremiumAccess() : false;
    if (!isPrem) {
      showPaywall('premium_required');
      return;
    }
  }
  if (typeof hasReachedDailyLimit === 'function' && hasReachedDailyLimit()) {
    var modeSelectEl = document.getElementById('modeSelect');
    if (modeSelectEl) {
      var existingBanner = document.querySelector('.daily-limit-banner');
      if (!existingBanner) {
        /* ADR-095: source the number from the single limit definition (not a hardcoded "20") and bind via
           addEventListener rather than an inline onclick (CSP-friendly, consistent with the rest of the app). */
        var _freeLimit = (typeof getDailyQuestionLimit === 'function' && isFinite(getDailyQuestionLimit())) ? getDailyQuestionLimit() : 20;
        var banner = document.createElement('div');
        banner.className = 'daily-limit-banner';
        banner.innerHTML = QRI18n.t('practice.dailyLimitBanner', { count: _freeLimit }) +
          '<br><button class="btn-primary" type="button">' + QRI18n.t('practice.upgradeNow') + '</button>';
        var _upBtn = banner.querySelector('button');
        if (_upBtn) _upBtn.addEventListener('click', function () { showPaywall('daily_limit'); });
        modeSelectEl.parentNode.insertBefore(banner, modeSelectEl);
      }
    }
    showPaywall('daily_limit');   /* ADR-107: the accurate daily-cap context, not the generic 'settings' hero */
    return;
  }
  var modeSelect = document.getElementById('modeSelect');
  var categorySelect = document.getElementById('categorySelect');
  var customPracticeConfig = document.getElementById('customPracticeConfig');
  var drillContainer = document.getElementById('drillContainer');
  if (!modeSelect || !categorySelect || !drillContainer) return;

  var timerCfg = _getTimerConfig();
  var _canAdaptive = (typeof canAccessFeature === 'function') ? canAccessFeature('adaptive_training') : false;
  var _useAdaptive = _adaptiveModeActive && _canAdaptive && (modeKey === 'focus' || modeKey === 'custom');

  var modes = {
    quick:  { count: 5,  timeLimitSec: null, perQuestionSec: null, category: null, mode: '⚡ ' + QRI18n.t('practice.quickDrill') },
    reflex: { count: 10, timeLimitSec: null, perQuestionSec: 15,   category: null, mode: '🧠 ' + QRI18n.t('practice.reflexDrill'), autoAdvance: true },
    timed:  { count: 10, timeLimitSec: 180,  perQuestionSec: null, category: null, mode: '⏱ ' + QRI18n.t('practice.timedTest') },
    focus:  { count: 10, timeLimitSec: timerCfg.timeLimitSec, perQuestionSec: timerCfg.perQuestionSec, category: null, mode: '🎯 ' + (_useAdaptive ? QRI18n.t('practice.focusAdaptive') : QRI18n.t('practice.focusTraining')), adaptive: _useAdaptive },
    custom: { count: _customPracticeState.totalQuestions, timeLimitSec: timerCfg.timeLimitSec, perQuestionSec: timerCfg.perQuestionSec, category: null, topics: selectedTopics.slice(), mode: '📑 ' + (_useAdaptive ? QRI18n.t('practice.customAdaptive') : QRI18n.t('practice.customTraining')), adaptive: _useAdaptive },
    review: { count: 10, timeLimitSec: null, perQuestionSec: null, category: null, mode: '🔄 ' + QRI18n.t('practice.reviewMistakes'), reviewMode: true },
    mixed:  { count: 12, timeLimitSec: null, perQuestionSec: null, category: null, topics: _mixedAptitudeTopics(), mode: '🎨 ' + QRI18n.t('practice.mixedAptitude') }
  };

  /* The AI companion deep-links with SERVER-supplied mode strings (js/companion-ui.js deepLink →
     mission cards and ⚡ chips). It emits exactly two: 'focus', a category drill, which is a key above;
     and 'practice', a general session with no category, which was NOT — so it reached the `|| modes.quick`
     default and ran a 5-question Quick Drill. That is the correct session for it, but it was correct by
     accident: the default meant "practice" and "typo" alike, so a mode key that was genuinely wrong was
     indistinguishable from one that was merely undeclared, and neither was visible.
     Declaring the alias changes no behaviour for any input the server sends today; it just leaves the
     default meaning only what it says — an unrecognised key — which is now logged instead of silently
     becoming a Quick Drill. Still FALLS BACK rather than refusing: a dead CTA is worse than a small
     session, and the premium/quota gates at the head of this function have already run regardless. */
  var MODE_ALIASES = { practice: 'quick' };
  var resolvedKey = MODE_ALIASES[modeKey] || modeKey;
  if (!Object.prototype.hasOwnProperty.call(modes, resolvedKey)) {
    console.warn('[Practice] unrecognised mode key "' + modeKey + '" — running Quick Drill');
  }
  var config = Object.assign({}, modes[resolvedKey] || modes.quick);

  /* ADR-167 — THE ADR-151 PROMISE APPLIES TO EVERY MODE, NOT JUST SETS.
     "Don't advertise questions the allowance can't cover" was implemented for DI/Reasoning sets
     (ADR-151) and extended to session review (ADR-155), but the six modes in the table above still took
     their `count` verbatim. A free user with 2 questions left tapped Reflex Drill, read "10 Questions"
     on the start screen, and was stopped by the quota panel after 2 — the engine gate is correct, the
     NUMBER was the lie.
     Premium is never clamped (_questionsLeftToday returns Infinity), and the floor of 1 in that helper
     means a clamp can never produce an empty deck, which the engine would treat as a generation
     failure. The hard gate above (hasReachedDailyLimit) still runs first and is unaffected: this only
     makes the promise on the start screen the truth. */
  var _dpPremium = (typeof hasPremiumAccess === 'function') ? hasPremiumAccess() : false;
  var _dpLeft = _questionsLeftToday(_dpPremium);
  if (isFinite(_dpLeft) && typeof config.count === 'number' && config.count > _dpLeft) {
    config.count = _dpLeft;
  }

  /* ADR-170 — REVIEW MISTAKES IS BOUNDED BY THE ARCHIVE, NOT ONLY BY THE ALLOWANCE.
     ADR-151/155/167 established that the start screen must not promise questions the session cannot
     deliver, but every one of those clamps measured the DAILY ALLOWANCE. Review Mistakes has a second,
     independent ceiling: the number of distinct reviewable records in the archive. `count: 10` was
     taken verbatim, so a premium user with four reviewable mistakes read "10 Questions" and answered
     four — measured in a browser, promised 10 / delivered 4.
     `countReviewableMistakes()` applies the SAME filter and qkey dedupe the deck builder uses, so the
     number on the screen and the deck behind it cannot disagree.
     The floor of 1 matters: an empty archive must keep today's behaviour (the engine's own
     empty-deck path) rather than becoming a zero-count config, which the engine reads as a generation
     failure — so this can only ever make an over-promise honest, never create a new failure mode. */
  if (modeKey === 'review' && typeof countReviewableMistakes === 'function') {
    var _revMax = countReviewableMistakes();
    if (typeof config.count === 'number' && _revMax > 0 && config.count > _revMax) {
      config.count = Math.max(1, _revMax);
    }
  }

  if (category) {
    config.category = category;
    config.mode = '🎯 ' + (categoryLabel || category);
  }
  /* ADR-080: a Quick-Start session can be scoped to a chosen SUBJECT (Quant / DI / LR / Mixed) via the
     subject-selection modal — pass its categories as `topics` so the quick/reflex/timed pool draws from that subject
     instead of defaulting to Quant. The mode label gets a subject suffix so the drill header reads honestly. */
  if (opts.topics && opts.topics.length && !category) {
    config.topics = opts.topics.slice();
    if (opts.subjectLabel) config.mode = config.mode + ' · ' + opts.subjectLabel;
  }
  /* ADR-091: the habitual path costs one tap — the Home warmup goes straight to Question 1 (the
     interstitial shows the same four facts every day; it stays for Practice-tab launches, where the
     mode choice is a real decision). Same engine opt startSessionReview already uses. */
  if (opts.skipStartScreen === true) config.skipStartScreen = true;

  config.onFinish = function (view) {
    try {
      if (typeof QRDiagnostic !== 'undefined') {
        QRDiagnostic.log('PRACTICE', 'config.onFinish', 'enter', { view: view });
      }
    } catch (_) {}
    _disposeActiveDrillSession();
    if (view === 'practice') {
      _resetPracticeUiToModes();
    }
    Router.showView(view);
  };

  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('PRACTICE', 'startDrillFromPractice', 'dom_switch_to_drill', {
        modeKey: opts.modeKey,
        drillContainerDisplayBefore: drillContainer.style.display,
        modeSelectDisplayBefore: modeSelect.style.display
      });
    }
  } catch (_) {}
  modeSelect.style.display = 'none';
  categorySelect.style.display = 'none';
  if (customPracticeConfig) customPracticeConfig.style.display = 'none';
  drillContainer.style.display = 'block';

  if (typeof AdaptiveState !== 'undefined') {
    AdaptiveState.setPattern(null);
  } else {
    window._sessionAdaptivePattern = null;
  }
  _startPracticeEngine(drillContainer, config);
}

/* ---- Sectional-timer mock (Phase D): a timed quant-section simulation of the chosen exam ----
 * Builds a weightage-true deck from the exam's drillable topics and runs it under the exam's real
 * section clock + marking scheme. Reuses the proven drill engine via _preloadedQuestions. */
function startMockFromPractice(examId) {
  if (typeof QR_MOCK === 'undefined' || typeof generateQuestions !== 'function') return;
  /* Defensive entitlement gate (PREM-5, ADR-107): Timed Mock is Premium-only. The card handler checks this before
     calling, but keeping the gate at the launcher head means ANY future caller (deep link, retry, test) is safe —
     the entitlement is enforced in one authoritative place, not only at the UI entry point. Premium users have an
     Infinity daily limit, so the 20/day cap never blocks a mock. */
  if (typeof canAccessFeature !== 'function' || !canAccessFeature('timed_mocks')) {
    if (typeof showPaywall === 'function') showPaywall('timed_mocks');
    return;
  }
  if (typeof hasPremiumAccess === 'function' && !hasPremiumAccess()) {
    if (typeof showPaywall === 'function') showPaywall('premium_required');
    return;
  }
  var built = QR_MOCK.buildMockDeck(examId, function (cat, n) { return generateQuestions(n || 1, cat); });
  if (!built || !built.deck || !built.deck.length) {
    if (typeof showToast === 'function') showToast(QRI18n.t('practice.mockUnavailable'));
    return;
  }
  var mock = built.mock;
  var drillContainer = document.getElementById('drillContainer');
  var modeSelect = document.getElementById('modeSelect');
  var categorySelect = document.getElementById('categorySelect');
  var customPracticeConfig = document.getElementById('customPracticeConfig');
  if (!drillContainer) return;

  var config = {
    count: mock.totalQuestions,
    timeLimitSec: mock.durationSec,     // the single section clock — auto-submits on zero (engine behaviour)
    perQuestionSec: null,
    category: null,
    mode: '📝 ' + QRI18n.t('practice.mockSuffix', { exam: mock.examName }),
    _preloadedQuestions: built.deck,
    /* Inject the EXAM-ACCURATE score (its own marking scheme) into the results card when it renders — this is
       what makes the mock a "real marking scheme" test rather than a plain drill. (Raw attempts are persisted
       by the drill engine via savePracticeSession; feeding the planner's mock-trend is a server-side follow-up.) */
    onResults: function (summary, container) {
      if (!summary || typeof QR_MOCK === 'undefined' || !container) return;
      var scored = QR_MOCK.score(mock, { correct: summary.correct, attempted: summary.attempted }, { elapsedSec: summary.totalTimeSec });
      var negNote = mock.negPerWrong ? QRI18n.t('practice.perWrong', { n: mock.negPerWrong }) : QRI18n.t('practice.noNegative');
      var el = document.createElement('div');
      el.className = 'mock-score-summary';
      el.setAttribute('style', 'margin:0 0 14px;padding:12px 14px;border-radius:12px;background:rgba(0,0,0,0.05);text-align:center;');
      el.innerHTML = '<h3 style="margin:0 0 4px;">' + QRI18n.t('practice.mockScoreHead', { exam: mock.examName }) + '</h3>' +
        '<p style="margin:0;font-size:1.4em;"><strong>' + scored.score + ' / ' + scored.maxScore + '</strong>' + negNote + '</p>' +
        '<p style="margin:6px 0 0;opacity:0.8;">' + QRI18n.t('practice.mockAttemptLine', { a: scored.attempted, t: mock.totalQuestions, c: scored.correct, w: scored.wrong, s: scored.skipped }) + '</p>' +
        (scored.secPerQ ? '<p style="margin:4px 0 0;opacity:0.8;">' + QRI18n.t('practice.paceLine', { p: scored.secPerQ, b: mock.secondsPerQuestion }) + '</p>' : '');
      var card = container.querySelector('.card');
      if (card) card.insertBefore(el, card.firstChild); else container.appendChild(el);
    },
    onFinish: function (view) {
      _disposeActiveDrillSession();
      if (view === 'practice') _resetPracticeUiToModes();
      Router.showView(view);
    }
  };

  if (modeSelect) modeSelect.style.display = 'none';
  if (categorySelect) categorySelect.style.display = 'none';
  if (customPracticeConfig) customPracticeConfig.style.display = 'none';
  drillContainer.style.display = 'block';
  if (typeof AdaptiveState !== 'undefined') AdaptiveState.setPattern(null); else window._sessionAdaptivePattern = null;
  _startPracticeEngine(drillContainer, config);
}

/* ---- Session review launcher: replay THIS session's missed questions from memory ---- */
/* Free for everyone by design — the wrong question objects (chart/figure specs intact) are still in
   memory when the results card offers "Review these N now", so no persistence and no premium-archive
   giveaway. The cross-session Review Mistakes mode stays premium. Skips the pre-session start screen:
   the user committed by tapping the action. */
function startSessionReview(wrongQuestions) {
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('PRACTICE', 'startSessionReview', 'called', {
        questionCount: Array.isArray(wrongQuestions) ? wrongQuestions.length : 0
      });
    }
  } catch (_) {}
  if (!Array.isArray(wrongQuestions) || !wrongQuestions.length) return;
  if (typeof hasReachedDailyLimit === 'function' && hasReachedDailyLimit()) { showPaywall('daily_limit'); return; }
  var drillContainer = document.getElementById('drillContainer');
  if (!drillContainer) return;

  /* ADR-155 — the ADR-151 "don't promise questions the allowance can't cover" rule applies HERE too.
     Review-these-N-now is offered straight off the results card, at the exact moment a free user is most likely
     to be near the 20/day cap: they just spent a whole session getting there. With 2 questions left, a 6-wrong
     session offered "Review these 6 now" and then stopped them dead after 2. The engine's gate is still the
     enforcement point — this only makes the number on the button the truth. */
  var _srPremium = (typeof hasPremiumAccess === 'function') ? hasPremiumAccess() : false;
  var _srLeft = _questionsLeftToday(_srPremium);
  if (isFinite(_srLeft) && wrongQuestions.length > _srLeft) wrongQuestions = wrongQuestions.slice(0, _srLeft);

  var config = {
    count: wrongQuestions.length,
    timeLimitSec: null, perQuestionSec: null, category: null,
    _preloadedQuestions: wrongQuestions,
    skipStartScreen: true,
    mode: '🔄 ' + QRI18n.t('practice.sessionReview'),
    onFinish: function (view) {
      _disposeActiveDrillSession();
      if (view === 'practice') _resetPracticeUiToModes();
      Router.showView(view);
    }
  };

  drillContainer.classList.remove('drill-results-active');
  drillContainer.style.display = 'block';
  if (typeof AdaptiveState !== 'undefined') AdaptiveState.setPattern(null); else window._sessionAdaptivePattern = null;
  _startPracticeEngine(drillContainer, config);
}

/* How many NEW DI (or Reasoning) sets a user gets per day — Infinity for premium. Single definition lives in
   js/paywall.js (FREE_DAILY_SETS_PER_KIND, exposed via getDailySetLimit) so the gates below and the Practice-tab
   quota card can never disagree about it (ADR-151). Falls back to 1 only if paywall.js somehow isn't loaded,
   which would already have failed every other gate on this screen. */
function _freeSetLimit() {
  return (typeof getDailySetLimit === 'function') ? getDailySetLimit() : 1;
}

/* ADR-151 — DON'T ADVERTISE QUESTIONS THE ALLOWANCE CAN'T COVER.
   A set's questions count against the same 20/day cap as everything else, and the engine already refuses to
   render question #21 (drill-engine.js → QuotaPolicy.shouldStopForDailyQuota → _renderQuotaReached). But the
   launch config took `set.questions.length` verbatim, so a free user with 2 questions left opened a set whose
   start screen promised 5 and then stopped them two questions in. Trim the deck to what they can actually
   finish so the promise on the start screen is the truth. Premium (limit === Infinity) is never trimmed.
   Returns a shallow copy — the generator's object is left alone. */
/* How many more questions this user can actually finish today, or Infinity when the cap does not apply.
   ADR-155 pulled this out of _clampSetToDailyAllowance so the SAME arithmetic backs every deck the app sizes,
   not just DI/Reasoning sets. Returns Infinity for premium, and for any state where the cap can't be evaluated —
   failing OPEN here is correct, because the engine's own per-question gate
   (QuotaPolicy.shouldStopForDailyQuota -> _renderQuotaReached) is the enforcement point. This function only
   decides what number to PROMISE on the start screen. */
function _questionsLeftToday(isPremium) {
  if (isPremium) return Infinity;
  if (typeof getDailyQuestionLimit !== 'function' || typeof loadProgress !== 'function') return Infinity;
  var limit = getDailyQuestionLimit();
  if (!isFinite(limit)) return Infinity;
  var used = parseInt((loadProgress() || {}).todayAttempted) || 0;
  /* >= 1 is guaranteed by the hasReachedDailyLimit() gate the callers run first; Math.max is belt-and-braces
     so a future caller can never produce an empty deck (which the engine would treat as a generation failure). */
  return Math.max(1, limit - used);
}

function _clampSetToDailyAllowance(set, isPremium) {
  if (isPremium || !set || !Array.isArray(set.questions)) return set;
  var remaining = _questionsLeftToday(isPremium);
  if (!isFinite(remaining)) return set;
  if (set.questions.length <= remaining) return set;
  var trimmed = {};
  for (var k in set) { if (Object.prototype.hasOwnProperty.call(set, k)) trimmed[k] = set[k]; }
  trimmed.questions = set.questions.slice(0, remaining);
  return trimmed;
}

/* ---- DI Set launcher (ADR-078): one shared chart + linked questions, served by the same drill engine ---- */
function startDiSet(category) {
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('PRACTICE', 'startDiSet', 'called', { category: category || null });
    }
  } catch (_) {}
  if (typeof DISetEngine === 'undefined' || !DISetEngine.generateSet) {
    /* engine not loaded → degrade gracefully to a normal DI focus drill */
    return startDrillFromPractice('focus', category || 'di-bar', 'Data Interpretation');
  }
  /* The 20/day question cap also applies at launch — a set's questions count toward it, so if the user is already
     out of daily questions, don't start a new one (ADR-107). */
  if (typeof hasReachedDailyLimit === 'function' && hasReachedDailyLimit()) { showPaywall('daily_limit'); return; }
  /* Per-day SET quota (ADR-107): free users get ONE new DI set per day; Premium is unlimited. Gated on the daily
     counter + hasPremiumAccess (NOT _LOCKED_FEATURES — this is a per-day quota, not an all-or-nothing lock). */
  var _isPremiumSet = (typeof hasPremiumAccess === 'function') ? hasPremiumAccess() : false;
  if (!_isPremiumSet && typeof getSetsStartedToday === 'function' && getSetsStartedToday('di') >= _freeSetLimit()) {
    if (typeof showPaywall === 'function') showPaywall('diset_limit');
    return;
  }
  var cats = ['di-bar', 'di-line', 'di-pie', 'di-table', 'di-caselet'];
  var cat = category || cats[Math.floor(Math.random() * cats.length)];
  var set = DISetEngine.generateSet(cat);
  if (!set || !set.questions || !set.questions.length) { if (typeof showToast === 'function') showToast(QRI18n.t('practice.diSetFailed')); return; }
  set = _clampSetToDailyAllowance(set, _isPremiumSet);

  var modeSelect = document.getElementById('modeSelect');
  var categorySelect = document.getElementById('categorySelect');
  var customPracticeConfig = document.getElementById('customPracticeConfig');
  var drillContainer = document.getElementById('drillContainer');
  if (!drillContainer) return;

  var label = (typeof DIEngine !== 'undefined' && DIEngine.label) ? DIEngine.label(set.category) : 'DI';
  var config = {
    count: set.questions.length,
    timeLimitSec: null, perQuestionSec: null, category: null,
    diSet: set,
    mode: '📊 ' + QRI18n.t('practice.setSuffix', { label: label }),
    /* ADR-151: the day's one free set is spent when the user actually STARTS it, not when they open the
       start screen to look at it. The engine fires this once, from begin(). */
    onStart: function () {
      if (!_isPremiumSet && typeof recordSetStarted === 'function') recordSetStarted('di');
    },
    onFinish: function (view) {
      _disposeActiveDrillSession();
      if (view === 'practice') _resetPracticeUiToModes();
      Router.showView(view);
    }
  };

  if (modeSelect) modeSelect.style.display = 'none';
  if (categorySelect) categorySelect.style.display = 'none';
  if (customPracticeConfig) customPracticeConfig.style.display = 'none';
  drillContainer.style.display = 'block';
  if (typeof AdaptiveState !== 'undefined') AdaptiveState.setPattern(null); else window._sessionAdaptivePattern = null;
  _startPracticeEngine(drillContainer, config);
}

/* ---- LR Set launcher (ADR-079): one shared seating/floor scenario + linked MCQs, served by the same set-mode ---- */
function startLrSet(category) {
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('PRACTICE', 'startLrSet', 'called', { category: category || null });
    }
  } catch (_) {}
  if (typeof LRSetEngine === 'undefined' || !LRSetEngine.generateSet) {
    return startDrillFromPractice('focus', category || 'lr-syllogism', 'Logical Reasoning');
  }
  /* The 20/day question cap also applies at launch (ADR-107) — a set's questions count toward it. */
  if (typeof hasReachedDailyLimit === 'function' && hasReachedDailyLimit()) { showPaywall('daily_limit'); return; }
  /* Per-day SET quota (ADR-107): free users get ONE new Reasoning set per day; Premium unlimited. */
  var _isPremiumSet = (typeof hasPremiumAccess === 'function') ? hasPremiumAccess() : false;
  if (!_isPremiumSet && typeof getSetsStartedToday === 'function' && getSetsStartedToday('lr') >= _freeSetLimit()) {
    if (typeof showPaywall === 'function') showPaywall('lrset_limit');
    return;
  }
  var cats = ['lr-seating', 'lr-puzzle'];
  var cat = category || cats[Math.floor(Math.random() * cats.length)];
  var set = LRSetEngine.generateSet(cat);
  if (!set || !set.questions || !set.questions.length) { if (typeof showToast === 'function') showToast(QRI18n.t('practice.lrSetFailed')); return; }
  set = _clampSetToDailyAllowance(set, _isPremiumSet);

  var modeSelect = document.getElementById('modeSelect');
  var categorySelect = document.getElementById('categorySelect');
  var customPracticeConfig = document.getElementById('customPracticeConfig');
  var drillContainer = document.getElementById('drillContainer');
  if (!drillContainer) return;

  var label = (cat === 'lr-puzzle') ? QRI18n.t('practice.puzzleShort') : QRI18n.t('practice.seatingShort');
  var config = {
    count: set.questions.length,
    timeLimitSec: null, perQuestionSec: null, category: null,
    diSet: set,
    mode: '🧩 ' + QRI18n.t('practice.setSuffix', { label: label }),
    /* ADR-151: charged from the engine's begin(), not from this launcher — see startDiSet. */
    onStart: function () {
      if (!_isPremiumSet && typeof recordSetStarted === 'function') recordSetStarted('lr');
    },
    onFinish: function (view) {
      _disposeActiveDrillSession();
      if (view === 'practice') _resetPracticeUiToModes();
      Router.showView(view);
    }
  };

  if (modeSelect) modeSelect.style.display = 'none';
  if (categorySelect) categorySelect.style.display = 'none';
  if (customPracticeConfig) customPracticeConfig.style.display = 'none';
  drillContainer.style.display = 'block';
  if (typeof AdaptiveState !== 'undefined') AdaptiveState.setPattern(null); else window._sessionAdaptivePattern = null;
  _startPracticeEngine(drillContainer, config);
}

function _startPracticeEngine(drillContainer, config) {
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('PRACTICE', '_startPracticeEngine', 'instantiating', {
        previousEngineExists: !!_activeDrillEngine,
        mode: config && config.mode
      });
    }
  } catch (_) {}
  if (_activeDrillEngine) {
    _activeDrillEngine.cleanup();
  }
  var engine = createDrillEngine(drillContainer, config);
  _activeDrillEngine = engine;
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('ENGINE', '_startPracticeEngine', 'engine_assigned');
    }
  } catch (_) {}
  engine.start();
}

/* ---- Free-tier daily allowance card (renders #dailyQuotaIndicator, which lives in the Practice view) ----
   Moved here from js/views/home-view.js (ADR-151): Router.onShow('practice') is its only caller and the markup
   is inside the practice mode list, so it belongs with the controller that owns both.

   ADR-151 SUPERSEDES ADR-091's cold-start rule here. ADR-091 hid the card until the first question of the day
   so a fresh user was never greeted with "0/20". In practice that meant a free user could not see what their
   allowance WAS until they had already spent some of it, and the three free limits (20 questions, 1 DI set,
   1 Reasoning set) were never visible together anywhere. The Practice tab is where the user decides what to
   spend the allowance on, so the card now shows from 0 and reports all three. Premium sees nothing. */
function _renderDailyQuota(progress) {
  var container = document.getElementById('dailyQuotaIndicator');
  if (!container) return;
  container.innerHTML = '';
  container.style.display = 'none';

  if (typeof getDailyQuestionLimit !== 'function') return;
  var limit = getDailyQuestionLimit();
  if (!isFinite(limit)) return;   /* Premium — no cap, no card */

  var p = progress || {};
  var used = Math.max(0, parseInt(p.todayAttempted) || 0);
  var remaining = Math.max(0, limit - used);
  var pct = Math.min(100, Math.round((used / limit) * 100));

  var setLimit = (typeof getDailySetLimit === 'function') ? getDailySetLimit() : 1;
  var diUsed = Math.min(setLimit, Math.max(0, parseInt(p.diSetsToday) || 0));
  var lrUsed = Math.min(setLimit, Math.max(0, parseInt(p.lrSetsToday) || 0));

  /* Every interpolated value below is either an integer computed here or a string from our own locale
     bundle — same trust model as the rest of this file's template literals. No user input reaches it. */
  function _setChip(labelKey, u) {
    return '<span class="quota-set' + (u >= setLimit ? ' quota-set-spent' : '') + '">' +
      QRI18n.t(labelKey) + ' ' + u + '/' + setLimit + '</span>';
  }

  container.style.display = '';
  container.innerHTML =
    '<div class="daily-quota-card">' +
      '<div class="quota-header">' +
        '<span class="quota-label">' + QRI18n.t('home.dailyQuestions') + '</span>' +
        '<span class="quota-count">' + used + ' / ' + limit + '</span>' +
      '</div>' +
      '<div class="quota-bar">' +
        '<div class="quota-fill' + (pct >= 100 ? ' quota-full' : '') + '" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<div class="quota-sets">' + _setChip('practice.quotaDiSet', diUsed) + _setChip('practice.quotaLrSet', lrUsed) + '</div>' +
      (remaining <= 5 && remaining > 0
        ? '<span class="quota-warning">' + QRI18n.t('home.questionsRemaining', { count: remaining }) + '</span>'
        : '') +
      (remaining === 0
        ? '<span class="quota-warning">' + QRI18n.t('home.dailyLimitReached') + ' <a href="#" class="quota-upgrade-link" id="quotaUpgradeLink">' + QRI18n.t('home.upgradeForUnlimited') + '</a></span>'
        : '') +
    '</div>';

  var upgradeLink = container.querySelector('#quotaUpgradeLink');
  if (upgradeLink) {
    upgradeLink.addEventListener('click', function (e) {
      e.preventDefault();
      if (typeof showPaywall === 'function') showPaywall('daily_limit');
    });
  }
}

/**
 * Initialize practice view — register Router callbacks.
 * Called once from app.js DOMContentLoaded.
 */
function initPracticeView() {
  Router.onShow('practice', function () {
    try {
      if (typeof QRDiagnostic !== 'undefined') {
        QRDiagnostic.log('PRACTICE', 'Router.onShow(practice)', 'start');
      }
    } catch (_) {}
    _disposeActiveDrillSession();

    /* Daily quota indicator (free users only) */
    if (typeof _renderDailyQuota === 'function') {
      _renderDailyQuota((typeof loadProgress === 'function') ? loadProgress() : {});
    }

    _resetPracticeUiToModes();
    try {
      if (typeof QRDiagnostic !== 'undefined') {
        QRDiagnostic.log('PRACTICE', 'Router.onShow(practice)', 'completed');
      }
    } catch (_) {}
  });

  Router.onInit('practice', function () {
    var modeSelect = document.getElementById('modeSelect');
    var categorySelect = document.getElementById('categorySelect');
    var customPracticeConfig = document.getElementById('customPracticeConfig');
    var drillContainer = document.getElementById('drillContainer');
    var customSlider = document.getElementById('customQuestionCount');
    var customStartBtn = document.getElementById('startCustomSessionBtn');
    _customPracticeDom.slider = customSlider;
    _customPracticeDom.value = document.getElementById('customQuestionCountValue');
    _customPracticeDom.text = document.getElementById('customQuestionCountText');
    _customPracticeDom.error = document.getElementById('customModeError');
    if (!modeSelect || !categorySelect || !drillContainer) return;

    var modeCards = modeSelect.querySelectorAll('.mode-card');
    for (var i = 0; i < modeCards.length; i++) {
      modeCards[i].addEventListener('click', function () {
        var modeKey = this.getAttribute('data-mode');
        try {
          if (typeof QRDiagnostic !== 'undefined') {
            QRDiagnostic.log('PRACTICE', 'mode_card_click', 'clicked', { modeKey: modeKey });
          }
        } catch (_) {}
        if (!_tryPracticeAction()) return;
        SoundEngine.play('settingsToggle');
        if (modeKey === 'custom') {
          if (!canAccessFeature('custom_training')) { showPaywall('custom_training'); return; }
          _customPracticeActive = true;
          _focusModeActive = false;
          modeSelect.style.display = 'none';
          categorySelect.style.display = 'flex';
          if (customPracticeConfig) customPracticeConfig.style.display = 'block';
          var focusStartSec2 = document.getElementById('focusStartSection');
          if (focusStartSec2) focusStartSec2.style.display = 'none';
          var catTitle2 = document.getElementById('categorySelectTitle');
          if (catTitle2) catTitle2.textContent = QRI18n.t('practice.customTraining');
          _resetTimerSelection();
          _resetAdaptiveToggle();
          _resetCustomPracticeState();
          if (typeof CategoryPicker !== 'undefined') CategoryPicker.render();   /* ADR-084: dynamic picker from source of truth */
          _syncCustomPracticeSelectionUi();
          return;
        }
        if (modeKey === 'mock') {
          /* Timed Mock is Premium-only (entitlement: timed_mocks), mirroring the custom/review gate. */
          if (!canAccessFeature('timed_mocks')) { showPaywall('timed_mocks'); return; }
          var _isPremMock = (typeof hasPremiumAccess === 'function') ? hasPremiumAccess() : false;
          if (!_isPremMock) { showPaywall('premium_required'); return; }
          var _mockExam = '';
          try { _mockExam = (typeof TargetExam !== 'undefined' && TargetExam.get()) || ''; } catch (_) {}
          if (!_mockExam) {
            if (typeof showToast === 'function') showToast(QRI18n.t('practice.setTargetExam'));
            if (typeof Router !== 'undefined') { try { Router.showView('settings'); } catch (_) {} }
            return;
          }
          _customPracticeActive = false;
          _focusModeActive = false;
          startMockFromPractice(_mockExam);
          return;
        }
        if (modeKey === 'diset') {
          _customPracticeActive = false;
          _focusModeActive = false;
          startDiSet();
          return;
        }
        if (modeKey === 'lrset') {
          _customPracticeActive = false;
          _focusModeActive = false;
          startLrSet();
          return;
        }
        _customPracticeActive = false;
        if (modeKey === 'focus') {
          _focusModeActive = true;
          _focusSelectedCategory = null;
          _focusSelectedCategoryLabel = null;
          modeSelect.style.display = 'none';
          categorySelect.style.display = 'flex';
          var focusStartSec = document.getElementById('focusStartSection');
          if (focusStartSec) focusStartSec.style.display = 'none';
          var catTitle = document.getElementById('categorySelectTitle');
          if (catTitle) catTitle.textContent = QRI18n.t('practice.focusTraining');
          _resetTimerSelection();
          _resetAdaptiveToggle();
          if (typeof CategoryPicker !== 'undefined') CategoryPicker.render();   /* ADR-084: dynamic picker from source of truth */
          _syncCustomPracticeSelectionUi();
        } else if (modeKey === 'review') {
          if (!canAccessFeature('review_mistakes')) { showPaywall('review_mistakes'); return; }
          startDrillFromPractice('review');
        } else if (modeKey === 'mixed') {
          /* ADR-109: Mixed Aptitude is Premium. Gate at the card (paywall) — startDrillFromPractice re-checks. */
          if (typeof requirePremium === 'function' ? !requirePremium('mixed_aptitude') : true) return;
          startDrillFromPractice('mixed');
        } else if (modeKey === 'quick' || modeKey === 'reflex' || modeKey === 'timed') {
          /* ADR-080: ask which subject first (unless the user opted out) — then launch the session scoped to it. */
          _launchQuickStart(modeKey);
        } else {
          startDrillFromPractice(modeKey);
        }
      });
    }

    var catBtns = categorySelect.querySelectorAll('.category-btn');
    _customPracticeDom.catBtns = catBtns;
    categorySelect.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.classList || !target.classList.contains('category-btn')) return;
      if (!_tryPracticeAction()) return;
      SoundEngine.play('settingsToggle');
      var cat = target.getAttribute('data-cat');
      if (!cat) return;
      if (_customPracticeActive) {
        _toggleCustomPracticeTopic(cat);
        _syncCustomPracticeSelectionUi();
        if (_customPracticeDom.error) _customPracticeDom.error.textContent = '';
        return;
      }
      if (_focusModeActive) {
        var allCatBtns = categorySelect.querySelectorAll('.category-btn');
        for (var cb = 0; cb < allCatBtns.length; cb++) allCatBtns[cb].classList.remove('selected');
        target.classList.add('selected');
        _focusSelectedCategory = cat;
        /* Prefer the explicit data-label (ADR-084) so decorations inside the button — e.g. a pin star — never leak
           into the drill's category label. */
        _focusSelectedCategoryLabel = target.getAttribute('data-label') || target.textContent;
        var focusStartSec = document.getElementById('focusStartSection');
        if (focusStartSec) focusStartSec.style.display = 'block';
        if (typeof CategoryPicker !== 'undefined' && CategoryPicker.noteRecent) CategoryPicker.noteRecent(cat);
        return;
      }
      if (typeof CategoryPicker !== 'undefined' && CategoryPicker.noteRecent) CategoryPicker.noteRecent(cat);
      startDrillFromPractice('focus', cat, target.getAttribute('data-label') || target.textContent);
    });

    var focusStartBtn = document.getElementById('startFocusSessionBtn');
    if (focusStartBtn) {
      focusStartBtn.addEventListener('click', function () {
        if (!_tryPracticeAction()) return;
        if (!_focusSelectedCategory) { showToast(QRI18n.t('practice.selectCategoryFirst')); return; }
        startDrillFromPractice('focus', _focusSelectedCategory, _focusSelectedCategoryLabel);
      });
    }

    _initTimerControls();
    _initAdaptiveToggle();

    if (customSlider) {
      customSlider.addEventListener('input', function () {
        var val = parseInt(customSlider.value, 10);
        if (isNaN(val)) val = _CUSTOM_DEFAULT_QUESTIONS;
        _customPracticeState.totalQuestions = Math.max(_CUSTOM_MIN_QUESTIONS, Math.min(_CUSTOM_MAX_QUESTIONS, val));
        _updateCustomQuestionCountUI();
      });
    }

    if (customStartBtn) {
      customStartBtn.addEventListener('click', function () {
        if (!_tryPracticeAction()) return;
        if (!canAccessFeature('custom_training')) { showPaywall('custom_training'); return; }
        if (selectedTopics.length === 0) {
          if (_customPracticeDom.error) _customPracticeDom.error.textContent = QRI18n.t('practice.selectAtLeastOne');
          return;
        }
        startDrillFromPractice('custom');
      });
    }

    var backToModesBtn = document.getElementById('backToModes');
    if (backToModesBtn) {
      backToModesBtn.addEventListener('click', function () {
        _disposeActiveDrillSession();
        _resetPracticeUiToModes();
      });
    }
  });
}
