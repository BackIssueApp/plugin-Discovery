// A read-only window onto the collection for discovery: which ComicVine volumes
// are already owned (to badge them / drive "owned" out of the feed) and which
// publishers you collect most (the For You signal). Opens its OWN read-only
// connection to the same SQLite file — it never writes (adding a series goes
// through core's /api/collection/add-cv), so it needs no migrations.
import Database from 'better-sqlite3';

export function openCollection(dbPath) {
  let db = null;
  const conn = () => (db ||= new Database(dbPath, { readonly: true, fileMustExist: true }));
  return {
    // Set of CV volume ids present in the collection.
    ownedVolumeIds() {
      try { return new Set(conn().prepare('SELECT cv_id FROM series WHERE cv_id IS NOT NULL').all().map((r) => r.cv_id)); }
      catch { return new Set(); }
    },
    // Publisher names you own the most series from, most first.
    topPublishers(n = 8) {
      try {
        return conn().prepare(
          `SELECT cs.publisher AS p FROM series s
             JOIN cv_series cs ON cs.comicvine_id = s.cv_id
            WHERE cs.publisher IS NOT NULL AND cs.publisher != ''
            GROUP BY cs.publisher ORDER BY COUNT(*) DESC LIMIT ?`
        ).all(n).map((r) => r.p);
      } catch { return []; }
    },
  };
}
