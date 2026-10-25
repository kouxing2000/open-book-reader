/* Open Book Reader — auto-open sentinel
 * The ONLY extension code that ever runs on a page without a gesture — and only on
 * sites where the user explicitly enabled auto-open (a siteRules entry with auto:true
 * whose origin permission was granted; see docs/auto-open-spec.md). Registered by the
 * service worker via chrome.scripting.registerContentScripts (id 'obr-sentinel',
 * js: [settings.js, sentinel.js]) and ALSO injected straight into the enabling tab by
 * the enable flow (registration only affects future document loads).
 *
 * It watches the page, runs the decision ladder (suppression/state → rule → metadata
 * veto → content gate) over a short settle window, and when a probe passes asks the
 * SW to inject the engine and open the rule's mode. A Reader or Gallery rule is the
 * user's own choice and opens on every page it matches; only Smart pick judges the page,
 * and there every ambiguity resolves toward NOT opening — a miss costs one manual click,
 * a wrong open costs trust.
 * It only READS the page; the one thing it ever adds is the enable-time confirmation
 * chip (its own shadow host, via OBR._showAutoChip).
 */
(function () {
  const OBR = (globalThis.OBR = globalThis.OBR || {});
  if (OBR._sentinelLoaded) return; // double-injection guard (enable-time executeScript + registered load)
  OBR._sentinelLoaded = true;

  // Shared with the engines (registered scripts and executeScript injections share the
  // extension's ONE isolated world per frame): pages the user dismissed reading mode on.
  OBR._autoSuppressed = OBR._autoSuppressed || new Set();

  // Probe schedule (ms after arm): forum posts and SPA content render late, so retry a
  // few times — Smart pick re-runs veto then gate on every probe — then give up quietly
  // (no badge, no toast). Overridable before injection for tests (OBR._sentinelDelays).
  const DELAYS = OBR._sentinelDelays || [0, 1000, 2500, 5000];

  // Exact schema.org @type strings. A top-level list-ish node VETOES the open; a
  // top-level article-ish node alongside suspends the veto (the content gate then
  // decides — thresholds never drop). Exact string equality ONLY — BreadcrumbList is
  // schema.org's subtype of ItemList and rides on virtually every news article, so
  // substring/subtype matching would veto every news site.
  const LIST_TYPES = ['CollectionPage', 'ItemList', 'SearchResultsPage', 'ProfilePage'];
  const ARTICLE_TYPES = ['Article', 'NewsArticle', 'BlogPosting', 'DiscussionForumPosting', 'QAPage'];

  // px, both sides, for the image gate — deliberately above the gallery's 80px
  // collection floor (divergence fails toward NOT opening; strict bias).
  const IMG_MIN = 120;

  /* ------------------------------------------------------------- metadata veto */
  // The @type strings of TOP-LEVEL JSON-LD nodes only: each block's root object, the
  // members of a root array or @graph, and a root node's mainEntity. Types nested under
  // itemListElement/item deliberately do NOT count — Google's recommended carousel
  // markup for category pages is an ItemList whose itemListElement→item entries are
  // Articles, so a flat "article-ish anywhere" scan would suspend the veto on exactly
  // the list pages it exists for. Unparseable JSON-LD is ignored (neutral).
  function topLevelTypes() {
    const types = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      let j = null;
      try { j = JSON.parse(s.textContent); } catch (e) { return; }
      const nodes = [];
      (Array.isArray(j) ? j : [j]).forEach((r) => {
        if (!r || typeof r !== 'object') return;
        nodes.push(r);
        if (Array.isArray(r['@graph'])) r['@graph'].forEach((g) => { if (g && typeof g === 'object') nodes.push(g); });
      });
      nodes.slice().forEach((n) => { // one level of mainEntity (WebPage → Article is a common shape)
        const m = n.mainEntity;
        if (m && typeof m === 'object' && !Array.isArray(m)) nodes.push(m);
      });
      nodes.forEach((n) => {
        const t = n['@type'];
        if (typeof t === 'string') types.push(t);
        else if (Array.isArray(t)) t.forEach((x) => { if (typeof x === 'string') types.push(x); });
      });
    });
    return types;
  }

  // 'veto' | 'neutral'. One-directional by design: metadata is a CLAIM, not a
  // measurement — it may stop an open, never enable one. (og:type plays no role at
  // all: sloppy templates stamp it sitewide too often to trust in either direction.)
  function metadataVerdict() {
    let types;
    try { types = topLevelTypes(); } catch (e) { return 'neutral'; }
    if (!types.some((t) => LIST_TYPES.includes(t))) return 'neutral';
    return types.some((t) => ARTICLE_TYPES.includes(t)) ? 'neutral' : 'veto';
  }
  OBR._sentinelMetadataVerdict = metadataVerdict; // test hook

  /* ------------------------------------------------------------- content gates */
  // Lazy-load evidence: loading="lazy" or a data-* attribute carrying a URL-ish value.
  // Needed because manga/webtoon pages have decoded almost nothing at probe time — but
  // requiring the evidence (not just a layout box) keeps decorative/broken <img>es from
  // counting.
  function lazyEvidence(img) {
    if ((img.getAttribute('loading') || '').toLowerCase() === 'lazy') return true;
    for (const a of img.attributes) {
      if (!a.name.startsWith('data-')) continue;
      const v = a.value || '';
      if (/^(https?:)?\/\//i.test(v) || /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(v)) return true;
    }
    return false;
  }

  function imageGatePasses(minCount) {
    let n = 0;
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      if (img.naturalWidth >= IMG_MIN && img.naturalHeight >= IMG_MIN) n++;
      else if (lazyEvidence(img)) {
        const r = img.getBoundingClientRect();
        if (r.width >= IMG_MIN && r.height >= IMG_MIN) n++;
      }
      if (n >= minCount) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------- the ladder */
  // Observable state for tests (poll `done`) and for the SW console when debugging.
  const state = (OBR._sentinelState = {
    armedUrl: '', armedKey: '', armCount: 0, probesDone: 0, done: false, outcome: '', mode: '',
  });

  let armToken = 0;       // bumping it cancels the in-flight schedule (SPA re-arm)
  let justEnabled = false; // one-shot: show the §3.1 confirmation chip if nothing opens

  function hostVisible(id) {
    const h = document.getElementById(id);
    return !!h && getComputedStyle(h).display !== 'none';
  }

  // Focus sits where the user types: a text field, an editor, or a frame (old forum reply
  // boxes are iframe editors). Shadow roots are followed to the element that holds focus.
  function typingFocus() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'IFRAME') return true;
    return tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i.test(el.type || '');
  }

  // One full ladder pass. Returns { mode } on a pass; otherwise a string outcome —
  // terminal ('suppressed' | 'overlay-open' | 'no-rule' | 'stale') or retryable
  // ('vetoed' | 'gate': content may still be rendering, the next probe re-checks), and on
  // the last probe 'typing'. `isFinal` marks the last probe of the settle window.
  async function probe(token, isFinal) {
    // Step 0 — suppression & state.
    if (OBR._autoSuppressed.has(OBR._autoPageKey())) return 'suppressed';
    if (hostVisible('obr-host') || hostVisible('obr-gallery-host')) return 'overlay-open';
    // Step 1 — the rule (fresh settings each probe: the chip's Stop writes mid-window).
    const settings = await OBR.loadSettings();
    if (token !== armToken) return 'stale';
    const rule = OBR.matchSiteRuleEx(location.href, settings.siteRules);
    if (!rule || rule.auto !== true) return 'no-rule';
    // A 0 ("off") threshold falls back to the default: for the TOOLBAR auto-pick 0
    // disables a signal, but here it would make every page pass the content checks.
    const minWords = settings.autoTextMinWords > 0 ? settings.autoTextMinWords : OBR.DEFAULTS.autoTextMinWords;
    const anchor = settings.autoAnchorWords > 0 ? settings.autoAnchorWords : OBR.DEFAULTS.autoAnchorWords;
    const minImgs = settings.autoGalleryMin > 0 ? settings.autoGalleryMin : OBR.DEFAULTS.autoGalleryMin;
    const proseOk = (opts) => {
      const st = OBR._proseStats(opts);
      return st.words >= minWords && st.maxBlock >= anchor;
    };
    // Reader or Gallery: the user picked the view, so it opens on every page the rule
    // matches, list pages included, and no veto applies. The content checks only time it:
    // a page that renders late opens once its content shows ({ divs: true } also sees a post
    // kept in one <div> split by <br>), and any page on the last probe — unless a text box has
    // focus by then, where the reader's keys would swallow what the user types.
    if (rule.mode === 'text' || rule.mode === 'images') {
      if (isFinal) return typingFocus() ? 'typing' : { mode: rule.mode };
      return (imageGatePasses(minImgs) || proseOk({ divs: true })) ? { mode: rule.mode } : 'gate';
    }
    // Smart pick. Step 2 — metadata veto, before the gate on every probe.
    if (metadataVerdict() === 'veto') return 'vetoed';
    // Step 3 — content gate: an article wins, else an image set, else nothing.
    const mode = proseOk() ? 'text' : (imageGatePasses(minImgs) ? 'images' : null);
    return mode ? { mode } : 'gate';
  }

  function requestOpen(mode) {
    try { console.info('[OpenBookReader] auto-open → ' + mode + ' on ' + location.host + location.pathname); } catch (e) { /* */ }
    try {
      if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'obr-auto-open', mode }, () => { void chrome.runtime.lastError; });
      }
    } catch (e) { /* messaging unavailable (harness) */ }
  }

  function finish(outcome, mode) {
    state.done = true;
    state.outcome = outcome;
    state.mode = mode || '';
    if (justEnabled) {
      // The user just enabled auto-open from this page and it did not open (a list page
      // under Smart pick, or a text box in focus at the last probe): confirm the switch
      // flipped instead of silently doing nothing — but never by wrongly opening.
      justEnabled = false;
      if (outcome !== 'opened') {
        try { OBR._showAutoChip('enabled', OBR.normalizeHost(location.href)); } catch (e) { /* */ }
      }
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  // Resolves when the document is (or becomes) visible — §3.2: never change state
  // behind the user's back in a hidden tab.
  const whenVisible = () => new Promise((resolve) => {
    if (!document.hidden) return resolve();
    const onVis = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVis);
      resolve();
    };
    document.addEventListener('visibilitychange', onVis);
  });

  async function runSchedule(token) {
    let elapsed = 0, last = '';
    for (let i = 0; i < DELAYS.length; i++) {
      await wait(DELAYS[i] - elapsed);
      elapsed = DELAYS[i];
      if (token !== armToken) return;
      await whenVisible();
      if (token !== armToken) return;
      let res;
      try { res = await probe(token, i === DELAYS.length - 1); } catch (e) { res = 'gate'; }
      if (token !== armToken || res === 'stale') return;
      state.probesDone = i + 1;
      if (res && typeof res === 'object') {
        finish('opened', res.mode);
        requestOpen(res.mode);
        return;
      }
      if (res === 'suppressed' || res === 'overlay-open' || res === 'no-rule') return finish(res, '');
      last = res; // 'vetoed' | 'gate' | 'typing' — content may still be rendering; next probe re-runs the full ladder
    }
    finish(last || 'gave-up', '');
  }

  function arm(opts) {
    if (opts && opts.justEnabled) justEnabled = true;
    if (OBR._justEnabled) { justEnabled = true; OBR._justEnabled = false; } // set ahead of injection by the enable flow
    armToken++;
    state.armCount++;
    state.armedUrl = location.href;      // full href, for debug visibility in the SW console
    state.armedKey = OBR._autoPageKey(); // origin+pathname+search — the re-arm comparison key
    state.probesDone = 0;
    state.done = false;
    state.outcome = '';
    state.mode = '';
    runSchedule(armToken);
  }
  // The enable flow calls this after injecting the files: on a RE-enable the load-time
  // guard above means this file's IIFE never re-runs, so the explicit re-arm is what
  // restarts probing (and carries the confirmation-chip flag).
  OBR._sentinelArm = arm;

  /* ------------------------------------------------------- SPA URL-change re-arm */
  function onUrlChange() {
    // Compare origin+pathname+search (NOT the hash) — the same key the suppression set
    // uses. A hash-only change (a scroll-spy or in-page anchor rewriting location.hash)
    // must not re-arm and perpetually reset the settle window; only a real navigation does.
    if (OBR._autoPageKey() === state.armedKey) return;
    arm();
  }
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);
  // A list that loads more as you scroll rewrites its address in place (replaceState, a
  // 'replace' navigation): it is still the page the user closed, so a closed address hands its
  // suppression to the new one at the moment of the rewrite. A click into a topic ('push', also
  // right after Back) and back/forward ('traverse') are judged on their own. Only the carry runs
  // here: re-arming at a push would probe the route before it renders.
  if (globalThis.navigation) {
    navigation.addEventListener('currententrychange', (e) => {
      if (e.navigationType !== 'replace' || !e.from || !e.from.url) return;
      const from = new URL(e.from.url);
      if (OBR._autoSuppressed.has(from.origin + from.pathname + from.search)) {
        OBR._autoSuppressed.add(OBR._autoPageKey());
      }
    });
  }
  // Re-arming waits for the route's render: the URL is compared on DOM mutations, throttled,
  // since an SPA route change always mutates the document.
  let moPending = false;
  const mo = new MutationObserver(() => {
    if (moPending) return;
    moPending = true;
    setTimeout(() => { moPending = false; onUrlChange(); }, 200);
  });
  try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { /* */ }

  arm(); // registered load (document_idle) or enable-time injection: start watching now
})();
