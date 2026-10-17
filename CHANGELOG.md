# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Added

- **Translated UI.** The Discover drawer, its tabs and the settings card
  follow the language picked under Profile → Language on BackIssue builds
  newer than 0.9.0, English on older ones. Translations ship for French,
  German, Spanish, Italian, Portuguese and Dutch in `locales/`.
  Also covers the permission, job and library-type labels, the plugin
  description and the notification titles shown in BackIssue’s own screens.

### Changed

- The messages shown when Discover cannot build a feed no longer name a
  metadata database; they say the metadata source is missing, rate-limited
  or not one that offers these feeds.

### Changed
- Discover now says plainly that it needs the built-in metadata service or
  ComicVine when another metadata source is selected, instead of failing
  part-way through building a feed.

## [1.1.0] — 2026-10-09

### Changed
- **Popular** now ranks series by how many readers are following them, not by
  publisher. When that signal isn't available it falls back to the previous
  major-publisher ordering, so the tab always has something to show.

## [1.0.2] — 2026-07-18

### Changed
- Settings moved from **Settings → Sources** to the dedicated **Settings →
  Plugins** tab (falls back to the Sources area on cores without it).


## [1.0.1] — 2026-07-08

### Fixed
- The Discover menu item is hidden from users who can't add to the library.

## [1.0.0] — 2026-07-08

Initial release: a ComicVine-driven Discover drawer — new releases, latest
additions, personalized "for you" picks, and popular series, each with
one-click add to the library.
