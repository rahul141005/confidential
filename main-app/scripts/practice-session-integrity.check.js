/**
 * practice-session-integrity.check.js — ADR-151.
 *
 * Two defects were found together on the pre-session ("Begin Challenge") screen:
 *
 *   BUG A — the app navigated itself back to the Practice mode list ~2s after the screen appeared, and did
 *   the same to the results/review card. Cause: FirestoreSync's own debounced write echoed back through the
 *   live user-doc listener as if it were a REMOTE change (because `updatedAt` counted as a change), and the
 *   resulting "repaint the current view" call ran Router.onShow('practice'), which tears the drill container
 *   down. Both existing stand-down guards (`_drillActive`, the `drill-session-active` body class) are only
 *   raised between begin() and finish(), so neither covered the start screen or the results card.
 *
 *   BUG B — a free user's one DI/Reasoning set per day was spent when the start screen was RENDERED, because
 *   the launcher called recordSetStarted() before createDrillEngine().start(), and start() shows the start
 *   screen rather than starting. Opening a set to look at it and backing out burned the day's allowance.
 *
 * Both are invisible to any test that only reads a pure function, so this suite pins the *wiring* by source
 * inspection, and unit-tests the one piece of real logic that came with the fix (the deck clamp).
 *
 *   node scripts/practice-session-integrity.check.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');
var SYNC = fs.readFileSync(path.join(ROOT, 'js/firestore-sync.js'), 'utf8');
var ENGINE = fs.readFileSync(path.join(ROOT, 'js/drill-engine.js'), 'utf8');
var PRACTICE_SRC = fs.readFileSync(path.join(ROOT, 'js/controllers/practice-modes.js'), 'utf8');
var HOME = fs.readFileSync(path.join(ROOT, 'js/views/home-view.js'), 'utf8');
var PAYWALL = fs.readFileSync(path.join(ROOT, 'js/paywall.js'), 'utf8');

var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } }

/* Blank out comment CONTENT while preserving every newline, so line numbers stay honest and a code pattern
   quoted in a comment (these files explain themselves at length) can't be mistaken for a real call site. */
function stripComments(src) {
  var out = '', inBlock = false, inLine = false, inStr = null;
  for (var i = 0; i < src.length; i++) {
    var c = src[i], n = src[i + 1];
    if (inBlock) { out += (c === '\n') ? '\n' : ' '; if (c === '*' && n === '/') { out += ' '; i++; inBlock = false; } continue; }
    if (inLine) { if (c === '\n') { out += '\n'; inLine = false; } else out += ' '; continue; }
    if (inStr) { out += c; if (c === '\\') { out += (n === undefined ? '' : n); i++; } else if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '*') { out += '  '; i++; inBlock = true; continue; }
    if (c === '/' && n === '/') { out += '  '; i++; inLine = true; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; continue; }
    out += c;
  }
  return out;
}

/* Body of a top-level `function name(...) { ... }`, matched by brace balance so nested braces are safe. */
function fnBody(src, name) {
  var head = src.indexOf('function ' + name + '(');
  if (head === -1) return null;
  var i = src.indexOf('{', head);
  if (i === -1) return null;
  var depth = 0;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}

console.log('Practice session integrity (ADR-151)\n');

/* ─────────────── BUG A · the repaint must not be self-triggered ─────────────── */

ok(/REFRESH_STAMPS_NO_REPAINT\s*=\s*\{[^}]*updatedAt\s*:\s*true/.test(SYNC),
  'firestore-sync: updatedAt is listed as a non-repainting stamp');
ok(/if\s*\(!REFRESH_STAMPS_NO_REPAINT\[sk\]\)\s*changed\s*=\s*true;/.test(SYNC),
  'firestore-sync: the stamp loop consults REFRESH_STAMPS_NO_REPAINT before setting `changed`');
/* It must still be MIRRORED — the durable pending-write buffer compares against the last known server value. */
ok(/_memoryCache\[sk\]\s*=\s*d\[sk\];/.test(SYNC),
  'firestore-sync: stamps are still mirrored into _memoryCache (pending-buffer base must stay fresh)');
ok(/REFRESH_STAMPS\s*=\s*\[[^\]]*'updatedAt'/.test(SYNC),
  'firestore-sync: updatedAt is still in REFRESH_STAMPS (mirrored, just not repaint-worthy)');

/* ─────────────── BUG A · both repaint sites must stand down for engine UI ─────────────── */

var guard = fnBody(SYNC, '_holdsTransientUi');
ok(guard !== null, 'firestore-sync: _holdsTransientUi() exists');
if (guard) {
  ok(/_drillActive/.test(guard), '_holdsTransientUi covers _drillActive (live session)');
  ok(/drill-session-active/.test(guard), '_holdsTransientUi covers the drill-session-active body class');
  ok(/_activeDrillEngine/.test(guard),
    '_holdsTransientUi covers _activeDrillEngine — THE start screen + results card case (ADR-151)');
}

/* Every Router.showView(...) in firestore-sync is a background repaint; each must be gated on the guard. */
var SYNC_CODE = stripComments(SYNC).split('\n');
var repaints = SYNC_CODE.map(function (line, i) { return { line: line, n: i + 1 }; })
  .filter(function (r) { return /Router\.showView\(/.test(r.line); });
ok(repaints.length === 2, 'firestore-sync has exactly the 2 known background repaint sites (found ' + repaints.length + ')');
repaints.forEach(function (r) {
  /* The guard is either an early return a few statements above, or inline in the same condition. */
  var above = SYNC_CODE.slice(Math.max(0, r.n - 9), r.n).join('\n');
  ok(/_holdsTransientUi\(\)/.test(above),
    'firestore-sync:' + r.n + ' repaint is gated on _holdsTransientUi()');
});
/* The old, too-narrow inline guard must be gone from both sites — otherwise a future edit could "fix" a
   regression by restoring it and silently lose the start-screen/results coverage. */
ok(SYNC.indexOf("classList.contains('drill-session-active')") === SYNC.lastIndexOf("classList.contains('drill-session-active')"),
  'firestore-sync: the drill-session-active check lives ONLY inside _holdsTransientUi');

/* ─────────────── BUG B · the allowance is spent in begin(), not at launch ─────────────── */

ok(/var onStart = opts\.onStart \|\| null;/.test(ENGINE), 'drill-engine: accepts an onStart host hook');
var begin = fnBody(ENGINE, 'begin');
ok(begin !== null && /onStart\(\)/.test(begin), 'drill-engine: onStart is invoked from begin()');
ok(begin !== null && /_onStartFired/.test(begin), 'drill-engine: onStart is latched one-shot (Retry cannot double-charge)');
ok(!/_onStartFired\s*=\s*false;/.test(ENGINE.replace(/var _onStartFired = false;/, '')),
  'drill-engine: the onStart latch is never reset');
/* renderStart() paints the pre-session screen; it must not be able to fire the hook. */
var renderStart = fnBody(ENGINE, 'renderStart');
ok(renderStart !== null && !/onStart/.test(renderStart),
  'drill-engine: renderStart() (the "Begin Challenge" screen) never touches onStart');

['startDiSet', 'startLrSet'].forEach(function (name) {
  var body = fnBody(PRACTICE_SRC, name);
  ok(body !== null, name + ' found');
  if (!body) return;
  var calls = body.match(/recordSetStarted\(/g) || [];
  ok(calls.length === 1, name + ': records the set exactly once (found ' + calls.length + ')');
  var hook = /onStart:\s*function\s*\(\)\s*\{[^}]*recordSetStarted\(/.test(body);
  ok(hook, name + ': the recordSetStarted call lives inside the onStart hook, not at launch time');
  /* The launcher must not charge before handing the engine over. */
  var tail = body.slice(body.indexOf('_startPracticeEngine('));
  ok(!/recordSetStarted\(/.test(tail), name + ': nothing is charged after _startPracticeEngine either');
  ok(/_clampSetToDailyAllowance\(/.test(body), name + ': clamps the deck to the remaining daily allowance');
});

/* ─────────────── the quota card belongs to Practice ─────────────── */

ok(!/function _renderDailyQuota/.test(HOME), 'home-view no longer defines _renderDailyQuota');
ok(/function _renderDailyQuota/.test(PRACTICE_SRC), 'practice-modes defines _renderDailyQuota');
var quota = fnBody(PRACTICE_SRC, '_renderDailyQuota');
ok(quota !== null && !/used === 0/.test(quota),
  'the quota card no longer hides itself at 0 used (ADR-151 supersedes the ADR-091 cold-start rule)');
ok(quota !== null && /diSetsToday/.test(quota) && /lrSetsToday/.test(quota),
  'the quota card reports the DI and Reasoning set allowances too');
ok(/FREE_DAILY_SETS_PER_KIND = 1;/.test(PAYWALL), 'paywall defines FREE_DAILY_SETS_PER_KIND');
ok(/getDailySetLimit:\s*getDailySetLimit/.test(PAYWALL), 'paywall exports getDailySetLimit');
ok(!/getSetsStartedToday\('(di|lr)'\)\s*>=\s*\d/.test(PRACTICE_SRC),
  'the per-day set gates read the shared limit, not a hardcoded number');

/* ─────────────── unit: the deck clamp ─────────────── */

/* practice-modes.js is pure function declarations (no top-level side effects), so it can be evaluated in a
   sandbox and its helpers called directly. Stubs stand in for the browser globals it reads. */
function clampWith(limit, todayAttempted) {
  var sandbox = {
    getDailyQuestionLimit: function () { return limit; },
    loadProgress: function () { return { todayAttempted: todayAttempted }; },
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(PRACTICE_SRC, sandbox, { filename: 'practice-modes.js' });
  return sandbox._clampSetToDailyAllowance;
}

var SET5 = { category: 'di-bar', chart: { kind: 'bar' }, context: 'ctx', questions: [1, 2, 3, 4, 5] };

var clampFree = clampWith(20, 18);
var r1 = clampFree(SET5, false);
ok(r1.questions.length === 2, 'free user with 2 questions left gets a 2-question deck (got ' + r1.questions.length + ')');
ok(r1.chart === SET5.chart && r1.category === SET5.category && r1.context === SET5.context,
  'the clamp preserves the shared chart/category/context');
ok(SET5.questions.length === 5, 'the clamp does not mutate the generator\'s set');

var r2 = clampWith(20, 0)(SET5, false);
ok(r2 === SET5, 'a deck that fits is returned untouched (same object, no copy)');

var r3 = clampWith(20, 19)(SET5, false);
ok(r3.questions.length === 1, 'one question left → a 1-question deck');

var r4 = clampWith(20, 20)(SET5, false);
ok(r4.questions.length === 1, 'already at the cap → never an EMPTY deck (the engine would call that a generation failure)');

var r5 = clampWith(Infinity, 999)(SET5, true);
ok(r5 === SET5, 'premium is never clamped');
var r6 = clampWith(Infinity, 999)(SET5, false);
ok(r6 === SET5, 'an infinite limit is never clamped even if the premium flag is not passed');

/* ─────────────── ADR-152 · release blockers ─────────────── */

var ROUTER = fs.readFileSync(path.join(ROOT, 'js/router.js'), 'utf8');

/* B1 — the set mapping must carry `options`, or every LR set is unanswerable (readonly digit box for a name). */
var beginBuild = fnBody(ENGINE, '_beginBuild');
ok(beginBuild !== null && /options:\s*sq\.options/.test(beginBuild),
  'drill-engine: the diSet mapping carries `options` through to the engine (ADR-152 — LR sets)');
ok(/isMCQ = !!\(q\.options && q\.options\.length\)/.test(ENGINE),
  'drill-engine: isMCQ is still derived from q.options (the field the mapping must supply)');

/* B2 — the set numpad must reuse the guarded submit closure, never call checkAnswer bare. */
var setQ = fnBody(ENGINE, '_renderSetQuestion');
ok(setQ !== null && /showCustomNumpad\(ui\.answerInputEl, function \(\) \{ submit\(\); \}/.test(setQ),
  'drill-engine: the set-path numpad routes through the guarded submit() closure');
ok(setQ !== null && !/showCustomNumpad\([^)]*checkAnswer\(/.test(setQ),
  'drill-engine: the set-path numpad never calls checkAnswer directly (empty ↵ cannot grade a blank answer)');
ok(setQ !== null && /if \(!input\.value\.trim\(\)\) return;/.test(setQ),
  'drill-engine: the set-path submit closure still carries the empty-value guard');

/* B3 — the duel Back handler must be consulted BEFORE the practice drill-session branch. */
var popstate = stripComments(ROUTER);
var duelIdx = popstate.indexOf('DuelManager.handleBackNav()');
var practiceIdx = popstate.indexOf('showExitSessionDialog');
ok(duelIdx !== -1 && practiceIdx !== -1 && duelIdx < practiceIdx,
  'router: DuelManager.handleBackNav() is tested BEFORE the practice exit dialog (ADR-152 — duel Back)');
ok((popstate.match(/DuelManager\.handleBackNav\(\)/g) || []).length === 1,
  'router: the duel Back branch exists exactly once (no duplicate left behind by the reorder)');

/* B4 — the account-switch purge gap must not be able to write stats. */
ok(/var _purgedAwaitingHydration = false;/.test(SYNC),
  'firestore-sync: _purgedAwaitingHydration is declared');
ok(/_purgedAwaitingHydration && field === 'stats'/.test(SYNC),
  'firestore-sync: queueUpdate refuses a stats write during the purge gap (ADR-152 — account-switch data loss)');
ok(/_dataLoaded = false;\s*\n\s*_purgedAwaitingHydration = true;/.test(SYNC),
  'firestore-sync: the flag is RAISED when sync state is reset');
var clears = (SYNC.match(/_purgedAwaitingHydration = false;/g) || []).length;
var loaded = (SYNC.match(/_dataLoaded = true;/g) || []).length;
ok(clears === loaded + 1,
  'firestore-sync: the flag is cleared at every hydration-complete site (' + (clears - 1) + ' clears vs ' + loaded + ' sites)');
/* The guard must be narrow: it must not swallow a genuine first-session write (ADR-054). */
ok(/field === 'stats'/.test(SYNC) && !/_purgedAwaitingHydration\)\s*return;/.test(SYNC),
  'firestore-sync: the purge-gap guard is scoped to `stats`, not a blanket drop (ADR-054 stays intact)');

/* ─────────────── ADR-153 · the results card must survive a background repaint ─────────────── */

var SESSMGR = fs.readFileSync(path.join(ROOT, 'js/session-manager.js'), 'utf8');
var PAYWALL_SRC = fs.readFileSync(path.join(ROOT, 'js/paywall.js'), 'utf8');
var I18NT = fs.readFileSync(path.join(ROOT, 'js/i18n-transition.js'), 'utf8');

var owns = fnBody(SESSMGR, '_engineOwnsScreen');
ok(owns !== null, 'session-manager: _engineOwnsScreen() exists (the one predicate)');
if (owns) {
  ok(/_drillSessionActive/.test(owns), '_engineOwnsScreen covers _drillSessionActive (live session)');
  ok(/_activeDrillEngine/.test(owns),
    '_engineOwnsScreen covers _activeDrillEngine — THE results-card leg (ADR-153)');
  ok(/drill-session-active/.test(owns), '_engineOwnsScreen covers the body class');
}

var dispose = fnBody(SESSMGR, '_disposeActiveDrillSession');
ok(dispose !== null && /container\.innerHTML\s*=\s*''/.test(dispose),
  'session-manager: disposing a drill clears persistent container markup');

/* The post-activation repaint in paywall.js must stand down when the engine owns the screen. */
var payCode = stripComments(PAYWALL_SRC).split('\n');
var payRepaint = payCode.map(function (l, i) { return { line: l, n: i + 1 }; })
  .filter(function (r) { return /Router\.showView\(currentView\)/.test(r.line); });
ok(payRepaint.length === 1, 'paywall: exactly one post-activation repaint site (found ' + payRepaint.length + ')');
payRepaint.forEach(function (r) {
  var above = payCode.slice(Math.max(0, r.n - 6), r.n).join('\n');
  ok(/_engineOwnsScreen\(\)/.test(above),
    'paywall:' + r.n + ' the post-upgrade repaint stands down when the engine owns the screen (ADR-153)');
});

/* i18n-transition must not keep its own narrower notion of "a drill is on screen". */
var i18nDrill = fnBody(I18NT, '_drillActive');
ok(i18nDrill !== null && /_engineOwnsScreen/.test(i18nDrill),
  'i18n-transition: _drillActive defers to the shared predicate rather than the body class alone');

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════
   ADR-155 — four defects that all share one shape: a guard that exists, but not on the path that needed it.
   Each block below pins the WIRING, because none of these is visible from a pure function.
   ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

var SESSION_MGR = stripComments(fs.readFileSync(path.join(ROOT, 'js/session-manager.js'), 'utf8'));
var PROGRESS = stripComments(fs.readFileSync(path.join(ROOT, 'js/progress.js'), 'utf8'));
var QUESTIONS = stripComments(fs.readFileSync(path.join(ROOT, 'js/questions.js'), 'utf8'));
var ENGINE_C = stripComments(ENGINE);
var PRACTICE_C = stripComments(PRACTICE_SRC);

/* ── 1. The exit dialog must FREEZE the session it is asking about ──────────────────────────────────────
   "End Session?" takes time to answer. While it was up, a Reflex Drill's per-question countdown reached zero
   and auto-submitted a BLANK answer (graded wrong, filed as a knowledge mistake), and a Timed Test's global
   countdown ran finish() UNDERNEATH the dialog. The freeze lives in session-manager so all three call sites
   (drill-engine's two exit buttons + router.js's Back handler) get it without drifting. */
ok(/_activeDrillEngine\.pauseForOverlay\(\)/.test(SESSION_MGR),
  'exit dialog: freezes the live session before asking (ADR-155)');
ok(/function _thawIfDismissed\(\)[\s\S]{0,300}?resumeFromOverlay/.test(SESSION_MGR),
  'exit dialog: a dismissal (cancel / backdrop / Escape) thaws the session again');
ok(/_frozenEngine = null;\s*\n?\s*closeDialog\(\);\s*\n?\s*onConfirm\(\);/.test(SESSION_MGR),
  '** exit dialog: CONFIRM does not thaw - performExit() tears the engine down, its clocks must stay dead');
ok(/onClose: function \(\) \{[^}]*_thawIfDismissed\(\)/.test(SESSION_MGR),
  'exit dialog: the thaw rides the shared overlay lifecycle, not just the button handlers');

/* fnBody() matches `function name(`; this one is an object property, so slice it out by hand. */
var _pfoAt = ENGINE_C.indexOf('pauseForOverlay: function');
var _pfo = _pfoAt === -1 ? null : ENGINE_C.slice(_pfoAt, ENGINE_C.indexOf('resumeFromOverlay', _pfoAt));
ok(_pfo !== null && /isDuel \|\| _paused \|\| _isFinished/.test(_pfo),
  '** pauseForOverlay refuses to pause a DUEL (server-timed) or an already-paused/finished session');
ok(_pfo !== null && /perQTimer \|\| overallTimer \|\| _autoAdvanceTimer/.test(_pfo),
  'pauseForOverlay only freezes when something is actually ticking (untimed Quick Drill is untouched)');
ok(_pfo !== null && /pauseSession\(true\)/.test(_pfo),
  '** the freeze is SILENT - no pause overlay competes with the dialog already on screen');
ok(/resumeFromOverlay: function/.test(ENGINE_C),
  'the engine exposes the matching thaw');

/* ── 2. Force-exit must close the dialog THROUGH its overlay handle ─────────────────────────────────────
   _exitDrillSession() used to set display:none and strip body.modal-open by hand. QROverlay ref-counts that
   class (js/ui/overlay.js _lock/_unlock), so the count stayed one too high and the NEXT overlay to close
   could not clear the scroll lock - the whole app became unscrollable until reload. Reachable through
   defect 1: a global timer expiring under the dialog ran finish() -> _exitDrillSession() with it still open. */
var _exitFn = fnBody(SESSION_MGR, '_exitDrillSession');
ok(_exitFn !== null && /_exitDialogHandle/.test(_exitFn) && /\.close\(\)/.test(_exitFn),
  '** _exitDrillSession closes the exit dialog through its QROverlay handle (ref-count stays balanced)');
ok(/_exitDialogHandle = null;[\s\S]{0,80}_thawIfDismissed/.test(SESSION_MGR),
  'the handle is released on a normal close so no stale reference survives the session');

/* ── 3. "Continue learning" must release the global engine reference ────────────────────────────────────
   Every other exit routes through Router.onShow('practice') or the bottom-nav handler, both of which null
   _activeDrillEngine. This one routes to LEARN. Since ADR-153 that reference is the load-bearing leg of
   _engineOwnsScreen(), so a torn-down engine left here pinned "the engine owns the screen" ON and every
   background repaint app-wide (firestore-sync + paywall) silently stood down for the rest of the session. */
var _cl = fnBody(ENGINE_C, '_continueLearning');
ok(_cl !== null && /_activeDrillEngine = null/.test(_cl),
  '** _continueLearning releases _activeDrillEngine (otherwise ADR-153 stands every repaint down forever)');

/* ── 4. Mistake-archive eviction is by TIMESTAMP, never by array position ───────────────────────────────
   Hydration replaces p.mistakes with the archive's canonical ordering, and that ordering is DESCENDING by ts
   (mistake-archive.js _dedupeSortCap). shift() therefore deleted the user's most RECENT mistake every time
   the CAP was hit - the one record they most wanted to review, gone from the server on the next sync too. */
ok(!/if \(p\.mistakes\.length >= QRMistakeArchive\.CAP\) p\.mistakes\.shift\(\);/.test(PROGRESS),
  '** the archive no longer evicts by array position (p.mistakes is NOT in insertion order after hydration)');
ok(/p\.mistakes\.length >= QRMistakeArchive\.CAP[\s\S]{0,600}?p\.mistakes\.splice\(_oldestIdx, 1\)/.test(PROGRESS),
  '** ...it scans for the minimum ts and evicts THAT record');
ok(/_dedupeSortCap[\s\S]{0,300}?return \(y\.ts \|\| 0\) - \(x\.ts \|\| 0\);/
    .test(stripComments(fs.readFileSync(path.join(ROOT, 'js/mistake-archive.js'), 'utf8'))),
  '** the premise still holds: the archive really does hand back a NEWEST-FIRST array');

/* ── 5. A review deck gets one slot per QUESTION, not one per ATTEMPT ───────────────────────────────────
   buildRecord stamps `id: stableId(question, selected, ts)`, so every re-attempt is a new archive row. Right
   for the archive, wrong for a deck: a question missed three times took three of the ten slots. */
ok(/_byKey\[_k\][\s\S]{0,400}?mistakes = _deduped;/.test(QUESTIONS),
  '** getMistakeQuestions collapses the archive to one record per qkey before shuffling');
ok(/if \(!_k\) \{ _deduped\.push\(_m\); continue; \}/.test(QUESTIONS),
  'legacy rows with no qkey keep their own identity (never merged into one bucket)');

/* ── 6. The ADR-151 deck clamp now covers session review too ────────────────────────────────────────────
   "Review these N now" is offered off the results card - exactly when a free user is most likely to be near
   the 20/day cap, having just spent a session getting there. It promised N and stopped them after 2. */
ok(/function _questionsLeftToday/.test(PRACTICE_C),
  'the remaining-allowance arithmetic is factored out so every sized deck shares it');
var _sr = fnBody(PRACTICE_C, 'startSessionReview');
ok(_sr !== null && /_questionsLeftToday/.test(_sr) && /wrongQuestions\.slice\(0, _srLeft\)/.test(_sr),
  '** startSessionReview clamps its deck to what the user can actually finish today (ADR-155)');
ok(_sr !== null && /hasReachedDailyLimit/.test(_sr),
  'the hard gate is still there - the clamp is about the PROMISE, not about enforcement');
var _clamp = fnBody(PRACTICE_C, '_clampSetToDailyAllowance');
ok(_clamp !== null && /_questionsLeftToday/.test(_clamp),
  'the set clamp was rebased onto the same helper (one arithmetic, not two)');

/* ── 7. The quota panel is a snapshot; entitlement is live ──────────────────────────────────────────────
   The free-cap card is painted once and then sits on screen indefinitely, but premium can arrive underneath
   it without going through its button — ADR-118 propagates a purchase made on another device into an open
   session, and a Super Admin grant does the same. Tapping "Upgrade to continue" then opened a paywall for
   something the user already owned, and their only way off the card was "See results", which ENDS a session
   they had just become entitled to finish. */
var _qr = ENGINE_C.slice(ENGINE_C.indexOf("querySelector('#quotaUpgradeBtn')"),
                         ENGINE_C.indexOf("querySelector('#quotaResultsBtn')"));
ok(_qr.length > 0 && /hasPremiumAccess/.test(_qr),
  '** the quota panel re-derives entitlement when Upgrade is TAPPED, not when it was painted (ADR-155)');
ok(/_alreadyPremium\)\s*\{[\s\S]{0,200}?_resumePausedSession\(\);/.test(_qr),
  '** an already-premium user resumes the session instead of being shown a paywall they do not need');
ok(/_alreadyPremium\)\s*\{[\s\S]{0,200}?__qrResumeAfterUpgrade = null/.test(_qr),
  'that path leaves no armed resume hook behind for a later, unrelated upgrade to fire');
ok(/function _resumePausedSession\(\)/.test(ENGINE_C) &&
   (ENGINE_C.match(/_resumePausedSession\(\)/g) || []).length >= 3,
  'both resume paths share ONE body, so the timed-test clock restore cannot drift between them');

/* ── 8. A failed startup hydration must be recoverable (ADR-157) ────────────────────────────────────────
   loadFromFirestore retries a failed read a bounded number of times then gives up, setting _dataLoaded with
   _memoryCache still NULL so the app isn't wedged. getAccessState() resolves a null cache as FREE — the right
   fail direction — but the ADR-072/118 listener, the only other path that could deliver the entitlement,
   refused to act on a null cache too. A paying user whose connection hiccuped at startup was latched to free
   chrome and the 20-question wall for the whole session, recoverable only by relaunching. */
var SYNC_C = stripComments(SYNC);
ok(/_dataLoaded = true;[\s\S]{0,200}?retries exhausted/.test(SYNC_C) ||
   /_MAX_LOAD_RETRIES[\s\S]{0,400}?_dataLoaded = true/.test(SYNC_C),
  'the premise holds: exhausted retries still set _dataLoaded with a null cache');
ok(/if \(!_memoryCache && _dataLoaded && !_purgedAwaitingHydration && _loadedUserId !== uid\) \{/.test(SYNC_C),
  '** the live listener adopts the snapshot when startup hydration never landed (ADR-157)');
var _adopt = SYNC_C.slice(SYNC_C.indexOf('if (!_memoryCache && _dataLoaded'),
                          SYNC_C.indexOf('if (!_memoryCache || _loadedUserId !== uid) return;'));
ok(/_enforcePremiumExpiry\(_memoryCache/.test(_adopt),
  '** the adopted document still goes through the ADR-115/117 expiry rule (no free premium)');
ok(!/AppState\.setProgress/.test(_adopt),
  '** adoption does NOT push stats into AppState - that merge belongs to loadFromFirestore (mistake union)');
ok(/!_purgedAwaitingHydration/.test(_adopt),
  '** and it stands down during the ADR-152 account-switch purge gap');
ok(/_holdsTransientUi\(\)/.test(_adopt),
  'the recovery repaint obeys ADR-151 like every other repaint in this file');

/* ── 9. Nothing may grade a question while the pause screen is up (ADR-158) ─────────────────────────────
   A z-index comparison says the pause overlay (200) covers the numpad (99). It does not, and reasoning from
   those two numbers is exactly how this was WRONGLY DISPROVED in the ADR-155 pass.
   `body.drill-session-active #drillContainer` is `position:fixed; z-index:10`, and a positioned element with
   a z-index CREATES A STACKING CONTEXT — so the overlay, appended inside that container, has its 200 resolved
   within it and can never rise above the body-level #customNumpad. Confirmed in a real browser: with the
   pause screen open, elementFromPoint over the keypad returned the keypad, a digit tap typed, and Submit
   graded the question — todayAttempted 0->1 and a mistake filed while the user believed time was frozen.
   Four doors had to close, and the two JS guards must hold even if the CSS rule is ever overridden. */
var NUMPAD = stripComments(fs.readFileSync(path.join(ROOT, 'js/ui/numpad.js'), 'utf8'));
var CSS = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

/* the premise itself — if this ever stops being true the whole finding changes shape */
ok(/body\.drill-session-active #drillContainer \{[^}]*position: fixed;[^}]*z-index: var\(--z-session-bg\)/.test(CSS),
  '** the premise holds: #drillContainer is still a positioned, z-indexed STACKING CONTEXT');
ok(/--z-session-bg:\s*10;[\s\S]{0,120}?--z-session-numpad:\s*99;/.test(CSS),
  '** ...and the numpad still outranks it at the body level (10 vs 99)');

/* The click handler is the one that had no guard. Anchor on ITS OWN body — the debounce latch it owns —
   rather than on a comment string, because NUMPAD is comment-stripped and slicing on prose silently matched
   the whole file, which let the keydown guard satisfy an assertion about the click guard. That mistake made
   this very check pass while the defect was live; the mutation run is what caught it. */
var _npClickAt = NUMPAD.indexOf('_lastNumpadClick < _NUMPAD_DEBOUNCE_MS');
var _npClick = _npClickAt === -1 ? '' : NUMPAD.slice(Math.max(0, _npClickAt - 700), _npClickAt);
ok(_npClickAt !== -1 && /getElementById\('drillPauseOverlay'\)[\s\S]{0,140}?classList\.contains\('modal-open'\)[\s\S]{0,40}?return;/.test(_npClick),
  '** the numpad CLICK handler yields to a blocking overlay BEFORE it debounces (ADR-158)');
ok((NUMPAD.match(/getElementById\('drillPauseOverlay'\)/g) || []).length >= 2,
  '** both numpad entry paths — pointer and physical keyboard — carry the guard');

/* Every answer-entry path must share the one predicate: MCQ (:374), set MCQ, set free-entry, single free-entry. */
ok((ENGINE_C.match(/answered \|\| _blockedByOverlay\(\)\) return;/g) || []).length >= 4,
  '** all FOUR answer-entry paths refuse under an overlay (MCQ, set MCQ, set free-entry, free-entry)');
ok(!/var submit = function \(\) \{ if \(answered\) return;/.test(ENGINE_C),
  '** the SET path\'s Submit button is guarded too - it was a third door into grading while paused');
ok(!/function submit\(\) \{\s*\n?\s*if \(answered\) return;/.test(ENGINE_C),
  '** ...and so is the single-question path\'s');

ok(/document\.body\.classList\.add\('drill-paused'\)/.test(ENGINE_C) &&
   /document\.body\.classList\.remove\('drill-paused'\)/.test(ENGINE_C),
  'the body is marked while paused and unmarked on resume (presentational half)');
ok(/body\.drill-paused #customNumpad,\s*\n?\s*body\.drill-paused \.drill-actions \{ display: none; \}/.test(CSS),
  '** the two BODY-LEVEL session surfaces are hidden while paused, since the overlay cannot cover them');

/* ── 10. Nothing may leak QROverlay's ref-counted body.modal-open (ADR-163) ─────────────────────────────
   `body.modal-open` is half of the drill engine's `_blockedByOverlay()` predicate, and since ADR-158 that
   predicate gates the numpad pointer handler, the physical keyboard, both MCQ handlers AND both Submit
   paths. So a leaked lock is not a cosmetic scroll bug — it is a TOTAL INPUT OUTAGE: no question in any
   drill or duel can be answered until the app is restarted. ADR-158 widened the blast radius of a defect
   that already existed, which is exactly why these ratchets sit next to it.
   Two leaks, both reproduced in headless Chromium and both from the most ordinary Android gesture:
     REL-01  hardware Back while a Settings modal is open — router hid every .modal-overlay and stripped
             the class RAW, never decrementing the count, so the next overlay cycle wedged it on forever.
     REL-02  a second hardware Back during duel solving — showExitModal had no re-entrancy guard, opened a
             SECOND overlay and overwrote _exitHandle, so close() unlocked once against two locks. */
var ROUTER = stripComments(fs.readFileSync(path.join(ROOT, 'js/router.js'), 'utf8'));
var OVERLAY = stripComments(fs.readFileSync(path.join(ROOT, 'js/ui/overlay.js'), 'utf8'));
var DUELUI = stripComments(fs.readFileSync(path.join(ROOT, 'js/duel-ui.js'), 'utf8'));

/* the premise: the class really is load-bearing for answer input */
ok(/_blockedByOverlay[\s\S]{0,200}?classList\.contains\('modal-open'\)/.test(ENGINE_C),
  '** ADR-163 premise: body.modal-open still gates answer input via _blockedByOverlay()');

/* REL-01 — the router must go through the module, not around it */
var _co = ROUTER.slice(ROUTER.indexOf('function _cleanupOverlays'), ROUTER.indexOf('function showView'));
ok(_co.length > 100, 'the _cleanupOverlays body was located');
ok(/QROverlay\.releaseAll\(\)/.test(_co),
  '** _cleanupOverlays tears overlays down through QROverlay.releaseAll(), not by hand (ADR-163)');
ok(!/document\.body\.classList\.remove\('modal-open'\)/.test(_co),
  '** ...and never strips the ref-counted class raw, which is what leaked the count');
ok(/function releaseAll\(\)/.test(OVERLAY) && /releaseAll: releaseAll/.test(OVERLAY),
  'QROverlay exposes releaseAll so there is ONE supported teardown rather than a third hand-rolled one');
ok(/token\.close = function \(\)/.test(OVERLAY),
  '** each stack token carries its own close, so releaseAll drains through the real lifecycle');
var _ra = OVERLAY.slice(OVERLAY.indexOf('function releaseAll'), OVERLAY.indexOf('var QROverlay ='));
ok(/_locks\[cls\] = 0;/.test(_ra) && /classList\.remove\(cls\)/.test(_ra),
  'releaseAll force-clears a lock that survived its overlay — a stuck lock is worse than a lost teardown');

/* REL-02 — the duel exit modal must not be openable twice */
ok(/var _exitShowing = false;/.test(DUELUI), 'duel-ui declares the re-entrancy flag');
var _sem = DUELUI.slice(DUELUI.indexOf('function showExitModal'), DUELUI.indexOf('function hideExitModal'));
ok(/if \(_exitShowing\) return;\s*\n?\s*_exitShowing = true;/.test(_sem),
  '** showExitModal refuses a second open — a second Back used to double-lock and orphan the first handle');
ok(/onClose: function \(\)[^}]*_exitShowing = false;/.test(_sem),
  'the flag clears on the shared overlay lifecycle, not only on the button handlers');
ok(/_exitShowing = false;/.test(DUELUI.slice(DUELUI.indexOf('function hideExitModal'))),
  'the no-QROverlay fallback path clears it too');

/* ── 11. The ADR-151 promise covers EVERY mode, not just sets (ADR-167) ────────────────────────────────
   "Don't advertise questions the allowance can't cover" was built for DI/Reasoning sets (ADR-151) and
   extended to session review (ADR-155), but the six modes in startDrillFromPractice's table still took
   their `count` verbatim. A free user with 2 questions left tapped Reflex Drill, read "10 Questions" on
   the start screen and was stopped after 2. The engine gate was right; the NUMBER was the lie.
   Verified in a browser both directions: with 2 left, quick/reflex/timed all promise 2 (down from
   5/10/10); with a full allowance they promise 5/10/10 unchanged, so the clamp does not over-fire. */
var _sdfp = PRACTICE_C.slice(PRACTICE_C.indexOf('function startDrillFromPractice'),
                             PRACTICE_C.indexOf('function startMockFromPractice'));
ok(_sdfp.length > 200, 'the startDrillFromPractice body was located');
ok(/_questionsLeftToday\(_dpPremium\)/.test(_sdfp),
  '** every practice mode clamps its promised count to the remaining allowance (ADR-167)');
ok(/isFinite\(_dpLeft\)[\s\S]{0,120}?config\.count = _dpLeft;/.test(_sdfp),
  '** ...and only when the allowance is finite, so premium is never clamped');
ok(/hasReachedDailyLimit/.test(_sdfp),
  'the hard daily gate still runs first — the clamp is about the PROMISE, not enforcement');
/* The floor of 1 is what stops a clamp producing an empty deck, which the engine treats as a
   generation failure. It lives in the shared helper, so pin it there. */
ok(/return Math\.max\(1, limit - used\);/.test(PRACTICE_C),
  '** the remaining-allowance helper floors at 1 — a clamp can never produce an empty deck');

/* Behavioural: the eviction rule, run for real against a DESCENDING array (the post-hydration shape). */
(function () {
  var CAP = 3;
  var arr = [{ id: 'c', ts: 300 }, { id: 'b', ts: 200 }, { id: 'a', ts: 100 }];   // newest-first, as hydrated
  var oldestIdx = 0, oldestTs = Number(arr[0] && arr[0].ts) || 0;
  for (var i = 1; i < arr.length; i++) {
    var ts = Number(arr[i] && arr[i].ts) || 0;
    if (ts < oldestTs) { oldestTs = ts; oldestIdx = i; }
  }
  if (arr.length >= CAP) arr.splice(oldestIdx, 1);
  arr.push({ id: 'd', ts: 400 });
  var ids = arr.map(function (r) { return r.id; }).sort().join(',');
  ok(ids === 'b,c,d', '** eviction on a newest-first array drops the OLDEST (got: ' + ids + ')');
  ok(ids.indexOf('c') !== -1, '** ...and specifically does NOT drop the newest record at index 0');
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
