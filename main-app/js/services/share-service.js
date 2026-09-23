/**
 * share-service.js — Premium share result card generation
 *
 * Generates a high-resolution 9:16 portrait PNG card (1080×1920)
 * for sharing drill results via Web Share API, download, or clipboard.
 *
 * Features:
 *   - Premium dark gradient background with blue accent
 *   - Dynamic performance labels based on accuracy + speed
 *   - Clean, Instagram/WhatsApp-friendly layout
 *   - Share preview modal with save/share/regenerate
 *   - Web Share API with PNG file + download fallback
 *
 * Public API:
 *   ShareService.shareAsImage(data)
 *   ShareService.shareTextFallback(accuracy, speedScore)
 */

var ShareService = (function () {
  'use strict';

  /* i18n (ADR-111): share chrome, toasts and card text read the app-language channel. Canvas text
     shapes Devanagari via the browser's font fallback. Performance badges + taglines stay keyed to
     their canonical English (fallback) so an absent catalog can never blank the card. */
  function _t(key, params) { return (typeof QRI18n !== 'undefined') ? QRI18n.t(key, params) : key; }
  function _tx(key, fallback) { var v = _t(key); return v === key ? fallback : v; }
  function _diffLabel(d) {
    var k = { easy: 'settings.difficultyEasy', medium: 'settings.difficultyMedium', hard: 'settings.difficultyHard' }[String(d || '').toLowerCase()];
    return k ? _t(k) : String(d || '');
  }

  /* ---- Performance Labels ---- */
  var PERFORMANCE_LABELS = [
    { minAcc: 95, maxAvg: 5,   key: 'reflexMaster',       label: 'Reflex Master',       emoji: '⚡' },
    { minAcc: 90, maxAvg: 7,   key: 'speedDemon',         label: 'Speed Demon',         emoji: '🔥' },
    { minAcc: 90, maxAvg: 999, key: 'precisionGenius',    label: 'Precision Genius',     emoji: '🎯' },
    { minAcc: 80, maxAvg: 10,  key: 'quantWarrior',       label: 'Quant Warrior',        emoji: '⚔️' },
    { minAcc: 80, maxAvg: 999, key: 'accuracyBeast',      label: 'Accuracy Beast',       emoji: '💎' },
    { minAcc: 70, maxAvg: 999, key: 'eliteSolver',        label: 'Elite Solver',        emoji: '🏅' },
    { minAcc: 60, maxAvg: 999, key: 'aptitudeChallenger', label: 'Aptitude Challenger',  emoji: '💪' },
    { minAcc: 50, maxAvg: 999, key: 'calculationMachine', label: 'Calculation Machine',  emoji: '🧮' },
    { minAcc: 0,  maxAvg: 999, key: 'risingLearner',      label: 'Rising Learner',       emoji: '🌱' }
  ];

  var TAGLINES = [
    'Train your reflexes. Own the exam.',
    'Speed is a skill. Sharpen it daily.',
    'From practice to percentile.',
    'Every session builds your edge.',
    'Speed Aptitude mastery, one drill at a time.',
    'Precision under pressure.',
    'Challenge accepted. Challenge conquered.',
    'Your brain is your greatest weapon.'
  ];

  function _getPerformanceLabel(accuracy, avgTime) {
    var acc = parseFloat(accuracy) || 0;
    var avg = parseFloat(avgTime) || 999;
    for (var i = 0; i < PERFORMANCE_LABELS.length; i++) {
      var p = PERFORMANCE_LABELS[i];
      if (acc >= p.minAcc && avg <= p.maxAvg) return p;
    }
    return PERFORMANCE_LABELS[PERFORMANCE_LABELS.length - 1];
  }

  function _getRandomTagline() {
    var i = Math.floor(Math.random() * TAGLINES.length);
    return _tx('share.tagline' + (i + 1), TAGLINES[i]);
  }

  /* ---- Canvas Drawing Helpers ---- */

  /** Draw a rounded rectangle path */
  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** Create a linear gradient */
  function _gradient(ctx, x1, y1, x2, y2, stops) {
    var g = ctx.createLinearGradient(x1, y1, x2, y2);
    for (var i = 0; i < stops.length; i++) {
      g.addColorStop(stops[i][0], stops[i][1]);
    }
    return g;
  }

  /** Truncate text to fit width */
  function _truncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var ellipsis = '…';
    while (text.length > 0 && ctx.measureText(text + ellipsis).width > maxWidth) {
      text = text.slice(0, -1);
    }
    return text + ellipsis;
  }

  /* ---- Main Card Generation ---- */

  /**
   * Generate a premium 9:16 portrait share card.
   *
   * @param {object} data
   * @param {string} data.accuracy - e.g. "85"
   * @param {string} data.avgTime - e.g. "3.2"
   * @param {number} data.speedScore - e.g. 72 (honest 0-100 speed score)
   * @param {number} data.score - correct answers
   * @param {number} data.total - total questions
   * @param {number} data.streak - best session streak
   * @param {string} data.mode - e.g. "Reflex Drill"
   * @param {string} data.difficulty - e.g. "medium"
   * @param {string} data.totalTime - e.g. "45.2"
   * @param {string} data.displayName - display name
   * @param {string[]} [data.topics] - topics practiced
   * @returns {HTMLCanvasElement}
   */
  function _generateCard(data) {
    var W = 1080;
    var PAD = 72;
    var CW = W - PAD * 2;
    var FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

    /* ---- Render pass on oversized buffer ---- */
    var BUFFER_H = 1600;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = BUFFER_H;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    /* We draw content first, then produce the final canvas at exact height */
    /* Use a transparent background for now — final bg is drawn at the end */
    ctx.clearRect(0, 0, W, BUFFER_H);

    /* Reusable accent line gradient */
    var lineGrad = _gradient(ctx, PAD + 100, 0, W - PAD - 100, 0, [
      [0, 'rgba(37, 99, 235, 0)'],
      [0.2, 'rgba(37, 99, 235, 0.35)'],
      [0.8, 'rgba(37, 99, 235, 0.35)'],
      [1, 'rgba(37, 99, 235, 0)']
    ]);

    /* ── Spacing constants (consistent vertical rhythm) ── */
    var SEC_GAP = 36;    /* between major sections */
    var INNER_GAP = 14;  /* within a section */

    var y = 56; /* top padding */
    ctx.textAlign = 'center';

    /* ════════════════════════════════
       SECTION 1 — BRAND HEADER
       ════════════════════════════════ */
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 42px ' + FONT;
    ctx.fillText('QuantReflex', W / 2, y);
    y += 30;

    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.font = '20px ' + FONT;
    ctx.fillText(_t('share.brandSub'), W / 2, y);
    y += 28;

    /* Divider */
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD + 100, y);
    ctx.lineTo(W - PAD - 100, y);
    ctx.stroke();
    y += SEC_GAP;

    /* ════════════════════════════════
       SECTION 2 — PLAYER IDENTITY
       ════════════════════════════════ */
    if (data.displayName) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
      ctx.font = '26px ' + FONT;
      ctx.fillText(_truncate(ctx, data.displayName, CW - 80), W / 2, y);
      y += INNER_GAP + 6;
    }

    /* ════════════════════════════════
       SECTION 3 — PERFORMANCE LABEL + MODE PILL
       ════════════════════════════════ */
    var perf = _getPerformanceLabel(data.accuracy, data.avgTime);
    y += 16;
    ctx.fillStyle = '#3b82f6';
    ctx.font = 'bold 32px ' + FONT;
    ctx.fillText(perf.emoji + '  ' + _tx('share.perf_' + perf.key, perf.label), W / 2, y);
    y += 30; /* equal breathing before pill */

    /* Mode + Difficulty pill */
    var modeText = (data.mode || _t('share.modePractice')).toUpperCase();
    if (data.difficulty && data.difficulty !== 'medium') {
      modeText += '  ·  ' + _diffLabel(data.difficulty).toUpperCase();
    }
    ctx.font = '600 18px ' + FONT;
    var pillW = ctx.measureText(modeText).width + 36;
    var pillH = 28;
    _roundRect(ctx, (W - pillW) / 2, y - pillH / 2 - 2, pillW, pillH, pillH / 2);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(147, 197, 253, 0.8)';
    ctx.fillText(modeText, W / 2, y);
    y += 30; /* equal breathing after pill */

    /* ════════════════════════════════
       SECTION 4 — HERO SCORE BLOCK
       Grouped as one cohesive unit:
       [  BIG %  ]
       [ ACCURACY ]
       [ X of Y correct ]
       ════════════════════════════════ */

    /* Big percentage — 120px bold */
    var accText = data.accuracy + '%';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 120px ' + FONT;
    /* For 120px font, ascent ≈ 90px. Place baseline so text is optically centered */
    var scoreBL = y + 88;
    ctx.fillText(accText, W / 2, scoreBL);

    /* ACCURACY label — tight beneath */
    ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
    ctx.font = '600 20px ' + FONT;
    ctx.fillText(_t('share.accuracySpaced'), W / 2, scoreBL + 28);

    /* Score fraction */
    ctx.fillStyle = 'rgba(226, 232, 240, 0.45)';
    ctx.font = '24px ' + FONT;
    ctx.fillText(_t('share.scoreFraction', { score: data.score, total: data.total }), W / 2, scoreBL + 56);

    y = scoreBL + 56 + SEC_GAP;

    /* ════════════════════════════════
       SECTION 5 — STATS GRID (2×2)
       Cards with true vertical centering
       ════════════════════════════════ */
    var stats = [
      { value: data.avgTime + 's', label: _t('drill.avgTime') },
      { value: '' + data.streak,   label: _t('drill.bestStreak') },
      { value: data.totalTime + 's', label: _t('drill.totalTime') },
      { value: '' + data.total,    label: _t('drill.questionsLbl', { count: data.total }) }
    ];

    var colGap = 14;
    var rowGap = 12;
    var sCardW = Math.floor((CW - colGap) / 2);
    var sCardH = 104; /* taller for proper breathing */

    /* Vertical centering math:
       Content block = value (36px ascent ~27) + 14px gap + label (18px ascent ~14) = ~55px
       Top offset = (104 - 55) / 2 ≈ 24
       Value baseline = 24 + 27 = 51
       Label baseline = 51 + 14 + 14 = 79 */
    var valOff = 50;
    var lblOff = 78;

    for (var si = 0; si < stats.length; si++) {
      var col = si % 2;
      var row = Math.floor(si / 2);
      var sx = PAD + col * (sCardW + colGap);
      var sy = y + row * (sCardH + rowGap);

      /* Card bg */
      _roundRect(ctx, sx, sy, sCardW, sCardH, 16);
      ctx.fillStyle = 'rgba(30, 41, 59, 0.45)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();

      /* Value — centered */
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 36px ' + FONT;
      ctx.fillText(stats[si].value, sx + sCardW / 2, sy + valOff);

      /* Label — centered */
      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.font = '18px ' + FONT;
      ctx.fillText(stats[si].label, sx + sCardW / 2, sy + lblOff);
    }
    y += (sCardH * 2) + rowGap + SEC_GAP;

    /* ════════════════════════════════
       SECTION 6 — SPEED SCORE
       Narrower width, visually integrated
       ════════════════════════════════ */
    if (data.speedScore > 0) {
      var benchW = Math.min(CW, 720); /* narrower than full width */
      var benchX = (W - benchW) / 2;
      var benchH = 56;
      _roundRect(ctx, benchX, y, benchW, benchH, 14);
      var benchGrad = _gradient(ctx, benchX, y, benchX + benchW, y, [
        [0, 'rgba(37, 99, 235, 0.08)'],
        [1, 'rgba(37, 99, 235, 0.03)']
      ]);
      ctx.fillStyle = benchGrad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.fillStyle = '#93c5fd';
      ctx.font = 'bold 24px ' + FONT;
      ctx.fillText('⚡ Speed Score ' + data.speedScore + '/100', W / 2, y + 35);
      y += benchH + SEC_GAP - 8;
    }

    /* ════════════════════════════════
       SECTION 7 — TOPIC CHIPS
       ════════════════════════════════ */
    if (data.topics && data.topics.length > 0) {
      ctx.font = '18px ' + FONT;
      var chipTexts = data.topics.slice(0, 5);
      var chipPadH = 20;
      var chipGap = 8;
      var chipH = 30;

      /* Measure chip widths */
      var totalChipW = 0;
      var chipWidths = [];
      for (var ci = 0; ci < chipTexts.length; ci++) {
        var cw = ctx.measureText(chipTexts[ci]).width + chipPadH * 2;
        chipWidths.push(cw);
        totalChipW += cw + (ci > 0 ? chipGap : 0);
      }

      /* Overflow: truncate to 3 + count */
      if (totalChipW > CW) {
        chipTexts = data.topics.slice(0, 3);
        if (data.topics.length > 3) chipTexts.push('+' + (data.topics.length - 3));
        totalChipW = 0;
        chipWidths = [];
        for (var cj = 0; cj < chipTexts.length; cj++) {
          var cw2 = ctx.measureText(chipTexts[cj]).width + chipPadH * 2;
          chipWidths.push(cw2);
          totalChipW += cw2 + (cj > 0 ? chipGap : 0);
        }
      }

      var chipX = (W - totalChipW) / 2;
      for (var ck = 0; ck < chipTexts.length; ck++) {
        _roundRect(ctx, chipX, y, chipWidths[ck], chipH, chipH / 2);
        ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.16)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(147, 197, 253, 0.6)';
        ctx.font = '18px ' + FONT;
        ctx.fillText(chipTexts[ck], chipX + chipWidths[ck] / 2, y + 20);

        chipX += chipWidths[ck] + chipGap;
      }
      y += chipH + SEC_GAP - 6;
    }

    /* ════════════════════════════════
       SECTION 8 — FOOTER GROUP
       Tagline + divider + URL as one unit
       ════════════════════════════════ */
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.font = 'italic 22px ' + FONT;
    ctx.fillText('"' + _getRandomTagline() + '"', W / 2, y);
    y += 28;

    /* Bottom divider */
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD + 100, y);
    ctx.lineTo(W - PAD - 100, y);
    ctx.stroke();
    y += 28;

    /* URL */
    ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
    ctx.font = '20px ' + FONT;
    ctx.fillText('quantreflex.app', W / 2, y);
    y += 44; /* bottom padding */

    /* ════════════════════════════════
       FINAL — Produce trimmed canvas
       Background, glows, and content at exact height
       ════════════════════════════════ */
    var finalH = y;
    var out = document.createElement('canvas');
    out.width = W;
    out.height = finalH;
    var oc = out.getContext('2d');
    if (!oc) return canvas;

    /* 1. Background gradient at exact final height */
    var bgGrad = _gradient(oc, 0, 0, 0, finalH, [
      [0, '#080c18'],
      [0.35, '#0c1225'],
      [0.65, '#0e1630'],
      [1, '#080c18']
    ]);
    oc.fillStyle = bgGrad;
    oc.fillRect(0, 0, W, finalH);

    /* 2. Accent glows positioned relative to final height */
    var g1 = oc.createRadialGradient(W - 80, 140, 30, W - 80, 140, 380);
    g1.addColorStop(0, 'rgba(37, 99, 235, 0.12)');
    g1.addColorStop(1, 'rgba(37, 99, 235, 0)');
    oc.fillStyle = g1;
    oc.fillRect(0, 0, W, finalH);

    var g2 = oc.createRadialGradient(140, finalH - 160, 20, 140, finalH - 160, 300);
    g2.addColorStop(0, 'rgba(37, 99, 235, 0.06)');
    g2.addColorStop(1, 'rgba(37, 99, 235, 0)');
    oc.fillStyle = g2;
    oc.fillRect(0, 0, W, finalH);

    /* 3. Composite content on top */
    oc.drawImage(canvas, 0, 0, W, finalH, 0, 0, W, finalH);

    return out;
  }

  /* ---- Share Preview Modal ---- */

  function _createPreviewModal(canvas, data) {
    /* Overlay */
    var overlay = document.createElement('div');
    overlay.className = 'share-preview-overlay';
    overlay.innerHTML =
      '<div class="share-preview-modal" role="dialog" aria-modal="true" aria-label="' + _t('share.previewTitle') + '">' +
        '<div class="share-preview-header">' +
          '<h3 class="share-preview-title">🏆 ' + _t('share.previewTitle') + '</h3>' +
          '<button class="share-preview-close" aria-label="' + _t('share.closeAria') + '">&times;</button>' +
        '</div>' +
        '<div class="share-preview-canvas-wrap"></div>' +
        '<div class="share-preview-actions"></div>' +
      '</div>';

    var canvasWrap = overlay.querySelector('.share-preview-canvas-wrap');
    var previewImg = document.createElement('img');
    previewImg.className = 'share-preview-img';
    previewImg.alt = _t('share.cardAlt');
    previewImg.src = canvas.toDataURL('image/png');
    canvasWrap.appendChild(previewImg);

    /* Action buttons */
    var actionsDiv = overlay.querySelector('.share-preview-actions');

    /* Share button */
    var shareBtn = document.createElement('button');
    shareBtn.className = 'btn accent share-action-btn';
    shareBtn.textContent = '📤 ' + _t('share.shareBtn');
    shareBtn.addEventListener('click', function () {
      _doShare(canvas, data);
    });
    actionsDiv.appendChild(shareBtn);

    /* Save button */
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn share-action-btn';
    saveBtn.textContent = '💾 ' + _t('share.saveBtn');
    saveBtn.addEventListener('click', function () {
      _doSaveImage(canvas);
    });
    actionsDiv.appendChild(saveBtn);

    /* Regenerate button */
    var regenBtn = document.createElement('button');
    regenBtn.className = 'btn share-action-btn share-action-regen';
    regenBtn.textContent = '🔄 ' + _t('share.newCardBtn');
    regenBtn.addEventListener('click', function () {
      var newCanvas = _generateCard(data);
      if (newCanvas) {
        previewImg.src = newCanvas.toDataURL('image/png');
        canvas = newCanvas;
      }
    });
    actionsDiv.appendChild(regenBtn);

    /* Show with animation, lifecycle via the shared controller (FW-W1) — gains Escape, focus-trap
       and focus-restore this modal never had. The .closing class mirrors the entrance transition. */
    document.body.appendChild(overlay);
    var handle = QROverlay.open(overlay, {
      dialogEl: overlay.querySelector('.share-preview-modal'),
      removeOnClose: true, closingClass: 'closing', closeMs: 250,
      initialFocus: '.share-preview-close'
    });
    overlay.querySelector('.share-preview-close').addEventListener('click', function () {
      handle.close();
    });
    requestAnimationFrame(function () {
      overlay.classList.add('share-preview-visible');
    });
  }

  /* ---- Share / Save Actions ---- */

  function _doShare(canvas, data) {
    canvas.toBlob(function (blob) {
      if (!blob) {
        shareTextFallback(data.accuracy, data.speedScore);
        return;
      }
      var file = new File([blob], 'quantreflex-achievement.png', { type: 'image/png' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({
          files: [file],
          title: _t('share.shareTitle'),
          text: _t('share.shareText', { acc: data.accuracy })
        }).catch(function () {
          _doSaveImage(canvas);
        });
      } else {
        _doSaveImage(canvas);
      }
    }, 'image/png');
  }

  function _doSaveImage(canvas) {
    canvas.toBlob(function (blob) {
      if (!blob) {
        if (typeof showToast === 'function') showToast(_t('share.errImage'));
        return;
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'quantreflex-achievement.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      if (typeof showToast === 'function') showToast('✅ ' + _t('share.savedImgToast'));
    }, 'image/png');
  }

  /* ---- Public API ---- */

  /**
   * Generate and show the premium share card preview.
   *
   * @param {object} data - Session data object
   */
  function shareAsImage(data) {
    /* Backwards compatibility: old 3-arg signature (accuracy, avg, speedScore) */
    if (typeof data === 'string') {
      data = {
        accuracy: arguments[0],
        avgTime: arguments[1],
        speedScore: arguments[2],
        score: 0,
        total: 0,
        streak: 0,
        mode: 'Practice',
        difficulty: 'medium',
        totalTime: '0',
        displayName: ''
      };
    }

    var canvas = _generateCard(data);
    if (!canvas) {
      shareTextFallback(data.accuracy, data.speedScore);
      return;
    }

    _createPreviewModal(canvas, data);
  }

  /**
   * Premium esports-style Math Duel share card.
   * Two frosted player blocks (avatar · name · big score · accuracy · speed), a centered VS badge,
   * a winner banner + gold avatar ring, drawn over a dark gradient with accent glows.
   */
  function _generateDuelCard(data) {
    var W = 1080;
    var PAD = 72;
    var CW = W - PAD * 2;
    var FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';
    var BUFFER_H = 1400;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = BUFFER_H;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, W, BUFFER_H);

    var isDraw = data.result === 'draw';
    var myName = String(data.myName || _t('share.you'));
    var opName = String(data.opName || _t('share.opponent'));
    var isWinner = data.winner === data.myUid;

    /* ---- local draw helpers (closure over ctx) ---- */
    function fillRR(x, yy, w, h, r, fill) { _roundRect(ctx, x, yy, w, h, r); ctx.fillStyle = fill; ctx.fill(); }
    function strokeRR(x, yy, w, h, r, col, lw) { _roundRect(ctx, x, yy, w, h, r); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); }
    function cleanSpd(s) { s = String(s == null ? '' : s); if (s.indexOf('No data') >= 0 || s === '') return '—'; return s.replace('/q', ''); }
    function avatar(cx, cy, r, c1, c2, initial) {
      var g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold ' + Math.round(r * 0.95) + 'px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(_duelInitial(initial), cx, cy + 2);
      ctx.textBaseline = 'alphabetic';
    }

    var y = 100;
    ctx.textAlign = 'center';

    /* ── Brand header ── */
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px ' + FONT;
    ctx.fillText('QuantReflex', W / 2, y);
    y += 38;
    ctx.fillStyle = '#60a5fa';
    ctx.font = '600 22px ' + FONT;
    ctx.fillText('M A T H   D U E L', W / 2, y);
    y += 64;

    /* ── Winner banner ── */
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 56px ' + FONT;
    var bannerText = isDraw ? _t('share.draw') : _t('share.wins', { name: isWinner ? myName : opName });
    ctx.fillText((isDraw ? '🤝 ' : '👑 ') + _truncate(ctx, bannerText, CW - 110), W / 2, y);
    y += 72;

    /* ── Player cards ── */
    var cardW = 392;
    var cardH = 472;
    var card1X = PAD;
    var card2X = W - PAD - cardW;
    var yC = y;
    var glowX = null, glowY = null;

    function drawPlayer(cardX, name, score, accStr, spdStr, c1, c2, isW) {
      var cx = cardX + cardW / 2;
      fillRR(cardX, yC, cardW, cardH, 28, isW ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)');
      strokeRR(cardX, yC, cardW, cardH, 28, isW ? 'rgba(251,191,36,0.9)' : 'rgba(255,255,255,0.08)', isW ? 3 : 1.5);
      var ay = yC + 104;
      if (isW) { ctx.beginPath(); ctx.arc(cx, ay, 70, 0, Math.PI * 2); ctx.closePath(); ctx.fillStyle = 'rgba(251,191,36,0.20)'; ctx.fill(); }
      avatar(cx, ay, 58, c1, c2, name);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f1f5f9'; ctx.font = '600 30px ' + FONT;
      ctx.fillText(_truncate(ctx, name, cardW - 56), cx, yC + 210);
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 96px ' + FONT;
      ctx.fillText(String(score), cx, yC + 318);
      ctx.fillStyle = '#64748b'; ctx.font = '600 19px ' + FONT;
      ctx.fillText(_t('share.correctSpaced'), cx, yC + 354);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cardX + 40, yC + 384); ctx.lineTo(cardX + cardW - 40, yC + 384); ctx.stroke();
      var lx = cardX + cardW * 0.30, rx = cardX + cardW * 0.70;
      ctx.fillStyle = '#94a3b8'; ctx.font = '600 18px ' + FONT;
      ctx.fillText(_t('share.accuracyShort'), lx, yC + 420);
      ctx.fillText(_t('share.speedShort'), rx, yC + 420);
      ctx.fillStyle = '#e2e8f0'; ctx.font = 'bold 30px ' + FONT;
      ctx.fillText(accStr, lx, yC + 456);
      ctx.fillText(spdStr, rx, yC + 456);
      if (isW) { glowX = cx; glowY = ay; }
    }

    drawPlayer(card1X, myName, data.myScore, data.myAccuracy + '%', cleanSpd(data.mySpeed), '#3b82f6', '#2563eb', isWinner && !isDraw);
    drawPlayer(card2X, opName, data.opScore, data.opAccuracy + '%', cleanSpd(data.opSpeed), '#fb7185', '#f43f5e', !isWinner && !isDraw);

    /* VS badge centered in the gap, aligned to the avatars */
    var vsY = yC + 104;
    ctx.beginPath(); ctx.arc(W / 2, vsY, 42, 0, Math.PI * 2); ctx.closePath();
    ctx.fillStyle = '#0b1220'; ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,0.40)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#cbd5e1'; ctx.font = 'bold 30px ' + FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('VS', W / 2, vsY + 1); ctx.textBaseline = 'alphabetic';

    y = yC + cardH + 58;

    /* ── Footer ── */
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e2e8f0'; ctx.font = '600 30px ' + FONT;
    ctx.fillText(_t('share.duelCta'), W / 2, y);
    y += 44;
    ctx.fillStyle = 'rgba(148,163,184,0.75)'; ctx.font = '24px ' + FONT;
    ctx.fillText('quantreflex.app', W / 2, y);
    y += 64;

    /* ── Compose final canvas: gradient bg + accent glows under the content buffer ── */
    var H = Math.ceil(y);
    var finalCanvas = document.createElement('canvas');
    finalCanvas.width = W;
    finalCanvas.height = H;
    var fctx = finalCanvas.getContext('2d');
    var bgGrad = fctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#0b1220');
    bgGrad.addColorStop(0.5, '#0f172a');
    bgGrad.addColorStop(1, '#020617');
    fctx.fillStyle = bgGrad;
    fctx.fillRect(0, 0, W, H);
    function radial(cx, cy, r, col) {
      var g = fctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      fctx.fillStyle = g; fctx.fillRect(0, 0, W, H);
    }
    radial(180, 230, 440, 'rgba(59,130,246,0.16)');
    radial(900, 250, 440, 'rgba(244,63,94,0.13)');
    if (glowX != null) radial(glowX, glowY, 360, 'rgba(251,191,36,0.18)');
    fctx.drawImage(canvas, 0, 0, W, H, 0, 0, W, H);
    return finalCanvas;
  }

  /** First letter for a duel avatar (mirrors DuelUI._initial). */
  function _duelInitial(name) { var n = String(name || '?').trim(); return n ? n.charAt(0).toUpperCase() : '?'; }

  /**
   * Generate and show the premium share card preview for Duels.
   *
   * @param {object} data - Duel Result data object
   */
  function shareDuelAsImage(data) {
    var canvas = _generateDuelCard(data);
    if (!canvas) {
      shareTextFallback(data.myAccuracy, 0);
      return;
    }
    _createPreviewModal(canvas, data);
  }

  /**
   * Share drill result as text via Web Share API or clipboard.
   *
   * @param {string} accuracy - e.g. "85"
   * @param {number} speedScore - speed score 0-100, e.g. 72
   */
  function shareTextFallback(accuracy, speedScore) {
    var shareText = _t('share.fallbackText', { acc: accuracy, speed: speedScore || 0 });
    if (navigator.share) {
      navigator.share({ text: shareText }).catch(function () {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareText).then(function () {
        if (typeof showToast === 'function') showToast('✅ ' + _t('share.copiedToast'));
      }).catch(function () {
        if (typeof showToast === 'function') showToast(_t('share.copyFailed'));
      });
    } else {
      if (typeof showToast === 'function') showToast(_t('share.notSupported'));
    }
  }

  return {
    shareAsImage: shareAsImage,
    shareDuelAsImage: shareDuelAsImage,
    shareTextFallback: shareTextFallback
  };
})();
