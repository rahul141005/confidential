/**
 * progress.js — localStorage-based progress tracking
 *
 * Stores:
 *   totalAttempted, totalCorrect, bestStreak, currentStreak,
 *   drillSessions, timedTestSessions, dailyStreak,
 *   lastPracticeDate, todayAttempted, todayCorrect,
 *   categoryStats (per-category attempted/correct),
 *   mistakes (wrong questions log),
 *   responseTimes (array of per-question times),
 *   dailyHistory (date → {attempted, correct})
 */

var PROGRESS_KEY = 'quant_reflex_progress';

/* Session-level cache: avoids repeated JSON.parse on every loadProgress() call.
   Invalidated on every saveProgress() write and on Firestore data load. */
var _progressCache = null;

/** Invalidate the progress cache. Called by FirestoreSync on data load. */
function invalidateProgressCache() { _progressCache = null; }

/** Return saved progress or defaults */
function loadProgress() {
  try {
    if (_progressCache) {
      /* ADR-109 cert fix: the cache must not outlive the DAY. Without this, a tab left open across local midnight
         never re-runs the day-change reset below (nothing invalidates the cache mid-session), so yesterday's
         todayAttempted/diSetsToday/lrSetsToday keep counting — wrongly limiting a genuine day-2 user and showing
         stale counts on Home/Stats. A null lastActiveDate (never practiced) keeps the fast path: the counters are
         already 0, so there is nothing to reset and no reason to re-parse storage on every call. */
      var _cachedDay = _progressCache.lastActiveDate;
      if (!_cachedDay || _cachedDay === new Date().toDateString()) return _progressCache;
      _progressCache = null;   /* crossed local midnight in a live tab — fall through to the reset path */
    }
    var data = (typeof AppState !== 'undefined') ? AppState.getProgress() : null;
    if (!data) {
      var raw = localStorage.getItem(PROGRESS_KEY);
      if (raw) data = JSON.parse(raw);
    }
    if (data) {
      /* Check if date has changed — reset today counters */
      var today = new Date().toDateString();
      if (data.lastActiveDate !== today) {
        try {
          if (typeof QRDiagnostic !== 'undefined') {
            QRDiagnostic.log('progress', 'loadProgress:date_rollover_reset', {
              oldDate: data.lastActiveDate,
              newDate: today,
              oldTodayAttempted: data.todayAttempted,
              oldTodayCorrect: data.todayCorrect
            });
          }
        } catch (_) {}
        /* Check daily streak continuity */
        if (data.lastActiveDate) {
          var last = new Date(data.lastActiveDate);
          var now = new Date(today);
          var diffDays = Math.round((now - last) / (1000 * 60 * 60 * 24));
          if (diffDays > 1) {
            data.dailyStreak = 0; /* streak broken */
          }
        }
        data.todayAttempted = 0;
        data.todayCorrect = 0;
        data.todayCats = {};   /* ADR-080: per-category counts for TODAY's subject split — reset with the day counters */
        data.diSetsToday = 0;  /* ADR-107: free users get 1 new DI set + 1 new Reasoning set per day — reset daily */
        data.lrSetsToday = 0;
        data.lastActiveDate = today;
        data.lastActiveMs = Date.now();   /* sortable last-active (ADR-029) — toDateString isn't query-safe */
        saveProgress(data);
      }
      /* Ensure required fields exist */
      if (!data.categoryStats) data.categoryStats = {};
      if (!data.mistakes) data.mistakes = [];
      if (!data.responseTimes) data.responseTimes = [];
      if (!data.dailyHistory) data.dailyHistory = {};
      /* Sanitize numeric fields — protect against NaN/undefined corruption */
      data.totalAttempted = parseInt(data.totalAttempted) || 0;
      data.totalCorrect = parseInt(data.totalCorrect) || 0;
      data.bestStreak = parseInt(data.bestStreak) || 0;
      data.currentStreak = parseInt(data.currentStreak) || 0;
      data.drillSessions = parseInt(data.drillSessions) || 0;
      data.timedTestSessions = parseInt(data.timedTestSessions) || 0;
      data.dailyStreak = parseInt(data.dailyStreak) || 0;
      data.bestDailyStreak = parseInt(data.bestDailyStreak) || 0;
      data.todayAttempted = parseInt(data.todayAttempted) || 0;
      data.todayCorrect = parseInt(data.todayCorrect) || 0;
      data.diSetsToday = parseInt(data.diSetsToday) || 0;   /* ADR-107 */
      data.lrSetsToday = parseInt(data.lrSetsToday) || 0;
      _progressCache = data;
      return data;
    }
  } catch (_) {
    /* ignore parse errors */
  }
  var defaults = {
    totalAttempted: 0, totalCorrect: 0,
    bestStreak: 0, currentStreak: 0,
    drillSessions: 0, timedTestSessions: 0,
    dailyStreak: 0, bestDailyStreak: 0,
    lastActiveDate: null,
    lastPracticeDate: null,
    todayAttempted: 0, todayCorrect: 0,
    diSetsToday: 0, lrSetsToday: 0,   /* ADR-107: per-day DI/LR set quota counters */
    categoryStats: {},
    mistakes: [],
    responseTimes: [],
    dailyHistory: {}
  };
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('progress', 'loadProgress:returning_defaults', {
        reason: 'no_stored_data_or_parse_failure'
      });
    }
  } catch (_) {}
  _progressCache = defaults;
  return defaults;
}

/** Persist progress to localStorage and sync to Firestore */
function saveProgress(data) {
  try {
    if (typeof QRDiagnostic !== 'undefined' && data) {
      QRDiagnostic.log('progress', 'saveProgress', {
        todayAttempted: data.todayAttempted,
        todayCorrect: data.todayCorrect,
        lastActiveDate: data.lastActiveDate,
        totalAttempted: data.totalAttempted
      });
    }
  } catch (_) {}
  _progressCache = data; /* Update cache so next loadProgress() is instant */
  try {
    if (typeof AppState !== 'undefined') {
      AppState.setProgress(data);
    } else {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
    }
    if (typeof FirestoreSync !== 'undefined') {
      FirestoreSync.syncStats(data);
    }
  } catch (e) {
    console.warn('Failed to save progress:', e);
  }
}

/**
 * Record the result of a single answer.
 * @param {boolean} correct
 * @param {string}  [category] - optional question category for tracking
 * @param {object}  [questionData] - optional {question, answer, category} for mistake tracking
 * @param {number}  [responseTime] - optional response time in seconds
 */
/* Resolve a question's difficulty tier ('easy'|'medium'|'hard') for the difficulty-mix counter. Prefer an explicit
   field, then a leading tier on the subtype (LR/DI use "easy:variant"), then the active difficulty setting. Returns
   null only if nothing is resolvable, so the counter never invents a tier. */
function _answerDifficulty(questionData) {
  var d = questionData && questionData.difficulty;
  if (d === 'easy' || d === 'medium' || d === 'hard') return d;
  var st = questionData && questionData.subtype;
  if (typeof st === 'string') { var m = st.match(/^(easy|medium|hard)\b/); if (m) return m[1]; }
  try { if (typeof window !== 'undefined' && typeof window._getDifficulty === 'function') { var g = window._getDifficulty(); if (g === 'easy' || g === 'medium' || g === 'hard') return g; } } catch (_) {}
  return 'medium';
}

function recordAnswer(correct, category, questionData, responseTime, meta) {
  var p = loadProgress();
  var today = new Date().toDateString();
  meta = meta || {};

  /* Daily streak: increment on first practice of a new day */
  if (p.lastPracticeDate !== today) {
    p.dailyStreak = (p.dailyStreak || 0) + 1;
    /* Track best daily streak ever achieved */
    if (p.dailyStreak > (p.bestDailyStreak || 0)) {
      p.bestDailyStreak = p.dailyStreak;
    }
    p.lastPracticeDate = today;
  }

  p.lastActiveDate = today;
  p.lastActiveMs = Date.now();   /* sortable last-active (ADR-029) — backs coaching roster order + the inactive-sweep range query that toDateString silently broke */
  p.totalAttempted++;
  p.todayAttempted = (p.todayAttempted || 0) + 1;
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('progress', 'recordAnswer:increment', {
        todayAttempted: p.todayAttempted,
        totalAttempted: p.totalAttempted,
        correct: !!correct
      });
    }
  } catch (_) {}

  if (correct) {
    p.totalCorrect++;
    p.todayCorrect = (p.todayCorrect || 0) + 1;
    p.currentStreak++;
    if (p.currentStreak > p.bestStreak) p.bestStreak = p.currentStreak;
  } else {
    p.currentStreak = 0;
    /* Track mistake (ADR-111 F-M8: the durable Mistake Archive). QRMistakeArchive.buildRecord captures a versioned,
       forward-compatible record that reproduces the attempt exactly — the fully-rendered question in its capture
       language (stem, options, explanation, AND the machine chart/figure/optionFigure specs, so DI + LR-visual are
       reviewable too) plus rich metadata (lang, selected, timing, hints, explanation-viewed, difficulty, engine,
       source, session type, timestamp). Backward-compatible: the record is a superset of the v1 shape. */
    if (questionData && typeof QRMistakeArchive !== 'undefined') {
      if (!p.mistakes) p.mistakes = [];
      /* ADR-155 — EVICT BY TIMESTAMP, NOT BY ARRAY POSITION.
         This used to be `p.mistakes.shift()`, which assumes the array is in ascending insertion order so that
         index 0 is the oldest. It is not. On every cold boot for a signed-in user, hydration replaces the array
         with the archive's canonical ordering — QRMistakeArchive.mergeMistakes -> _dedupeSortCap sorts
         DESCENDING by ts (js/mistake-archive.js), newest first. From that moment index 0 was the user's MOST
         RECENT mistake, and each new mistake past CAP=100 silently destroyed it. The one record a student most
         wants to review is the one the cap deleted, and it was gone from the server too on the next sync.
         Scanning for the minimum ts is correct under ascending, descending or unsorted order alike. */
      if (p.mistakes.length >= QRMistakeArchive.CAP) {
        var _oldestIdx = 0, _oldestTs = Number(p.mistakes[0] && p.mistakes[0].ts) || 0;
        for (var _mi = 1; _mi < p.mistakes.length; _mi++) {
          var _ts = Number(p.mistakes[_mi] && p.mistakes[_mi].ts) || 0;
          if (_ts < _oldestTs) { _oldestTs = _ts; _oldestIdx = _mi; }
        }
        p.mistakes.splice(_oldestIdx, 1);
      }
      p.mistakes.push(QRMistakeArchive.buildRecord(questionData, {
        category: questionData.category || category,
        ts: Date.now(),
        date: today,
        lang: _studyLangGuarded(),
        selected: meta.selected,
        timeMs: (typeof responseTime === 'number') ? responseTime : null,
        hintsUsed: meta.hintsUsed,
        explanationViewed: meta.explanationViewed,
        source: meta.source || 'drill',
        sessionType: meta.sessionType
      }));
    } else if (questionData) {
      /* Archive module absent (defensive) — fall back to the legacy v1 record so a mistake is never dropped. */
      if (!p.mistakes) p.mistakes = [];
      if (p.mistakes.length >= 100) p.mistakes.shift();
      var _reviewable = questionData.options && questionData.options.length && !questionData.chart && !questionData.figure;
      p.mistakes.push({ question: questionData.question, answer: String(questionData.answer), category: questionData.category || category, options: _reviewable ? questionData.options.slice() : null, explanation: questionData.explanation || null, subtype: questionData.subtype || null, date: today });
    }
  }

  /* Track response time */
  if (typeof responseTime === 'number') {
    if (!p.responseTimes) p.responseTimes = [];
    /* Keep last 200 response times */
    if (p.responseTimes.length >= 200) p.responseTimes.shift();
    p.responseTimes.push(responseTime);
  }

  /* Category tracking. Beyond attempted/correct we also accumulate per-category SOLVING TIME and the last-practiced
     timestamp (ADR-080) — these power the "X is 40% slower than Y" comparative insights, per-subject "last practiced",
     and the speed term of exam-readiness. All additive + guarded, so pre-ADR-080 saves (which lack the keys) upgrade
     transparently. */
  if (category) {
    if (!p.categoryStats) p.categoryStats = {};
    if (!p.categoryStats[category]) {
      p.categoryStats[category] = { attempted: 0, correct: 0 };
    }
    var _cs = p.categoryStats[category];
    _cs.attempted++;
    if (correct) _cs.correct++;
    if (typeof responseTime === 'number' && isFinite(responseTime)) {
      _cs.sumTime = (_cs.sumTime || 0) + responseTime;
      _cs.timedCount = (_cs.timedCount || 0) + 1;
    }
    _cs.lastTs = Date.now();
    /* today-only per-category tally (reset on day change in loadProgress) → today's subject split on Stats */
    if (!p.todayCats) p.todayCats = {};
    p.todayCats[category] = (p.todayCats[category] || 0) + 1;
  }

  /* Difficulty mix (ADR-080): how many questions the user has actually solved at each tier — a real input to
     exam-readiness (a wall of "easy" correct answers should not read as exam-ready). Difficulty is taken from the
     question's own subtype/difficulty, falling back to the active difficulty setting. */
  (function () {
    var d = _answerDifficulty(questionData);
    if (!d) return;
    if (!p.byDifficulty) p.byDifficulty = {};
    if (!p.byDifficulty[d]) p.byDifficulty[d] = { attempted: 0, correct: 0 };
    p.byDifficulty[d].attempted++;
    if (correct) p.byDifficulty[d].correct++;
  })();

  /* Daily history tracking */
  if (!p.dailyHistory) p.dailyHistory = {};
  if (!p.dailyHistory[today]) {
    p.dailyHistory[today] = { attempted: 0, correct: 0, sumTimes: 0, count: 0 };
  }
  p.dailyHistory[today].attempted++;
  if (correct) p.dailyHistory[today].correct++;
  /* Dated speed history (Analytics Foundation, ADR-027): accumulate per-day response time so the
     Coaching App can compute a REAL per-day avg solving speed (sumTimes / count). Backward-compatible —
     pre-ADR-027 day records lack these keys, so default to 0 before incrementing. */
  if (typeof responseTime === 'number' && isFinite(responseTime)) {
    p.dailyHistory[today].sumTimes = (p.dailyHistory[today].sumTimes || 0) + responseTime;
    p.dailyHistory[today].count = (p.dailyHistory[today].count || 0) + 1;
  }

  /* Cap dailyHistory to last 90 days to prevent unbounded storage growth */
  var histKeys = Object.keys(p.dailyHistory);
  if (histKeys.length > 90) {
    histKeys.sort(function (a, b) { return new Date(a).getTime() - new Date(b).getTime(); });
    var toRemove = histKeys.slice(0, histKeys.length - 90);
    for (var h = 0; h < toRemove.length; h++) {
      delete p.dailyHistory[toRemove[h]];
    }
  }

  saveProgress(p);
}

/**
 * Record a finished session's within-session speed improvement % into a rolling average on the user's stats
 * (ADR-030). The Coaching App reads `stats.avgSessionImprovementPct` cheaply off the root user doc (no
 * per-student practiceSessions fan-out). EMA-smoothed (~last 10-20 sessions) so one outlier session can't
 * swing it; seeded directly on the first session. Called from drill-engine#finish for ≥6-question sessions.
 */
function recordSessionImprovement(pct) {
  if (typeof pct !== 'number' || !isFinite(pct)) return;
  var p = loadProgress();
  var prior = p.avgSessionImprovementPct;
  var next;
  if (typeof prior !== 'number' || !isFinite(prior)) {
    next = pct;
  } else {
    var alpha = 0.1; /* EMA weight — ~last 10-20 sessions */
    next = prior * (1 - alpha) + pct * alpha;
  }
  p.avgSessionImprovementPct = parseFloat(next.toFixed(1));
  saveProgress(p);
}

/** Record completion of a drill session */
function recordDrillSession() {
  var p = loadProgress();
  p.drillSessions = (p.drillSessions || 0) + 1;
  saveProgress(p);
}

/** Record completion of a timed test session */
function recordTimedTestSession() {
  var p = loadProgress();
  p.timedTestSessions = (p.timedTestSessions || 0) + 1;
  saveProgress(p);
}

/* Active study language, guarded (F-M8: stamps each captured mistake so the archive replays in its practice language). */
function _studyLangGuarded() {
  try { if (typeof QRI18n !== 'undefined' && QRI18n.studyLang) { var l = QRI18n.studyLang(); return (l === 'hi' || l === 'mr') ? l : 'en'; } } catch (_) {}
  return 'en';
}

/** Get stored mistakes for review mode. Normalised to the current archive schema on read (v1 records upgrade in place). */
function getMistakes() {
  var p = loadProgress();
  var list = p.mistakes || [];
  return (typeof QRMistakeArchive !== 'undefined') ? QRMistakeArchive.normalizeList(list) : list;
}

/* ── Mistake Archive query + mutation + sync API (ADR-111 F-M8). The durable foundation for review, bookmarks,
   spaced repetition, weak-topic detection, revision plans, coaching analytics, export and search. All persist. ── */

/** Filter / sort / search the archive. opts per QRMistakeArchive.query. Returns normalised v2 records. */
function queryMistakes(opts) {
  if (typeof QRMistakeArchive === 'undefined') return getMistakes();
  return QRMistakeArchive.query(loadProgress().mistakes || [], opts);
}
/** Distinct-value facet counts for building filter chips. */
function mistakeFacets() {
  if (typeof QRMistakeArchive === 'undefined') return {};
  return QRMistakeArchive.facets(loadProgress().mistakes || []);
}
/* Mutate one record by id, persist, return whether it was found. */
function _mutateMistake(id, fn) {
  var p = loadProgress();
  if (!Array.isArray(p.mistakes)) return false;
  var found = false;
  p.mistakes = p.mistakes.map(function (raw) {
    var r = (typeof QRMistakeArchive !== 'undefined') ? QRMistakeArchive.normalize(raw) : raw;
    if (r && r.id === id) { found = true; fn(r); }
    return r;
  });
  if (found) saveProgress(p);
  return found;
}
/** Toggle/set a bookmark on a mistake (future: saved-for-later, revision decks). */
function bookmarkMistake(id, on) { return _mutateMistake(id, function (r) { r.bookmarked = (on == null) ? !r.bookmarked : !!on; }); }
/** Mark a mistake resolved / unresolved (future: weak-topic clearing, mastery tracking). */
function resolveMistake(id, on) { return _mutateMistake(id, function (r) { r.resolved = (on == null) ? !r.resolved : !!on; }); }
/** Record that a mistake was reviewed and advance its spaced-repetition schedule (SM-2). gotItRight resolves it. */
function recordMistakeReview(id, gotItRight, ts) {
  return _mutateMistake(id, function (r) {
    if (typeof QRMistakeArchive !== 'undefined' && QRMistakeArchive.scheduleReview) {
      var s = QRMistakeArchive.scheduleReview(r, !!gotItRight, (typeof ts === 'number') ? ts : Date.now());
      r.reviewCount = s.reviewCount; r.ease = s.ease; r.interval = s.interval; r.dueTs = s.dueTs; r.lastReviewedTs = s.lastReviewedTs; r.resolved = s.resolved;
    } else { r.reviewCount = (r.reviewCount || 0) + 1; r.lastReviewedTs = (typeof ts === 'number') ? ts : Date.now(); if (gotItRight) r.resolved = true; }
  });
}
/** Mistakes due for spaced-repetition review at/before `nowTs` (unscheduled records are eligible immediately). */
function getDueMistakes(nowTs) {
  var now = (typeof nowTs === 'number') ? nowTs : Date.now();
  return getMistakes().filter(function (r) { return r.dueTs == null || r.dueTs <= now; });
}
/** Export the whole archive as a portable payload (user export / backup). */
function exportMistakes() { return (typeof QRMistakeArchive !== 'undefined') ? QRMistakeArchive.exportArchive(loadProgress().mistakes || []) : { mistakes: getMistakes() }; }
/** Import a payload, merge-deduped into the archive (import can never duplicate or corrupt existing records). */
function importMistakes(payload) {
  if (typeof QRMistakeArchive === 'undefined') return getMistakes();
  var p = loadProgress();
  p.mistakes = QRMistakeArchive.importArchive(p.mistakes || [], payload);
  saveProgress(p);
  return p.mistakes;
}
/** Delete one mistake by id; returns the removed record (for undo/restore) or null. */
function deleteMistake(id) {
  var p = loadProgress();
  if (!Array.isArray(p.mistakes)) return null;
  var removed = null;
  p.mistakes = p.mistakes.filter(function (raw) {
    var r = (typeof QRMistakeArchive !== 'undefined') ? QRMistakeArchive.normalize(raw) : raw;
    if (r && r.id === id && !removed) { removed = r; return false; }
    return true;
  });
  if (removed) saveProgress(p);
  return removed;
}
/** Restore a previously-deleted record (merge-by-id so a re-add can't duplicate). */
function restoreMistake(record) {
  if (!record || typeof QRMistakeArchive === 'undefined') return false;
  var p = loadProgress();
  p.mistakes = QRMistakeArchive.mergeMistakes(p.mistakes || [], [record]);
  saveProgress(p);
  return true;
}
/** Reconcile remote (cloud) mistakes into the local archive with no duplication / loss / corruption (sync integrity). */
function reconcileRemoteMistakes(remoteList) {
  if (typeof QRMistakeArchive === 'undefined') return getMistakes();
  var p = loadProgress();
  p.mistakes = QRMistakeArchive.mergeMistakes(p.mistakes || [], remoteList || []);
  saveProgress(p);
  return p.mistakes;
}

/** Get average response time */
function getAvgResponseTime() {
  var p = loadProgress();
  var times = p.responseTimes || [];
  if (times.length === 0) return 0;
  var sum = 0;
  for (var i = 0; i < times.length; i++) sum += times[i];
  return (sum / times.length).toFixed(1);
}

/** Categories that are not valid for analytics (e.g. from legacy data) */
var _INVALID_CATEGORIES = { onboarding: true };

/** Check if a category name is valid for analytics display */
function isValidCategory(cat) {
  return !_INVALID_CATEGORIES[cat];
}

/* ADR-053: weak/strong topic come from the ONE derivation layer (statMath) — the SAME implementation the
   server profile uses — so Analytics and QuanAI can never name different weak/strong topics. `_mathStats()`
   strips analytics-invalid categories before handing the stats to statMath. */
function _mathStats() {
  var p = loadProgress();
  var cats = p.categoryStats || {}, clean = {};
  Object.keys(cats).forEach(function (c) { if (!_INVALID_CATEGORIES[c]) clean[c] = cats[c]; });
  return { totalAttempted: p.totalAttempted || 0, totalCorrect: p.totalCorrect || 0,
    categoryStats: clean, dailyHistory: p.dailyHistory || {}, todayAttempted: p.todayAttempted || 0, todayCorrect: p.todayCorrect || 0,
    byDifficulty: p.byDifficulty || {}, responseTimes: p.responseTimes || [] };
}

/** Weakest category (lowest accuracy, ≥ MASTERY_MIN_ATTEMPTS) — via the shared derivation layer. */
function getWeakestCategory() { return (typeof QR_STATMATH !== 'undefined') ? QR_STATMATH.weakest(_mathStats()) : null; }

/** Strongest category (highest accuracy, ≥ MASTERY_MIN_ATTEMPTS) — via the shared derivation layer. */
function getStrongestCategory() { return (typeof QR_STATMATH !== 'undefined') ? QR_STATMATH.strongest(_mathStats()) : null; }

/** Reset all progress */
function resetProgress() {
  _progressCache = null; /* Invalidate cache */
  saveProgress({
    totalAttempted: 0, totalCorrect: 0,
    bestStreak: 0, currentStreak: 0,
    drillSessions: 0, timedTestSessions: 0,
    dailyStreak: 0, bestDailyStreak: 0,
    lastActiveDate: null,
    lastPracticeDate: null,
    todayAttempted: 0, todayCorrect: 0,
    diSetsToday: 0, lrSetsToday: 0,   /* ADR-107 */
    categoryStats: {},
    mistakes: [],
    responseTimes: [],
    dailyHistory: {}
  });
}

/**
 * ADR-107 (Phase 5B): record that a free user STARTED a DI or Reasoning set today. Free users get one of each per
 * day; the gate in practice-modes.js reads diSetsToday/lrSetsToday and increments through here on a granted start.
 * localStorage-primary + Firestore mirror, exactly like the todayAttempted counter — no server/schema change.
 * @param {'di'|'lr'} kind
 * @returns {number} the new per-day count for that kind
 */
function recordSetStarted(kind) {
  var data = loadProgress();
  if (kind === 'lr') {
    data.lrSetsToday = (parseInt(data.lrSetsToday) || 0) + 1;
  } else {
    data.diSetsToday = (parseInt(data.diSetsToday) || 0) + 1;
  }
  data.lastActiveDate = new Date().toDateString();
  saveProgress(data);
  return kind === 'lr' ? data.lrSetsToday : data.diSetsToday;
}

/** ADR-107: how many DI (or LR) sets a free user has started TODAY. Premium ignores these (unlimited). */
function getSetsStartedToday(kind) {
  var data = loadProgress();
  return (kind === 'lr' ? (parseInt(data.lrSetsToday) || 0) : (parseInt(data.diSetsToday) || 0));
}
