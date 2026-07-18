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

  // Ask for the per-site origin permission an auto-open rule needs. This page is an
  // extension page and the change event runs in a click's gesture context, so
  // permissions.request can prompt directly — no popup relay needed here.
  function requestOrigins(origins, cb) {
    try {
      if (chrome.permissions && chrome.permissions.request) {
        chrome.permissions.request({ origins }, (granted) => { void chrome.runtime.lastError; cb(!!granted); });
        return;
      }
    } catch (e) { /* fall through */ }
    cb(false);
  }

  // The per-row Auto-open checkbox. Checking asks for the site permission first (a
  // denied prompt reverts the box); unchecking only clears the flag — the permission is
  // never auto-revoked (it may serve other features; revoking is the user's call in
  // chrome://extensions). Rules whose host part can't form a Chrome match pattern
  // (a mid-host `*`) can't auto-open: disabled box + a title explaining why.
  function autoCheckbox(rule, onCommit) {
    const label = document.createElement('label');
    label.className = 'site-auto';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rule.auto === true;
    const text = document.createElement('span');
    text.textContent = OBR.t('optAutoCol');
    const origins = OBR.originsForRule(rule.match);
    if (!origins.length) {
      cb.disabled = true;
      label.title = OBR.t('optAutoNoPattern');
    } else {
      label.title = OBR.t('optAutoHint');
      cb.addEventListener('change', () => {
        // Persist the flag, then let the caller refresh the row's plain-English gloss.
        const commit = (on) => persistRules(
          OBR.setRuleAuto(cloneRules(), rule.match, on),
          onCommit ? () => onCommit(on) : undefined
        );
        if (!cb.checked) return commit(false);
        requestOrigins(origins, (granted) => {
          if (!granted) { cb.checked = false; return; }
          commit(true);
        });
      });
    }
    label.append(cb, text);
    return label;
  }

  // A plain-language gloss of what a rule does, derived from its pattern scope +
  // mode + auto flag — nothing stored, so it always matches the live rule. Keeps
  // each row self-describing instead of an opaque "site + on/off".
  function ruleSummary(rule) {
    const pat = String(rule.match || '');
    const slash = pat.indexOf('/');
    const host = slash === -1 ? pat : pat.slice(0, slash);
    const path = slash === -1 ? '' : pat.slice(slash); // keeps the leading '/'
    const isSub = /^\*\./.test(host); // subdomain-wildcard rule (also matches the apex)
    const hasPath = path && path !== '/' && path !== '/*';
    let scope;
    if (hasPath) scope = OBR.t(isSub ? 'optRuleScopeSubsPath' : 'optRuleScopePath', [path]);
    else if (isSub) scope = OBR.t('optRuleScopeSubs');
    else scope = OBR.t('optRuleScopeSite');
    const specificMode = rule.mode === 'text' || rule.mode === 'images';
    const modeName = OBR.t(rule.mode === 'text' ? 'optModeReader'
      : rule.mode === 'images' ? 'optModeGallery' : 'optModeAuto');
    let act;
    if (rule.auto === true) act = specificMode ? OBR.t('optRuleActAutoMode', [modeName]) : OBR.t('optRuleActAutoSmart');
    else act = specificMode ? OBR.t('optRuleActManualMode', [modeName]) : OBR.t('optRuleActManualSmart');
    return scope + ' · ' + act;
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
      renderFocus();
      return;
    }
    list.forEach(({ rule, i }) => {
      const row = document.createElement('div');
      row.className = 'site-row';

      // The muted gloss under the row; updated in place when mode / auto change
      // (no full re-render, so an open <select> keeps focus).
      const sub = document.createElement('div');
      sub.className = 'site-sub';
      sub.textContent = ruleSummary(rule);

      // Editable URL pattern — mirrors the saved-pick selector editor (live ✓/✗, ↶ revert,
      // Esc to cancel). Committing renames the rule's `match`, so you can refine a whole-site
      // rule into a path one (e.g. host -> host/blog/*) without delete + re-add.
      const original = String(rule.match || '');
      const pat = document.createElement('input');
      pat.type = 'text'; pat.className = 'site-pat-input'; pat.spellcheck = false;
      pat.value = original;
      pat.setAttribute('aria-label', OBR.t('optRulePatternAria'));
      const mark = document.createElement('span');
      mark.className = 'pick-valid';
      const revert = document.createElement('button');
      revert.className = 'ghost pick-revert'; revert.textContent = '↶'; revert.title = OBR.t('optRevertTitle');

      // A pattern is invalid if it can't normalize OR it duplicates ANOTHER rule's `match`
      // (editing A to equal B would shadow-collide — matchSiteRuleEx keeps only the first —
      // and leave two identical, independently-editable rows). addRule dedups too.
      const patCollides = (norm) => rules.some((r, j) => j !== i && String(r.match || '') === norm);
      const patValidity = () => {
        const v = pat.value.trim();
        const norm = v ? OBR.normalizePattern(v) : '';
        const ok = !!norm && !patCollides(norm);
        mark.textContent = v ? (ok ? '✓' : '✗') : '';
        mark.className = 'pick-valid ' + (v ? (ok ? 'ok' : 'bad') : '');
        pat.classList.toggle('invalid', !!v && !ok);
        return ok;
      };
      const patRefresh = () => { patValidity(); revert.style.display = pat.value.trim() === original ? 'none' : ''; };
      const patCommit = () => {
        const norm = OBR.normalizePattern(pat.value);
        if (!norm || norm === original) { pat.value = norm || original; patRefresh(); return; } // empty/broken/unchanged
        if (patCollides(norm)) { patRefresh(); return; } // duplicate of another rule — keep ✗ shown, don't persist
        const next = cloneRules();
        next[i] = Object.assign({}, next[i], { match: norm });
        const finish = () => persistRules(next, renderSites); // structural change -> full re-render
        // Origins are HOST-scoped, so a path-only edit keeps the same grant. Only a HOST
        // change (or an un-grantable pattern) can leave an auto rule ungranted — turn auto
        // OFF then, so re-checking the box runs the tested permission prompt in a click gesture.
        if (next[i].auto === true) {
          const origins = OBR.originsForRule(norm);
          if (!origins.length) { delete next[i].auto; return finish(); }
          if (chrome.permissions && chrome.permissions.contains) {
            return chrome.permissions.contains({ origins }, (has) => {
              void chrome.runtime.lastError;
              if (!has) delete next[i].auto;
              finish();
            });
          }
        }
        finish();
      };
      pat.addEventListener('input', patRefresh);
      pat.addEventListener('change', patCommit); // blur / Enter when the value changed
      pat.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); pat.blur(); }           // commit
        else if (e.key === 'Escape') { e.preventDefault(); pat.value = original; patRefresh(); } // cancel
      });
      revert.addEventListener('click', () => { pat.value = original; patRefresh(); pat.focus(); });
      patRefresh();

      const mode = modeSelect(rule.mode);
      mode.addEventListener('change', () => {
        const next = cloneRules();
        next[i] = Object.assign({}, next[i], { mode: mode.value });
        persistRules(next);
        sub.textContent = ruleSummary(next[i]);
      });

      // persistRules sets rules = next before this runs, so rules[i] carries the latest MODE
      // (from an in-place mode change this row) as well as the new auto flag — read it rather
      // than rebuild from the stale render-time `rule`, which would repaint an old mode.
      const auto = autoCheckbox(rule, () => {
        sub.textContent = ruleSummary(rules[i]);
      });

      const remove = document.createElement('button');
      remove.className = 'ghost site-remove'; remove.textContent = '✕'; remove.title = OBR.t('optRemove');
      remove.addEventListener('click', () => removeRule(i));

      const top = document.createElement('div');
      top.className = 'site-top';
      top.append(pat, mark, revert, mode, auto, remove);

      row.append(top, sub);
      wrap.appendChild(row);
    });
    renderFocus();
  }

  function addRule() {
    const input = document.getElementById('siteHost');
    const match = OBR.normalizePattern(input.value);
    if (!match) return;
    const modeVal = document.getElementById('siteMode').value;
    const autoCb = document.getElementById('siteAuto');
    const finish = (auto) => {
      const next = cloneRules();
      const existing = next.find((r) => r.match === match); // update in place if same pattern
      if (existing) { existing.mode = modeVal; if (auto) existing.auto = true; }
      else { const r = { match, mode: modeVal }; if (auto) r.auto = true; next.push(r); }
      persistRules(next, renderSites);
      input.value = '';
      if (autoCb) autoCb.checked = false;
    };
    if (autoCb && autoCb.checked) {
      // Auto-open needs the site permission; a denied prompt (or an un-grantable
      // pattern) still adds the rule, just without the auto flag — the row's checkbox
      // shows the state and can retry.
      const origins = OBR.originsForRule(match);
      if (!origins.length) return finish(false);
      return requestOrigins(origins, (granted) => finish(granted));
    }
    finish(false);
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
    renderFocus(); // keep the "focus on a site" list in sync with pick hosts
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
    renderFocus(); // keep the "focus on a site" list in sync with hidden-image hosts
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
      // The scoped lists (rules/picks/hidden) live inside the collapsed "Per-site data"
      // <details>; expand it so a ⚙ deep-link / stash / focus pick actually reveals them.
      const section = document.getElementById('perSiteSection');
      if (section) section.open = true;
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

  // The distinct sites that have any rule / saved pick / hidden-image entry — the focus
  // dropdown's options. A rule host drops a leading "*." (a subdomain-wildcard rule focuses
  // under its base host) and is normalized to match the pick/hidden keys (bare hosts).
  function focusHosts() {
    const set = new Set();
    (rules || []).forEach((r) => {
      const h = OBR.normalizeHost(String(r.match || '').split('/')[0].replace(/^\*\./, ''));
      if (h) set.add(h);
    });
    Object.keys(picks || {}).forEach((h) => { if (h) set.add(h); });
    Object.keys(hiddenMap || {}).forEach((h) => { if ((hiddenMap[h] || []).length) set.add(h); });
    return Array.from(set).sort();
  }
  // Populate + toggle the manual "focus on a site" control. The options page can't read the
  // current tab (no `tabs` permission), so it can't auto-scope like the ⚙ deep-link does —
  // this lets you pick a site by hand. Shown only when NOT already scoped and ≥1 site exists.
  function renderFocus() {
    const bar = document.getElementById('siteFocusBar');
    const sel = document.getElementById('siteFocus');
    const hosts = focusHosts();
    // Badge the (default-collapsed) "Per-site data" header with the distinct-site count, so a
    // returning user sees there's saved data inside without having to expand it. Runs on every
    // list render (renderSites/renderPicks/renderHidden all call renderFocus).
    const countEl = document.getElementById('perSiteCount');
    if (countEl) countEl.textContent = hosts.length ? '(' + hosts.length + ')' : '';
    if (!bar || !sel) return;
    if (filterSite || !hosts.length) { bar.hidden = true; return; }
    sel.textContent = '';
    const all = document.createElement('option');
    all.value = ''; all.textContent = OBR.t('optFocusAll');
    sel.appendChild(all);
    hosts.forEach((h) => {
      const o = document.createElement('option');
      o.value = h; o.textContent = h;
      sel.appendChild(o);
    });
    sel.value = '';
    bar.hidden = false;
  }
  document.getElementById('siteFocus').addEventListener('change', (e) => applySiteFilter(e.target.value));

  // Remember which settings sections the user left open. This is per-device UI state, so it
  // lives in localStorage — NOT chrome.storage.sync, whose 8KB is reserved for real settings.
  // A stored value overrides the HTML default (Reader open, the rest collapsed); an active
  // site-scope still force-opens Per-site data below via setFilterBar(). Sections are keyed by
  // their summary's data-i18n so no extra ids are needed and the key survives reordering.
  const OPEN_KEY = 'obr_options_open';
  const sectionCards = Array.from(document.querySelectorAll('details.card'));
  const cardKey = (d) => { const el = d.querySelector('summary [data-i18n]'); return el ? el.getAttribute('data-i18n') : ''; };
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}');
    sectionCards.forEach((d) => { const k = cardKey(d); if (k && k in saved) d.open = !!saved[k]; });
  } catch (e) { /* no/blocked localStorage — the HTML defaults stand */ }
  sectionCards.forEach((d) => d.addEventListener('toggle', () => {
    try {
      const map = {};
      sectionCards.forEach((c) => { const k = cardKey(c); if (k) map[k] = c.open; });
      localStorage.setItem(OPEN_KEY, JSON.stringify(map));
    } catch (e) { /* ignore write failures — persistence is best-effort */ }
  }));

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
