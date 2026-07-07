// Discovery plugin for BackIssue — "what should I read / add next".
//
// Not a download source: it surfaces new & upcoming comics from ComicVine (the
// app's source of truth) as one-click adds, in a self-contained Discover drawer.
// Four feeds: New Series (#1s launching), Upcoming (everything shipping soon),
// For You (new #1s from publishers you already collect), and Popular (new #1s
// ranked major-publisher-first — a labelled heuristic, since CV has no
// popularity metric and League of Comic Geeks is Cloudflare-walled).
import path from 'node:path';
import config from '../../src/config.js';
import { makeCvClient } from '../../src/cv.js';
import { buildNewSeries, buildLatest, buildForYou, buildPopular, isoDay } from './feeds.js';
import { makeEnrichCache, makeFeedCache } from './cache.js';
import { openCollection } from './collection.js';

const TABS = ['new', 'latest', 'foryou', 'popular'];

export default function register(api) {
  api.registerSettings({
    discoveryEnabled: { type: 'bool' },
    discoveryWindowDays: { type: 'int', min: 7, max: 180 },    // ± window for #1 launches
    discoveryUpcomingDays: { type: 'int', min: 7, max: 120 },  // forward window for Upcoming
    discoveryCacheHours: { type: 'int', min: 1, max: 168 },    // feed TTL
  });
  api.registerClientAsset({ js: 'client/ui.js', css: 'client/discover.css' });

  const cacheFile = path.join(import.meta.dirname, '.enrich-cache.json');
  const feedCache = makeFeedCache((Number(config.discoveryCacheHours) || 12) * 3600 * 1000);
  const collection = openCollection(config.dbPath);

  // Assemble one feed (served from the TTL cache). Enrichment (volume→publisher)
  // shares a disk cache, so only the first-ever build of a window is slow.
  async function buildFeed(tab) {
    const cv = makeCvClient(config); // throws if CV isn't configured — caller handles
    // Enrich generously so New Series (100) and Latest (80) items get a publisher
    // (needed to flag/hide manga); cached to disk, so the cost is paid once,
    // mostly on the background warm.
    const enrich = makeEnrichCache(cv, { file: cacheFile, maxPerRun: 120 }).enrich;
    const backDays = Number(config.discoveryWindowDays) || 42;
    const fwdDays = Number(config.discoveryUpcomingDays) || 42;
    return feedCache.get(tab, async () => {
      const win = { from: isoDay(-backDays), to: isoDay(backDays) };
      // Recent releases: a trailing window (CV has no forward-dated data). Start
      // safely in the past to dodge the store_date filter quirk — see buildLatest.
      if (tab === 'latest') return buildLatest(cv, enrich, { from: isoDay(-fwdDays), to: isoDay(3) });
      if (tab === 'foryou') return buildForYou(cv, enrich, collection.topPublishers(8), win);
      if (tab === 'popular') return buildPopular(cv, enrich, win);
      return buildNewSeries(cv, enrich, win);
    });
  }

  // Serve a feed, then stamp "owned" fresh every request — the CV data is stable
  // for the TTL, but the collection changes as you add series.
  // Default-on: the user opted in by installing the plugin, so it's enabled
  // unless the toggle was explicitly turned off.
  const enabled = () => config.discoveryEnabled !== false;

  api.registerRoute('get', '/api/discovery/feed', async (req, res) => {
    if (!enabled()) return res.json({ items: [], disabled: true });
    const tab = TABS.includes(String(req.query.tab)) ? String(req.query.tab) : 'new';
    try {
      const items = await buildFeed(tab);
      const owned = collection.ownedVolumeIds();
      res.json({ tab, items: items.map((i) => ({ ...i, owned: owned.has(i.cvVolumeId) })) });
    } catch (e) {
      const msg = e?.rateLimited ? 'ComicVine is rate-limited right now — try again shortly.'
        : /no ComicVine API keys/.test(String(e?.message)) ? 'ComicVine isn’t configured (add an API key in Settings).'
        : String(e?.message || e);
      res.json({ items: [], error: msg });
    }
  });

  // Warm the feeds in the background at boot so the first drawer open is instant
  // (enrichment can take ~40s on a cold disk cache). Fire-and-forget — never
  // blocks startup or other plugins.
  api.registerStartup(() => {
    if (enabled()) {
      (async () => { for (const tab of TABS) { try { await buildFeed(tab); } catch { /* CV down/off — retried on demand */ } } })();
    }
    return undefined; // no cleanup handle
  });
}
