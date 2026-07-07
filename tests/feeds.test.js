// Discovery feed shaping — pure helpers + orchestrators driven by a fake CV
// client, so the logic (dedup, publisher normalization, ranking, filtering,
// enrichment) is locked in without the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoDay, issueToItem, dedupByVolume, normPublisher, majorRank, applyEnrichment,
  isManga, isWestern, buildNewSeries, buildLatest, buildForYou, buildPopular,
} from '../feeds.js';

const issue = (vid, name, num, date, cover) => ({
  issue_number: num, store_date: date, name: name + ' ' + num,
  volume: { id: vid, name }, image: cover ? { small_url: cover } : null,
});

test('issueToItem pulls the volume identity and cover off a CV issue', () => {
  const it = issueToItem(issue(10, 'Saga', '1', '2026-07-10', 'c.jpg'));
  assert.equal(it.cvVolumeId, 10);
  assert.equal(it.name, 'Saga');
  assert.equal(it.storeDate, '2026-07-10');
  assert.equal(it.coverUrl, 'c.jpg');
  assert.equal(it.owned, false);
});

test('dedupByVolume keeps one item per volume (earliest launch) and drops volume-less', () => {
  const items = [
    issueToItem(issue(1, 'A', '1', '2026-07-10')),
    issueToItem(issue(1, 'A', '1', '2026-06-01')), // earlier printing of the same #1
    issueToItem({ issue_number: '1', store_date: '2026-07-01', volume: null }), // no volume → dropped
  ];
  const out = dedupByVolume(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].storeDate, '2026-06-01');
});

test('normPublisher folds the CV variants', () => {
  assert.equal(normPublisher('Image Comics'), normPublisher('Image'));
  assert.equal(normPublisher('BOOM! Studios'), 'boom');
  assert.equal(normPublisher('DC Comics'), 'dc');
});

test('majorRank orders majors and rejects the rest', () => {
  assert.equal(majorRank('Marvel'), 0);
  assert.ok(majorRank('Image Comics') < majorRank('Titan Comics'));
  assert.equal(majorRank('Shueisha'), Infinity);
});

test('applyEnrichment fills publisher/startYear from the enrich map', () => {
  const [it] = applyEnrichment([issueToItem(issue(5, 'X', '1', '2026-07-01'))], new Map([[5, { publisher: 'Marvel', startYear: '2026' }]]));
  assert.equal(it.publisher, 'Marvel');
  assert.equal(it.startYear, '2026');
});

test('isManga flags Japanese houses + manga imprints, not Western publishers', () => {
  for (const p of ['Shueisha', 'Kodansha', 'Kodansha Comics', 'Shogakukan', 'Viz', 'Viz Media', 'Seven Seas Entertainment', 'Yen Press', 'Square Enix'])
    assert.equal(isManga(p), true, p + ' should be manga');
  for (const p of ['Marvel', 'DC Comics', 'Image', 'Dark Horse Comics', 'BOOM! Studios', null, ''])
    assert.equal(isManga(p), false, String(p) + ' should not be manga');
  // enrichment stamps the flag onto items
  const [it] = applyEnrichment([issueToItem(issue(9, 'Taro', '1', '2026-07-03'))], new Map([[9, { publisher: 'Shueisha' }]]));
  assert.equal(it.isManga, true);
});

test('isWestern is an allowlist: known Western houses pass, foreign/unknown do not', () => {
  for (const p of ['Marvel', 'DC Comics', 'Image', 'Image Comics', 'Dark Horse Comics', 'Mad Cave Studios', 'Oni Press', 'IDW Publishing', 'Titan Comics', 'Rebellion'])
    assert.equal(isWestern(p), true, p + ' should be Western');
  for (const p of ['Shueisha', 'Alpha Polis', 'Futabasha Publishers Ltd.', 'Shōnen Gahōsha', 'Akita Shoten', 'Splitter', null, ''])
    assert.equal(isWestern(p), false, String(p) + ' should not be Western');
  // enrichment stamps isWestern; an un-enriched item (no publisher) is not Western
  const [w] = applyEnrichment([issueToItem(issue(1, 'X', '1', '2026-07-01'))], new Map([[1, { publisher: 'Marvel' }]]));
  assert.equal(w.isWestern, true);
  assert.equal(issueToItem(issue(2, 'Y', '1', '2026-07-01')).isWestern, false);
});

// A fake CV whose list() returns the given issues and whose volume() resolves a
// publisher table. Records the filter it was called with.
function fakeCv(issues, publishers = {}) {
  const calls = [];
  return {
    calls,
    async list(resource, opts) { calls.push({ resource, ...opts }); return { results: issues, total: issues.length }; },
    async volume(id) { return { id, publisher: publishers[id] || null, start_year: '2026', image_url: null, count_of_issues: 1 }; },
  };
}
const passthroughEnrich = (cv) => async (ids) => {
  const m = new Map();
  for (const id of new Set(ids)) { const v = await cv.volume(id); m.set(id, { publisher: v.publisher, startYear: v.start_year, coverUrl: v.image_url }); }
  return m;
};

test('buildNewSeries queries #1s in the window and returns them newest-first', async () => {
  const cv = fakeCv([issue(1, 'A', '1', '2026-07-01'), issue(2, 'B', '1', '2026-07-20')], { 1: 'Marvel', 2: 'Image' });
  const out = await buildNewSeries(cv, passthroughEnrich(cv), { from: '2026-06-01', to: '2026-08-01' });
  assert.match(cv.calls[0].filter, /issue_number:1/);
  assert.match(cv.calls[0].filter, /store_date:2026-06-01\|2026-08-01/);
  assert.deepEqual(out.map((i) => i.name), ['B', 'A']); // newest first
  assert.equal(out[0].publisher, 'Image');
});

test('buildLatest returns one card per volume, newest first, and flags manga', async () => {
  const cv = fakeCv([
    issue(3, 'C', '5', '2026-07-01'),
    issue(4, 'D', '2', '2026-07-03'),
    issue(3, 'C', '6', '2026-07-02'), // same volume as first — newer issue wins, one card
  ], { 3: 'Shueisha', 4: 'Marvel' });
  const out = await buildLatest(cv, passthroughEnrich(cv), { from: '2026-06-20', to: '2026-07-08' });
  assert.equal(cv.calls[0].sort, 'store_date:asc');
  assert.equal(out.length, 2, 'deduped to one card per volume');
  assert.deepEqual(out.map((i) => i.storeDate), ['2026-07-03', '2026-07-02']); // newest first; vol C kept its 07-02 issue
  assert.equal(out.find((i) => i.cvVolumeId === 3).isManga, true, 'Shueisha volume flagged manga');
  assert.equal(out.find((i) => i.cvVolumeId === 4).isManga, false);
});

test('buildForYou keeps only #1s from publishers you collect', async () => {
  const cv = fakeCv([issue(1, 'Marvel Book', '1', '2026-07-01'), issue(2, 'Manga Book', '1', '2026-07-02')], { 1: 'Marvel', 2: 'Shueisha' });
  const out = await buildForYou(cv, passthroughEnrich(cv), ['Marvel', 'DC Comics'], { from: '2026-06-01', to: '2026-08-01' });
  assert.deepEqual(out.map((i) => i.name), ['Marvel Book']);
});

test('buildPopular drops non-majors and ranks majors first', async () => {
  const cv = fakeCv([
    issue(1, 'Indie', '1', '2026-07-10'),
    issue(2, 'DC Book', '1', '2026-07-10'),
    issue(3, 'Marvel Book', '1', '2026-07-10'),
  ], { 1: 'Some Indie Press', 2: 'DC Comics', 3: 'Marvel' });
  const out = await buildPopular(cv, passthroughEnrich(cv), { from: '2026-06-01', to: '2026-08-01' });
  assert.deepEqual(out.map((i) => i.name), ['Marvel Book', 'DC Book']); // Marvel(0) before DC(1); indie dropped
});

test('isoDay returns yyyy-mm-dd offset from a fixed base', () => {
  const base = new Date('2026-07-04T00:00:00Z');
  assert.equal(isoDay(0, base), '2026-07-04');
  assert.equal(isoDay(-42, base), '2026-05-23');
  assert.equal(isoDay(7, base), '2026-07-11');
});
