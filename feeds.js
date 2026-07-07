// Discovery feed builders. Everything here is ComicVine-derived (CV is the app's
// source of truth) and split into small pure helpers + thin orchestrators so the
// shaping logic is testable without hitting the network.
//
// The reliable CV discovery signal is ISSUE store_dates, not volume recency
// (sorting volumes by date_added returns whatever was last catalogued — obscure
// back-catalogue, not new releases). So "new series" = #1 issues in a date
// window, deduped to their volume. Publisher isn't on an issue, so feeds that
// need it (For You, Popular, the publisher badge) enrich volumes on demand
// (cached — see cache.js).

// Western publishers we treat as "major" for the Popular heuristic and for
// filtering out the manga/foreign-language #1s that otherwise dominate the raw
// CV feed. Order is the ranking (earlier = higher).
export const MAJOR_PUBLISHERS = [
  'Marvel', 'DC Comics', 'Image', 'Image Comics', 'Dark Horse Comics', 'Dark Horse',
  'BOOM! Studios', 'IDW Publishing', 'Dynamite Entertainment', 'Titan Comics',
  'Vault Comics', 'Oni Press', 'Valiant', 'Mad Cave Studios', 'Skybound',
  'AWA Studios', 'AfterShock Comics', 'Archie Comics',
];

const FIELDS_ISSUE = 'issue_number,store_date,volume,name,image';

// yyyy-mm-dd for a date offset (in days) from `base` (defaults to today). Kept
// pure by taking `base` so tests are deterministic.
export function isoDay(offsetDays = 0, base = new Date()) {
  const d = new Date(base.getTime() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

// A CV issue (from a /issues list) → a partial feed item (no publisher yet).
export function issueToItem(i) {
  return {
    cvVolumeId: i.volume?.id ?? null,
    name: i.volume?.name || i.name || 'Unknown',
    issueNumber: i.issue_number ?? null,
    storeDate: i.store_date || null,
    coverUrl: i.image?.small_url || i.image?.original_url || i.image?.thumb_url || null,
    publisher: null,
    startYear: null,
    isManga: false,   // set by applyEnrichment once the publisher is known
    isWestern: false, // ditto — drives the "Western only" filter
    owned: false,
  };
}

// Collapse issues to one item per volume, keeping the earliest store_date (the
// launch). Drops items with no volume id (can't be added).
export function dedupByVolume(items) {
  const byVol = new Map();
  for (const it of items) {
    if (it.cvVolumeId == null) continue;
    const prev = byVol.get(it.cvVolumeId);
    if (!prev || (it.storeDate && prev.storeDate && it.storeDate < prev.storeDate)) byVol.set(it.cvVolumeId, it);
  }
  return [...byVol.values()];
}

// Normalize a publisher name for comparison (CV is inconsistent: "Image" vs
// "Image Comics", trailing punctuation, case).
export function normPublisher(p) {
  return String(p || '').trim().toLowerCase().replace(/\s+(comics|publishing|studios|entertainment)$/i, '').replace(/[!.]/g, '');
}

const MAJOR_NORM = MAJOR_PUBLISHERS.map(normPublisher);

// Manga publishers (Japanese houses + English manga imprints). CV has no
// format/origin field, so publisher is the only way to identify manga — used to
// optionally hide it from the New Series feed. Include name variants; they're
// matched after normPublisher (which strips a trailing "Comics/Entertainment"/…).
export const MANGA_PUBLISHERS = [
  'Shueisha', 'Kodansha', 'Kodansha Comics', 'Shogakukan', 'Kadokawa', 'Square Enix',
  'Hakusensha', 'Enterbrain', 'Akita Shoten', 'Futabasha', 'Ichijinsha', 'Houbunsha',
  'Media Factory', 'ASCII Media Works', 'Coamix', 'Comicsmart', 'Kobunsha', 'Takeshobo',
  'Viz', 'Viz Media', 'Seven Seas', 'Seven Seas Entertainment', 'Yen Press', 'Vertical',
  'Tokyopop', 'Denpa', 'Star Fruit Books', 'Kodansha USA',
];
const MANGA_NORM = new Set(MANGA_PUBLISHERS.map(normPublisher));
export function isManga(publisher) { return !!publisher && MANGA_NORM.has(normPublisher(publisher)); }

// Western (US/UK/Anglophone) comic publishers — an ALLOWLIST. Blocklisting the
// manga/foreign houses is endless (there are hundreds), so the "Western only"
// filter shows a publisher only if it's on THIS list; foreign AND unknown are
// hidden. Kept generous so legit indies aren't dropped. normPublisher folds CV's
// "Comics/Publishing/Studios/Entertainment" suffixes, so list the plain names.
export const WESTERN_PUBLISHERS = [
  'Marvel', 'Marvel Comics', 'DC', 'DC Comics', 'Image', 'Image Comics', 'Dark Horse', 'Dark Horse Comics',
  'IDW', 'IDW Publishing', 'BOOM! Studios', 'Dynamite Entertainment', 'Titan Comics', 'Oni Press',
  'Lion Forge', 'Mad Cave Studios', 'Mad Cave', 'Vault Comics', 'Valiant', 'Valiant Entertainment',
  'AWA Studios', 'AfterShock Comics', 'Skybound', 'Archie Comics', 'Fantagraphics', 'Rebellion', '2000 AD',
  'Ablaze', 'Scout Comics', 'Zenescope Entertainment', 'Antarctic Press', 'Action Lab', 'Black Mask Studios',
  'Humanoids', 'Ahoy Comics', 'Massive Publishing', 'Clover Press', 'Abstract Studio', 'Top Cow',
  'Vertigo', 'DC Black Label', 'Papercutz', 'First Second', 'Drawn & Quarterly', 'Legendary Comics',
  'Aspen', 'Aspen MLT', 'Red 5 Comics', 'Heavy Metal', 'Bad Idea', 'TKO Studios', 'DSTLRY',
  'American Mythology Productions', "Devil's Due", 'Keenspot Entertainment', 'Alien Books', 'Ignition Press',
  'Invader Comics', 'Floating World Comics', 'UDON', 'Harry N. Abrams', 'Abrams ComicArts', 'Wildstorm',
  'Icon', 'Blackbox Comics', 'Behemoth', 'Whatnot Publishing', 'Oni-Lion Forge', 'Boom Entertainment',
];
const WESTERN_NORM = new Set(WESTERN_PUBLISHERS.map(normPublisher));
export function isWestern(publisher) { return !!publisher && WESTERN_NORM.has(normPublisher(publisher)); }

// Rank index of a publisher in the major list (lower = more major; Infinity if
// not major).
export function majorRank(publisher) {
  const i = MAJOR_NORM.indexOf(normPublisher(publisher));
  return i === -1 ? Infinity : i;
}

// Apply enrichment (Map volumeId → {publisher,startYear,coverUrl,count}) onto
// items, filling publisher/startYear, preferring the volume cover, and flagging
// manga (so the client can hide it) once the publisher is known.
export function applyEnrichment(items, enriched) {
  return items.map((it) => {
    const e = enriched.get(it.cvVolumeId);
    if (!e) return it;
    const publisher = e.publisher ?? it.publisher;
    return { ...it, publisher, startYear: e.startYear ?? it.startYear, coverUrl: it.coverUrl || e.coverUrl, isManga: isManga(publisher), isWestern: isWestern(publisher) };
  });
}

// --- Orchestrators ---------------------------------------------------------
// Each takes the CV client and (where publisher matters) an async
// `enrich(volumeIds) → Map`. They return an array of feed items.

// New #1 issues in [from,to], one per volume, newest first. enrich adds the
// publisher badge but the feed renders without it if enrichment is capped out.
export async function buildNewSeries(cv, enrich, { from, to, limit = 100 } = {}) {
  const { results } = await cv.list('issues', {
    filter: `issue_number:1,store_date:${from}|${to}`,
    sort: 'store_date:desc', fieldList: FIELDS_ISSUE, limit,
  });
  const items = dedupByVolume(results.map(issueToItem));
  const enriched = await enrich(items.map((i) => i.cvVolumeId));
  return applyEnrichment(items, enriched)
    .sort((a, b) => String(b.storeDate || '').localeCompare(String(a.storeDate || '')));
}

// Recently-released series (any issue, not just #1s), newest first, one card per
// volume. This is "what's out now" — genuinely forward-looking discovery isn't
// possible via CV: it doesn't populate store_date for issues more than a few
// days out (verified — nothing dated past ~today), so an "upcoming" feed would
// be empty. We show the trailing window instead.
//
// CV QUIRK: the store_date filter returns ZERO if the range start is within ~a
// day of today, so `from` sits a couple of weeks in the past. CV's descending
// sort is unreliable, so we page an ascending scan and sort newest-first here.
export async function buildLatest(cv, enrich, { from, to, want = 80, limit = 100, maxPages = 3 } = {}) {
  const raw = [];
  for (let page = 0; page < maxPages; page++) {
    const { results, total } = await cv.list('issues', {
      filter: `store_date:${from}|${to}`,
      sort: 'store_date:asc', fieldList: FIELDS_ISSUE, limit, offset: page * limit,
    });
    if (!results.length) break;
    raw.push(...results.map(issueToItem));
    if ((page + 1) * limit >= total) break;
  }
  // One card per volume (add-cv adds the whole series), keeping its newest issue.
  const byVol = new Map();
  for (const it of raw) {
    if (it.cvVolumeId == null) continue;
    const prev = byVol.get(it.cvVolumeId);
    if (!prev || (it.storeDate && prev.storeDate && it.storeDate > prev.storeDate)) byVol.set(it.cvVolumeId, it);
  }
  const items = [...byVol.values()]
    .sort((a, b) => String(b.storeDate || '').localeCompare(String(a.storeDate || '')))
    .slice(0, want);
  // Enrich for publisher so manga can be flagged/hidden here too (Latest is full
  // of manga anthologies otherwise).
  const enriched = await enrich(items.map((i) => i.cvVolumeId));
  return applyEnrichment(items, enriched);
}

// New #1s whose publisher is one you already collect a lot of — "more of what
// you like". ownedPublishers is a ranked list of publisher names.
export async function buildForYou(cv, enrich, ownedPublishers, { from, to, limit = 100 } = {}) {
  const wanted = new Set(ownedPublishers.map(normPublisher));
  const items = await buildNewSeries(cv, enrich, { from, to, limit });
  return items
    .filter((i) => i.publisher && wanted.has(normPublisher(i.publisher)))
    .sort((a, b) => String(b.storeDate || '').localeCompare(String(a.storeDate || '')));
}

// New #1s ranked major-Western-publisher first — a transparent popularity
// heuristic (CV has no real popularity metric, and LOCG is Cloudflare-walled).
export async function buildPopular(cv, enrich, { from, to, limit = 100 } = {}) {
  const items = await buildNewSeries(cv, enrich, { from, to, limit });
  return items
    .filter((i) => majorRank(i.publisher) !== Infinity)
    .sort((a, b) => majorRank(a.publisher) - majorRank(b.publisher)
      || String(b.storeDate || '').localeCompare(String(a.storeDate || '')));
}
