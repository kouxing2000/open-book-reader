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
  const CHECKBOXES = ['readSelection', 'galleryAutoLoad', 'galleryFitWidth', 'galleryHideAvatars', 'printSourceUrl', 'printBranding'];
  const savedEl = document.getElementById('saved');
  let saveTimer;

  // Optional ?site=<host> deep-link (the reader/gallery ⚙ pass the current site): scope the
  // site-rules + saved-picks lists to one site, with a "Show all" toggle. '' = show everything.
  let filterSite = (() => {
    try { const s = new URLSearchParams(location.search).get('site'); return s ? OBR.normalizeHost(s) : ''; }
    catch (e) { return ''; }
  })();

  // The shared status toast. `failed` styles it red and holds it longer.
  function flashNote(text, failed) {
    savedEl.textContent = text;
    savedEl.classList.toggle('error', !!failed);
    savedEl.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savedEl.classList.remove('show'), failed ? 2600 : 1200);
  }

  // `ok` is saveSettings' success boolean (undefined from legacy callers = assume ok). On a
  // failed write, say so instead of the dishonest "Saved ✓", and hold it a bit longer.
  function flashSaved(ok) {
    const failed = ok === false;
    flashNote(failed ? OBR.t('optSaveFailed') : OBR.t('optSaved'), failed);
  }

  /* ---- Site access (host permissions) --------------------------------------------------
   * Grant state lives in CHROME, not in our settings, so it changes behind this page's back
   * (chrome://extensions, or the list below). Two different SCOPES reach us:
   *   auto-open      -> OBR.originsForRule(match)  e.g. *://site.com/* + *://www.site.com/*
   *   ZIP download   -> the image origins themselves   (background.js permsFor(msg))
   * Neither is broad by default, but `<all_urls>` is still reachable via the permission popup's
   * explicit "Allow all sites instead", and it COVERS every per-site pattern — once held, a
   * per-rule contains() reports "granted" for EVERY site. That's why this card lists what
   * permissions.getAll() actually returns instead of testing each rule: the broad grant shows
   * up as ONE honest row rather than N false ones. */
  const ALL_URLS = '<all_urls>';

  // Whether a broad all-sites grant is currently held. Refreshed by renderSiteAccess (which
  // already calls getAll), and read SYNCHRONOUSLY by the Auto-open checkbox: permissions.request
  // must run inside the click's user gesture, so it cannot await a contains() round-trip first.
  let broadGrantHeld = false;

  function permsGetAll() {
    return new Promise((res) => {
      try {
        if (!chrome.permissions || !chrome.permissions.getAll) return res({ origins: [] });
        chrome.permissions.getAll((p) => { void chrome.runtime.lastError; res(p || { origins: [] }); });
      } catch (e) { res({ origins: [] }); }
    });
  }

  function permsContains(origins) {
    return new Promise((res) => {
      try {
        if (!chrome.permissions || !chrome.permissions.contains || !origins.length) return res(false);
        chrome.permissions.contains({ origins }, (h) => { void chrome.runtime.lastError; res(!!h); });
      } catch (e) { res(false); }
    });
  }

  // Revoke, then VERIFY — resolves true only if access is genuinely gone.
  // permissions.remove resolves `true` even for origins that were never granted, so its own
  // result proves nothing. And under a COVERING grant it does something subtler than failing:
  // observed behaviour is that the per-site entries vanish from getAll() while contains() stays
  // true — the bookkeeping changes, the access does not. contains() afterwards is the only
  // honest signal. Never report a revoke from remove()'s callback alone.
  function revokeOrigins(origins) {
    return new Promise((res) => {
      try {
        if (!chrome.permissions || !chrome.permissions.remove || !origins.length) return res(false);
        chrome.permissions.remove({ origins }, () => {
          void chrome.runtime.lastError;
          permsContains(origins).then((still) => res(!still));
        });
      } catch (e) { res(false); }
    });
  }

  // A grant that covers every site. background.js requests the literal '<all_urls>', but don't
  // assume getAll() echoes that exact string back — treat any all-host pattern the same, or the
  // card would label it a per-site grant and offer a Revoke that cannot work.
  function isBroadOrigin(o) {
    return o === ALL_URLS || /^(\*|https?):\/\/\*\/\*$/.test(String(o));
  }

  // The host a per-site origin pattern covers ('' for broad / unexpected shapes), used both as
  // the card's row label and its grouping key. A `*.` wildcard grant is KEPT as `*.example.com`
  // rather than collapsed to the apex: it covers strictly more, and merging it into a bare
  // `example.com` row would understate its reach on a card whose whole job is honest scope.
  function originHost(origin) {
    // Accept a scheme-specific pattern too, not just our own `*://` shape: Chrome's own Site
    // access box lets the user type one, and grants predating the per-origin download flow can
    // carry them. Failing to parse is not cosmetic — an unparsed grant loses its label, is
    // dropped by site scoping (the scoped view would claim no access while access exists), and
    // reads as "not used by any rule".
    const m = /^(?:\*|https?):\/\/([^/]+)\/\*$/.exec(String(origin));
    if (!m) return '';
    const host = m[1].toLowerCase();
    return host.startsWith('*.') ? host : host.replace(/^www\./, '');
  }

  function renderSiteAccess() {
    const wrap = document.getElementById('siteAccess');
    if (!wrap) return;
    permsGetAll().then((p) => {
      let origins = ((p && p.origins) || []).slice();
      broadGrantHeld = origins.some(isBroadOrigin); // read the UNfiltered set — scoping must not hide it
      // Scope to the focused site like the lists above, but ALWAYS keep the broad grant: it's
      // what explains why a scoped site still counts as granted. A `*.host` wildcard grant
      // covers the focused host too, so it belongs in that site's view.
      if (filterSite) origins = origins.filter((o) => isBroadOrigin(o)
        || originHost(o) === filterSite || originHost(o) === '*.' + filterSite);
      // One row per SITE, not per origin: auto-open grants a host as a PAIR
      // (`*://site.com/*` + `*://www.site.com/*`) and getAll reports each half separately, so
      // rendering raw origins would list the same site twice. Group by host — that also makes
      // each row's revoke target the whole pair, which is what actually frees the site.
      const groups = [];
      const byHost = new Map();
      origins.forEach((o) => {
        if (isBroadOrigin(o)) { groups.push({ broad: true, label: '', targets: [o] }); return; }
        const host = originHost(o) || o;
        let g = byHost.get(host);
        if (!g) { g = { broad: false, label: host, targets: [] }; byHost.set(host, g); groups.push(g); }
        g.targets.push(o);
      });
      // Broad grants first — they subsume every row under them, so their explanation reads
      // first. Two-key comparator (not a bare -1/1) so it stays consistent if Chrome ever
      // reports more than one all-host pattern.
      groups.sort((a, b) => (a.broad ? 0 : 1) - (b.broad ? 0 : 1) || a.label.localeCompare(b.label));

      wrap.textContent = '';
      const countEl = document.getElementById('accessCount');
      if (countEl) countEl.textContent = groups.length ? '(' + groups.length + ')' : '';
      if (!groups.length) {
        const empty = document.createElement('div');
        empty.className = 'site-empty';
        empty.textContent = filterSite ? OBR.t('optAccessNoneForSite', [filterSite]) : OBR.t('optAccessNone');
        wrap.appendChild(empty);
        return;
      }

      // Only claim a reason we can actually attribute. A per-site origin normally comes from an
      // auto-open rule — but Chrome lets the user type any site into its OWN Site access box,
      // and those arrive here with no rule behind them. Asserting "Granted for auto-open" for
      // one of those would be a plain lie on the card whose entire job is not misleading people.
      // Saying so also surfaces something useful: a grant nothing is using any more.
      const usedByRules = OBR.autoRuleOrigins(rules);

      groups.forEach((g) => {
        const row = document.createElement('div');
        row.className = 'acc-row';

        const org = document.createElement('span');
        org.className = 'acc-org' + (g.broad ? ' broad' : '');
        org.textContent = g.broad ? OBR.t('optAccessAllSites') : g.label;
        const why = document.createElement('span');
        why.className = 'acc-why';
        // A per-site row under a broad grant is REDUNDANT — the all-sites grant already covers
        // it, so removing this entry alone changes no access. Say so, rather than leaving the
        // user to discover it by clicking Revoke and getting a contradictory result.
        why.textContent = g.broad ? OBR.t('optAccessWhyAll')
          : broadGrantHeld ? OBR.t('optAccessRedundant')
            : OBR.t(g.targets.some((o) => usedByRules.indexOf(o) !== -1)
              ? 'optAccessWhySite' : 'optAccessWhyUnused');
        org.appendChild(why);

        const btn = document.createElement('button');
        btn.className = 'ghost acc-revoke';
        btn.textContent = OBR.t(g.broad ? 'optAccessRemove' : 'optAccessRevoke');
        btn.addEventListener('click', () => {
          btn.disabled = true;
          revokeOrigins(g.targets).then((gone) => {
            btn.disabled = false;
            // Removing a per-site entry under a broad grant DOES delete the entry (the row goes)
            // but cannot remove access (the broad grant still covers the site). Reporting only
            // "Still granted" while the row disappeared read as a contradiction — say both, and
            // don't colour it as a failure, because the part the user asked for did happen.
            const covered = !gone && !g.broad && broadGrantHeld;
            flashNote(OBR.t(gone ? 'optAccessRevoked'
              : covered ? 'optAccessRemovedStillCovered' : 'optAccessStillGranted'), !gone && !covered);
            renderSiteAccess();
            refreshPausedLines(); // a revoked site may now have paused auto-open rules
          });
        });

        row.append(org, btn);
        wrap.appendChild(row);
      });
    });
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

  // `then` receives saveSettings' success boolean, so a caller that follows up with a second
  // user-visible action (the auto-open revoke) can stay silent when the write itself failed
  // instead of overwriting "Save failed" with its own cheerier message.
  function persistRules(next, then) {
    rules = next;
    OBR.saveSettings({ siteRules: next }).then((ok) => { flashSaved(ok); if (then) then(ok !== false); });
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
  // denied prompt reverts the box); unchecking clears the flag AND hands the site permission
  // back. A ZIP download's grant is a DIFFERENT set of patterns (its own image origins), and
  // `remove` is pattern-exact, so releasing this pair cannot disturb it. The revoke is VERIFIED before it's reported: under a broad
  // <all_urls> grant the per-site removal is a no-op, and claiming "removed" then would lie.
  // Rules whose host part can't form a Chrome match pattern (a mid-host `*`) can't auto-open:
  // disabled box + a title explaining why.
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
        // `after` receives the save's success boolean (see persistRules).
        const commit = (on, after) => persistRules(
          OBR.setRuleAuto(cloneRules(), rule.match, on),
          (saved) => { if (onCommit) onCommit(on); if (after) after(saved); }
        );
        if (!cb.checked) {
          // Only release AFTER the write is known to have landed. Running them concurrently
          // let the revoke's green toast overwrite a red "Save failed" — reporting success for
          // a write that didn't persist, leaving the rule still auto:true in storage with its
          // permission gone. That dishonest-toast case is exactly why flashSaved takes `ok`.
          commit(false, (saved) => {
            if (!saved) return; // leave "Save failed" on screen; keep the grant
            releaseRuleOrigins(rule, rules).then(reportRelease);
          });
          return;
        }
        // Don't ask for access we already have. A broad all-sites grant (from a ZIP download)
        // already covers this site, and requesting anyway makes Chrome record a REDUNDANT
        // per-site entry that then shows up as its own Site access row beside "All sites" —
        // which is exactly what it looked like before this check.
        if (broadGrantHeld) { commit(true); return; }
        requestOrigins(origins, (granted) => {
          if (!granted) { cb.checked = false; return; }
          commit(true);
          renderSiteAccess();
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

  // Deleting a rule releases its site permission too, on the same terms as unchecking
  // Auto-open — otherwise the grant outlives the only thing that asked for it, and the two
  // ways of switching auto-open off would behave differently.
  function removeRule(i) {
    const gone = rules[i];
    const next = cloneRules();
    next.splice(i, 1);
    persistRules(next, (saved) => {
      renderSites();
      if (saved && gone && gone.auto === true) releaseRuleOrigins(gone, rules).then(reportRelease);
    });
  }

  // Hand a rule's site permission back, on the shared terms in OBR.releasableOrigins — which
  // holds the grant when a sibling auto rule on the same host still needs it (origins are
  // HOST-scoped, so `host/blog/*` and `host/forum/*` share one). The service worker's
  // "Stop auto-opening" menu item calls the same helper, so turning auto-open off behaves
  // identically wherever the user does it. `nextRules` is the rule list AFTER the change.
  // Resolves null when nothing was released, otherwise revokeOrigins' VERIFIED boolean.
  function releaseRuleOrigins(rule, nextRules) {
    const origins = OBR.releasableOrigins(rule, nextRules); // [] = not grantable, or a sibling needs it
    if (!origins.length) return Promise.resolve(null);
    return revokeOrigins(origins);
  }

  // Report a release + refresh the card. `null` = we deliberately kept the grant for a sibling
  // rule, which is not a failure and gets no toast at all.
  function reportRelease(gone) {
    if (gone !== null) flashNote(OBR.t(gone ? 'optAccessRevoked' : 'optAccessStillGranted'), !gone);
    renderSiteAccess();
  }

  // Add the "auto-open is on but has no site permission" line to a rule row, with an inline
  // re-grant. It's a SIBLING of the gloss, not a rewrite of it: the gloss says what the rule
  // does and stays true either way, while this line says whether it can currently run. The
  // click runs in a real user gesture, so it goes straight to the same requestOrigins path
  // the checkbox uses.
  function markPaused(row, origins) {
    // Guards a double-probe of the SAME row (render + a permission event landing together).
    // It does NOT catch a full re-render — that builds brand-new row nodes, so a probe still
    // in flight resolves onto a detached row and its warning is simply dropped. That's benign:
    // the new render fires its own probe. Don't "fix" it by holding a stale row reference.
    if (row.querySelector('.site-warn')) return;
    const warn = document.createElement('div');
    warn.className = 'site-warn';
    warn.textContent = OBR.t('optAutoPaused') + ' ';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = OBR.t('optAutoRegrant');
    btn.addEventListener('click', () => {
      requestOrigins(origins, (granted) => {
        if (!granted) return;
        warn.remove();
        renderSiteAccess();
      });
    });
    warn.appendChild(btn);
    row.appendChild(warn);
  }

  // Re-probe every rendered auto rule and add/remove its paused line IN PLACE. Used when
  // permissions change under an open page: a full renderSites() rebuilds every row from
  // storage, which would wipe an in-progress pattern edit and close an open <select> — and
  // permissions.onAdded fires for unrelated activity in other tabs (the gallery asking for
  // `downloads`), so that would be data loss triggered by something the user isn't even
  // looking at. Rows carry their rule's `match` in a data attribute to survive this lookup.
  function refreshPausedLines() {
    const wrap = document.getElementById('sites');
    if (!wrap) return;
    Array.from(wrap.querySelectorAll('.site-row')).forEach((row) => {
      const rule = (rules || []).find((r) => r && String(r.match || '') === (row.dataset.ruleMatch || ''));
      const drop = () => { const w = row.querySelector('.site-warn'); if (w) w.remove(); };
      if (!rule || rule.auto !== true) return drop();
      const origins = OBR.originsForRule(rule.match);
      if (!origins.length) return drop();
      permsContains(origins).then((has) => {
        if (has) drop();
        else markPaused(row, origins); // no-ops when the line is already there
      });
    });
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
      row.dataset.ruleMatch = String(rule.match || ''); // lets refreshPausedLines find its rule

      // The muted gloss under the row; updated in place when mode / auto change
      // (no full re-render, so an open <select> keeps focus).
      const sub = document.createElement('div');
      sub.className = 'site-sub';
      sub.textContent = ruleSummary(rule);

      // Auto-open needs a site permission that lives outside our settings and can be revoked
      // without us (chrome://extensions, the Site access card). Checking it is async, so patch
      // the row when it resolves rather than blocking this synchronous render — same shape as
      // patCommit's check. The stored `auto` flag is deliberately KEPT (background.js re-arms
      // the sentinel if the permission comes back), so the box stays checked and only the
      // gloss tells the truth: on, but paused.
      if (rule.auto === true) {
        const gOrigins = OBR.originsForRule(rule.match);
        if (gOrigins.length) permsContains(gOrigins).then((has) => { if (!has) markPaused(row, gOrigins); });
      }

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
    // The auto rules are about to vanish, so the site permissions they asked for would outlive
    // the only thing referencing them: an orphaned grant that nothing in the UI explains. Take
    // the origins BEFORE the wipe and hand them back after. Deliberately rule-derived only —
    // a broad <all_urls> grant belongs to the gallery's ZIP download, not to any rule, so a
    // settings reset is not the place to revoke it.
    const orphaned = OBR.autoRuleOrigins(rules);
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
          if (orphaned.length) revokeOrigins(orphaned).then(renderSiteAccess);
          else renderSiteAccess();
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
    renderSiteAccess();
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
    renderSiteAccess();
  });

  OBR.loadSettings().then((s) => {
    bind(s);
    rules = s.siteRules || [];
    renderSites();
    // Re-render the access card now that `rules` exists: its per-row "why" attributes each
    // grant to a rule, and the first render below runs before this resolves — so without
    // this a legitimately-used grant briefly reads "Not used by any auto-open rule".
    renderSiteAccess();
  });

  OBR.loadPicks().then((p) => { picks = p || {}; renderPicks(); });
  OBR.loadHiddenMap().then((m) => { hiddenMap = m || {}; renderHidden(); });
  renderSiteAccess();

  // Grants can change while this page sits open — from chrome://extensions, or from a
  // permission prompt in another tab. Re-render both the access list and the rule rows so the
  // page never keeps claiming access it no longer has (or paused rows it no longer has).
  // Guard BOTH events: a partial shim carrying one but not the other would throw here at IIFE
  // top level and kill everything below it (the stashed-site consumption, storage.onChanged).
  if (chrome.permissions && chrome.permissions.onAdded && chrome.permissions.onRemoved) {
    const refreshAccess = () => { renderSiteAccess(); refreshPausedLines(); };
    chrome.permissions.onAdded.addListener(refreshAccess);
    chrome.permissions.onRemoved.addListener(refreshAccess);
  }

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

  // The context menu's "Auto-open on pages like this…" stashes a best-guess URL PATTERN + the
  // auto flag here. Scope to the pattern's host (which opens the Per-site data section), then
  // pre-fill the add-rule form with the full pattern, tick Auto-open, and scroll + focus it so
  // the user lands right on the editable field to review/adjust the scope before adding.
  const PREFILL_STASH = 'obr_options_prefill';
  function applyPrefill(pf) {
    const pattern = OBR.normalizePattern((pf && pf.pattern) || '');
    if (!pattern) return;
    const host = OBR.normalizeHost(String(pattern).split('/')[0].replace(/^\*\./, ''));
    applySiteFilter(host); // scope the lists + auto-open the section + prime #siteHost with the host
    const hostInput = document.getElementById('siteHost');
    const autoCb = document.getElementById('siteAuto');
    if (hostInput) hostInput.value = pattern; // override the host-priming with the full URL pattern
    if (autoCb) autoCb.checked = pf.auto !== false;
    requestAnimationFrame(() => {
      if (!hostInput) return;
      hostInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      hostInput.focus();
      try { hostInput.select(); } catch (e) { /* */ }
    });
  }
  function consumePrefill() {
    if (!local) return;
    try {
      local.get(PREFILL_STASH, (d) => {
        const pf = d && d[PREFILL_STASH];
        if (pf && pf.pattern) { local.remove(PREFILL_STASH); applyPrefill(pf); }
      });
    } catch (e) { /* local storage unavailable */ }
  }

  if (!filterSite) consumeStashedSite();
  consumePrefill();
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SITE_STASH] && changes[SITE_STASH].newValue) consumeStashedSite();
      if (area === 'local' && changes[PREFILL_STASH] && changes[PREFILL_STASH].newValue) consumePrefill();
      // Site rules can change under an open Options tab — a context-menu "Always open as…" on
      // another tab, or a sync from another device. Without this refresh, a later edit here would
      // write back a STALE rules array and silently drop those. Reload + re-render only when they
      // actually differ, so our own writes don't trigger a self re-render.
      if (area === 'sync' && changes[OBR.STORAGE_KEY]) {
        OBR.loadSettings().then((s) => {
          const next = s.siteRules || [];
          // renderSiteAccess too: the card attributes each grant to a rule, so a rule change
          // from another tab/device can flip a row between "for auto-open" and "unused".
          if (JSON.stringify(next) !== JSON.stringify(rules)) { rules = next; renderSites(); renderSiteAccess(); }
        });
      }
      // The hidden-images map can change from the gallery (another tab) or a device sync.
      if (area === 'sync' && changes[OBR.HIDDEN_KEY]) {
        OBR.loadHiddenMap().then((m) => { hiddenMap = m || {}; renderHidden(); });
      }
    });
  }
})();
