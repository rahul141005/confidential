/**
 * practice-config.js — Practice session configuration state
 *
 * Extracted from app.js. Manages:
 *   - Custom practice state (topic selection, question count)
 *   - Timer controls (per-question / total timer)
 *   - Adaptive training toggle
 *   - Practice UI reset
 *
 * All functions remain as bare globals for backward compatibility.
 */

/* Custom-practice question-count bounds — the single source of truth for the default (ADR-104: was duplicated as a
   literal 20 on _customPracticeState.totalQuestions). Declared before the state that seeds from it. */
var _CUSTOM_DEFAULT_QUESTIONS = 20;
var _CUSTOM_MIN_QUESTIONS = 1;
var _CUSTOM_MAX_QUESTIONS = 100;
var _customPracticeState = {
  totalQuestions: _CUSTOM_DEFAULT_QUESTIONS
};
var selectedTopics = [];
var _customPracticeDom = {
  slider: null,
  value: null,
  text: null,
  error: null,
  catBtns: null
};
var _customPracticeActive = false;
var _focusModeActive = false;
var _focusSelectedCategory = null;
var _focusSelectedCategoryLabel = null;
var _adaptiveModeActive = false;
var _selectedTimerOption = 'none';
var _timerPillMode = 'per';

/* ---- Timer Config ---- */

function _getTimerConfig() {
  if (!_selectedTimerOption || _selectedTimerOption === 'none') {
    return { timeLimitSec: null, perQuestionSec: null };
  }
  var parts = _selectedTimerOption.split(':');
  if (parts[0] === 'per') {
    return { timeLimitSec: null, perQuestionSec: parseInt(parts[1], 10) };
  }
  if (parts[0] === 'total') {
    return { timeLimitSec: parseInt(parts[1], 10), perQuestionSec: null };
  }
  return { timeLimitSec: null, perQuestionSec: null };
}

function _resetTimerSelection() {
  _selectedTimerOption = 'none';
  _timerPillMode = 'per';
  var toggle = document.getElementById('timerToggle');
  if (toggle) toggle.checked = false;
  var configArea = document.getElementById('timerConfigArea');
  if (configArea) configArea.style.display = 'none';
  var secondsInput = document.getElementById('timerSecondsInput');
  if (secondsInput) secondsInput.value = '15';
  var pills = document.querySelectorAll('.timer-pill');
  for (var i = 0; i < pills.length; i++) {
    pills[i].classList.toggle('active', pills[i].getAttribute('data-pill') === 'per');
  }
}

function _updateTimerOptionFromUI() {
  var toggle = document.getElementById('timerToggle');
  if (!toggle || !toggle.checked) {
    _selectedTimerOption = 'none';
    return;
  }
  var secondsInput = document.getElementById('timerSecondsInput');
  var val = parseInt(secondsInput ? secondsInput.value : '15', 10);
  if (isNaN(val) || val < 5) val = 5;
  if (val > 600) val = 600;
  _selectedTimerOption = _timerPillMode + ':' + val;
}

function _initTimerControls() {
  var toggle = document.getElementById('timerToggle');
  var configArea = document.getElementById('timerConfigArea');
  var pillContainer = document.querySelector('.timer-pill-selector');
  var secondsInput = document.getElementById('timerSecondsInput');
  if (!toggle) return;

  toggle.addEventListener('change', function () {
    if (this.checked && _focusModeActive && (typeof canAccessFeature !== 'function' || !canAccessFeature('focus_timer'))) {
      this.checked = false;
      if (typeof showPaywall === 'function') showPaywall('focus_timer');
      return;
    }
    if (configArea) configArea.style.display = this.checked ? 'block' : 'none';
    _updateTimerOptionFromUI();
    if (typeof SoundEngine !== 'undefined') SoundEngine.play('settingsToggle');
  });

  if (pillContainer) {
    pillContainer.addEventListener('click', function (e) {
      var pill = e.target.closest('.timer-pill');
      if (!pill) return;
      var pills = pillContainer.querySelectorAll('.timer-pill');
      for (var i = 0; i < pills.length; i++) pills[i].classList.remove('active');
      pill.classList.add('active');
      _timerPillMode = pill.getAttribute('data-pill');
      _updateTimerOptionFromUI();
      if (typeof SoundEngine !== 'undefined') SoundEngine.play('settingsToggle');
    });
  }

  if (secondsInput) {
    secondsInput.addEventListener('change', function () { _updateTimerOptionFromUI(); });
    secondsInput.addEventListener('input', function () { _updateTimerOptionFromUI(); });
  }
}

/* ---- Adaptive Toggle ---- */

function _resetAdaptiveToggle() {
  _adaptiveModeActive = false;
  var toggle = document.getElementById('adaptiveTrainingToggle');
  if (toggle) toggle.checked = false;
  var hint = document.getElementById('adaptiveHint');
  if (hint) hint.style.display = 'none';
  var diffRow = document.getElementById('difficultySettingsRow');
  if (diffRow) diffRow.style.display = '';
  var diffSel = document.getElementById('difficultySelect');
  if (diffSel) { diffSel.disabled = false; diffSel.title = ''; }
}

function _initAdaptiveToggle() {
  var toggle = document.getElementById('adaptiveTrainingToggle');
  if (!toggle) return;

  var labelEl = document.querySelector('#adaptiveTrainingSection .timer-toggle-label');
  if (labelEl) {
    var isPrem = typeof canAccessFeature === 'function' ? canAccessFeature('adaptive_training') : false;
    if (!isPrem) {
      if (!labelEl.querySelector('.adaptive-lock')) {
        var lockSpan = document.createElement('span');
        lockSpan.className = 'adaptive-lock';
        lockSpan.textContent = ' 🔒';
        lockSpan.setAttribute('aria-label', QRI18n.t('practice.premiumRequiredAria'));
        labelEl.appendChild(lockSpan);
      }
    } else {
      var existing = labelEl.querySelector('.adaptive-lock');
      if (existing) existing.remove();
    }
  }

  toggle.addEventListener('change', function () {
    if (this.checked) {
      if (typeof canAccessFeature === 'function' && !canAccessFeature('adaptive_training')) {
        this.checked = false;
        if (typeof showPaywall === 'function') showPaywall('adaptive_training');
        return;
      }
      _adaptiveModeActive = true;
      var hint = document.getElementById('adaptiveHint');
      if (hint) hint.style.display = 'block';
      var diffRow = document.getElementById('difficultySettingsRow');
      if (diffRow) diffRow.style.display = 'none';
      var diffSel = document.getElementById('difficultySelect');
      if (diffSel) { diffSel.disabled = true; diffSel.title = QRI18n.t('practice.adaptiveManagedTitle'); }
    } else {
      _adaptiveModeActive = false;
      var hint2 = document.getElementById('adaptiveHint');
      if (hint2) hint2.style.display = 'none';
      var diffRow2 = document.getElementById('difficultySettingsRow');
      if (diffRow2) diffRow2.style.display = '';
      var diffSel2 = document.getElementById('difficultySelect');
      if (diffSel2) { diffSel2.disabled = false; diffSel2.title = ''; }
    }
    if (typeof SoundEngine !== 'undefined') SoundEngine.play('settingsToggle');
  });
}

/* ---- Custom Practice Topic Selection ---- */

function _toggleCustomPracticeTopic(topicKey) {
  if (!topicKey) return;
  var idx = selectedTopics.indexOf(topicKey);
  if (idx === -1) selectedTopics.push(topicKey);
  else selectedTopics.splice(idx, 1);
}

function _syncCustomPracticeSelectionUi() {
  var catBtns = _getCustomPracticeCategoryButtons();
  if (!catBtns) return;
  var availableTopics = {};
  for (var j = 0; j < catBtns.length; j++) {
    var key = catBtns[j].getAttribute('data-cat');
    if (key) availableTopics[key] = true;
  }
  var normalized = [];
  for (var k = 0; k < selectedTopics.length; k++) {
    var topic = selectedTopics[k];
    if (availableTopics[topic] && normalized.indexOf(topic) === -1) {
      normalized.push(topic);
    }
  }
  if (normalized.length !== selectedTopics.length) {
    selectedTopics.splice.apply(selectedTopics, [0, selectedTopics.length].concat(normalized));
  }
  for (var i = 0; i < catBtns.length; i++) {
    var topicKey = catBtns[i].getAttribute('data-cat');
    catBtns[i].classList.toggle('selected', selectedTopics.indexOf(topicKey) !== -1);
  }
}

function _getCustomPracticeCategoryButtons() {
  _customPracticeDom.catBtns = document.querySelectorAll('#categorySelect .category-btn');
  return _customPracticeDom.catBtns;
}

function _ensureCustomPracticeDomCached() {
  if (!_customPracticeDom.slider) _customPracticeDom.slider = document.getElementById('customQuestionCount');
  if (!_customPracticeDom.value) _customPracticeDom.value = document.getElementById('customQuestionCountValue');
  if (!_customPracticeDom.text) _customPracticeDom.text = document.getElementById('customQuestionCountText');
  if (!_customPracticeDom.error) _customPracticeDom.error = document.getElementById('customModeError');
  _getCustomPracticeCategoryButtons();
}

function _updateCustomQuestionCountUI() {
  _ensureCustomPracticeDomCached();
  var valueEl = _customPracticeDom.value;
  var textEl = _customPracticeDom.text;
  if (valueEl) valueEl.textContent = String(_customPracticeState.totalQuestions);
  if (textEl) textEl.textContent = QRI18n.t('practice.youWillSolve', { count: _customPracticeState.totalQuestions });
}

function _resetCustomPracticeState() {
  _ensureCustomPracticeDomCached();
  selectedTopics.splice(0, selectedTopics.length);
  _customPracticeState.totalQuestions = _CUSTOM_DEFAULT_QUESTIONS;
  var slider = _customPracticeDom.slider;
  if (slider) slider.value = String(_CUSTOM_DEFAULT_QUESTIONS);
  _updateCustomQuestionCountUI();
  var customErr = _customPracticeDom.error;
  if (customErr) customErr.textContent = '';
  _syncCustomPracticeSelectionUi();
}

/* ---- Practice UI Reset ---- */

function _resetPracticeUiToModes() {
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('PRACTICE', '_resetPracticeUiToModes', 'start');
    }
  } catch (_) {}
  _customPracticeActive = false;
  _focusModeActive = false;
  _focusSelectedCategory = null;
  _focusSelectedCategoryLabel = null;
  var modeSelect = document.getElementById('modeSelect');
  var categorySelect = document.getElementById('categorySelect');
  var customPracticeConfig = document.getElementById('customPracticeConfig');
  var drillContainer = document.getElementById('drillContainer');
  var focusStartSec = document.getElementById('focusStartSection');
  var catTitle = document.getElementById('categorySelectTitle');
  if (modeSelect) modeSelect.style.display = 'block';
  if (categorySelect) categorySelect.style.display = 'none';
  if (customPracticeConfig) customPracticeConfig.style.display = 'none';
  if (focusStartSec) focusStartSec.style.display = 'none';
  if (catTitle) catTitle.textContent = QRI18n.t('practice.chooseCategory');
  if (drillContainer) {
    drillContainer.style.display = 'none';
    drillContainer.classList.remove('drill-results-active');
    drillContainer.innerHTML = '';
  }
  _resetTimerSelection();
  _resetAdaptiveToggle();
  _resetCustomPracticeState();
  var limitBanner = document.querySelector('.daily-limit-banner');
  if (limitBanner && limitBanner.parentNode) limitBanner.parentNode.removeChild(limitBanner);
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('PRACTICE', '_resetPracticeUiToModes', 'completed');
    }
  } catch (_) {}
}
