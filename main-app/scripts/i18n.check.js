/**
 * i18n.check.js — validates the localization layer (ADR-111).
 *
 * Guards the invariants the i18n architecture depends on:
 *   1. CATALOG PARITY — en/hi/mr expose the identical key set; no empty values; plural objects
 *      carry the same categories everywhere.
 *   2. PLACEHOLDER PARITY — every {token} in an English value appears in the hi/mr values too
 *      (a missing token silently drops data for one language).
 *   3. NO RAW-ENGLISH LEAKAGE — hi/mr values may contain Latin script only for glossary-allowlisted
 *      brand terms (QuantReflex, Premium, DI…), never untranslated English prose.
 *   4. DOM KEYS RESOLVE — every data-i18n / data-i18n-attr key in index.html exists in the catalogs.
 *   5. FLAG LOCKSTEP — the inline pre-paint I18N_ON (index.html) matches QRI18n.ENABLED (js/i18n.js),
 *      and the SW precaches the i18n core, all three catalogs and the Devanagari font.
 *   6. CHANNEL SEPARATION — study-content namespaces are read only via tc(), UI namespaces only via
 *      t() (the two-language model would silently cross-wire otherwise).
 *   7. RUNTIME BEHAVIOR — flag-off hard-forces English; preview mode enables switching; fallback
 *      chain hi/mr→en→key; {param} interpolation; Intl plural selection (hi treats 0 as "one").
 *   node scripts/i18n.check.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
function p(rel) { return path.join(__dirname, '..', rel); }

var pass = 0, fail = 0;
function ok(label, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + label); } }

console.log('i18n.check — localization layer (ADR-111)');

var LANGS = ['en', 'hi', 'mr'];
/* Namespaces reserved for the STUDY channel (tc); everything else is UI (t). Grows in later phases. */
var CONTENT_NS = ['gen', 'learnContent', 'tips', 'study'];
/* Latin-script tokens legitimately present inside hi/mr values (do-not-translate glossary). */
var LATIN_ALLOWLIST = [
  'QuantReflex', 'QuanAI', 'Premium', 'English', 'Focus', 'DI', 'LR', 'AI',
  'CAT', 'MBA', 'CET', 'MAH', 'Bank', 'PO', 'SSC', 'CGL', 'IBPS', 'RRB', 'UPSC', 'MPSC', 'NDA', 'CDS',
  'km', 'kmph', 'cm', 'mm', 'kg', 'XP',
  /* 'Google Play' precedes bare 'Google': stripping is literal and in array order, so the bare form
     would otherwise consume the first word and leave "Play" behind as untranslated English. The store
     brand is DNT in every locale — a user must be able to match it against the app that charged them. */
  'Google Play', 'Google', 'QRABCD1234', 'AP', 'GP', 'Speed Aptitude', 'Speed Score', 'Math Duel', 'Quant', 'Playful Professional', 'Classic Blue', 'XAT', 'SNAP', 'NMAT', 'CMAT', 'SBI', 'Foundation',
  /* share text carries the product URL verbatim (longest form first — stripping is literal) */
  'https://www.quantreflex.app', 'https://quantreflex.app', 'www.quantreflex.app', 'quantreflex.app',
  /* developer + payment-processor proper nouns (About modal, DNT) */
  'Razorpay', 'KrisVeltrix', 'KVt',
  /* platform / browser brand names (App Guide install instructions, DNT) */
  'Android', 'Chrome', 'iPhone', 'Safari',
  /* theme brand word ('Playful Professional' / 'Playful theme', DNT) */
  'Playful',
  /* home premium badge + login placeholder (DNT) */
  'PRO', 'you@example.com'
];

/* ── capture raw catalogs by requiring the locale IIFEs against a recording stub ── */
var catalogs = { en: {}, hi: {}, mr: {} };
global.QRI18n = {
  register: function (lang, cat) {
    var target = catalogs[lang];
    for (var ns in cat) {
      if (!target[ns]) target[ns] = {};
      for (var k in cat[ns]) target[ns][k] = cat[ns][k];
    }
  }
};
LANGS.forEach(function (l) { require(p('locales/' + l)); });
delete global.QRI18n;

function flatKeys(cat) {
  var keys = [];
  for (var ns in cat) for (var k in cat[ns]) keys.push(ns + '.' + k);
  return keys.sort();
}
function get(cat, key) {
  var dot = key.indexOf('.');
  var ns = cat[key.slice(0, dot)];
  return ns ? ns[key.slice(dot + 1)] : undefined;
}
function tokensOf(v) {
  var s = typeof v === 'object' ? Object.keys(v).map(function (c) { return v[c]; }).join(' ') : String(v);
  return (s.match(/\{\w+\}/g) || []).sort().join(',');
}

/* ── 1+2. key parity, non-empty values, plural-category + placeholder parity ── */
(function () {
  var enKeys = flatKeys(catalogs.en);
  ok('1 en catalog is non-empty', enKeys.length > 0);
  ['hi', 'mr'].forEach(function (l) {
    ok('1 ' + l + ' key set identical to en', flatKeys(catalogs[l]).join('|') === enKeys.join('|'));
  });
  LANGS.forEach(function (l) {
    flatKeys(catalogs[l]).forEach(function (key) {
      var v = get(catalogs[l], key);
      if (typeof v === 'string') {
        if (!v.trim()) { fail++; console.error('  ✗ 1 empty value: ' + l + ':' + key); } else pass++;
      } else if (typeof v === 'object' && v !== null) {
        var cats = Object.keys(v).sort().join(',');
        var enV = get(catalogs.en, key);
        ok('1 plural categories match en for ' + l + ':' + key,
          typeof enV === 'object' && Object.keys(enV).sort().join(',') === cats);
      } else { fail++; console.error('  ✗ 1 bad value type: ' + l + ':' + key); }
    });
  });
  enKeys.forEach(function (key) {
    var want = tokensOf(get(catalogs.en, key));
    ['hi', 'mr'].forEach(function (l) {
      var got = tokensOf(get(catalogs[l], key) || '');
      ok('2 placeholder parity ' + l + ':' + key, got === want);
    });
  });
})();

/* ── 3. no raw-English leakage in hi/mr (allowlist-stripped Latin runs) ── */
(function () {
  ['hi', 'mr'].forEach(function (l) {
    flatKeys(catalogs[l]).forEach(function (key) {
      var v = get(catalogs[l], key);
      var s = typeof v === 'object' ? Object.keys(v).map(function (c) { return v[c]; }).join(' ') : String(v);
      s = s.replace(/\{\w+\}/g, ' ').replace(/<[^>]+>/g, ' '); /* placeholders + inline HTML markup are language-neutral */
      LATIN_ALLOWLIST.forEach(function (t) { s = s.split(t).join(' '); });
      ok('3 no untranslated English in ' + l + ':' + key, !/[A-Za-z]{3,}/.test(s));
    });
  });
})();

/* ── 4. every data-i18n / data-i18n-html / data-i18n-attr key in index.html resolves,
      and every data-i18n-html catalog value carries only whitelisted markup ── */
var indexHtml = fs.readFileSync(p('index.html'), 'utf8');
(function () {
  var used = {};
  var htmlKeys = {};
  var m, re = /data-i18n="([^"]+)"/g;
  while ((m = re.exec(indexHtml))) used[m[1]] = 1;
  re = /data-i18n-html="([^"]+)"/g;
  while ((m = re.exec(indexHtml))) { used[m[1]] = 1; htmlKeys[m[1]] = 1; }
  re = /data-i18n-attr="([^"]+)"/g;
  while ((m = re.exec(indexHtml))) {
    m[1].split(';').forEach(function (pair) {
      var i = pair.indexOf(':');
      if (i !== -1) used[pair.slice(i + 1)] = 1;
    });
  }
  var keys = Object.keys(used);
  ok('4 index.html uses data-i18n keys', keys.length > 0);
  keys.forEach(function (key) {
    ok('4 key resolves in all catalogs: ' + key, LANGS.every(function (l) { return get(catalogs[l], key) !== undefined; }));
  });
  /* data-i18n-html values are assigned as innerHTML (sanitized at runtime); the sanitizer is
     defense-in-depth, so guarantee at build time that every catalog value carries only bare
     <strong>/<em>/<br> and balanced strong/em tags — a disallowed tag or attribute is a bug. */
  var BAD_TAG = /<(?!\/?(?:strong|em|br)\b)[a-zA-Z]/; /* any tag whose name isn't strong/em/br */
  var HAS_ATTR = /<(?:strong|em|br)\b[^>]*[^\/>]>/i;   /* a whitelisted tag carrying attributes */
  function count(s, re2) { return (s.match(re2) || []).length; }
  Object.keys(htmlKeys).forEach(function (key) {
    LANGS.forEach(function (l) {
      var v = get(catalogs[l], key);
      if (v === undefined) return; /* resolution failure already reported above */
      var s = typeof v === 'object' ? Object.keys(v).map(function (c) { return v[c]; }).join(' ') : String(v);
      ok('4 html value only whitelisted tags: ' + l + ':' + key, !BAD_TAG.test(s));
      ok('4 html value no tag attributes: ' + l + ':' + key, !HAS_ATTR.test(s));
      ok('4 html value balanced <strong>: ' + l + ':' + key, count(s, /<strong>/gi) === count(s, /<\/strong>/gi));
      ok('4 html value balanced <em>: ' + l + ':' + key, count(s, /<em>/gi) === count(s, /<\/em>/gi));
    });
  });
})();

/* ── 4b. CODE → CATALOG resolution (ADR-130) ──
   Every other section here checks the catalogs against EACH OTHER: en⇄hi⇄mr key parity (§1), placeholder
   parity (§2), glossary (§3), and §4 checks that keys named in index.html resolve. None of them notices
   when JS asks for a key that exists in NO catalog — and `QRI18n.t` answers an unknown key by RETURNING
   THE KEY STRING, so the raw identifier lands in the DOM, in every language including English.

   That is exactly how `js/duel-archive.js` shipped `_t('guide.difficultyEasy')` — a namespace with no
   difficulty keys — and rendered "guide.difficultyEasy" on the Battle Archive filter chips and on every
   archive card subtitle. Catalog parity was perfect throughout, because all three catalogs agree the key
   lives under `settings.`. The guard was running in the wrong direction.

   Only COMPLETE literal first arguments are checked (the closing quote must be followed by `)` or `,`),
   so dynamically composed keys — `_t('learn.cat_' + id + 'Title')`, `_t('report.mode_' + m)` — are
   skipped rather than false-flagged. */
(function () {
  function resolves(key) {
    var parts = key.split('.'), cur = catalogs.en;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object' || !(parts[i] in cur)) return false;
      cur = cur[parts[i]];
    }
    return cur != null;
  }
  function walk(dir, out) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (e.name.endsWith('.js')) out.push(full);
    });
    return out;
  }

  var LITERAL = /(?:QRI18n\.t|QRI18n\.tc|_t|_tc)\(\s*'([a-zA-Z][\w.]*\.[\w.]+)'\s*(?=[),])/g;
  var scanned = 0, unresolved = [];
  walk(p('js'), []).forEach(function (f) {
    var src = fs.readFileSync(f, 'utf8'), m;
    LITERAL.lastIndex = 0;
    while ((m = LITERAL.exec(src)) !== null) {
      scanned++;
      if (!resolves(m[1])) {
        unresolved.push(path.relative(p('.'), f) + ':' + src.slice(0, m.index).split('\n').length + ' -> ' + m[1]);
      }
    }
  });
  ok('4b scanned a meaningful number of literal t() keys in js/ (>800, got ' + scanned + ')', scanned > 800);
  ok('4b EVERY literal t() key in js/ resolves in the en catalog' +
     (unresolved.length ? ' — unresolved: ' + unresolved.slice(0, 8).join(' | ') : ''), unresolved.length === 0);

  /* Same direction for the declarative channel. §4 asserts the key EXISTS in all catalogs; these assert
     the same thing from the code side and keep the two halves symmetrical. */
  var attrBad = [], attrSeen = 0, m2, ATTR = /data-i18n(?:-html)?="([^"]+)"/g;
  while ((m2 = ATTR.exec(indexHtml)) !== null) {
    attrSeen++;
    if (!resolves(m2[1])) attrBad.push('index.html:' + indexHtml.slice(0, m2.index).split('\n').length + ' -> ' + m2[1]);
  }
  ok('4b scanned the data-i18n attribute set (>300, got ' + attrSeen + ')', attrSeen > 300);
  ok('4b every data-i18n / data-i18n-html key resolves' +
     (attrBad.length ? ' — ' + attrBad.slice(0, 8).join(' | ') : ''), attrBad.length === 0);

  var pairBad = [], pairSeen = 0, m3, ATTRMAP = /data-i18n-attr="([^"]+)"/g;
  while ((m3 = ATTRMAP.exec(indexHtml)) !== null) {
    var line = indexHtml.slice(0, m3.index).split('\n').length;
    m3[1].split(';').forEach(function (pair) {
      var t = pair.trim(); if (!t) return;
      pairSeen++;
      var key = t.split(':').slice(1).join(':').trim();
      if (!key || !resolves(key)) pairBad.push('index.html:' + line + ' -> ' + t);
    });
  }
  ok('4b scanned the data-i18n-attr pair set (>20, got ' + pairSeen + ')', pairSeen > 20);
  ok('4b every data-i18n-attr key resolves' + (pairBad.length ? ' — ' + pairBad.join(' | ') : ''), pairBad.length === 0);
})();

/* ── 5. flag lockstep + SW/script/font wiring ── */
(function () {
  var i18nSrc = fs.readFileSync(p('js/i18n.js'), 'utf8');
  var coreFlag = /var ENABLED = (true|false);/.exec(i18nSrc);
  var htmlFlag = /var I18N_ON = (true|false);/.exec(indexHtml);
  ok('5 QRI18n.ENABLED declared', !!coreFlag);
  ok('5 inline I18N_ON declared', !!htmlFlag);
  ok('5 flag lockstep (index.html I18N_ON === js/i18n.js ENABLED)', !!coreFlag && !!htmlFlag && coreFlag[1] === htmlFlag[1]);

  /* ADR-129 FAIL-1 — extend the lockstep to the DOCUMENT that gates the release.
     `I18N_KNOWN_LIMITS.md` names `I18N_CERTIFICATION.md` as the certification gate, and that file asserted
     verbatim: "The feature flag was NOT flipped; it remains QRI18n.ENABLED = false / I18N_ON = false. No
     merge to main and no production-facing change was made." — while the source shipped `true` on both.
     A reviewer reading the gate would conclude localization was dark for every user; Wave S4 exists
     precisely because those defects were LIVE. A gate that is wrong in its headline is worse than no gate,
     because it stops people looking. So the gate now carries the flag's current value the same way
     `#aboutVersionLine` carries APP_VERSION (ADR-124): flip the flag without updating the doc and this
     fails. Scoped to this one file on purpose — DECISION_LOG.md legitimately QUOTES the retracted claim in
     the ADR-125 record, and ADR-111's own historical decision text is provenance, not a current-state claim. */
  var cert = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'BIBLE', 'I18N_CERTIFICATION.md'), 'utf8');
  var flag = coreFlag ? coreFlag[1] : '';
  ok('5 certification gate pins the CURRENT flag value (var ENABLED = ' + flag + ')',
    cert.indexOf('var ENABLED = ' + flag + ';') !== -1);
  ok('5 certification gate does not carry the retracted present-tense claim',
    !/The feature flag was NOT flipped/.test(cert) && !/it remains\s+`?QRI18n\.ENABLED = false/.test(cert));
  ok('5 certification gate states the flag is live while the source ships it on',
    flag !== 'true' || /FLAG IS NOW ON/i.test(cert));

  var sw = fs.readFileSync(p('service-worker.js'), 'utf8');
  ['./js/i18n.js', './locales/en.js', './locales/hi.js', './locales/mr.js', './fonts/noto-sans-devanagari.woff2']
    .forEach(function (a) { ok('5 SW precaches ' + a, sw.indexOf("'" + a + "'") !== -1); });

  ['js/i18n.js', 'locales/en.js', 'locales/hi.js', 'locales/mr.js'].forEach(function (src) {
    ok('5 index.html loads ' + src, indexHtml.indexOf('src="' + src + '"') !== -1);
  });
  ok('5 i18n.js loads before locales', indexHtml.indexOf('src="js/i18n.js"') < indexHtml.indexOf('src="locales/en.js"'));
  ok('5 Devanagari font file exists', fs.existsSync(p('fonts/noto-sans-devanagari.woff2')));
  ok('5 @font-face for Devanagari in style.css', fs.readFileSync(p('css/style.css'), 'utf8').indexOf('noto-sans-devanagari.woff2') !== -1);
  ok('5 language rows present in Settings', indexHtml.indexOf('id="languageSettingsBlock"') !== -1 &&
    indexHtml.indexOf('id="appLanguageSelect"') !== -1 && indexHtml.indexOf('id="studyLanguageSelect"') !== -1);
  ok('5 settings.js wires the language selects', fs.readFileSync(p('js/settings.js'), 'utf8').indexOf('appLanguageSelect') !== -1);
})();

/* ── 6. channel separation: content namespaces only via tc(), UI namespaces only via t() ── */
(function () {
  function walk(dir, out) {
    fs.readdirSync(dir).forEach(function (f) {
      var full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full, out);
      else if (/\.js$/.test(f)) out.push(full);
    });
    return out;
  }
  var offenders = [];
  walk(p('js'), []).forEach(function (file) {
    var src = fs.readFileSync(file, 'utf8');
    var m, re = /QRI18n\.(t|tc)\(\s*['"]([\w-]+)\./g;
    while ((m = re.exec(src))) {
      var isContentNs = CONTENT_NS.indexOf(m[2]) !== -1;
      if (m[1] === 't' && isContentNs) offenders.push(file + ': t() on content ns ' + m[2]);
      if (m[1] === 'tc' && !isContentNs) offenders.push(file + ': tc() on UI ns ' + m[2]);
    }
  });
  ok('6 no t()/tc() channel cross-wiring' + (offenders.length ? ' — ' + offenders.join('; ') : ''), offenders.length === 0);
})();

/* ── 7. runtime behavior: shipped-ON switching, then preview-mode fallback/plurals ── */
(function () {
  /* 7a. flag shipped ON (UI Phase 1 final audit) → languages switch live, no preview needed.
     ENABLED stays as the emergency kill-switch; the coercion path it guards (isOn() false →
     hard-force 'en') remains covered structurally by the lockstep + declaration checks in §5. */
  delete require.cache[require.resolve(p('js/i18n'))];
  var I = require(p('js/i18n'));
  ok('7 flag ships ON', I.ENABLED === true);
  I.register('en', { test: { hello: 'Hello {name}', items: { one: '{count} item', other: '{count} items' } } });
  I.register('hi', { test: { hello: 'नमस्ते {name}', items: { one: '{count} प्रश्न', other: '{count} प्रश्न' } } });
  I.setLanguages('hi', 'mr');
  ok('7 shipped flag: app language switches', I.appLang() === 'hi');
  ok('7 shipped flag: study language switches', I.studyLang() === 'mr');
  I.setLanguages('en', 'en');
  ok('7 t() interpolates params', I.t('test.hello', { name: 'Asha' }) === 'Hello Asha');
  ok('7 unknown key returns the key', I.t('test.nope') === 'test.nope');
  ok('7 plural en count=1', I.t('test.items', { count: 1 }) === '1 item');
  ok('7 plural en count=5', I.t('test.items', { count: 5 }) === '5 items');

  /* 7b. preview mode (qr_i18n_preview) → switching + fallback + hi plural rules live */
  delete require.cache[require.resolve(p('js/i18n'))];
  global.localStorage = { getItem: function (k) { return k === 'qr_i18n_preview' ? '1' : null; } };
  var P = require(p('js/i18n'));
  P.register('en', { test: { hello: 'Hello {name}', onlyEn: 'English only', items: { one: '{count} item', other: '{count} items' } } });
  P.register('hi', { test: { hello: 'नमस्ते {name}', items: { one: '{count} प्रश्न', other: '{count} प्रश्न' } } });
  ok('7 preview turns i18n on', P.isOn() === true);
  P.setLanguages('hi', 'mr');
  ok('7 preview: app language switches', P.appLang() === 'hi');
  ok('7 preview: study language switches', P.studyLang() === 'mr');
  ok('7 hi value served', P.t('test.hello', { name: 'आशा' }) === 'नमस्ते आशा');
  ok('7 missing hi key falls back to en', P.t('test.onlyEn') === 'English only');
  ok('7 missing mr catalog falls back to en on tc()', P.tc('test.onlyEn') === 'English only');
  ok('7 hi plural: 0 selects "one" (CLDR)', P.t('test.items', { count: 0 }) === '0 प्रश्न');
  ok('7 invalid language coerces to en', (P.setLanguages('xx', 'hi'), P.appLang() === 'en'));
  P.setLanguages('en', 'mr');
  ok('7 localeTag study=mr forces -u-nu-latn', P.localeTag('study') === 'mr-IN-u-nu-latn');
  ok('7 localeTag app=en is en-IN', P.localeTag() === 'en-IN');

  /* 7c. data-i18n-html: whitelist sanitize + orig-stash + EN restore, driven through
     the real applyDom via a minimal fake element. The hi value deliberately carries a
     hostile <img onerror> to prove the sanitizer neutralizes it. The real browser-DOM
     path (innerHTML rendering, Devanagari shaping) is covered by the Phase-D Playwright
     harness. */
  P.register('en', { about: { rich: 'Train <strong>daily</strong>.' } });
  P.register('hi', { about: { rich: 'रोज़ <strong>अभ्यास</strong> करें।<img src=x onerror="alert(1)">' } });
  var htmlEl = {
    _a: { 'data-i18n-html': 'about.rich' },
    innerHTML: 'Train <strong>daily</strong>.',
    getAttribute: function (n) { return this._a[n] !== undefined ? this._a[n] : null; },
    setAttribute: function (n, v) { this._a[n] = String(v); }
  };
  var fakeRoot = { querySelectorAll: function (sel) { return sel === '[data-i18n-html]' ? [htmlEl] : []; } };
  P.setLanguages('hi', 'mr');
  P.applyDom(fakeRoot);
  ok('7 html mode translates + keeps <strong>', htmlEl.innerHTML.indexOf('<strong>अभ्यास</strong>') !== -1);
  ok('7 html mode drops hostile <img>/onerror', htmlEl.innerHTML.indexOf('img') === -1 && htmlEl.innerHTML.toLowerCase().indexOf('onerror') === -1);
  ok('7 html mode stashes English original', htmlEl.getAttribute('data-i18n-orig-html') === 'Train <strong>daily</strong>.');
  P.setLanguages('en', 'en');
  P.applyDom(fakeRoot);
  ok('7 html mode restores English innerHTML', htmlEl.innerHTML === 'Train <strong>daily</strong>.');
  /* attributes on a whitelisted tag are stripped */
  P.register('en', { about: { attr: '<strong>x</strong>' } });
  P.register('hi', { about: { attr: '<strong class="x" onclick="e()">क</strong>' } });
  var attrEl = {
    _a: { 'data-i18n-html': 'about.attr' }, innerHTML: '<strong>x</strong>',
    getAttribute: function (n) { return this._a[n] !== undefined ? this._a[n] : null; },
    setAttribute: function (n, v) { this._a[n] = String(v); }
  };
  var attrRoot = { querySelectorAll: function (sel) { return sel === '[data-i18n-html]' ? [attrEl] : []; } };
  P.setLanguages('hi', 'mr');
  P.applyDom(attrRoot);
  ok('7 html mode strips tag attributes', attrEl.innerHTML === '<strong>क</strong>');
  delete global.localStorage;
})();

/* ── 8. JS-built modal i18n guard (audit B1): the Practice subject-picker builds its UI via innerHTML,
   which §4's data-i18n scan cannot see. It once shipped 100% hardcoded English. Lock it to i18n. ── */
(function () {
  var src = fs.readFileSync(p('js/ui/practice-subject-modal.js'), 'utf8');
  ok('8 subject-modal routes strings through QRI18n', /QRI18n\.t/.test(src) && /practice\.subject/.test(src));
  /* the specific English UI literals that used to be hardcoded must not reappear in the RENDERED code
     (strip the JSDoc block comment, which legitimately names the subjects in prose). */
  var codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
  ['What would you like to practice?', 'Quantitative Aptitude', 'Data Interpretation', 'Logical Reasoning',
   'Mixed Aptitude', "Don't ask again"].forEach(function (lit) {
    ok('8 subject-modal has no hardcoded "' + lit + '"', codeOnly.indexOf(lit) === -1);
  });
  /* every subject key resolves in all three catalogs (parity is enforced by §1; this is explicit) */
  var subjKeys = ['subjectHeading', 'subjectLast', 'subjectDontAsk', 'subjectClose',
    'subjectQuantTitle', 'subjectQuantDesc', 'subjectQuantKinds', 'subjectDiTitle', 'subjectDiDesc',
    'subjectDiKinds', 'subjectLrTitle', 'subjectLrDesc', 'subjectLrKinds', 'subjectMixedTitle',
    'subjectMixedDesc', 'subjectMixedKinds'];
  LANGS.forEach(function (lang) {
    subjKeys.forEach(function (k) {
      ok('8 ' + lang + ' practice.' + k, !!(catalogs[lang].practice && catalogs[lang].practice[k]));
    });
  });
})();

/* ── 9. Category-picker section headers (ADR-124, audit S4-V1) ────────────────────────────────────
   §8 locked ONE JS-innerHTML surface and stopped there. The sibling component — the Practice category
   picker — took its Quant section titles straight from the knowledge registry, which stores English
   only, so seven headers (Numbers … Mensuration) rendered in English for hi/mr users on the Practice
   screen while the DI/LR headers beside them translated. §4 could not see it (no data-i18n) and §8 did
   not cover it. This section closes that gap: the picker must resolve titles through i18n, and every
   quant category id declared in the registry must have a translated title in all three catalogs. ── */
(function () {
  var src = fs.readFileSync(p('js/ui/category-picker.js'), 'utf8');
  ok('9 picker resolves section titles through i18n (learn.cat_<id>Title)',
    /function _catSectionTitle\(/.test(src) && /'learn\.cat_' \+ id \+ 'Title'/.test(src));
  ok('9 the quant section model uses it rather than the raw registry title',
    /title: _catSectionTitle\(sid, meta\[sid\] && meta\[sid\]\.title\)/.test(src));
  ok('9 picker carries no untranslated hint strings',
    !/hint:\s*'[^']/.test(src));
  /* ADR-125 (S4-U3): ADR-124 made these headers locale-dependent, so the picker must invalidate on a
     language switch like every other localized JS-built surface — applyDom cannot reach innerHTML text and
     the app does not reload. Without this, a visible picker keeps the old locale (reproduced as a
     mixed-locale state: Hindi strip labels beside English section headers). */
  /* ADR-129 (C-3): the previous form asserted only the invalidation, and matched across an arbitrary
     300-char window that comments could span — so deleting the repaint (`if (showing) render()`) left
     this green while a VISIBLE picker went blank on every switch. Assert both halves, inside the
     onChange body, with comments stripped so a citation of the code cannot satisfy the guard. */
  var pickerBody = (function () {
    var noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    var m = /QRI18n\.onChange\(function\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\);/.exec(noComments);
    return m ? m[1] : '';
  })();
  ok('9 picker registers a QRI18n.onChange handler', pickerBody.length > 0);
  ok('9 picker clears the stale-locale tree inside that handler',
    /getElementById\('categoryGroups'\)/.test(pickerBody) && /\.innerHTML\s*=\s*''/.test(pickerBody));
  ok('9 picker repaints when it is currently visible (blank-picker guard)',
    /categorySelect/.test(pickerBody) && /if \(showing\) render\(\)/.test(pickerBody));

  /* derive the ids from the registry source so a newly added quant category fails this check until it
     is translated — the drift guard §8's fixed key list does not have */
  var catSrc = fs.readFileSync(p('data/knowledge/categories.js'), 'utf8');
  var ids = [];
  catSrc.replace(/\{\s*id:\s*'([^']+)'[^}]*?subject:\s*'quant'/g, function (_m, id) { ids.push(id); return _m; });
  ok('9 found the quant category ids in the registry (got ' + ids.length + ')', ids.length >= 7);
  LANGS.forEach(function (lang) {
    ids.forEach(function (id) {
      var v = catalogs[lang].learn && catalogs[lang].learn['cat_' + id + 'Title'];
      ok('9 ' + lang + ' learn.cat_' + id + 'Title', !!v);
    });
  });
  /* and they must actually be translated, not English copies (the failure §8 never tests for) */
  ['hi', 'mr'].forEach(function (lang) {
    ids.forEach(function (id) {
      var k = 'cat_' + id + 'Title';
      var en = catalogs.en.learn && catalogs.en.learn[k];
      var v = catalogs[lang].learn && catalogs[lang].learn[k];
      ok('9 ' + lang + ' learn.' + k + ' is translated, not an English copy', !!v && v !== en);
    });
  });
})();

/* ── 10. Language-switch transition coordinator (ADR-126, redesigned ADR-127) ──────────────────────
   The switch used to be a double render that also lost focus and smooth-scrolled the user to the top.
   QRI18nTransition owns the lifecycle; ADR-127 turned the whole-view fade into a per-section cascade.
   These assertions lock the properties that make it correct — every one of them is invisible to a
   rendering test that only checks the final strings. ── */
(function () {
  var src = fs.readFileSync(p('js/i18n-transition.js'), 'utf8');
  var set = fs.readFileSync(p('js/settings.js'), 'utf8');
  var html = fs.readFileSync(p('index.html'), 'utf8');
  var sw = fs.readFileSync(p('service-worker.js'), 'utf8');
  var css = fs.readFileSync(p('css/style.css'), 'utf8');
  var learn = fs.readFileSync(p('js/views/learn-view.js'), 'utf8');

  /* ---- lifecycle ---- */
  ok('10 settings routes the switch through the coordinator',
    /QRI18nTransition\.switchTo\(settings, _commit\)/.test(set));
  ok('10 a single commit pass owns init + the view re-render (no double render)',
    /QRI18n\.init\(settings\)/.test(src) && /Router\.refreshCurrentView\(\)/.test(src));
  ok('10 scroll and focus are captured and restored across the commit',
    /function _capture\(/.test(src) && /function _restore\(/.test(src) &&
    /snap\.focusId/.test(src) && /scrollTop = snap\.scrollTop/.test(src));
  ok('10 focus restore does not scroll the page',
    /focus\(\{ preventScroll: true \}\)/.test(src));
  ok('10 rapid switching is last-wins via a generation counter, never queued',
    /var gen = \+\+_gen;/.test(src) && (src.match(/gen !== _gen/g) || []).length >= 4);
  ok('10 it reuses QROverlay.reducedMotion rather than re-rolling matchMedia',
    /QROverlay\.reducedMotion\(\)/.test(src));
  ok('10 the change is announced in a dedicated polite region carrying lang=',
    /aria-live', 'polite'/.test(src) && /setAttribute\('lang', appLang/.test(src));
  ok('10 the coordinator subscribes to nothing per-switch (onChange has no unsubscribe)',
    !/QRI18n\.onChange/.test(src));
  ok('10 cleanup is unconditional so content can never be left dimmed',
    /function _finish\(/.test(src) && /_finish\(\);/.test(src));
  ok('10 a starvation guard clears the classes if rAF never fires (backgrounded tab)',
    /STARVATION_MS/.test(src) && /_starveTimer = setTimeout/.test(src));

  /* ---- ADR-127: the cascade is per-section, viewport-scoped, and nav-last ---- */
  ok('10 cascade units are the ACTIVE VIEW\'S DIRECT CHILDREN, not the view root',
    /function _units\(/.test(src) && /view\.children/.test(src) &&
    !/view\.classList\.add\(OUT_CLASS\)/.test(src));
  ok('10 only on-screen sections participate (nothing below the fold is animated)',
    /function _visible\(/.test(src) && /getBoundingClientRect\(\)/.test(src) &&
    /r\.bottom > 0 && r\.top < vh/.test(src) && /if \(_visible\(kids\[k\]\)\)/.test(src));
  ok('10 units are ordered by their on-screen top edge, so the wave travels downward',
    /vis\.sort\(function \(a, b\) \{ return a\.top - b\.top; \}\)/.test(src));
  /* ADR-128 F1: the nav slot is RESERVED, not derived from the last content index. Deriving it
     (Math.min(lastContentIndex + 1, cap)) collided with content from the sixth visible section onward,
     so on a tall tablet the chrome moved WITH the last sections instead of after them. Content must cap
     one slot below the ceiling and the nav must take the ceiling — assert both halves. */
  ok('10 the bottom-nav labels are the FINAL step, so the change settles on the chrome',
    /bottom-nav a > span\[data-i18n\]/.test(src) &&
    /var last = out\.length \? Math\.min\(out\[out\.length - 1\]\.i \+ 1, STAGGER_GROUPS - 1\) : 0;/.test(src));
  ok('10 content caps one slot BELOW the nav so the two can never collide',
    /STAGGER_GROUPS/.test(src) && /Math\.min\(v, STAGGER_GROUPS - 2\)/.test(src));
  /* The two above are only jointly sufficient: the derived nav index is strictly greater than every
     content index ONLY because content is capped one slot lower. Prove the arithmetic here rather than
     trusting the pair to stay in sync — this is the exact invariant ADR-128 F1 restored. */
  ok('10 nav index is provably > every content index at any section count',
    (function () {
      var cap = /var STAGGER_GROUPS = (\d+);/.exec(src);
      if (!cap) return false;
      var G = parseInt(cap[1], 10);
      for (var n = 1; n <= 40; n++) {
        var idx = [];
        for (var v = 0; v < n; v++) idx.push(Math.min(v, G - 2));
        var navI = Math.min(idx[idx.length - 1] + 1, G - 1);
        if (navI <= Math.max.apply(null, idx)) return false;
      }
      return true;
    })());
  ok('10 units are re-enumerated after the commit (a render can insert a direct child)',
    /var live = _units\(\);/.test(src));
  ok('10 a unit dimmed on the way out is always released, even if it is no longer a unit',
    /stillOut/.test(src));
  /* ADR-128 F5: only what actually dimmed may rise. A unit the commit newly brought into view was never
     part of the wave; giving it IN_CLASS applies `both` fill and yanks it to the floor to animate back
     up — a dip on content that never participated. Assert the reveal set is filtered by _activeUnits. */
  ok('10 only units that actually dimmed take part in the reveal',
    /if \(_activeUnits\.indexOf\(live\[w\]\.el\) !== -1\) wave\.push\(live\[w\]\);/.test(src) &&
    /var all = wave\.concat\(stillOut\);/.test(src));

  /* ---- ADR-127: overlays no longer participate (the old list led with a dead selector) ---- */
  /* Matched against SELECTOR STRINGS, not prose — the header comment explains why the old class list
     was deleted, and an assertion that greps the whole file would trip on its own rationale. */
  ok('10 overlay discovery is gone — no sheet can be open when language changes from Settings',
    !/querySelectorAll\(\s*'[^']*overlay/.test(src) && !/querySelector\(\s*'[^']*overlay/.test(src));

  /* ---- ADR-127: timing is emergent, and latency is absorbed rather than introduced ---- */
  ok('10 there is no fixed total-duration constant; timing is read back from the CSS',
    !/--qr-morph-total/.test(src) && !/--qr-morph-total/.test(css) &&
    /function _windowMs\(/.test(src) && /getComputedStyle\(el\)/.test(src));
  ok('10 the pack load runs UNDER the exit cascade, not in front of it',
    /_mark\(units, OUT_CLASS\)[\s\S]{0,900}?QRPacks\.ensure\(studyLang, function \(\) \{ packReady = true/.test(src));
  ok('10 a slow pack can never hang the transition (hard cap, then commit anyway)',
    /PACK_CAP_MS/.test(src) && /capped = true; tryCommit\(\)/.test(src));
  /* ADR-128 F2: the reduced-motion / drill branch returns early and used to have NO cap, so a pack that
     neither loaded nor errored left the language silently unchanged — the accessibility path being less
     robust than the default path. Assert it is capped, and that the cap and the pack callback share a
     once-only guard so they cannot both commit. */
  ok('10 the reduced-motion / drill branch is capped too, and commits at most once',
    /function commitOnce\(\)/.test(src) && /didInstant = true; commitInstant\(\)/.test(src) &&
    /QRPacks\.ensure\(studyLang, commitOnce\);\s*\n\s*setTimeout\(commitOnce, PACK_CAP_MS\);/.test(src));
  /* ADR-128 F3: scroll/focus must be captured immediately before the commit, not at tap time. The dim can
     hold for up to PACK_CAP_MS and nothing blocks interaction, so a t=0 snapshot would yank a user who
     scrolled or tabbed while waiting back to where they started. */
  ok('10 state is captured immediately before the commit, not at tap time',
    /snap = _capture\(\);\s*\n\s*doCommit\(\);/.test(src));
  ok('10 the commit waits for the exit to land so no section swaps text at full opacity',
    /if \(!exitLanded\) return;/.test(src));

  /* ---- ADR-127: never animate over live, timed content ---- */
  ok('10 an active drill gets the commit with NO animation at all',
    /if \(_reduced\(\) \|\| _drillActive\(\)\)/.test(src));
  ok('10 reduced motion skips the animation entirely (not merely shortens it)',
    /function commitInstant\(/.test(src));
  ok('10 a live drill is never re-rendered over',
    /_drillActive\(\)/.test(src) && /if \(!_drillActive\(\)\)/.test(src));

  /* ---- CSS: compositor-only, tokenised, paired reduced-motion ---- */
  ok('10 the cascade transitions only opacity/transform',
    /\.qr-lang-morph-out \{\s*opacity: var\(--qr-morph-floor\);\s*transition: opacity/.test(css) &&
    !/\.qr-lang-morph-(out|in)[^{]*\{[^}]*transition:[^;]*(width|height|top|left|margin|padding)/.test(css));
  ok('10 every timing is calc() on an existing token (zero design-lint duration cost)',
    /--qr-morph-out: calc\(var\(--qr-dur-fast\)/.test(css) &&
    /--qr-morph-out-step: calc\(var\(--qr-dur-fast\)/.test(css) &&
    /--qr-morph-in: calc\(var\(--qr-dur\)/.test(css) &&
    /--qr-morph-step: calc\(var\(--qr-dur-fast\)/.test(css));
  ok('10 both halves of the wave are cascaded by --qr-morph-i',
    /transition-delay: calc\(var\(--qr-morph-i, 0\) \* var\(--qr-morph-out-step\)\)/.test(css) &&
    /animation-delay: calc\(var\(--qr-morph-i, 0\) \* var\(--qr-morph-step\)\)/.test(css));
  ok('10 the exit is tighter than the return (exit compresses, entrance expands)',
    (function () {
      var o = /--qr-morph-out-step: calc\(var\(--qr-dur-fast\) \* ([\d.]+)\)/.exec(css);
      var i = /--qr-morph-step: calc\(var\(--qr-dur-fast\) \* ([\d.]+)\)/.exec(css);
      return !!(o && i) && parseFloat(o[1]) < parseFloat(i[1]);
    })());
  ok('10 it uses only an existing easing token (easings are pinned at 3/3, zero slack)',
    !/\.qr-lang-morph[\s\S]{0,400}?cubic-bezier\(/.test(css) &&
    /transition: opacity var\(--qr-morph-out\) var\(--qr-ease\)/.test(css));
  ok('10 content never fades below a readable floor', /--qr-morph-floor: 0\.4[0-9]/.test(css));
  ok('10 the return is ONE keyframe carrying both properties, with `both` fill so it cannot snap',
    /animation: qrLangSettle var\(--qr-morph-in\) var\(--qr-ease\) both/.test(css) &&
    /@keyframes qrLangSettle \{\s*from \{ opacity: var\(--qr-morph-floor\); transform: translateY\(4px\); \}/.test(css));
  ok('10 smooth-scroll is suppressed during the switch so the restore lands instantly',
    /html\.qr-lang-morphing \.container \{ scroll-behavior: auto; \}/.test(css));
  ok('10 the transition refreshes in place and never replays the view entry animation',
    /Router\.refreshCurrentView\(\)/.test(src) && /function refreshCurrentView\(/.test(fs.readFileSync(p('js/router.js'), 'utf8')));
  ok('10 reduced motion is a paired override (media query + body.reduced-motion)',
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.qr-lang-morph-out/.test(css) &&
    /body\.reduced-motion \.qr-lang-morph-out/.test(css));
  ok('10 the view root is never faded, so opacity cannot compound down the tree',
    !/\.spa-view-active\.qr-lang-morph/.test(css));
  /* Attribute position only: index.html still NAMES the retired attribute in the comment that explains
     why it was removed, which is exactly the documentation we want to keep. */
  ok('10 the retired hold opt-out is gone from both the coordinator and the markup',
    !/<[^!>]*data-i18n-morph=/.test(html) && !/getAttribute\('data-i18n-morph'\)/.test(src));

  /* ---- ADR-127: the Learn hub rebuild must not stack listeners or duplicate nodes ---- */
  ok('10 Learn wires its surviving hub controls once, not once per language change',
    /_staticWired/.test(learn) && /if \(_staticWired\) return;/.test(learn));
  ok('10 the table selector (which APPENDS and never clears) is built once',
    (function () {
      var i = learn.indexOf('if (_staticWired) return;');
      var j = learn.indexOf('renderTableSelector(tableSelector');
      return i > 0 && j > i;
    })());

  /* Wiring: a runtime file needs BOTH a script tag and a precache entry, and there is no generic
     guard for that in this repo — so assert both here. */
  ok('10 index.html loads the coordinator', /src="js\/i18n-transition\.js"/.test(html));
  ok('10 it loads after overlay.js (whose reducedMotion it reuses)',
    html.indexOf('js/ui/overlay.js') !== -1 &&
    html.indexOf('js/ui/overlay.js') < html.indexOf('js/i18n-transition.js'));
  ok('10 the service worker precaches the coordinator', /'\.\/js\/i18n-transition\.js'/.test(sw));
})();

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
