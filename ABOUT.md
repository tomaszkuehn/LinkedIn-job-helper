# LinkedIn Job Helper

A Brave browser extension (Manifest V3) for managing LinkedIn job listings more effectively. Save jobs to a local in-browser database, detect re-posted listings even after LinkedIn assigns a new job ID, mark jobs with quick statuses, and back the database up to a file automatically.

## Features

- **Save to local database** — injects a "Save to DB" button in the LinkedIn job detail panel. Scrapes title, company, location, workplace type, city, URL, and the full job description (`#job-details`). Status set before saving (Apply / Consider / German / Ignore) is carried over to the saved job.
- **Workplace type & city detection** — extracts `workplaceType` (remote / hybrid / onsite) and `city` from:
  1. Location metadata (already scraped) — e.g. "Hamburg, Hamburg, Germany (Hybrid)" → workplaceType=hybrid, city=Hamburg
  2. Description text fallback (regex over "Location:" / "Workplace:" sections and phrases like "fully remote", "work from home", "on-site")
- **Preferred cities + preference banner** — set a comma-separated list of preferred cities in Options → Preferences. The content script shows a banner below the action toolbar in the LinkedIn detail panel:
  - Green ✓ — remote (always acceptable), or onsite/hybrid in one of your preferred cities
  - Red ✗ — onsite/hybrid not in a preferred city
  - Neutral • — workplace type unknown or no preferred cities set
- **Distance from home (optional)** — set a home address (street, postcode, or city) in Options → Preferences; it's geocoded once via OpenStreetMap Nominatim and the lat/lon is cached locally. When the job location contains a postcode or street address (precise enough to geocode), the haversine distance to home is appended to the banner, e.g. `On-site in Hamburg — matches your preferred cities (12 km from home, ≤ 30 km)`. If only a city is detected (no postcode/street), no distance is shown.
- **Repost detection** — identifies already-seen jobs even when re-posted with a new `jobId`, using two content fingerprints:
  - `cardFingerprint` (loose): title + company — for fast badge matching on the list view and for status matching (stable whether or not the description has loaded)
  - `detailFingerprint` (strict): title + company + description text — for reliable repost detection
- **Auto-registration of seen jobs** — browsing a job detail panel auto-records it (debounced 2s) into a separate `seen` store. Full description text is stored for seen entries too (configurable retention below).
- **Visual cues**:
  - List cards: `👁 seen N days ago` badge, or `🔁 seen N days ago` when matched under a different jobId
  - Detail panel: top banner when the current job is a repost
- **Quick status actions** — mark any job (saved or just seen) as Apply / Consider / German / Ignore:
  - Four action buttons injected in the LinkedIn detail panel, in a separate toolbar block below LinkedIn's native action row (LinkedIn's original layout is preserved)
  - Status dropdowns in popup rows and options tables
  - Filtering by status in the options page (All / Apply / Consider / German / Ignored / No status)
  - "Ignored" status drops the description text from storage to save space (fingerprint + metadata retained for repost detection). Confirmation dialog before applying — warns that the description will be removed.
  - Status is matched by `cardFingerprint` so it works whether or not the description has loaded (e.g. user marks Consider before the description renders, then clicks Save — the status carries over).
  - Status is mirrored between the saved job and all seen entries sharing the same `cardFingerprint`.
- **Job preview modal** — in the options page, a "👁 View" button on each Saved/Seen row opens a modal with formatted title, company, location, status, dates, LinkedIn link, and rendered description (HTML or plain-text fallback). Copy buttons. Close via ✕, backdrop click, or Esc.
- **Copy seen → saved** — a "↳ To saved" button (popup and options Seen tab) copies a seen entry into the saved-jobs store. Useful when you want to keep a job you've only browsed without re-opening the detail to click Save. The job's jobId is taken from the seen entry's first `jobIds[]` entry, and status/description are carried over.
- **Auto-backup to file** — after every database change (debounced 2s), the service worker writes a JSON snapshot to `Downloads/linkedin-jobs-backup/`:
  - `overwrite` mode → single `linkedin-jobs-latest.json`
  - `timestamp` mode → sequential `linkedin-jobs-2026-07-25T13-45-12.json` files
- **Auto-prune of seen jobs** — seen entries older than the retention window (default 90 days; configurable 30/60/90/180/365/off) are automatically removed from `chrome.storage.local` to stay under the ~10 MB quota. Full data is preserved in backup files. Runs at SW startup and debounced after seen-store changes.
- **Storage usage indicator** — popup shows bytes used / ~10 MB limit with color-coded bar (green/amber/red) and a contextual hint.
- **Import / restore** — load a backup or export file back into the database (replaces current data, with confirmation). Handles legacy array format, `{saved, seen}` array format, and backup map format.
- **Inline confirm dialogs** — the popup uses custom modal dialogs instead of `window.confirm()`, which hangs MV3 popups when they lose focus. Esc cancels, Enter confirms.
- **Popup UI** — three tabs: **Saved**, **Seen**, **Backup**. Search, status dropdown, workplace/city chip, copy content, delete/forget, export JSON/CSV. Quick status change with toast feedback.
- **Options page** — full tabular view of saved and seen jobs with location, workplace, city, status columns; filters by status and workplace type (All / Remote / Hybrid / On-site / No workplace); search; preview modal; import/export (JSON + CSV with workplace/city/status columns); clear-all.

## Storage

Data is held entirely in `chrome.storage.local` (the extension's own storage, not the page's `indexedDB`). This avoids Brave's storage partitioning, which blocks `indexedDB` access from content scripts (`requestStorageAccess: Permission denied`).

Keys:
- `ljs_jobs` — map of `jobId` → saved job (includes `status`, `statusSetAt`)
- `ljs_seen` — map of `fingerprint` → seen-job entry (includes `status`, `statusSetAt`, full `descriptionText`/`descriptionHtml` unless status is `ignored`)
- `ljs_settings` — backup settings, retention window, preferred cities, home address + geocoded coords, max distance, last-backup and last-prune metadata

Data does **not** sync between devices. Use the backup file to transfer or restore.

## Job record schema

Saved job (`ljs_jobs[jobId]`):
```
{
  jobId, title, company, location,
  workplaceType: "" | "remote" | "hybrid" | "onsite",
  city: "",
  url,
  descriptionHtml, descriptionText,
  savedAt, sourceUrl,
  status: "" | "apply" | "to-consider" | "german" | "ignored",
  statusSetAt: ISO-string | null
}
```

Seen entry (`ljs_seen[fingerprint]`):
```
{
  fingerprint, cardFingerprint,
  title, company, location,
  workplaceType: "" | "remote" | "hybrid" | "onsite",
  city: "",
  descriptionText, descriptionHtml,   // empty when status === "ignored"
  jobIds: […],
  firstSeenAt, lastSeenAt, seenCount,
  status: "" | "apply" | "to-consider" | "german" | "ignored",
  statusSetAt: ISO-string | null
}
```

## Architecture

```
manifest.json
background/sw.js          service worker: auto-backup, auto-prune, settings, message hub
content/job-saver.js      content script (self-contained, no ES imports):
                          storage + fingerprints + scraper + save button + status toolbar
                          + seen badges + repost banner
content/job-saver.css     styles for injected toolbar, action buttons, badges, toast, banner
lib/db.js                 storage backend (chrome.storage.local) + status helpers
                           (setJobStatus, setSeenStatus, ensureSeen, getAllSeenByStatus, …)
                           + analyzeLocation (workplace type + city detection)
                           + geocodeAddress (Nominatim) + hasPreciseLocation + evaluatePreference
                           used by popup/options
lib/scraper.js            scraper helpers (legacy, popup/options)
popup/popup.{html,css,js} toolbar popup: Saved / Seen / Backup tabs + inline confirm modal
options/options.{html,js} full-page options: tables with status column + filter, preview modal,
                          import/export (JSON + CSV), clear-all
```

Content scripts in MV3 cannot use ES `import`, so `content/job-saver.js` is self-contained (inlined copy of the storage, fingerprint, and status logic from `lib/db.js`).

## Install (development)

1. Open `brave://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder
4. Visit `linkedin.com/jobs/search` — open any job to see the toolbar (Save to DB + Apply / Consider / German / Ignore) in the detail panel, below LinkedIn's native Easy Apply / Save buttons

## Permissions

- `storage` — for `chrome.storage.local` (the database)
- `downloads` — for auto-backup to file
- `activeTab`, `scripting` — reserved for future use
- `host_permissions: https://www.linkedin.com/*` — content script injection
- `host_permissions: https://nominatim.openstreetmap.org/*` — geocoding the home address (one-shot on save in Options) and geocoding precise job locations (cached in-memory)

The home address is sent to Nominatim (OpenStreetMap) only when you click **Save** in Options. Precise job locations (those containing a postcode or street) are geocoded once per session and cached in-memory. No tracking, no API key, no data stored on any server.

## Limitations

- `chrome.storage.local` has a ~10 MB quota — enough for tens of thousands of jobs with full description text. Auto-prune of seen entries (default 90 days) keeps growth bounded; backup files are the durable source of truth.
- Fingerprint matching is heuristic: minor edits to the job description by the poster produce a different `detailFingerprint` and won't be flagged as a repost. `cardFingerprint` (title + company only) catches re-posts under a new jobId even with edited descriptions, at the cost of occasional false positives for genuinely different jobs with the same title and company.
- Status is matched by `cardFingerprint` (title + company). Two genuinely different jobs with identical title + company share a status. In practice this is rare and the trade-off is acceptable (status is per-job-listing in spirit, but the matcher is intentionally loose so status survives a re-post with edited description).
- Workplace/city detection is heuristic. The location-metadata path is reliable when LinkedIn exposes it; the description-text fallback may produce false positives on generic phrases (e.g. "remote team" → remote). City extraction drops trailing country segments and known country names; single-token locations that aren't recognized countries are treated as cities.
- Distance is haversine (straight-line), not a driving/transit route. Geocoding is performed by OpenStreetMap Nominatim (free, no API key) and is rate-limited (1 request per address, cached). If Nominatim is unreachable, the banner falls back to green/red based on the preferred-cities list alone, without distance.

## License

Unreleased / personal project.