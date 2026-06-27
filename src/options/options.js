/* Open Book Reader — options page logic */
(function () {
  const OBR = globalThis.OBR;
  const SLIDERS = ['fontSize', 'maxBookWidth', 'columns', 'gutter', 'lineHeight', 'singlePageBelow', 'galleryColWidth', 'autoGalleryMin', 'autoTextMinWords', 'galleryAutoScrollSpeed'];
  const SELECTS = ['theme', 'fontFamily'];
  const CHECKBOXES = ['galleryAutoLoad'];
  const savedEl = document.getElementById('saved');
  let saveTimer;

  function flashSaved() {
    savedEl.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savedEl.classList.remove('show'), 1200);
  }

  // maxBookWidth uses 0 = "Full" (fill window); the slider's top position represents it.
  function setSliderFromSetting(key, value) {
    const el = document.getElementById(key);
    if (key === 'maxBookWidth' && !value) el.value = el.max; // 0/undefined -> Full
    else el.value = value;
  }

  function settingFromSlider(key, el) {
    if (key === 'maxBookWidth' && el.value === el.max) return 0; // Full -> no cap
    return el.step && el.step.includes('.') ? parseFloat(el.value) : parseInt(el.value, 10);
  }

  function reflectValue(key) {
    const el = document.getElementById(key);
    const valEl = document.getElementById(key + 'Val');
    if (!valEl) return;
    if (key === 'maxBookWidth' && el.value === el.max) valEl.textContent = 'Full';
    else if ((key === 'autoGalleryMin' || key === 'autoTextMinWords') && el.value === '0') valEl.textContent = 'Off';
    else valEl.textContent = el.value;
  }

  function bind(settings) {
    SLIDERS.forEach((key) => {
      const el = document.getElementById(key);
      setSliderFromSetting(key, settings[key]);
      reflectValue(key);
      el.addEventListener('input', () => reflectValue(key));
      el.addEventListener('change', () => {
        OBR.saveSettings({ [key]: settingFromSlider(key, el) }).then(flashSaved);
      });
    });
    SELECTS.forEach((key) => {
      const el = document.getElementById(key);
      el.value = settings[key];
      el.addEventListener('change', () => OBR.saveSettings({ [key]: el.value }).then(flashSaved));
    });
    CHECKBOXES.forEach((key) => {
      const el = document.getElementById(key);
      el.checked = !!settings[key];
      el.addEventListener('change', () => OBR.saveSettings({ [key]: el.checked }).then(flashSaved));
    });
  }

  /* ------------------------------------------------ per-site rules */
  // Local mirror of settings.siteRules; always read-modify-WRITE a fresh clone (settings.js
  // shallow-merges, so a new array replaces the saved rules wholesale).
  let rules = [];
  const cloneRules = () => JSON.parse(JSON.stringify(rules || []));

  function persistRules(next, then) {
    rules = next;
    OBR.saveSettings({ siteRules: next }).then(() => { flashSaved(); if (then) then(); });
  }

  function modeSelect(value) {
    const sel = document.createElement('select');
    sel.className = 'site-mode';
    [['auto', 'Auto'], ['images', 'Gallery'], ['text', 'Reader']].forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label; sel.appendChild(o);
    });
    sel.value = value || 'auto';
    return sel;
  }

  function removeRule(i) {
    const next = cloneRules();
    next.splice(i, 1);
    persistRules(next, renderSites);
  }

  function renderSites() {
    const wrap = document.getElementById('sites');
    wrap.textContent = '';
    if (!rules.length) {
      const empty = document.createElement('div');
      empty.className = 'site-empty';
      empty.textContent = 'No per-site rules yet.';
      wrap.appendChild(empty);
      return;
    }
    rules.forEach((rule, i) => {
      const row = document.createElement('div');
      row.className = 'site-row';

      const name = document.createElement('span');
      name.className = 'site-host'; name.textContent = rule.match;

      const mode = modeSelect(rule.mode);
      mode.addEventListener('change', () => {
        const next = cloneRules();
        next[i] = Object.assign({}, next[i], { mode: mode.value });
        persistRules(next);
      });

      const remove = document.createElement('button');
      remove.className = 'ghost site-remove'; remove.textContent = '✕'; remove.title = 'Remove';
      remove.addEventListener('click', () => removeRule(i));

      row.append(name, mode, remove);
      wrap.appendChild(row);
    });
  }

  function addRule() {
    const input = document.getElementById('siteHost');
    const match = OBR.normalizePattern(input.value);
    if (!match) return;
    const modeVal = document.getElementById('siteMode').value;
    const next = cloneRules();
    const existing = next.find((r) => r.match === match); // update in place if same pattern
    if (existing) existing.mode = modeVal;
    else next.push({ match, mode: modeVal });
    persistRules(next, renderSites);
    input.value = '';
  }

  document.getElementById('siteAddBtn').addEventListener('click', addRule);
  document.getElementById('siteHost').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addRule(); }
  });

  document.getElementById('reset').addEventListener('click', () => {
    chrome.storage.sync.set({ [OBR.STORAGE_KEY]: {} }, () => {
      OBR.loadSettings().then((s) => {
        SLIDERS.forEach((k) => { setSliderFromSetting(k, s[k]); reflectValue(k); });
        SELECTS.forEach((k) => { document.getElementById(k).value = s[k]; });
        CHECKBOXES.forEach((k) => { document.getElementById(k).checked = !!s[k]; });
        rules = [];
        renderSites();
        flashSaved();
      });
    });
  });

  document.getElementById('shortcutsBtn').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  OBR.loadSettings().then((s) => {
    bind(s);
    rules = s.siteRules || [];
    renderSites();
  });
})();
