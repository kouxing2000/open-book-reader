/* Open Book Reader — options page logic */
(function () {
  const OBR = globalThis.OBR;

  // Localize the static HTML from the shared catalog. This is an extension page, so chrome.i18n
  // is available via OBR.t. Plain text -> [data-i18n] (textContent); strings with inline
  // <b>/<code>/<kbd> -> [data-i18n-html] (innerHTML, our own bundled strings); plus
  // [data-i18n-placeholder] / [data-i18n-title]. When a key doesn't resolve, OBR.t returns the
  // key itself, so the hardcoded English in options.html stays as the fallback.
  (function localize() {
    const T = (k) => { const m = OBR.t(k); return m && m !== k ? m : ''; };
    document.querySelectorAll('[data-i18n]').forEach((el) => { const m = T(el.getAttribute('data-i18n')); if (m) el.textContent = m; });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { const m = T(el.getAttribute('data-i18n-html')); if (m) el.innerHTML = m; });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { const m = T(el.getAttribute('data-i18n-placeholder')); if (m) el.setAttribute('placeholder', m); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { const m = T(el.getAttribute('data-i18n-title')); if (m) el.setAttribute('title', m); });
    try { const lang = chrome.i18n.getUILanguage && chrome.i18n.getUILanguage(); if (lang) document.documentElement.lang = lang; } catch (e) { /* */ }
  })();

  const SLIDERS = ['fontSize', 'maxBookWidth', 'columns', 'gutter', 'lineHeight', 'singlePageBelow', 'galleryColumns', 'galleryOrderedCols', 'autoGalleryMin', 'autoTextMinWords', 'galleryAutoScrollSpeed', 'gallerySlideSeconds'];
  const SELECTS = ['theme', 'fontFamily', 'pageTurn'];
  const CHECKBOXES = ['readSelection', 'galleryAutoLoad', 'galleryFitWidth', 'galleryHideAvatars', 'printSourceUrl'];
  const savedEl = document.getElementById('saved');
  let saveTimer;

  // Optional ?site=<host> deep-link (the reader/gallery ⚙ pass the current site): scope the
  // site-rules + saved-picks lists to one site, with a "Show all" toggle. '' = show everything.
  let filterSite = (() => {
    try { const s = new URLSearchParams(location.search).get('site'); return s ? OBR.normalizeHost(s) : ''; }
    catch (e) { return ''; }
  })();

  // `ok` is saveSettings' success boolean (undefined from legacy callers = assume ok). On a
  // failed write, say so instead of the dishonest "Saved ✓", and hold it a bit longer.
  function flashSaved(ok) {
    const failed = ok === false;
    savedEl.textContent = failed ? OBR.t('optSaveFailed') : OBR.t('optSaved');
    savedEl.classList.toggle('error', failed);
    savedEl.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savedEl.classList.remove('show'), failed ? 2600 : 1200);
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
    if (key === 'maxBookWidth' && el.value === el.max) valEl.textContent = OBR.t('optValFull');
    else if ((key === 'autoGalleryMin' || key === 'autoTextMinWords') && el.value === '0') valEl.textContent = OBR.t('optValOff');
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
    OBR.saveSettings({ siteRules: next }).then((ok) => { flashSaved(ok); if (then) then(); });
  }

  function modeSelect(value) {
    const sel = document.createElement('select');
    sel.className = 'site-mode';
    [['auto', OBR.t('optModeAuto')], ['images', OBR.t('optModeGallery')], ['text', OBR.t('optModeReader')]].forEach(([v, label]) => {
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
    // Keep each rule's ORIGINAL index (removeRule / mode-change splice by index) when the
    // site filter hides the rest. A rule matches the filtered site if its glob would apply.
    let list = rules.map((rule, i) => ({ rule, i }));
    if (filterSite) list = list.filter(({ rule }) =>
      // Show a rule if its glob matches the site host (whole-site / subdomain rules) OR its
      // pattern's host-part equals the site (so PATH-scoped rules like `host/blog/*` show too —
      // filterSite is always a bare host, which `host/blog/*` wouldn't otherwise match).
      OBR.matchSiteRule('http://' + filterSite + '/', [rule])
      || OBR.normalizeHost(String(rule.match).split('/')[0]) === filterSite);
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'site-empty';
      empty.textContent = filterSite ? OBR.t('optNoRuleForSite', [filterSite]) : OBR.t('optNoRules');
      wrap.appendChild(empty);
      return;
    }
    list.forEach(({ rule, i }) => {
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
      remove.className = 'ghost site-remove'; remove.textContent = '✕'; remove.title = OBR.t('optRemove');
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

  /* ------------------------------------------------ saved content picks */
  // The per-site "read THIS block" overrides (the ⌖ Pick result), stored separately
  // from settings under chrome.storage.sync's obr_picks. View + remove only here;
  // they're created in the reader.
  let picks = {}; // { host: { sel, t } }

  function renderPicks() {
    const wrap = document.getElementById('picks');
    wrap.textContent = '';
    let hosts = Object.keys(picks).sort();
    if (filterSite) hosts = hosts.filter((h) => h === filterSite); // picks are keyed by exact host
    const countEl = document.getElementById('picksCount');
    if (countEl) countEl.textContent = hosts.length ? '(' + hosts.length + ')' : '';
    if (!hosts.length) {
      const empty = document.createElement('div');
      empty.className = 'site-empty';
      empty.textContent = filterSite
        ? OBR.t('optNoPickForSite', [filterSite])
        : OBR.t('optNoPicks');
      wrap.appendChild(empty);
      return;
    }
    hosts.forEach((host) => {
      const row = document.createElement('div');
      row.className = 'pick-row';

      // Head line: host + remove.
      const head = document.createElement('div');
      head.className = 'pick-head';
      const h = document.createElement('span');
      h.className = 'pick-host'; h.textContent = host;
      const remove = document.createElement('button');
      remove.className = 'ghost site-remove'; remove.textContent = '✕'; remove.title = OBR.t('optRemovePick');
      remove.addEventListener('click', () => {
        OBR.clearPick(host).then(() => { delete picks[host]; renderPicks(); flashSaved(); });
      });
      head.append(h, remove);

      // Edit line: an editable CSS selector + live ✓/✗ validity + a revert button.
      // `original` is the value when this page opened — the ↶ revert target, captured
      // once so it survives the in-place auto-saves below.
      const original = (picks[host] && picks[host].sel) || '';
      const editLine = document.createElement('div');
      editLine.className = 'pick-edit';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'pick-sel-input'; input.spellcheck = false;
      input.value = original;
      input.setAttribute('aria-label', OBR.t('optSelectorAria', [host]));
      input.placeholder = OBR.t('optSelectorPlaceholder');
      const mark = document.createElement('span');
      mark.className = 'pick-valid';
      const revert = document.createElement('button');
      revert.className = 'ghost pick-revert'; revert.textContent = '↶';
      revert.title = OBR.t('optRevertTitle');

      // Syntax-only check (this page isn't the target site, so we can't match-test):
      // a selector is "valid" if document.querySelector doesn't throw on it.
      const validity = () => {
        const v = input.value.trim();
        let ok = false;
        if (v) { try { document.querySelector(v); ok = true; } catch (e) { ok = false; } }
        mark.textContent = v ? (ok ? '✓' : '✗') : '';
        mark.className = 'pick-valid ' + (v ? (ok ? 'ok' : 'bad') : '');
        input.classList.toggle('invalid', !!v && !ok);
        return ok;
      };
      // Show ↶ only when the field differs from the load-time value (something to undo).
      const refresh = () => { validity(); revert.style.display = input.value.trim() === original ? 'none' : ''; };
      const save = (v) => { picks[host].sel = v; OBR.savePick(host, v).then((ok) => { if (ok !== false) flashSaved(); }); };
      const commit = () => {
        const v = input.value.trim();
        if (v && validity() && v !== (picks[host].sel || '')) save(v); // skip empty / broken / unchanged
        refresh();
      };
      input.addEventListener('input', refresh);
      input.addEventListener('change', commit); // fires on blur / Enter when the value changed
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }           // commit
        else if (e.key === 'Escape') {                                          // cancel the in-progress edit
          e.preventDefault();
          input.value = (picks[host] && picks[host].sel) || ''; // back to last SAVED value
          refresh();
        }
      });
      revert.addEventListener('click', () => {
        input.value = original;
        if (original !== (picks[host].sel || '')) save(original); // re-persist the original
        refresh();
        input.focus();
      });
      refresh();

      editLine.append(input, mark, revert);
      row.append(head, editLine);
      wrap.appendChild(row);
    });
  }

  /* ------------------------------------------------ hidden images (per-site filter) */
  // The per-site image-filter glob patterns (the ⊘ Hide result), stored under obr_hidden.
  // View + remove only here; they're created in the gallery.
  let hiddenMap = {}; // { host: [pattern,...] }

  function renderHidden() {
    const wrap = document.getElementById('hidden');
    if (!wrap) return;
    wrap.textContent = '';
    let hosts = Object.keys(hiddenMap).filter((h) => (hiddenMap[h] || []).length).sort();
    if (filterSite) hosts = hosts.filter((h) => h === filterSite); // hidden lists are keyed by exact host
    const countEl = document.getElementById('hiddenCount');
    const total = hosts.reduce((n, h) => n + hiddenMap[h].length, 0);
    if (countEl) countEl.textContent = total ? '(' + total + ')' : '';
    if (!hosts.length) {
      const empty = document.createElement('div');
      empty.className = 'site-empty';
      empty.textContent = filterSite ? OBR.t('optNoHiddenForSite', [filterSite]) : OBR.t('optNoHidden');
      wrap.appendChild(empty);
      return;
    }
    hosts.forEach((host) => {
      const row = document.createElement('div');
      row.className = 'pick-row';
      const head = document.createElement('div');
      head.className = 'pick-head';
      const h = document.createElement('span');
      h.className = 'pick-host'; h.textContent = host;
      head.appendChild(h);
      row.appendChild(head);
      hiddenMap[host].forEach((pat) => {
        const line = document.createElement('div');
        line.className = 'pick-edit';
        const code = document.createElement('span');
        code.className = 'pick-sel-input'; code.textContent = pat;
        code.style.userSelect = 'text'; code.style.overflow = 'hidden'; code.style.textOverflow = 'ellipsis';
        const remove = document.createElement('button');
        remove.className = 'ghost site-remove'; remove.textContent = '✕'; remove.title = OBR.t('optRemoveHidden');
        remove.addEventListener('click', () => {
          const next = (hiddenMap[host] || []).filter((p) => p !== pat);
          OBR.saveHidden(host, next).then((ok) => {
            if (ok === false) return; // write failed (quota?) — keep the list truthful
            if (next.length) hiddenMap[host] = next; else delete hiddenMap[host];
            renderHidden(); flashSaved();
          });
        });
        line.append(code, remove);
        row.appendChild(line);
      });
      wrap.appendChild(row);
    });
  }

  document.getElementById('reset').addEventListener('click', () => {
    // Reset to defaults wipes the settings blob (incl. site rules), the saved-pick map, AND the
    // hidden-images map — a full clear of the user's customizations.
    chrome.storage.sync.remove([OBR.PICKS_KEY, OBR.HIDDEN_KEY], () => {
      chrome.storage.sync.set({ [OBR.STORAGE_KEY]: {} }, () => {
        OBR.loadSettings().then((s) => {
          SLIDERS.forEach((k) => { setSliderFromSetting(k, s[k]); reflectValue(k); });
          SELECTS.forEach((k) => { document.getElementById(k).value = s[k]; });
          CHECKBOXES.forEach((k) => { document.getElementById(k).checked = !!s[k]; });
          rules = [];
          renderSites();
          picks = {};
          renderPicks();
          hiddenMap = {};
          renderHidden();
          flashSaved();
        });
      });
    });
  });

  document.getElementById('shortcutsBtn').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // The "scope" bar announces the current filterSite and offers "Show all"; it also primes
  // the add-rule input. Re-run whenever the scope changes (?site, a stashed site, a live change).
  function setFilterBar() {
    const bar = document.getElementById('siteFilterBar');
    if (filterSite) {
      document.getElementById('siteFilterName').textContent = filterSite;
      bar.hidden = false;
      const hostInput = document.getElementById('siteHost');
      if (hostInput && !hostInput.value) hostInput.value = filterSite; // prime "add rule" for this site
    } else {
      bar.hidden = true;
    }
  }
  function applySiteFilter(site) {
    let h = '';
    if (site) { try { h = OBR.normalizeHost(site); } catch (e) { h = ''; } }
    filterSite = h;
    setFilterBar();
    renderSites();
    renderPicks();
    renderHidden();
  }
  setFilterBar(); // initial ?site scope (the data renders below already respect filterSite)

  document.getElementById('siteFilterClear').addEventListener('click', () => {
    filterSite = '';
    setFilterBar();
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* drop the ?site param */ }
    renderSites();
    renderPicks();
    renderHidden();
  });

  OBR.loadSettings().then((s) => {
    bind(s);
    rules = s.siteRules || [];
    renderSites();
  });

  OBR.loadPicks().then((p) => { picks = p || {}; renderPicks(); });
  OBR.loadHiddenMap().then((m) => { hiddenMap = m || {}; renderHidden(); });

  // The reader/gallery ⚙ routes through openOptionsPage() (so an open options tab is focused,
  // not duplicated) and hands the site to scope via a one-shot chrome.storage.local key, not a
  // ?site= URL. Read + CLEAR it on load (an explicit ?site wins; clearing stops it lingering),
  // and re-scope live when it changes — that last part is what lets an already-open tab follow a
  // fresh ⚙ click instead of opening anew.
  const SITE_STASH = 'obr_options_site';
  const local = chrome.storage && chrome.storage.local;
  function consumeStashedSite() {
    if (!local) return;
    try {
      local.get(SITE_STASH, (d) => {
        const site = d && d[SITE_STASH];
        if (site) { local.remove(SITE_STASH); applySiteFilter(site); }
      });
    } catch (e) { /* local storage unavailable — ?site still works */ }
  }
  if (!filterSite) consumeStashedSite();
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SITE_STASH] && changes[SITE_STASH].newValue) consumeStashedSite();
      // Site rules can change under an open Options tab — a context-menu "Always open as…" on
      // another tab, or a sync from another device. Without this refresh, a later edit here would
      // write back a STALE rules array and silently drop those. Reload + re-render only when they
      // actually differ, so our own writes don't trigger a self re-render.
      if (area === 'sync' && changes[OBR.STORAGE_KEY]) {
        OBR.loadSettings().then((s) => {
          const next = s.siteRules || [];
          if (JSON.stringify(next) !== JSON.stringify(rules)) { rules = next; renderSites(); }
        });
      }
      // The hidden-images map can change from the gallery (another tab) or a device sync.
      if (area === 'sync' && changes[OBR.HIDDEN_KEY]) {
        OBR.loadHiddenMap().then((m) => { hiddenMap = m || {}; renderHidden(); });
      }
    });
  }
})();
