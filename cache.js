// Two caches keep discovery from hammering the (rate-limited) ComicVine API:
//  - a PERSISTENT volume→publisher cache: publishers never change, so once a
//    volume is enriched it's cached forever (on disk), and enrichment is capped
//    per run so the first load can't fire hundreds of CV calls.
//  - an in-memory TTL cache for assembled feeds, so reopening the drawer or
//    switching back to a tab doesn't re-query CV.
import fs from 'node:fs';

export function makeEnrichCache(cv, { file, maxPerRun = 40 } = {}) {
  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run — no cache yet */ }
  let dirty = false;
  const save = () => { if (!dirty) return; try { fs.writeFileSync(file, JSON.stringify(store)); dirty = false; } catch { /* best-effort */ } };

  // volumeIds → Map(id → { publisher, startYear, coverUrl, count }). Cached ids
  // return free; uncached ids are fetched until the per-run budget runs out
  // (the rest fill in on later runs, so the feed improves as the cache warms).
  async function enrich(volumeIds) {
    const out = new Map();
    let budget = maxPerRun;
    for (const id of new Set(volumeIds.filter((x) => x != null))) {
      if (store[id]) { out.set(id, store[id]); continue; }
      if (budget <= 0) continue;
      budget--;
      try {
        const v = await cv.volume(id);
        const e = { publisher: v.publisher || null, startYear: v.start_year || null, coverUrl: v.image_url || null, count: v.count_of_issues || 0 };
        store[id] = e; dirty = true; out.set(id, e);
      } catch { /* leave un-enriched; retried next run */ }
    }
    save();
    return out;
  }
  return { enrich };
}

export function makeFeedCache(ttlMs = 12 * 3600 * 1000) {
  const m = new Map();
  return {
    async get(key, build) {
      const hit = m.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.val;
      const val = await build();
      m.set(key, { at: Date.now(), val });
      return val;
    },
    clear() { m.clear(); },
  };
}
