// Discovery client — injected by core via window.BackIssue. Adds a "Discover"
// entry to the sidebar's plugin area, opening a self-contained full-screen
// drawer with four feed tabs (New Series / Upcoming / For You / Popular). The bridge has no
// page-registration hook, so the plugin owns its own overlay element, tab state,
// and Escape/backdrop handling (mirrors the app's drawer pattern). Cards add a
// series straight to the collection via core's /api/collection/add-cv.
(function () {
  const TABS = [
    { key: 'new', label: 'New Series', blurb: 'First issues launching around now.' },
    { key: 'latest', label: 'Latest', blurb: 'Recently-released series across all publishers.' },
    { key: 'foryou', label: 'For You', blurb: 'New #1s from publishers you already collect.' },
    { key: 'popular', label: 'Popular', blurb: 'New #1s from major publishers (a heuristic — ComicVine has no popularity data).' },
  ];

  window.BackIssue.registerClient((api) => {
    const esc = api.escapeHtml;
    let overlay = null, gridEl = null, tabsEl = null, blurbEl = null;
    let active = 'new';
    let lastItems = [];                                       // last fetched feed, for re-filtering
    let westernOnly = localStorage.getItem('discoverWesternOnly') !== '0'; // default on

    // Settings block (Settings → Sources area — the only plugin settings slot).
    // Appended, never innerHTML-assigned, so it can't clobber other plugins.
    // Not a download source — mount in the dedicated Plugins settings tab when
    // the core has one, falling back to the Sources slot on older cores.
    const setSlot = api.slot('settings-plugin-panels') || api.slot('settings-plugin-sources');
    if (setSlot) {
      const block = document.createElement('div');
      block.className = 'src-block';
      block.innerHTML =
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-discoveryEnabled" type="checkbox" checked><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>Discovery</b><span class="modal__note src-toggle__note">A “Discover” button in the header opens new &amp; upcoming comics (from ComicVine) to add in one click.</span></div>' +
        '</div>' +
        '<div id="discovery-config" class="src-config">' +
          '<div class="fields-row">' +
            '<label class="field"><span>New/±window (days)</span><input id="set-discoveryWindowDays" type="number" min="7" max="180" step="7" placeholder="42"></label>' +
            '<label class="field"><span>Upcoming (days)</span><input id="set-discoveryUpcomingDays" type="number" min="7" max="120" step="7" placeholder="42"></label>' +
            '<label class="field"><span>Cache (hours)</span><input id="set-discoveryCacheHours" type="number" min="1" max="168" step="1" placeholder="12"></label>' +
          '</div>' +
          '<p class="modal__note">Feeds are cached this long to spare the ComicVine rate limit. “Popular” ranks new #1s by major publisher (a heuristic — ComicVine has no popularity metric).</p>' +
        '</div>';
      setSlot.appendChild(block);
      const en = block.querySelector('#set-discoveryEnabled');
      const cfg = block.querySelector('#discovery-config');
      const sync = () => cfg.classList.toggle('open', en.checked);
      en.onchange = sync; sync();
      api.onSettingsLoad(() => sync());
    }

    // Sidebar entry point (the Library menu's plugin area) — only for users who
    // can add series to the library. Discover's whole purpose is one-click Add
    // (POST /api/collection/add-cv, a library.manage action); a read-only viewer
    // couldn't act on it, so don't show it. (Older hosts without api.can still
    // get the button.)
    if (typeof api.can !== 'function' || api.can('library.manage')) {
      const btn = api.addMenuAction('Discover', openDiscover, (api.icon && api.icon('compass')) || '✧', { section: 'Discover' });
      btn.id = 'discover-btn';
      btn.title = 'Discover new & upcoming comics';
    }

    function openDiscover() {
      if (!overlay) buildOverlay();
      overlay.classList.add('is-open');
      document.body.classList.add('discover-open');
      selectTab(active);
    }
    function closeDiscover() {
      if (!overlay) return;
      overlay.classList.remove('is-open');
      document.body.classList.remove('discover-open');
    }

    function buildOverlay() {
      overlay = document.createElement('div');
      overlay.className = 'discover';
      overlay.innerHTML =
        '<div class="discover__backdrop"></div>' +
        '<div class="discover__panel" role="dialog" aria-label="Discover comics">' +
          '<div class="discover__head">' +
            '<div class="discover__title">✨ Discover</div>' +
            '<div class="discover__tabs"></div>' +
            '<label class="discover__manga" title="Show only Western (US/UK) publishers — hides manga and other foreign comics"><input type="checkbox" class="discover__manga-cb"' + (westernOnly ? ' checked' : '') + '> Western only</label>' +
            '<button class="discover__close" title="Close (Esc)">✕</button>' +
          '</div>' +
          '<div class="discover__blurb"></div>' +
          '<div class="discover__grid"></div>' +
        '</div>';
      document.body.appendChild(overlay);
      gridEl = overlay.querySelector('.discover__grid');
      tabsEl = overlay.querySelector('.discover__tabs');
      blurbEl = overlay.querySelector('.discover__blurb');

      for (const t of TABS) {
        const b = document.createElement('button');
        b.className = 'discover__tab'; b.dataset.tab = t.key; b.textContent = t.label;
        b.onclick = () => selectTab(t.key);
        tabsEl.appendChild(b);
      }
      const mangaCb = overlay.querySelector('.discover__manga-cb');
      mangaCb.onchange = () => {
        westernOnly = mangaCb.checked;
        localStorage.setItem('discoverWesternOnly', westernOnly ? '1' : '0');
        paint(); // re-filter the current feed without refetching
      };
      overlay.querySelector('.discover__close').onclick = closeDiscover;
      overlay.querySelector('.discover__backdrop').onclick = closeDiscover;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeDiscover();
      });
    }

    async function selectTab(key) {
      active = key;
      const meta = TABS.find((t) => t.key === key) || TABS[0];
      for (const b of tabsEl.querySelectorAll('.discover__tab')) b.classList.toggle('is-active', b.dataset.tab === key);
      blurbEl.textContent = meta.blurb;
      gridEl.innerHTML = '<div class="discover__note">Loading…</div>';
      let data;
      try { data = await api.get('/api/discovery/feed?tab=' + encodeURIComponent(key)); }
      catch (e) { gridEl.innerHTML = '<div class="discover__note discover__note--bad">Couldn’t load: ' + esc(String(e)) + '</div>'; return; }
      if (key !== active) return; // a newer tab click won the race
      if (data.disabled) return renderNote('Discovery is turned off. Enable it in <b>Settings → Discovery</b>.');
      if (data.error) return renderNote(esc(data.error), true);
      lastItems = data.items || [];
      paint();
    }

    // Render the current feed; when "Western only" is on, show just items whose
    // publisher is a known Western house (hides manga + other foreign comics, and
    // items whose publisher isn't identified yet).
    function paint() {
      renderCards(lastItems.filter((i) => !westernOnly || i.isWestern));
    }

    function renderNote(html, bad) {
      gridEl.innerHTML = '<div class="discover__note' + (bad ? ' discover__note--bad' : '') + '">' + html + '</div>';
    }

    function renderCards(items) {
      if (!items.length) return renderNote('Nothing here right now — try again later, or widen the window in Settings.');
      gridEl.innerHTML = '';
      for (const it of items) gridEl.appendChild(card(it));
    }

    function card(it) {
      const el = document.createElement('div');
      el.className = 'disc-card';
      // Wrap the cover in a fixed 2:3 box so the flex/grid layout can't squish
      // the image into a thin slice.
      const cover = '<div class="disc-card__coverwrap">' + (it.coverUrl
        ? '<img class="disc-card__cover" loading="lazy" src="' + esc(it.coverUrl) + '" alt="">'
        : '<span class="disc-card__cover--none">?</span>') + '</div>';
      const meta = [it.publisher, it.startYear].filter(Boolean).map(esc).join(' · ');
      const date = it.storeDate ? '<span class="disc-card__date">' + esc(it.storeDate) + '</span>' : '';
      el.innerHTML =
        cover +
        '<div class="disc-card__body">' +
          '<div class="disc-card__title" title="' + esc(it.name) + '">' + esc(it.name) + '</div>' +
          '<div class="disc-card__meta">' + (meta || '&nbsp;') + '</div>' +
          '<div class="disc-card__foot">' + date + '<span class="disc-card__action"></span></div>' +
        '</div>';
      const actionEl = el.querySelector('.disc-card__action');
      if (it.owned) actionEl.innerHTML = '<span class="disc-card__owned">✓ In collection</span>';
      else {
        const add = document.createElement('button');
        add.className = 'btn btn--ghost disc-card__add'; add.textContent = '+ Add';
        add.onclick = () => addSeries(it, add);
        actionEl.appendChild(add);
      }
      return el;
    }

    async function addSeries(it, btn) {
      if (it.cvVolumeId == null) return;
      btn.disabled = true; btn.textContent = 'Adding…';
      let r;
      try { r = await api.post('/api/collection/add-cv', { comicvineId: it.cvVolumeId }); }
      catch (e) { r = { error: String(e) }; }
      if (r && r.error) { btn.disabled = false; btn.textContent = '+ Add'; btn.title = r.error; return; }
      btn.replaceWith(Object.assign(document.createElement('span'), { className: 'disc-card__owned', textContent: '✓ Added' }));
    }
  });
})();
