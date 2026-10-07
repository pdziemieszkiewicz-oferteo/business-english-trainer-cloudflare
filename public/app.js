(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    lessonSelect: $('lessonSelect'), lessonMeta: $('lessonMeta'), lessonFile: $('lessonFile'),
    modeButtons: [...document.querySelectorAll('.mode-btn')], modeName: $('modeName'),
    counter: $('counter'), difficultyCounts: $('difficultyCounts'), phaseLabel: $('phaseLabel'), progressBar: $('progressBar'),
    sentenceText: $('sentenceText'), translationText: $('translationText'), timer: $('timer'), timerHint: $('timerHint'),
    prevBtn: $('prevBtn'), playBtn: $('playBtn'), repeatBtn: $('repeatBtn'), nextBtn: $('nextBtn'),
    easyBtn: $('easyBtn'), hardBtn: $('hardBtn'), ratingStatus: $('ratingStatus'), rideScreenBtn: $('rideScreenBtn'),
    voiceSelect: $('voiceSelect'), testVoiceBtn: $('testVoiceBtn'), voiceInfo: $('voiceInfo'),
    polishVoiceSelect: $('polishVoiceSelect'), testPolishVoiceBtn: $('testPolishVoiceBtn'), polishVoiceInfo: $('polishVoiceInfo'), translationSeconds: $('translationSeconds'),
    speechRate: $('speechRate'), speechRateValue: $('speechRateValue'),
    repetitionCount: $('repetitionCount'), pauseSeconds: $('pauseSeconds'), recallSeconds: $('recallSeconds'), businessSeconds: $('businessSeconds'), endWarningSeconds: $('endWarningSeconds'),
    shuffleEnabled: $('shuffleEnabled'), filterEasy: $('filterEasy'), filterHard: $('filterHard'), filterNone: $('filterNone'), wakeLockEnabled: $('wakeLockEnabled'), mediaControlsEnabled: $('mediaControlsEnabled'),
    refreshLessonsBtn: $('refreshLessonsBtn'), syncKeyInput: $('syncKeyInput'), generateSyncKeyBtn: $('generateSyncKeyBtn'),
    saveSyncKeyBtn: $('saveSyncKeyBtn'), copySyncKeyBtn: $('copySyncKeyBtn'), syncInfo: $('syncInfo'), syncBadge: $('syncBadge'),
    exportProgressBtn: $('exportProgressBtn'), progressFile: $('progressFile'), resetProgressBtn: $('resetProgressBtn'), stats: $('stats'),
    installBtn: $('installBtn'), rideOverlay: $('rideOverlay'), rideOverlayStatus: $('rideOverlayStatus'),
    showEnglishInPL: $('showEnglishInPL'), syncNowBtn: $('syncNowBtn'), syncConflict: $('syncConflict'),
    syncConflictText: $('syncConflictText'), useServerBtn: $('useServerBtn'), useDeviceBtn: $('useDeviceBtn'),
    exportBackupBtn: $('exportBackupBtn')
  };

  const STORE_KEY = 'ceoEnglishRideTrainerV6';
  const LEGACY_STORE_KEY = 'ceoEnglishRideTrainerV5';
  const APP_VERSION = '7.4';
  const MANUAL_REPLAY_BONUS_SECONDS = 2;
  const MODE_NAMES = { R: 'Repeat', A: 'Active Recall', B: 'Business Response', P: 'Translate & Recall (PL → EN)' };

  let state = loadState();
  let serverConfig = { backend: '' };
  let manifest = { lessons: [] };
  let lesson = null;
  let queue = [];
  let queuePos = 0;
  let running = false;
  let paused = false;
  let currentAbort = 0;
  let countdownTimer = null;
  let wakeLock = null;
  let deferredInstallPrompt = null;
  let audioCtx = null;
  let controlAudio = null;
  let controlAudioUrl = null;
  let voices = [];
  let syncTimer = null;
  let syncBusy = false;
  let conflict = null;
  let syncEpoch = 0;
  let syncCurrentPromise = null;
  let syncPromiseLessonId = null;

  function defaultState() {
    return {
      settings: {
        mode: 'R', repetitions: 2, pauseSeconds: 7, recallSeconds: 7, businessSeconds: 15, endWarningSeconds: 2,
        beep: true, shuffle: false, hardOnly: false, filterEasy: true, filterHard: true, filterNone: true, wakeLock: true, mediaControls: true, speechRate: 0.9, voiceURI: '', plVoiceURI: '', translationSeconds: 5, showEnglishInPL: true
      },
      lessons: {},
      lastLessonId: null,
      localLessons: {},
      syncKey: '',
      syncMeta: {},
      migrationBackups: {}
    };
  }

  function deepMergeState(raw) {
    const d = defaultState();
    const incomingSettings = raw?.settings || {};
    const settings = { ...d.settings, ...incomingSettings };
    // Migration from the previous single "Difficult exercises only" switch.
    // Preserve the user's intent the first time V7.4 opens.
    const hasNewDifficultyFilters = ['filterEasy', 'filterHard', 'filterNone'].some(k => Object.prototype.hasOwnProperty.call(incomingSettings, k));
    if (!hasNewDifficultyFilters && incomingSettings.hardOnly === true) {
      settings.filterEasy = false; settings.filterHard = true; settings.filterNone = false;
    }
    settings.hardOnly = false; // legacy field retained only for backward-compatible stored state
    return {
      ...d,
      ...raw,
      settings,
      lessons: raw?.lessons || {},
      localLessons: raw?.localLessons || {},
      syncMeta: raw?.syncMeta || {},
      migrationBackups: raw?.migrationBackups || {}
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem(LEGACY_STORE_KEY) || '{}';
      return deepMergeState(JSON.parse(raw));
    } catch { return defaultState(); }
  }
  function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

  function normalizeText(text) { return String(text || '').trim().replace(/\s+/g, ' '); }
  function hashText(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }
  function exerciseId(mode, promptEn, answerEn) {
    return `e-${hashText(`${mode}|${normalizeText(promptEn).toLowerCase()}|${normalizeText(answerEn).toLowerCase()}`)}`;
  }
  function lessonIdFromFilename(name) { return (name || 'lesson').replace(/\.txt$/i, '').trim() || 'lesson'; }

  function parseLesson(text, filename, explicitId = null, title = null) {
    const exercises = [];
    let lineNo = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      lineNo += 1;
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('|').map(x => x.trim());
      const type = (parts[0] || '').toUpperCase();
      if (type === 'R' && parts.length >= 3) {
        const [_, en, pl] = parts;
        exercises.push({ id: exerciseId('R', en, en), mode: 'R', index: exercises.length + 1, sourceLine: lineNo, promptEn: en, promptPl: pl, answerEn: en, answerPl: pl });
        // Virtual PL→EN exercise shares the existing lesson line; progress remains mode-specific.
        if (pl) exercises.push({ id: exerciseId('P', pl, en), mode: 'P', index: exercises.length + 1, sourceLine: lineNo, promptEn: en, promptPl: pl, answerEn: en, answerPl: pl });
      } else if ((type === 'A' || type === 'B') && parts.length >= 5) {
        const [_, promptEn, promptPl, answerEn, answerPl] = parts;
        exercises.push({ id: exerciseId(type, promptEn, answerEn), mode: type, index: exercises.length + 1, sourceLine: lineNo, promptEn, promptPl, answerEn, answerPl });
      } else if (parts.length === 1 && line) {
        // Backward-compatible old lesson format: one English sentence per line.
        exercises.push({ id: exerciseId('R', line, line), mode: 'R', index: exercises.length + 1, sourceLine: lineNo, promptEn: line, promptPl: '', answerEn: line, answerPl: '' });
      }
    }
    const id = explicitId || lessonIdFromFilename(filename);
    return { id, title: title || id, filename, exercises, loadedAt: new Date().toISOString() };
  }

  function emptyExerciseProgress(ex) {
    return { id: ex.id, mode: ex.mode, played: 0, easy: 0, hard: 0, score: null, lastPracticedAt: null, lastRating: null, lastRatedAt: null };
  }

  function reconcileProgress(currentLesson) {
    const old = state.lessons[currentLesson.id] || {
      lessonId: currentLesson.id, sessions: 0, totalPlays: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), exercises: {}
    };
    const next = {};
    for (const ex of currentLesson.exercises) next[ex.id] = old.exercises?.[ex.id] ? { ...old.exercises[ex.id], mode: ex.mode } : emptyExerciseProgress(ex);
    state.lessons[currentLesson.id] = {
      ...old, lessonId: currentLesson.id, inputFile: currentLesson.filename,
      exerciseCount: currentLesson.exercises.length, exercises: next,
      rounds: old.rounds || {},
      updatedAt: old.updatedAt || new Date().toISOString()
    };
    state.lastLessonId = currentLesson.id;
    saveState();
  }

  function touchProgress() {
    const p = getProgress();
    if (p) p.updatedAt = new Date().toISOString();
  }

  function getProgress() { return lesson ? state.lessons[lesson.id] : null; }
  function progressFor(ex) { return getProgress()?.exercises?.[ex.id] || null; }
  function isHard(ex) {
    const p = progressFor(ex);
    return p ? ((p.hard || 0) > (p.easy || 0) || p.lastRating === 'hard') : false;
  }

  function exerciseDifficulty(ex) {
    const p = progressFor(ex);
    if (!p) return 'none';
    if (p.lastRating === 'easy' || p.lastRating === 'hard') return p.lastRating;
    // Legacy fallback for ratings created before lastRating was stored reliably.
    const easy = Number(p.easy || 0), hard = Number(p.hard || 0);
    if (easy === 0 && hard === 0) return 'none';
    return hard > easy ? 'hard' : 'easy';
  }

  function selectedDifficulty(kind) {
    if (kind === 'easy') return state.settings.filterEasy !== false;
    if (kind === 'hard') return state.settings.filterHard !== false;
    return state.settings.filterNone !== false;
  }

  function difficultyFilterActive() {
    return !(state.settings.filterEasy !== false && state.settings.filterHard !== false && state.settings.filterNone !== false);
  }

  function matchesDifficultyFilter(ex) { return selectedDifficulty(exerciseDifficulty(ex)); }

  function difficultyCountsForMode(mode = state.settings.mode) {
    const counts = { none: 0, easy: 0, hard: 0 };
    for (const ex of modeExercises(mode)) counts[exerciseDifficulty(ex)] += 1;
    return counts;
  }

  function compareExercises(a, b) {
    const pa = progressFor(a) || { played: 0, lastPracticedAt: null };
    const pb = progressFor(b) || { played: 0, lastPracticedAt: null };
    if ((pa.played || 0) !== (pb.played || 0)) return (pa.played || 0) - (pb.played || 0);
    const ta = pa.lastPracticedAt ? Date.parse(pa.lastPracticedAt) : 0;
    const tb = pb.lastPracticedAt ? Date.parse(pb.lastPracticedAt) : 0;
    if (ta !== tb) return ta - tb;
    if (state.settings.shuffle) return Math.random() - 0.5;
    return a.index - b.index;
  }

  function modeExercises(mode = state.settings.mode) {
    return lesson ? lesson.exercises.filter(ex => ex.mode === mode) : [];
  }

  function deriveRoundState(mode) {
    const list = modeExercises(mode);
    const p = getProgress();
    if (!list.length || !p) return { round: 1, queueIds: [], position: 0, completedIds: [], updatedAt: new Date().toISOString() };

    // Migration from V4: infer the current round from the lowest repetition count.
    const reps = list.map(ex => p.exercises?.[ex.id]?.played || 0);
    const minReps = Math.min(...reps);
    const completed = list.filter(ex => (p.exercises?.[ex.id]?.played || 0) > minReps);
    const pending = list.filter(ex => (p.exercises?.[ex.id]?.played || 0) === minReps).sort(compareExercises);
    const completedSorted = [...completed].sort((a, b) => {
      const ta = Date.parse(p.exercises?.[a.id]?.lastPracticedAt || 0) || 0;
      const tb = Date.parse(p.exercises?.[b.id]?.lastPracticedAt || 0) || 0;
      return ta - tb || a.index - b.index;
    });
    const queueIds = [...completedSorted, ...pending].map(ex => ex.id);
    return {
      round: minReps + 1,
      queueIds,
      position: Math.min(completedSorted.length, Math.max(0, queueIds.length - 1)),
      completedIds: completedSorted.map(ex => ex.id),
      updatedAt: new Date().toISOString()
    };
  }

  function roundState(mode = state.settings.mode) {
    const p = getProgress();
    if (!p) return null;
    p.rounds = p.rounds || {};
    const currentIds = modeExercises(mode).map(ex => ex.id);
    const saved = p.rounds[mode];
    const savedIds = saved?.queueIds || [];
    const sameSet = savedIds.length === currentIds.length && savedIds.every(id => currentIds.includes(id));
    if (!saved || !sameSet) {
      p.rounds[mode] = deriveRoundState(mode);
      touchProgress();
      saveState();
      scheduleServerPush();
    }
    return p.rounds[mode];
  }

  function createNextRound(mode = state.settings.mode) {
    const p = getProgress();
    if (!p) return null;
    const old = roundState(mode) || { round: 0 };
    const list = modeExercises(mode).sort(compareExercises);
    p.rounds[mode] = {
      round: (old.round || 0) + 1,
      queueIds: list.map(ex => ex.id),
      position: 0,
      completedIds: [],
      updatedAt: new Date().toISOString()
    };
    touchProgress();
    saveState();
    scheduleServerPush();
    return p.rounds[mode];
  }

  function saveRoundPosition() {
    if (!lesson || difficultyFilterActive()) return;
    const rs = roundState();
    if (!rs) return;
    rs.position = Math.max(0, Math.min(queuePos, Math.max(0, queue.length - 1)));
    rs.updatedAt = new Date().toISOString();
    touchProgress();
    saveState();
    scheduleServerPush();
  }

  function buildQueue({ resetPosition = false } = {}) {
    if (!lesson) { queue = []; queuePos = 0; updateUI(); return; }

    const rs = roundState();
    const byId = new Map(modeExercises().map(ex => [ex.id, ex]));
    const fullRoundQueue = (rs?.queueIds || []).map(id => byId.get(id)).filter(Boolean);
    const previousId = currentExercise()?.id || null;

    queue = difficultyFilterActive() ? fullRoundQueue.filter(matchesDifficultyFilter) : fullRoundQueue;

    if (resetPosition) {
      queuePos = 0;
    } else if (difficultyFilterActive()) {
      const previousIndex = previousId ? queue.findIndex(ex => ex.id === previousId) : -1;
      queuePos = previousIndex >= 0 ? previousIndex : Math.min(queuePos, Math.max(0, queue.length - 1));
    } else {
      queuePos = Math.max(0, Math.min(Number(rs?.position || 0), Math.max(0, queue.length - 1)));
    }

    if (resetPosition && rs && !difficultyFilterActive()) {
      rs.position = 0; rs.updatedAt = new Date().toISOString(); touchProgress(); saveState(); scheduleServerPush();
    }
    updateUI();
  }

  function currentExercise() { return queue[queuePos] || null; }

  function displayExercisePart(ex, part = 'prompt') {
    if (!ex) return;
    const useAnswer = part === 'answer';
    const inPL = ex.mode === 'P';
    const status = $('statusCard');
    status.classList.toggle('polish-mode', inPL);
    if (inPL) {
      // PL is the primary line. English is always below it, optionally concealed
      // until the learner has tried to retrieve it.
      if (els.translationText.nextElementSibling !== els.sentenceText) {
        els.sentenceText.before(els.translationText);
      }
      els.translationText.textContent = ex.promptPl || ex.answerPl || '';
      els.sentenceText.textContent = ex.answerEn || '';
      els.sentenceText.hidden = !useAnswer && !state.settings.showEnglishInPL;
    } else {
      if (els.sentenceText.nextElementSibling !== els.translationText) {
        els.sentenceText.after(els.translationText);
      }
      els.sentenceText.hidden = false;
      els.sentenceText.textContent = useAnswer ? ex.answerEn : ex.promptEn;
      els.translationText.textContent = useAnswer ? ex.answerPl : ex.promptPl;
    }
  }

  function updateRatingStatus() {
    const ex = currentExercise();
    const entry = ex ? progressFor(ex) : null;
    const last = entry?.lastRating === 'easy' || entry?.lastRating === 'hard'
      ? entry.lastRating : null;
    els.easyBtn.classList.toggle('last-rated', last === 'easy');
    els.hardBtn.classList.toggle('last-rated', last === 'hard');
    els.easyBtn.setAttribute('aria-label', last === 'easy' ? 'Easy: last rating for this sentence' : 'Rate this sentence Easy');
    els.hardBtn.setAttribute('aria-label', last === 'hard' ? 'Hard: last rating for this sentence' : 'Rate this sentence Hard');
    els.easyBtn.textContent = last === 'easy' ? 'Easy ✓' : 'Easy';
    els.hardBtn.textContent = last === 'hard' ? 'Hard ✓' : 'Hard';

    if (!entry || !last) {
      els.ratingStatus.textContent = ex ? 'Not rated yet' : 'No sentence selected';
      return;
    }
    // V7.1 stored the most recent rating but NOT its date. In particular,
    // lastPracticedAt is updated on every completed exercise, so using it as
    // the rating date would display an incorrect timestamp.
    const parsed = entry.lastRatedAt ? Date.parse(entry.lastRatedAt) : NaN;
    const when = Number.isFinite(parsed)
      ? new Date(parsed).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'date unavailable (rated in an earlier version)';
    els.ratingStatus.textContent = `Last: ${last === 'easy' ? 'Easy' : 'Hard'} · ${when} · Easy ${entry.easy || 0} / Hard ${entry.hard || 0}`;
  }

  function updateUI() {
    els.modeButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === state.settings.mode));
    els.modeName.textContent = MODE_NAMES[state.settings.mode] || state.settings.mode;
    if (!lesson) {
      els.lessonMeta.textContent = '';
      els.counter.textContent = '—'; if (els.difficultyCounts) els.difficultyCounts.textContent = '— / — / —'; els.progressBar.style.width = '0%'; els.stats.innerHTML = '';
      els.sentenceText.hidden = false; $('statusCard').classList.remove('polish-mode');
      els.sentenceText.textContent = 'No lesson loaded.'; els.translationText.textContent = '';
      updateRatingStatus();
      return;
    }
    const allForMode = lesson.exercises.filter(x => x.mode === state.settings.mode);
    els.lessonMeta.textContent = `${allForMode.length} exercises in ${MODE_NAMES[state.settings.mode]}`;
    const ex = currentExercise();
    if (ex) {
      const rs = roundState();
      const roundNo = rs?.round || 1;
      els.counter.textContent = `${queuePos + 1} / ${queue.length} · Round ${roundNo}`;
      const dc = difficultyCountsForMode();
      if (els.difficultyCounts) { els.difficultyCounts.textContent = `${dc.none} / ${dc.easy} / ${dc.hard}`; els.difficultyCounts.title = 'None / Easy / Hard'; }
      els.progressBar.style.width = `${((queuePos + 1) / Math.max(1, queue.length)) * 100}%`;
      displayExercisePart(ex, 'prompt');
    } else {
      els.counter.textContent = '0 / 0';
      const dc = difficultyCountsForMode();
      if (els.difficultyCounts) { els.difficultyCounts.textContent = `${dc.none} / ${dc.easy} / ${dc.hard}`; els.difficultyCounts.title = 'None / Easy / Hard'; }
      els.progressBar.style.width = '0%';
      els.sentenceText.hidden = false; $('statusCard').classList.remove('polish-mode');
      els.sentenceText.textContent = difficultyFilterActive() ? 'No exercises match the selected difficulty ratings.' : 'No exercises in this mode.';
      els.translationText.textContent = '';
    }
    updateStats();
    updateRatingStatus();
    updateMediaMetadata();
  }

  function updateStats() {
    const p = getProgress(); if (!p || !lesson) return;
    const modeExercises = lesson.exercises.filter(x => x.mode === state.settings.mode);
    const items = modeExercises.map(x => p.exercises[x.id]).filter(Boolean);
    const played = items.reduce((a, x) => a + (x.played || 0), 0);
    const hard = items.filter(x => (x.hard || 0) > (x.easy || 0) || x.lastRating === 'hard').length;
    const practiced = items.filter(x => (x.played || 0) > 0).length;
    const minReps = items.length ? Math.min(...items.map(x => x.played || 0)) : 0;
    els.stats.innerHTML = `
      <div class="stat"><strong>${practiced}/${items.length}</strong><span>practised in this mode</span></div>
      <div class="stat"><strong>${played}</strong><span>total completed practices</span></div>
      <div class="stat"><strong>${minReps}</strong><span>lowest repetition count</span></div>
      <div class="stat"><strong>${hard}</strong><span>currently difficult</span></div>`;
  }

  function setPhase(label, hint = '') {
    els.phaseLabel.textContent = label;
    els.timerHint.textContent = hint;
  }
  function setPlayIcon() { els.playBtn.textContent = running && !paused ? '⏸' : '▶'; }

  function fillVoiceSelector(selector, filtered, previous, preferLang) {
    selector.innerHTML = '';
    if (!filtered.length) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = `No ${preferLang === 'pl' ? 'Polish' : 'English'} voice exposed`;
      selector.appendChild(opt);
      return '';
    }
    for (const v of filtered) {
      const option = document.createElement('option');
      option.value = v.voiceURI;
      option.textContent = `${v.name} — ${v.lang}${v.localService ? ' (local)' : ''}`;
      selector.appendChild(option);
    }
    const preferred = filtered.find(v => v.voiceURI === previous)
      || filtered.find(v => new RegExp(`^${preferLang}-US$`, 'i').test(v.lang) && v.localService)
      || filtered.find(v => v.localService)
      || filtered[0];
    selector.value = preferred.voiceURI;
    return preferred.voiceURI;
  }

  function loadVoices() {
    voices = window.speechSynthesis?.getVoices?.() || [];
    const english = voices.filter(v => /^en(?:[-_]|$)/i.test(v.lang));
    const polish = voices.filter(v => /^pl(?:[-_]|$)/i.test(v.lang));
    state.settings.voiceURI = fillVoiceSelector(els.voiceSelect, english, state.settings.voiceURI, 'en');
    state.settings.plVoiceURI = fillVoiceSelector(els.polishVoiceSelect, polish, state.settings.plVoiceURI, 'pl');
    saveState();
    showVoiceInfo();
  }

  function selectedVoice(lang = 'en') {
    const selector = lang === 'pl' ? els.polishVoiceSelect : els.voiceSelect;
    return voices.find(v => v.voiceURI === selector.value) || null;
  }
  function showVoiceInfo() {
    const en = selectedVoice('en');
    const pl = selectedVoice('pl');
    els.voiceInfo.textContent = en ? `${en.lang} · ${en.localService ? 'installed/local' : 'network voice'}` : 'No English voice exposed by this browser. Install one or try another browser.';
    els.polishVoiceInfo.textContent = pl ? `${pl.lang} · ${pl.localService ? 'installed/local' : 'network voice'}` : 'No Polish voice exposed. Install a Polish system voice for reliable PL→EN practice.';
  }

  function speak(text, lang = 'en') {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) return reject(new Error('Speech synthesis is not supported by this browser.'));
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = selectedVoice(lang);
      if (v) u.voice = v;
      u.lang = v?.lang || (lang === 'pl' ? 'pl-PL' : 'en-US');
      u.rate = Number(state.settings.speechRate || 0.9); u.pitch = 1;
      u.onend = () => resolve();
      u.onerror = e => reject(e.error || e);
      window.speechSynthesis.speak(u);
    });
  }

  function sleep(ms, token, hint = '', warningBeforeMs = 0) {
    return new Promise(resolve => {
      let remaining = ms;
      let lastTick = Date.now();
      let warningPlayed = false;
      els.timerHint.textContent = hint || '';
      function tick() {
        if (token !== currentAbort || !running) return resolve('aborted');
        const now = Date.now();
        if (!paused) remaining -= (now - lastTick);
        lastTick = now;
        const left = Math.max(0, remaining);
        els.timer.textContent = Math.ceil(left / 1000);
        if (!paused && !warningPlayed && warningBeforeMs > 0 && left > 0 && left <= warningBeforeMs) {
          warningPlayed = true;
          warningBeep();
        }
        if (left <= 0) { els.timer.textContent = '—'; resolve('done'); }
        else countdownTimer = setTimeout(tick, 120);
      }
      tick();
    });
  }

  function primeWarningAudio() {
    // Called directly from the user's Play/Repeat/Next gesture. On mobile,
    // Web Audio often needs unlocking BEFORE a timer reaches its warning point.
    try {
      const AudioClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioClass) return;
      audioCtx = audioCtx || new AudioClass();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch {}
  }

  function playSignalBeep() {
    try {
      primeWarningAudio();
      if (!audioCtx) return;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.055; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.11);
    } catch {}
  }

  function warningBeep() {
    // The only audible training signal is the configurable warning BEFORE a pause ends.
    playSignalBeep();
  }

  function warningMsForPause(seconds) {
    const warningSeconds = Number(state.settings.endWarningSeconds ?? 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(warningSeconds)) return 0;
    // A warning at or near the BEGINNING of a counter is worse than no warning.
    // Skip the sound when the pause is too short to accommodate the requested offset.
    if (seconds <= 0 || warningSeconds <= 0 || warningSeconds > seconds - 0.25) return 0;
    return warningSeconds * 1000;
  }

  function markPlayed(ex) {
    const p = getProgress(); if (!p || !ex) return;
    const ep = p.exercises[ex.id];
    ep.played = (ep.played || 0) + 1;
    ep.lastPracticedAt = new Date().toISOString();
    p.totalPlays = (p.totalPlays || 0) + 1;
    p.lastPracticedAt = new Date().toISOString();

    const rs = roundState(ex.mode);
    if (rs && !rs.completedIds.includes(ex.id)) rs.completedIds.push(ex.id);
    if (rs) rs.updatedAt = new Date().toISOString();

    touchProgress(); saveState(); updateStats(); scheduleServerPush();
  }

  async function waitPausedIfNeeded(token) {
    while (paused && running && token === currentAbort) await new Promise(r => setTimeout(r, 120));
    return token === currentAbort && running;
  }

  async function speakSafely(text, token, lang = 'en') {
    if (!(await waitPausedIfNeeded(token))) return false;
    try { await speak(text, lang); } catch {}
    return token === currentAbort && running;
  }

  async function repetitionWindows(token, bonus) {
    const reps = Number(state.settings.repetitions || 2);
    const seconds = Number(state.settings.pauseSeconds ?? 7) + bonus;
    for (let i = 1; i <= reps; i++) {
      setPhase(`Repeat ${i}/${reps}`, 'Repeat the English answer aloud');
      const result = await sleep(seconds * 1000, token, 'Repeat the English answer aloud', warningMsForPause(seconds));
      if (result === 'aborted') return false;
      // No beep at the start of the next repetition counter; the warning is at its end.
    }
    return true;
  }

  async function runCurrentExercise(options = {}) {
    const ex = currentExercise();
    if (!ex) { stopTraining('No exercise available.'); return; }
    const token = ++currentAbort;
    const bonus = Number(options.pauseBonusSeconds || 0);
    els.timer.textContent = '—';

    if (ex.mode === 'R') {
      displayExercisePart(ex, 'answer');
      setPhase('Listen', 'Listen to the model sentence');
      if (!(await speakSafely(ex.answerEn, token))) return;
      if (!(await repetitionWindows(token, bonus))) return;
    } else if (ex.mode === 'A') {
      displayExercisePart(ex, 'prompt');
      setPhase('Cue', 'Listen to the cue');
      if (!(await speakSafely(ex.promptEn, token))) return;
      setPhase('Recall', 'Say the target sentence from memory');
      const recallDuration = Number(state.settings.recallSeconds ?? 7) + bonus;
      if ((await sleep(recallDuration * 1000, token, 'Say the target sentence from memory', warningMsForPause(recallDuration))) === 'aborted') return;
      displayExercisePart(ex, 'answer');
      setPhase('Model answer', 'Listen and compare');
      if (!(await speakSafely(ex.answerEn, token))) return;
      if (!(await repetitionWindows(token, bonus))) return;
    } else if (ex.mode === 'P') {
      // PL voice first. English is intentionally hidden until the answer is spoken.
      displayExercisePart(ex, 'prompt');
      setPhase('Polish prompt', 'Listen to Polish, then produce the English sentence');
      if (!(await speakSafely(ex.promptPl, token, 'pl'))) return;
      setPhase('Translate', 'Say the English sentence from memory');
      const seconds = Number(state.settings.translationSeconds ?? 5) + bonus;
      if ((await sleep(seconds * 1000, token, 'Say the English sentence from memory', warningMsForPause(seconds))) === 'aborted') return;
      displayExercisePart(ex, 'answer');
      setPhase('English answer', 'Listen and compare');
      if (!(await speakSafely(ex.answerEn, token, 'en'))) return;
      if (!(await repetitionWindows(token, bonus))) return;
    } else {
      displayExercisePart(ex, 'prompt');
      setPhase('Business question', 'Listen, then answer freely');
      if (!(await speakSafely(ex.promptEn, token))) return;
      setPhase('Your answer', 'Answer in your own words');
      const responseDuration = Number(state.settings.businessSeconds ?? 15) + bonus;
      if ((await sleep(responseDuration * 1000, token, 'Answer in your own words', warningMsForPause(responseDuration))) === 'aborted') return;
      displayExercisePart(ex, 'answer');
      setPhase('Model answer', 'Listen to one strong answer');
      if (!(await speakSafely(ex.answerEn, token))) return;
      if (!(await repetitionWindows(token, bonus))) return;
    }

    if (token !== currentAbort || !running) return;
    markPlayed(ex);
    advanceAfterCompletion();
  }

  function advanceAfterCompletion() {
    if (!queue.length) return;

    const rs = roundState();
    if (!rs) return;
    const completed = new Set(rs.completedIds || []);
    const allIds = modeExercises().map(ex => ex.id);
    const fullRoundComplete = allIds.length > 0 && allIds.every(id => completed.has(id));

    if (fullRoundComplete) {
      createNextRound();
      buildQueue({ resetPosition: false });
    } else if (difficultyFilterActive()) {
      const currentId = currentExercise()?.id || null;
      const currentFullIndex = Math.max(0, (rs.queueIds || []).indexOf(currentId));
      const byId = new Map(modeExercises().map(ex => [ex.id, ex]));
      const filtered = (rs.queueIds || []).map(id => byId.get(id)).filter(Boolean).filter(matchesDifficultyFilter);
      if (!filtered.length) {
        queue = []; queuePos = 0; updateUI();
        stopTraining('No exercises match the selected difficulty ratings.');
        return;
      }
      // Continue with the next selected item in canonical round order. This also
      // behaves sensibly when rating the current item makes it leave the filter.
      let nextIndex = filtered.findIndex(ex => (rs.queueIds || []).indexOf(ex.id) > currentFullIndex);
      if (nextIndex < 0) nextIndex = 0;
      queue = filtered; queuePos = nextIndex; updateUI();
    } else {
      if (completed.size >= queue.length) {
        createNextRound();
        buildQueue({ resetPosition: false });
      } else {
        let next = queuePos;
        for (let step = 1; step <= queue.length; step++) {
          const candidate = (queuePos + step) % queue.length;
          if (!completed.has(queue[candidate].id)) { next = candidate; break; }
        }
        queuePos = next;
        saveRoundPosition();
        updateUI();
      }
    }

    setTimeout(() => { if (running && !paused) runCurrentExercise(); }, 280);
  }

  function makeSilentWavUrl(seconds = 8, sampleRate = 8000) {
    const samples = Math.max(1, Math.floor(seconds * sampleRate));
    const bytes = 44 + samples * 2;
    const buffer = new ArrayBuffer(bytes);
    const view = new DataView(buffer);
    const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); write(8, 'WAVE');
    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  function ensureControlAudio() {
    if (controlAudio) return controlAudio;
    controlAudioUrl = makeSilentWavUrl(8);
    controlAudio = new Audio(controlAudioUrl);
    controlAudio.loop = true;
    controlAudio.preload = 'auto';
    controlAudio.volume = 0.01;
    return controlAudio;
  }

  async function startMediaCarrier() {
    if (!state.settings.mediaControls) return;
    const a = ensureControlAudio();
    try { await a.play(); } catch {}
    updateMediaMetadata();
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; } catch {}
  }

  function pauseMediaCarrier() {
    try { controlAudio?.pause(); } catch {}
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; } catch {}
  }

  function stopMediaCarrier() {
    try { if (controlAudio) { controlAudio.pause(); controlAudio.currentTime = 0; } } catch {}
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'; } catch {}
  }

  function updateMediaMetadata() {
    if (!('mediaSession' in navigator) || !lesson) return;
    try {
      const rs = roundState();
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${lesson.title || lesson.id} · ${MODE_NAMES[state.settings.mode] || state.settings.mode}`,
        artist: 'CEO English Ride Trainer v7.4',
        album: difficultyFilterActive() ? `${queuePos + 1}/${queue.length} · Filtered · Round ${rs?.round || 1}` : `${queuePos + 1}/${queue.length} · Round ${rs?.round || 1}`
      });
    } catch {}
  }

  async function startTraining() {
    if (!lesson || !queue.length) return;
    if (!running) {
      running = true; paused = false;
      primeWarningAudio();
      startMediaCarrier();
      const p = getProgress(); p.sessions = (p.sessions || 0) + 1; touchProgress(); saveState(); scheduleServerPush();
      if (state.settings.wakeLock) await requestWakeLock();
      setPlayIcon(); runCurrentExercise();
    } else if (paused) {
      paused = false; primeWarningAudio(); startMediaCarrier(); if (window.speechSynthesis?.paused) window.speechSynthesis.resume(); setPhase('Resumed'); setPlayIcon();
    } else {
      paused = true; pauseMediaCarrier(); if (window.speechSynthesis?.speaking) window.speechSynthesis.pause(); setPhase('Paused'); setPlayIcon();
    }
  }

  function stopTraining(hint = '') {
    running = false; paused = false; ++currentAbort; clearTimeout(countdownTimer); window.speechSynthesis?.cancel(); stopMediaCarrier(); releaseWakeLock(); setPlayIcon();
    els.timerHint.textContent = hint || '';
  }

  async function startManualPlaybackAtCurrent() {
    stopTraining(); running = true; paused = false; primeWarningAudio(); startMediaCarrier();
    if (state.settings.wakeLock) await requestWakeLock();
    setPlayIcon(); runCurrentExercise({ pauseBonusSeconds: MANUAL_REPLAY_BONUS_SECONDS });
  }
  async function repeatCurrent() { if (lesson && queue.length) await startManualPlaybackAtCurrent(); }
  async function nextExercise() {
    if (!queue.length) return;
    stopTraining();
    queuePos = Math.min(queue.length - 1, queuePos + 1);
    saveRoundPosition();
    updateUI();
    running = true; paused = false; startMediaCarrier(); if (state.settings.wakeLock) await requestWakeLock(); setPlayIcon(); runCurrentExercise({ pauseBonusSeconds: MANUAL_REPLAY_BONUS_SECONDS });
  }
  async function prevExercise() {
    if (!queue.length) return;
    stopTraining();
    queuePos = Math.max(0, queuePos - 1);
    saveRoundPosition();
    updateUI();
    running = true; paused = false; startMediaCarrier(); if (state.settings.wakeLock) await requestWakeLock(); setPlayIcon(); runCurrentExercise({ pauseBonusSeconds: MANUAL_REPLAY_BONUS_SECONDS });
  }

  function rateCurrent(kind) {
    const ex = currentExercise(), p = getProgress(); if (!ex || !p) return;
    const ep = p.exercises[ex.id]; ep[kind] = (ep[kind] || 0) + 1; ep.lastRating = kind; ep.lastRatedAt = new Date().toISOString(); ep.lastPracticedAt = ep.lastRatedAt;
    ep.score = (ep.easy + ep.hard) ? Number((ep.easy / (ep.easy + ep.hard)).toFixed(3)) : null;
    touchProgress(); saveState(); scheduleServerPush();
    if (difficultyFilterActive() && !running) buildQueue({ resetPosition: true }); else { updateUI(); }
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  async function releaseWakeLock() { try { await wakeLock?.release(); } catch {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running && state.settings.wakeLock) requestWakeLock(); });

  async function enterRideScreen() {
    if (!els.rideOverlay) return;
    els.rideOverlay.hidden = false;
    els.rideOverlayStatus.textContent = running ? 'Training is running · tap to exit' : 'Ride screen · tap to exit';
    if (state.settings.wakeLock) await requestWakeLock();
    try { if (document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch {}
  }
  async function exitRideScreen() {
    if (!els.rideOverlay) return; els.rideOverlay.hidden = true;
    try { if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); } catch {}
  }

  // ---------- Server lessons ----------
  async function loadServerConfig() {
    try {
      const r = await fetch('server-config.json', { cache: 'no-store' });
      if (r.ok) serverConfig = { ...serverConfig, ...(await r.json()) };
    } catch {}
    updateSyncStatus();
  }

  async function loadManifest() {
    try {
      const r = await fetch('lessons/index.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      manifest = await r.json();
      populateLessonSelect();
      return true;
    } catch (e) {
      // Fall back to locally imported/cached lessons.
      const locals = Object.values(state.localLessons || {}).map(x => ({ id: x.id, title: x.title || x.id, local: true }));
      manifest = { lessons: locals };
      populateLessonSelect();
      return false;
    }
  }

  function populateLessonSelect() {
    els.lessonSelect.innerHTML = '';
    for (const item of manifest.lessons || []) {
      const opt = document.createElement('option'); opt.value = item.id; opt.textContent = item.title || item.id; els.lessonSelect.appendChild(opt);
    }
    const preferred = state.lastLessonId;
    if (preferred && [...els.lessonSelect.options].some(o => o.value === preferred)) els.lessonSelect.value = preferred;
  }

  async function loadLessonById(id) {
    stopTraining();
    const item = (manifest.lessons || []).find(x => x.id === id);
    if (!item) return;
    let text = '';
    let filename = `${id}.txt`;
    if (item.local && state.localLessons[id]) {
      text = state.localLessons[id].text; filename = state.localLessons[id].filename || filename;
    } else {
      try {
        const r = await fetch(item.file, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        text = await r.text();
        filename = item.file.split('/').pop() || filename;
        state.localLessons[id] = { id, title: item.title || id, filename, text, cachedAt: new Date().toISOString(), serverFile: item.file };
        saveState();
      } catch {
        const cached = state.localLessons[id];
        if (!cached) throw new Error('Lesson could not be loaded from the server and no offline copy is available.');
        text = cached.text; filename = cached.filename || filename;
      }
    }
    lesson = parseLesson(text, filename, item.id, item.title || item.id);
    reconcileProgress(lesson);
    state.lastLessonId = lesson.id; saveState();
    await syncCurrentLessonOnOpen();
    buildQueue({ resetPosition: false });
    updateSyncStatus();
    els.lessonSelect.value = lesson.id;
  }

  async function importLessonFile(file) {
    const text = await file.text();
    const id = lessonIdFromFilename(file.name);
    state.localLessons[id] = { id, title: id, filename: file.name, text, cachedAt: new Date().toISOString(), local: true };
    const existing = (manifest.lessons || []).find(x => x.id === id);
    if (!existing) manifest.lessons.push({ id, title: id, local: true });
    populateLessonSelect();
    await loadLessonById(id);
  }

  // ---------- V6.5 SERVER-AUTHORITATIVE PROGRESS ----------
  // V6.4 picked the newest *client* timestamp and blindly overwrote an older backend.
  // V7 never writes without an expected Cloudflare D1 revision. An offline copy can
  // only auto-sync if the server revision has NOT moved since its last read.
  const SYNC_WAIT = 450;
  function serverConfigured() { return serverConfig.backend === 'cloudflare-d1'; }
  function syncConfigured() { return serverConfigured() && Boolean(state.syncKey); }
  function syncKeyFingerprint() { return hashText(state.syncKey || ''); } // diagnostic only, not authentication

  function metaFor(id) {
    state.syncMeta = state.syncMeta || {};
    const fingerprint = syncKeyFingerprint();
    const old = state.syncMeta[id];
    if (!old || old.fingerprint !== fingerprint) {
      state.syncMeta[id] = { fingerprint, revision: null, dirty: false, edit: 0, lastSyncedAt: null, importNeedsReview: false };
      saveState();
    }
    return state.syncMeta[id];
  }
  function hasRealHistory(p) {
    return Boolean((p?.totalPlays || 0) > 0 || (p?.sessions || 0) > 0 ||
      Object.values(p?.exercises || {}).some(x => (x?.played || 0) > 0 || (x?.easy || 0) > 0 || (x?.hard || 0) > 0) ||
      Object.values(p?.rounds || {}).some(r => (r?.round || 1) > 1 || (r?.position || 0) > 0));
  }
  function preserveBackup(id, progress, reason) {
    if (!progress) return;
    state.migrationBackups = state.migrationBackups || {};
    state.migrationBackups[id] = { savedAt: new Date().toISOString(), reason, progress: structuredClone(progress) };
    saveState();
    els.exportBackupBtn.hidden = false;
  }
  function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(k => [k, stableJson(value[k])]));
    }
    return value;
  }
  function remoteMatchesLocal(remoteData, localData) {
    // PostgreSQL jsonb reorders object keys. Compare normalized snapshots so a
    // lost acknowledgement does not create a false conflict.
    return JSON.stringify(stableJson(remoteData)) === JSON.stringify(stableJson(localData));
  }
  function baseApiHeaders() {
    return {
      Authorization: `Bearer ${state.syncKey}`,
      'Content-Type': 'application/json'
    };
  }
  function setSyncBadge(label, cls = '') {
    els.syncBadge.textContent = label;
    els.syncBadge.className = `sync-badge ${cls}`.trim();
  }
  function syncDetails(id = lesson?.id) {
    const meta = id ? metaFor(id) : null;
    const rs = getProgress()?.rounds?.[state.settings.mode];
    const pos = rs ? `${(rs.position || 0) + 1}/${rs.queueIds?.length || 0}` : '—';
    const when = meta?.lastSyncedAt ? new Date(meta.lastSyncedAt).toLocaleTimeString() : 'not yet';
    return `${id || '—'} · ${state.settings.mode} · Round ${rs?.round || 1} · ${pos} · rev ${meta?.revision ?? '—'} · ${when}`;
  }
  function updateSyncStatus(message = '') {
    els.syncKeyInput.value = state.syncKey || '';
    if (!serverConfigured()) {
      setSyncBadge('Progress: local');
      els.syncInfo.textContent = message || 'Cloudflare D1 is not connected; results are stored on this device only.';
    } else if (!state.syncKey) {
      setSyncBadge('Key needed', 'error');
      els.syncInfo.textContent = message || 'Enter the SAME Sync Key on your phone and desktop.';
    } else if (conflict?.lessonId === lesson?.id) {
      setSyncBadge('Resolve conflict', 'error');
      els.syncInfo.textContent = message || 'Server and this device disagree. Select which copy to keep below.';
    } else {
      const m = lesson ? metaFor(lesson.id) : null;
      if (m?.dirty) {
        setSyncBadge('Unsynced local', 'busy');
        els.syncInfo.textContent = message || `Unsynced changes · ${syncDetails()}`;
      } else if (m?.revision !== null && m?.lastSyncedAt) {
        setSyncBadge(`Synced · r${m.revision}`, 'ok');
        els.syncInfo.textContent = message || `Synced · ${syncDetails()}`;
      } else {
        setSyncBadge('Checking server', 'busy');
        els.syncInfo.textContent = message || 'Connecting to the server; progress is not confirmed yet.';
      }
    }
    els.exportBackupBtn.hidden = !state.migrationBackups?.[lesson?.id];
  }
  function displayConflict(kind, remote, revision, message) {
    if (!lesson) return;
    conflict = { kind, lessonId: lesson.id, remote, revision };
    els.syncConflict.hidden = false;
    els.syncConflict.closest('details')?.setAttribute('open', '');
    els.syncConflictText.textContent = message;
    els.useServerBtn.textContent = remote ? 'Keep server progress' : 'Start a new server record';
    els.useDeviceBtn.textContent = remote ? 'Replace server with this device' : 'Upload this device to server';
    setSyncBadge('Resolve conflict', 'error');
    els.syncInfo.textContent = `Unsynced local copy preserved · ${syncDetails()}`;
  }
  function clearConflict() {
    conflict = null;
    els.syncConflict.hidden = true;
    updateSyncStatus();
  }
  async function fetchRemoteProgress(lessonId) {
    const r = await fetch(`/api/progress?lessonId=${encodeURIComponent(lessonId)}`, {
      headers: baseApiHeaders(), cache: 'no-store'
    });
    if (!r.ok) throw new Error(r.status === 503
      ? 'Cloudflare D1 is not initialized. Create the database and run schema.sql'
      : `Cloudflare server read failed (HTTP ${r.status})`);
    return await r.json(); // {revision, data, updatedAt} or null
  }
  async function casWrite(lessonId, data, expectedRevision) {
    const r = await fetch('/api/progress', {
      method: 'POST', headers: baseApiHeaders(), cache: 'no-store', // Do NOT use keepalive: large lesson progress can exceed its 64 KiB browser cap.
      body: JSON.stringify({ lessonId, data, expectedRevision })
    });
    if (!r.ok) {
      const serverError = await r.clone().json().catch(() => null);
      throw new Error(serverError?.error || (r.status === 503
        ? 'Cloudflare D1 is unavailable. Check the Worker binding and database.'
        : `Cloudflare server write failed (HTTP ${r.status})`));
    }
    return await r.json(); // {status:'ok',revision} or {status:'conflict',revision,data}
  }
  function acceptRemote(id, record, backupReason = '') {
    const data = record?.data || null;
    if (backupReason) preserveBackup(id, state.lessons[id], backupReason);
    if (data) state.lessons[id] = structuredClone(data);
    else state.lessons[id] = { lessonId: id, sessions: 0, totalPlays: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), exercises: {}, rounds: {} };
    const m = metaFor(id);
    m.revision = Number(record?.revision ?? 0);
    m.importNeedsReview = false;
    m.dirty = false;
    m.lastSyncedAt = new Date().toISOString();
    saveState();
    if (lesson?.id === id) {
      reconcileProgress(lesson);
      buildQueue({ resetPosition: false });
    }
    updateSyncStatus();
  }
  async function pushRemoteProgress(id = lesson?.id, { force = false } = {}) {
    if (!id || !syncConfigured() || syncBusy || conflict?.lessonId === id) return;
    const m = metaFor(id);
    if (!force && !m.dirty) return;
    // Only known revisions may be used for automatic writes.
    if (m.revision === null) return;
    syncBusy = true;
    if (id === lesson?.id) setSyncBadge('Syncing', 'busy');
    const capturedEdits = m.edit;
    const data = structuredClone(state.lessons[id]);
    const expected = m.revision;
    try {
      const result = await casWrite(id, data, expected);
      if (result?.status === 'ok') {
        m.revision = Number(result.revision);
        m.lastSyncedAt = new Date().toISOString();
        m.dirty = m.edit !== capturedEdits;
        saveState();
        if (id === lesson?.id) updateSyncStatus();
      } else if (result?.status === 'conflict') {
        // If the previous write succeeded but its acknowledgement was lost,
        // recognize the same snapshot and do NOT count it twice.
        if (remoteMatchesLocal(result.data, data) && m.edit === capturedEdits) {
          m.revision = Number(result.revision); m.dirty = false;
          m.lastSyncedAt = new Date().toISOString(); saveState(); updateSyncStatus();
        } else if (id === lesson?.id) {
          displayConflict('outdated', result.data,
            Number(result.revision), 'Another device updated this lesson. Neither copy will be overwritten automatically. Export your local copy, then choose which version to keep.');
        }
      } else throw new Error('Unexpected server response.');
    } catch (e) {
      // Keep the dirty local copy. Never label it Synced after a failed write.
      if (id === lesson?.id) {
        setSyncBadge('Offline / unsynced', 'error');
        els.syncInfo.textContent = `${e.message} · Local changes are retained. Use Sync now when connected.`;
      }
    } finally {
      syncBusy = false;
      if (m.dirty && m.revision !== null && !(conflict?.lessonId === id) && navigator.onLine) {
        // Retry changes made while a request was in flight, but not a failed unchanged write.
        if (m.edit !== capturedEdits) schedulePushFor(id);
      }
    }
  }
  const timers = new Map();
  function schedulePushFor(id) {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      pushRemoteProgress(id);
    }, SYNC_WAIT));
  }
  function scheduleServerPush() {
    if (!lesson || !syncConfigured()) return;
    const meta = metaFor(lesson.id);
    meta.edit = (meta.edit || 0) + 1;
    meta.dirty = true;
    saveState();
    updateSyncStatus();
    if (meta.revision !== null && !conflict && navigator.onLine) schedulePushFor(lesson.id);
  }
  async function syncCurrentLessonOnOpen() {
    if (!lesson) return;
    if (!syncConfigured()) { updateSyncStatus(); return; }
    const id = lesson.id;
    // Don't issue a second read that could race an in-flight write or first read.
    if (syncCurrentPromise) {
      if (syncPromiseLessonId === id) return syncCurrentPromise;
      await syncCurrentPromise;
    }
    syncPromiseLessonId = id;
    const m = metaFor(id);
    if (conflict?.lessonId === id) { updateSyncStatus(); return; }
    setSyncBadge('Checking server', 'busy');
    syncCurrentPromise = (async () => {
      try {
        // If there is a write in flight, wait before reading to avoid applying stale data.
        for (let i = 0; syncBusy && i < 40; i++) await new Promise(r => setTimeout(r, 100));
        if (syncBusy) return;
        const remote = await fetchRemoteProgress(id);
        if (lesson?.id !== id) return;
        if (m.importNeedsReview) {
          displayConflict('import', remote?.data || null, Number(remote?.revision ?? 0),
            'You imported a progress file. Decide explicitly whether to keep the current server state or replace it with the imported progress. Export a backup first if needed.');
          return;
        }
        if (remote?.data) {
          const serverRev = Number(remote.revision);
          if (m.dirty) {
            if (m.revision === serverRev) {
              // Local work began from the current server revision: safe CAS upload.
              await pushRemoteProgress(id);
            } else if (m.revision !== null && remoteMatchesLocal(remote.data, state.lessons[id])) {
              // Successful write, lost acknowledgement.
              m.revision = serverRev; m.dirty = false;
              m.lastSyncedAt = new Date().toISOString(); saveState(); updateSyncStatus();
            } else {
              displayConflict('outdated', remote.data, serverRev,
                'This device has unsynced progress, but the server changed. Export the local version before choosing which copy to keep.');
            }
          } else {
            // Migration: preserve pre-v6.5 local history if it differs from server.
            const legacy = m.revision === null && hasRealHistory(state.lessons[id]);
            const differs = !remoteMatchesLocal(remote.data, state.lessons[id]);
            acceptRemote(id, remote, legacy && differs ? 'Pre-v6.5 device history (server became authoritative)' : '');
          }
        } else {
          // The first device must explicitly claim a legacy history; otherwise
          // a stale device could silently establish the wrong Round 1/9.
          if (hasRealHistory(state.lessons[id]) && m.revision === null) {
            displayConflict('firstSync', null, 0,
              'There is no progress on the server yet. This device has older local history. Choose Upload this device to establish the initial server state, or Start a new server record.');
          } else if (m.revision !== null && m.revision > 0) {
            displayConflict('missingServer', null, 0,
              'The server record has disappeared. Your local progress is preserved. Choose explicitly how to proceed.');
          } else {
            m.revision = 0;
            m.dirty = true;
            m.edit++;
            saveState();
            await pushRemoteProgress(id);
          }
        }
      } catch (e) {
        const m = metaFor(id);
        const migrationMissing = String(e.message).includes('Cloudflare D1 is not initialized');
        setSyncBadge(migrationMissing ? 'Upgrade server' : (m.dirty ? 'Offline / unsynced' : 'Offline · cached'), 'error');
        els.syncInfo.textContent = `${e.message}. Current local history is available, but is NOT confirmed on the server.`;
      }
    })();
    try { await syncCurrentPromise; }
    finally { if (syncPromiseLessonId === id) { syncCurrentPromise = null; syncPromiseLessonId = null; } }
  }
  function generateSyncKey() {
    const arr = new Uint8Array(18); crypto.getRandomValues(arr);
    return [...arr].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  els.syncNowBtn.addEventListener('click', async () => {
    if (running && !paused) return alert('Pause the lesson before refreshing server progress.');
    await syncCurrentLessonOnOpen();
    updateUI(); updateSyncStatus();
  });
  els.exportBackupBtn.addEventListener('click', () => {
    if (!lesson) return;
    const backup = state.migrationBackups?.[lesson.id];
    if (!backup) return;
    downloadBlob(new Blob([JSON.stringify({ schemaVersion: 5, lessonId: lesson.id,
      backupReason: backup.reason, backedUpAt: backup.savedAt, progress: backup.progress }, null, 2)],
      { type: 'application/json' }), `${lesson.id}.preserved-local-backup.json`);
  });
  els.useServerBtn.addEventListener('click', async () => {
    if (!lesson || !conflict || conflict.lessonId !== lesson.id) return;
    if (!confirm('Replace this device’s progress with the server version? A local backup will be retained for export.')) return;
    const { remote, revision } = conflict;
    const id = lesson.id;
    preserveBackup(id, state.lessons[id], 'Local version before choosing server');
    conflict = null; els.syncConflict.hidden = true;
    acceptRemote(id, { data: remote, revision });
    if (!remote) { // Explicit new blank server record
      const meta = metaFor(id); meta.dirty = true; meta.edit++; saveState();
      await pushRemoteProgress(id);
    }
  });
  els.useDeviceBtn.addEventListener('click', async () => {
    if (!lesson || !conflict || conflict.lessonId !== lesson.id) return;
    if (!confirm('Replace the SERVER lesson progress with THIS DEVICE’s local copy? Other devices will adopt it on their next sync. Export both copies first if necessary.')) return;
    const { revision, remote } = conflict;
    const id = lesson.id;
    if (remote) preserveBackup(id, remote, 'Previous server copy before deliberate replacement');
    // Re-read to verify that the server has not moved while the conflict was displayed.
    try {
      setSyncBadge('Checking server', 'busy');
      const fresh = await fetchRemoteProgress(id);
      const actualRev = Number(fresh?.revision ?? 0);
      if (actualRev !== Number(revision)) {
        displayConflict('outdated', fresh?.data || null, actualRev,
          'The server changed again while you were deciding. Review the new revision and repeat your choice.');
        return;
      }
      const m = metaFor(id); m.revision = actualRev; m.importNeedsReview = false; m.dirty = true; m.edit++;
      conflict = null; els.syncConflict.hidden = true; saveState();
      await pushRemoteProgress(id, { force: true });
    } catch (e) {
      setSyncBadge('Offline / unsynced', 'error'); els.syncInfo.textContent = `${e.message}. No server data was overwritten.`;
    }
  });
  window.addEventListener('online', () => {
    if (lesson && syncConfigured() && !running) syncCurrentLessonOnOpen();
  });
  window.addEventListener('focus', () => {
    if (lesson && syncConfigured() && !running && !syncBusy && !conflict) syncCurrentLessonOnOpen();
  });

  // ---------- Progress import/export ----------
  function exportProgress() {
    if (!lesson) return;
    const p = getProgress();
    const payload = { schemaVersion: 5, lessonId: lesson.id, exportedAt: new Date().toISOString(), progress: p };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${lesson.id}.progress.json`);
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importProgressFile(file) {
    const data = JSON.parse(await file.text());
    const lessonId = data.lessonId || data.progress?.lessonId;
    const progress = data.progress || data;
    if (!lessonId) throw new Error('Missing lessonId.');
    if (state.lessons[lessonId] && syncConfigured()) {
      preserveBackup(lessonId, state.lessons[lessonId], 'Previous local progress before importing a file');
    }
    state.lessons[lessonId] = progress;
    if (syncConfigured()) {
      const meta = metaFor(lessonId);
      meta.dirty = true; meta.importNeedsReview = true;
      meta.edit = (meta.edit || 0) + 1;
    }
    saveState();
    if (lesson?.id === lessonId) {
      reconcileProgress(lesson); buildQueue({ resetPosition: false });
      if (syncConfigured()) await syncCurrentLessonOnOpen();
      else updateSyncStatus();
    }
  }
  function resetProgress() {
    if (!lesson || !confirm(`Reset all progress for ${lesson.id}?`)) return;
    state.lessons[lesson.id] = { lessonId: lesson.id, sessions: 0, totalPlays: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), exercises: {}, rounds: {} };
    reconcileProgress(lesson); buildQueue({ resetPosition: false }); scheduleServerPush();
  }

  // ---------- Settings / events ----------
  function applySettingsToUI() {
    els.repetitionCount.value = state.settings.repetitions;
    els.pauseSeconds.value = state.settings.pauseSeconds;
    els.recallSeconds.value = state.settings.recallSeconds;
    els.businessSeconds.value = state.settings.businessSeconds;
    els.translationSeconds.value = state.settings.translationSeconds;
    els.showEnglishInPL.checked = state.settings.showEnglishInPL !== false;
    els.endWarningSeconds.value = state.settings.endWarningSeconds;
    els.shuffleEnabled.checked = state.settings.shuffle;
    els.filterEasy.checked = state.settings.filterEasy !== false;
    els.filterHard.checked = state.settings.filterHard !== false;
    els.filterNone.checked = state.settings.filterNone !== false;
    els.wakeLockEnabled.checked = state.settings.wakeLock;
    els.mediaControlsEnabled.checked = state.settings.mediaControls;
    els.speechRate.value = state.settings.speechRate;
    els.speechRateValue.value = `${Number(state.settings.speechRate).toFixed(2)}×`;
    els.syncKeyInput.value = state.syncKey || '';
    loadVoices(); updateUI();
  }

  function validatedNumber(el, fallback) {
    const value = Number(el.value);
    if (el.value.trim() === '' || !Number.isFinite(value) || !el.validity.valid) {
      el.reportValidity();
      // Never persist an invalid partial input; return to the last saved value.
      el.value = String(fallback);
      return null;
    }
    return value;
  }

  function bindSetting(el, key, transform = x => x) {
    el.addEventListener('change', () => {
      let value;
      if (el.type === 'number') {
        value = validatedNumber(el, state.settings[key]);
        if (value === null) return;
      } else value = el.type === 'checkbox' ? el.checked : transform(el.value);
      state.settings[key] = value;
      saveState();
      if (['filterEasy', 'filterHard', 'filterNone'].includes(key)) buildQueue({ resetPosition: true });
    });
  }

  els.modeButtons.forEach(btn => btn.addEventListener('click', () => {
    if (state.settings.mode === btn.dataset.mode) return;
    stopTraining(); state.settings.mode = btn.dataset.mode; saveState(); buildQueue({ resetPosition: false }); updateSyncStatus();
  }));
  els.lessonSelect.addEventListener('change', () => loadLessonById(els.lessonSelect.value).catch(e => alert(e.message)));
  els.refreshLessonsBtn.addEventListener('click', async () => {
    const ok = await loadManifest();
    const id = state.lastLessonId && (manifest.lessons || []).some(x => x.id === state.lastLessonId) ? state.lastLessonId : manifest.lessons?.[0]?.id;
    if (id) await loadLessonById(id);
    els.syncInfo.textContent = ok ? 'Lessons refreshed from the server.' : 'Server lesson list unavailable. Using cached/local lessons.';
  });
  els.lessonFile.addEventListener('change', async () => { const f = els.lessonFile.files?.[0]; if (f) await importLessonFile(f); els.lessonFile.value = ''; });
  els.progressFile.addEventListener('change', async () => {
    const f = els.progressFile.files?.[0]; if (f) { try { await importProgressFile(f); alert('Progress imported.'); } catch(e) { alert(`Could not import progress: ${e.message}`); } }
    els.progressFile.value = '';
  });

  els.playBtn.addEventListener('click', startTraining); els.repeatBtn.addEventListener('click', repeatCurrent); els.nextBtn.addEventListener('click', nextExercise); els.prevBtn.addEventListener('click', prevExercise);
  els.rideScreenBtn.addEventListener('click', enterRideScreen); els.rideOverlay.addEventListener('click', exitRideScreen);
  els.easyBtn.addEventListener('click', () => rateCurrent('easy')); els.hardBtn.addEventListener('click', () => rateCurrent('hard'));
  els.exportProgressBtn.addEventListener('click', exportProgress); els.resetProgressBtn.addEventListener('click', resetProgress);
  els.testVoiceBtn.addEventListener('click', () => speak('Before we set a target, we need to establish a baseline.', 'en').catch(() => {}));
  els.testPolishVoiceBtn.addEventListener('click', () => speak('Zanim ustalimy cel, potrzebujemy punktu odniesienia.', 'pl').catch(() => {}));
  els.voiceSelect.addEventListener('change', () => { state.settings.voiceURI = els.voiceSelect.value; saveState(); showVoiceInfo(); });
  els.polishVoiceSelect.addEventListener('change', () => { state.settings.plVoiceURI = els.polishVoiceSelect.value; saveState(); showVoiceInfo(); });
  els.speechRate.addEventListener('change', () => { const rate = validatedNumber(els.speechRate, state.settings.speechRate); if (rate === null) return; state.settings.speechRate = rate; els.speechRateValue.value = `${rate.toFixed(2)}×`; saveState(); });

  bindSetting(els.repetitionCount, 'repetitions', Number);
  bindSetting(els.pauseSeconds, 'pauseSeconds', Number);
  bindSetting(els.recallSeconds, 'recallSeconds', Number);
  bindSetting(els.businessSeconds, 'businessSeconds', Number);
  bindSetting(els.translationSeconds, 'translationSeconds', Number);
  bindSetting(els.showEnglishInPL, 'showEnglishInPL', Boolean);
  els.showEnglishInPL.addEventListener('change', () => { if (lesson) updateUI(); });
  bindSetting(els.endWarningSeconds, 'endWarningSeconds', Number);
  bindSetting(els.shuffleEnabled, 'shuffle', Boolean);
  bindSetting(els.filterEasy, 'filterEasy', Boolean);
  bindSetting(els.filterHard, 'filterHard', Boolean);
  bindSetting(els.filterNone, 'filterNone', Boolean);
  bindSetting(els.wakeLockEnabled, 'wakeLock', Boolean);
  bindSetting(els.mediaControlsEnabled, 'mediaControls', Boolean);

  els.generateSyncKeyBtn.addEventListener('click', () => { els.syncKeyInput.type = 'text'; els.syncKeyInput.value = generateSyncKey(); });
  els.copySyncKeyBtn.addEventListener('click', async () => { const value = els.syncKeyInput.value.trim() || state.syncKey; if (value) await navigator.clipboard?.writeText(value); });
  els.saveSyncKeyBtn.addEventListener('click', async () => {
    const oldKey = state.syncKey;
    state.syncKey = els.syncKeyInput.value.trim(); saveState(); els.syncKeyInput.type = 'password';
    if (oldKey !== state.syncKey) { conflict = null; els.syncConflict.hidden = true; }
    updateSyncStatus();
    if (lesson) { await syncCurrentLessonOnOpen(); buildQueue({ resetPosition: false }); }
  });

  if ('speechSynthesis' in window) { window.speechSynthesis.onvoiceschanged = loadVoices; setTimeout(loadVoices, 250); setTimeout(loadVoices, 1200); }
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => { if (!running || paused) startTraining(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (running && !paused) startTraining(); });
      navigator.mediaSession.setActionHandler('stop', () => stopTraining('Stopped from headset/media controls'));
      navigator.mediaSession.setActionHandler('previoustrack', prevExercise);
      navigator.mediaSession.setActionHandler('nexttrack', nextExercise);
      try { navigator.mediaSession.setActionHandler('seekbackward', prevExercise); } catch {}
      try { navigator.mediaSession.setActionHandler('seekforward', nextExercise); } catch {}
    } catch {}
  }

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; els.installBtn.hidden = false; });
  els.installBtn.addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; els.installBtn.hidden = true; });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      await registration.update();
    } catch (_) {}
  });
}
  window.addEventListener('pagehide', () => { if (lesson && syncConfigured()) { const m = metaFor(lesson.id); if (m.dirty && m.revision !== null && !conflict) pushRemoteProgress(lesson.id); } });

  async function init() {
    applySettingsToUI();
    await loadServerConfig();
    await loadManifest();
    updateSyncStatus();
    const id = state.lastLessonId && (manifest.lessons || []).some(x => x.id === state.lastLessonId) ? state.lastLessonId : manifest.lessons?.[0]?.id;
    if (id) {
      try { await loadLessonById(id); } catch (e) { els.sentenceText.textContent = e.message; }
    } else {
      els.sentenceText.textContent = 'No lesson is available. Upload lessons/index.json and a lesson file, or import a local lesson.';
    }
    setPlayIcon();
  }

  init();
})();
