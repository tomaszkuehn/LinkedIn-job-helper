# LinkedIn Job Helper

A Brave browser extension (Manifest V3) for managing LinkedIn job listings more effectively. Save jobs to a local in-browser database, detect re-posted listings even after LinkedIn assigns a new job ID, and back the database up to a file automatically.

## Features

- **Save to local database** — injects a "Save to DB" button in the LinkedIn job detail panel. Scrapes title, company, location, URL, and the full job description (`#job-details`).
- **Repost detection** — identifies already-seen jobs even when re-posted with a new `jobId`, using two content fingerprints:
  - `cardFingerprint` (loose): title + company — for fast badge matching on the list view
  - `detailFingerprint` (strict): title + company + description text — for reliable repost detection
- **Auto-registration of seen jobs** — browsing a job detail panel auto-records it (debounced 2s) into a separate `seen` store.
- **Visual cues**:
  - List cards: `👁 seen N days ago` badge, or `🔁 seen N days ago` when matched under a different jobId
  - Detail panel: top banner when the current job is a repost
- **Auto-backup to file** — after every database change (debounced 2s), the service worker writes a JSON snapshot to `Downloads/linkedin-jobs-backup/`:
  - `overwrite` mode → single `linkedin-jobs-latest.json`
  - `timestamp` mode → sequential `linkedin-jobs-2026-07-25T13-45-12.json` files
- **Import / restore** — load a backup or export file back into the database (replaces current data, with confirmation).
- **Popup UI** — three tabs: **Saved**, **Seen**, **Backup**. Search, copy content, delete, export JSON/CSV.
- **Options page** — full tabular view of saved and seen jobs, import/export, clear-all.

## Storage

Data is held entirely in `chrome.storage.local` (the extension's own storage, not the page's `indexedDB`). This avoids Brave's storage partitioning, which blocks `indexedDB` access from content scripts (`requestStorageAccess: Permission denied`).

Keys:
- `ljs_jobs` — map of `jobId` → saved job
- `ljs_seen` — map of `fingerprint` → seen-job entry
- `ljs_settings` — backup settings and last-backup metadata

Data does **not** sync between devices. Use the backup file to transfer or restore.

## Architecture

```
manifest.json
background/sw.js          service worker: auto-backup, settings, message hub
content/job-saver.js      content script (self-contained, no ES imports):
                          storage + fingerprints + scraper + save button + seen badges + repost banner
content/job-saver.css     styles for injected button, badges, toast, banner
lib/db.js                 storage backend (chrome.storage.local) used by popup/options
lib/scraper.js            scraper helpers (legacy, popup/options)
popup/popup.{html,css,js} toolbar popup: Saved / Seen / Backup tabs
options/options.{html,js} full-page options: tables, import/export, clear
```

Content scripts in MV3 cannot use ES `import`, so `content/job-saver.js` is self-contained (inlined copy of the storage and fingerprint logic from `lib/db.js`).

## Install (development)

1. Open `brave://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder
4. Visit `linkedin.com/jobs/search` — open any job to see the "Save to DB" button in the detail panel

## Permissions

- `storage` — for `chrome.storage.local` (the database)
- `downloads` — for auto-backup to file
- `activeTab`, `scripting` — reserved for future use
- `host_permissions: https://www.linkedin.com/*` — content script injection

No remote permissions. No data leaves the browser.

## Limitations

- `chrome.storage.local` has a ~10 MB quota — enough for tens of thousands of jobs with full description text.
- Backup files accumulate in `Downloads/linkedin-jobs-backup/`; in `timestamp` mode, prune manually.
- Fingerprint matching is heuristic: minor edits to the job description by the poster produce a different `detailFingerprint` and won't be flagged as a repost. `cardFingerprint` (title + company only) catches re-posts under a new jobId even with edited descriptions, at the cost of occasional false positives for genuinely different jobs with the same title and company.

## License

Unreleased / personal project.