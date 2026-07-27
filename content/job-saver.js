// Content script — saving jobs + identification of already-seen jobs
// (even when re-posted with a new jobId) based on content fingerprints.
// Self-contained (MV3 content scripts nie wspierają ES import).

(function () {
  "use strict";

  // ---------- Context validity guard ----------
  // When the extension is reloaded (dev mode), the old content script's
  // chrome.* APIs become invalid ("Extension context invalidated").
  // We detect this and no-op all subsequent operations instead of throwing.
  let ctxValid = true;
  function checkCtx() {
    if (!ctxValid) return false;
    try {
      // chrome.runtime.id throws when context is invalidated.
      void chrome.runtime.id;
      return true;
    } catch (e) {
      ctxValid = false;
      console.warn("[LJS] Extension context invalidated — content script disabled. Reload the LinkedIn page.");
      return false;
    }
  }

  // ---------- Storage: chrome.storage.local ----------
  // IndexedDB strony jest partycjonowany/blokowany przez Brave (requestStorageAccess denied).
  // chrome.storage.local to storage rozszerzenia — omija partycjonowanie strony.
  const KEY_JOBS = "ljs_jobs";
  const KEY_SEEN = "ljs_seen";
  const KEY_SETTINGS = "ljs_settings";

  function storageGet(key) {
    return new Promise((resolve) => {
      if (!checkCtx()) return resolve({});
      try {
        chrome.storage.local.get(key, (res) => resolve((res && res[key]) || {}));
      } catch (e) {
        console.warn("[LJS] storage.get error", e);
        resolve({});
      }
    });
  }
  function storageSet(key, value) {
    return new Promise((resolve, reject) => {
      if (!checkCtx()) return reject(new Error("Extension context invalidated"));
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(value);
        });
      } catch (e) { reject(e); }
    });
  }

  async function saveJob(job) {
    job.savedAt = job.savedAt || new Date().toISOString();
    const jobs = await storageGet(KEY_JOBS);
    jobs[job.jobId] = job;
    await storageSet(KEY_JOBS, jobs);
    return job;
  }
  async function getJob(jobId) {
    const jobs = await storageGet(KEY_JOBS);
    return jobs[jobId] || null;
  }
  async function upsertSeen(entry) {
    const seen = await storageGet(KEY_SEEN);
    seen[entry.fingerprint] = entry;
    await storageSet(KEY_SEEN, seen);
    return entry;
  }
  async function getSeenByFp(fingerprint) {
    const seen = await storageGet(KEY_SEEN);
    return seen[fingerprint] || null;
  }
  async function getAllSeenByCardFp(cardFingerprint) {
    const seen = await storageGet(KEY_SEEN);
    return Object.values(seen).filter(s => s.cardFingerprint === cardFingerprint);
  }

  // ---------- Status (apply / to-consider / german / ignored) ----------
  const VALID_STATUSES = new Set(["apply", "applied", "to-consider", "german", "ignored"]);
  const STATUS_LABELS = {
    "apply": "Apply",
    "applied": "Applied",
    "to-consider": "Consider",
    "german": "German",
    "ignored": "Ignore",
  };

  // ---------- Workplace type + city detection (inline copy of lib/db.js) ----------
  const WORKPLACE_PATTERNS = [
    { type: "remote", re: /\b(fully\s+remote|100%?\s*%?\s*remote|work\s+from\s+home|wfh|remote\s+first|remote-?first|fully\s*distributed|anywhere\s+in\s+the\s+world)\b/i },
    { type: "remote", re: /\bremote\b/i },
    { type: "hybrid", re: /\bhybrid\b/i },
    { type: "onsite", re: /\b(?:on[-\s]?site|in[-\s]?office|office[-\s]?based|in\s+person)\b/i },
  ];
  const COUNTRIES_SET = new Set(["germany", "poland", "united states", "usa", "uk", "united kingdom", "france", "netherlands", "spain", "italy", "sweden", "switzerland", "austria", "ireland", "portugal", "romania", "czech republic", "belgium", "denmark", "finland", "norway", "india", "canada"]);

  function analyzeLocation(location, descriptionText) {
    let workplaceType = "";
    let city = "";
    const loc = String(location || "").trim();
    if (loc) {
      const locLower = loc.toLowerCase();
      if (/\bremote\b/.test(locLower) && !/\bhybrid\b/.test(locLower)) workplaceType = "remote";
      else if (/\bhybrid\b/.test(locLower)) workplaceType = "hybrid";
      else if (/\bon[-\s]?site\b/.test(locLower) || /\bin[-\s]?office\b/.test(locLower)) workplaceType = "onsite";
      let cleaned = loc.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*·\s*.*$/, "").trim();
      cleaned = cleaned.replace(/\s*(remote|hybrid|on[-\s]?site|in[-\s]?office)\b.*$/i, "").trim();
      if (cleaned) {
        const parts = cleaned.split(",").map(s => s.trim()).filter(Boolean);
        if (parts.length > 1) city = parts[0];
        else if (parts.length === 1 && !/remote|hybrid|onsite|on-site/i.test(parts[0])) {
          if (!COUNTRIES_SET.has(parts[0].toLowerCase())) city = parts[0];
        }
      }
    }
    if (!workplaceType && descriptionText) {
      const desc = String(descriptionText);
      const m = desc.match(/(?:location|workplace|work\s*location|workplace\s*type)\s*[:\-]\s*([^\n]{1,80})/i);
      if (m) {
        const line = m[1];
        if (/\bremote\b/i.test(line) && !/\bhybrid\b/i.test(line)) workplaceType = "remote";
        else if (/\bhybrid\b/i.test(line)) workplaceType = "hybrid";
        else if (/\bon[-\s]?site\b/i.test(line) || /\bin[-\s]?office\b/i.test(line)) workplaceType = "onsite";
        if (!city) {
          const cleanLine = line.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*(remote|hybrid|on[-\s]?site|in[-\s]?office)\b.*$/i, "").trim();
          const parts = cleanLine.split(",").map(s => s.trim()).filter(Boolean);
          if (parts.length >= 1) city = parts[0];
        }
      }
      if (!workplaceType) {
        for (const p of WORKPLACE_PATTERNS) {
          if (p.re.test(desc)) { workplaceType = p.type; break; }
        }
      }
    }
    return { workplaceType, city };
  }

  // ----- approximate distance between detected city and preferred city -----
  const CITY_COORDS = {
    // Germany
    "berlin": [52.52, 13.405], "hamburg": [53.55, 9.99], "munich": [48.14, 11.58], "muenchen": [48.14, 11.58],
    "frankfurt": [50.11, 8.68], "frankfurt am main": [50.11, 8.68], "cologne": [50.94, 6.96], "koeln": [50.94, 6.96],
    "stuttgart": [48.78, 9.18], "duesseldorf": [51.23, 6.79], "dortmund": [51.51, 7.46], "essen": [51.46, 7.01],
    "leipzig": [51.34, 12.37], "dresden": [51.05, 13.74], "hanover": [52.37, 9.73], "hannover": [52.37, 9.73],
    "nuremberg": [49.45, 11.08], "nuernberg": [49.45, 11.08], "bremen": [53.08, 8.80], "karlsruhe": [49.01, 8.40],
    "mannheim": [49.49, 8.46], "bonn": [50.73, 7.10], "wiesbaden": [50.08, 8.24], "augsburg": [48.37, 10.90],
    "freiburg": [47.99, 7.85], "mainz": [49.99, 8.27], "kassel": [51.31, 9.50], "saarbruecken": [49.24, 6.99],
    "magdeburg": [52.12, 11.63], "freiburg im breisgau": [47.99, 7.85], "heidelberg": [49.41, 8.69],
    "erlangen": [49.59, 11.01], "regensburg": [49.02, 12.10], "wolfsburg": [52.42, 10.78],
    // Poland
    "warsaw": [52.23, 21.01], "warszawa": [52.23, 21.01], "krakow": [50.06, 19.94], "krakau": [50.06, 19.94],
    "wroclaw": [51.11, 17.04], "breslau": [51.11, 17.04], "gdansk": [54.35, 18.65], "danzig": [54.35, 18.65],
    "poznan": [52.41, 16.93], "posen": [52.41, 16.93], "lodz": [51.76, 19.46], "katowice": [50.26, 19.02],
    "lublin": [51.25, 22.57], "bydgoszcz": [53.12, 18.01], "szczecin": [53.43, 14.55], "stettin": [53.43, 14.55],
    "bialystok": [53.13, 23.16], "torun": [53.01, 18.60], "rzeszow": [50.04, 22.00], "opole": [50.67, 17.92],
    "gdynia": [54.52, 18.53], "sopot": [54.44, 18.56], "kielce": [50.87, 20.63], "olsztyn": [53.77, 20.48],
    // Other EU
    "amsterdam": [52.37, 4.90], "rotterdam": [51.92, 4.48], "the hague": [52.08, 4.30], "den haag": [52.08, 4.30],
    "paris": [48.85, 2.35], "london": [51.51, -0.13], "vienna": [48.21, 16.37], "wien": [48.21, 16.37],
    "zurich": [47.38, 8.54], "zuerich": [47.38, 8.54], "geneva": [46.20, 6.14], "genf": [46.20, 6.14],
    "prague": [50.08, 14.44], "prag": [50.08, 14.44], "bratislava": [48.15, 17.11], "brussels": [50.85, 4.35],
    "bruessel": [50.85, 4.35], "copenhagen": [55.68, 12.57], "koebenhavn": [55.68, 12.57],
    "stockholm": [59.33, 18.07], "oslo": [59.91, 10.75], "helsinki": [60.17, 24.94],
    "dublin": [53.35, -6.26], "lisbon": [38.72, -9.14], "lissabon": [38.72, -9.14], "madrid": [40.42, -3.70],
    "barcelona": [41.39, 2.16], "rome": [41.90, 12.50], "roma": [41.90, 12.50], "milan": [45.46, 9.19],
    "mailand": [45.46, 9.19], "lyon": [45.76, 4.84], "toulouse": [43.60, 1.44], "nice": [43.70, 7.26],
  };

  function haversineKm(a, b) {
    if (!a || !b) return null;
    const R = 6371;
    const dLat = (b[0] - a[0]) * Math.PI / 180;
    const dLon = (b[1] - a[1]) * Math.PI / 180;
    const la1 = a[0] * Math.PI / 180;
    const la2 = b[0] * Math.PI / 180;
    const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }

  function cityCoords(name) {
    if (!name) return null;
    const k = String(name).trim().toLowerCase();
    return CITY_COORDS[k] || null;
  }

  // Heuristic: does the location string contain a postcode or street address?
  // If not, we don't geocode it and don't show distance (per user request).
  const POSTCODE_RE = /\b\d{5}\b|\b\d{2}-\d{3}\b/;
  const STREET_RE = /\b(?:str\.?|straße|strasse|ave\.?|avenue|rd\.?|road|st\.?|street|pl\.?|platz|gasse|weg|allee|boulevard|ul\.?|ulica)\b[.\s]*[a-ząćęłńóśźżäöüß\-]+(?:\s+\d+|\s+\d+\s*\w)?/i;
  const STREET_NUMBER_RE = /\b\d+[a-z]?\s*(?:[\/\-]\s*\d+[a-z]?)?\b\s*(?=\s|$|,)/i;

  function hasPreciseLocation(location) {
    const s = String(location || "");
    if (!s.trim()) return false;
    return POSTCODE_RE.test(s) || STREET_RE.test(s) || STREET_NUMBER_RE.test(s);
  }

  // In-memory cache for geocoded job locations (keyed by query string).
  // Avoids repeated requests when navigating between the same jobs.
  const geoCache = new Map();

  // Geocoding runs in the background service worker (content scripts inherit
  // the page's CSP, which blocks fetch to external origins with
  // "chrome-extension://invalid/" errors).
  function geocodeJobLocation(query) {
    const q = String(query || "").trim();
    if (!q) return Promise.resolve(null);
    if (geoCache.has(q)) return Promise.resolve(geoCache.get(q));
    if (!checkCtx()) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "geocode", query: q }, (res) => {
          if (!checkCtx() || chrome.runtime.lastError || !res || !res.ok || !res.coords) {
            geoCache.set(q, null);
            resolve(null);
            return;
          }
          const coords = res.coords;
          geoCache.set(q, coords);
          resolve(coords);
        });
      } catch (e) {
        console.warn("[LJS] geocodeJobLocation error", e);
        geoCache.set(q, null);
        resolve(null);
      }
    });
  }

  // Parse a comma-separated string of city names into a normalised lower array.
  function parseCityList(input) {
    return String(input || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }

  // Returns { verdict, reason, distanceKm }
  // preferredCities: string (comma-separated) or array
  // jobCoords: [lat, lon] | null  — geocoded job location (only if precise)
  // homeCoords: [lat, lon] | null  — geocoded home point (stored in settings)
  function evaluatePreference(workplaceType, city, preferredCities, jobCoords, homeCoords, maxDistanceKm) {
    if (workplaceType === "remote") {
      return { verdict: "good", reason: "Remote — always acceptable", distanceKm: null };
    }
    if (!workplaceType) {
      return { verdict: "neutral", reason: "Workplace type unknown", distanceKm: null };
    }
    const cities = Array.isArray(preferredCities)
      ? preferredCities.map(c => String(c).trim().toLowerCase()).filter(Boolean)
      : parseCityList(preferredCities);
    if (cities.length === 0) {
      return { verdict: "neutral", reason: workplaceType + " — no preferred cities set in Options", distanceKm: null };
    }
    const where = city ? city : "unknown city";
    const cityLower = String(city || "").trim().toLowerCase();
    const matches = cityLower && cities.includes(cityLower);
    // Distance (optional) — only if we have both precise job coords and home coords.
    let distStr = "";
    let distKm = null;
    if (jobCoords && homeCoords && Array.isArray(jobCoords) && Array.isArray(homeCoords)
        && jobCoords.length === 2 && homeCoords.length === 2) {
      const max = Number.isFinite(maxDistanceKm) && maxDistanceKm > 0 ? maxDistanceKm : 30;
      distKm = haversineKm(jobCoords, homeCoords);
      if (distKm !== null) {
        distStr = " (" + distKm + " km from home" + (distKm <= max ? ", ≤ " + max : ", > " + max) + " km)";
      }
    }
    if (matches) {
      return { verdict: "good", reason: workplaceType + " in " + where + " — matches your preferred cities" + distStr, distanceKm: distKm };
    }
    return { verdict: "bad", reason: workplaceType + " in " + where + " — not in your preferred cities (" + cities.join(", ") + ")" + distStr, distanceKm: distKm };
  }

  async function getSettingsSnapshot() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY_SETTINGS, (res) => {
          const s = res[KEY_SETTINGS] || {};
          const lat = Number.isFinite(s.homeLat) ? s.homeLat : null;
          const lon = Number.isFinite(s.homeLon) ? s.homeLon : null;
          const homeCoords = (lat !== null && lon !== null) ? [lat, lon] : null;
          resolve({
            preferredCities: s.preferredCities || "",
            homeCoords,
            maxDistanceKm: Number.isFinite(s.maxDistanceKm) ? s.maxDistanceKm : 30,
          });
        });
      } catch (e) { resolve({ preferredCities: "", homeCoords: null, maxDistanceKm: 30 }); }
    });
  }

  // Compute detailFingerprint for current detail, get/create seen entry, set status.
  // Status lookup/match uses cardFingerprint (title+company) so it's stable whether
  // or not the description has loaded yet — detailFingerprint depends on descriptionText
  // and would produce different keys before vs after the description renders.
  async function setCurrentJobStatus(meta, status) {
    if (status && !VALID_STATUSES.has(status)) throw new Error("Invalid status: " + status);
    const cfp = await cardFingerprint(meta.title, meta.company);
    const fp = meta.descriptionText
      ? await detailFingerprint(meta.title, meta.company, meta.descriptionText)
      : null;
    const seen = await storageGet(KEY_SEEN);
    const now = new Date().toISOString();

    // Apply status to: (a) the detail entry if it exists/gets created, and
    // (b) any other seen entries sharing the same cardFingerprint (e.g. previous
    // view before description loaded, or older repost entries).
    const matches = Object.values(seen).filter(e => e.cardFingerprint === cfp);
    let entry = fp ? seen[fp] : null;
    if (fp && !entry) {
      entry = {
        fingerprint: fp,
        cardFingerprint: cfp,
        title: meta.title || "",
        company: meta.company || "",
        location: meta.location || "",
        workplaceType: meta.workplaceType || "",
        city: meta.city || "",
        descriptionText: meta.descriptionText || "",
        descriptionHtml: meta.descriptionHtml || "",
        jobIds: [String(meta.jobId)],
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
        status: "",
        statusSetAt: null,
      };
      seen[fp] = entry;
      matches.push(entry);
    }

    // Apply status to all matching entries (including the detail entry).
    for (const e of matches) {
      e.status = status || "";
      e.statusSetAt = status ? now : null;
      if (status === "ignored") {
        e.descriptionText = "";
        e.descriptionHtml = "";
      }
      seen[e.fingerprint] = e;
    }

    await storageSet(KEY_SEEN, seen);

    // Mirror to saved jobs if present — match by any jobId across all matching entries.
    const allJobIds = new Set();
    for (const e of matches) for (const jid of (e.jobIds || [])) allJobIds.add(String(jid));
    const jobs = await storageGet(KEY_JOBS);
    let jobsChanged = false;
    if (status === "ignored") {
      // "ignored" → remove from saved jobs (if present); keep only in seen (no description).
      for (const jid of allJobIds) {
        if (jobs[jid]) {
          delete jobs[jid];
          jobsChanged = true;
        }
      }
    } else {
      for (const jid of allJobIds) {
        if (jobs[jid]) {
          jobs[jid].status = status || "";
          jobs[jid].statusSetAt = status ? now : null;
          jobsChanged = true;
        }
      }
    }
    if (jobsChanged) await storageSet(KEY_JOBS, jobs);
    return entry || (matches[0] || null);
  }

  async function getCurrentJobStatus(meta) {
    // Always look up by cardFingerprint — works whether description loaded or not.
    const cfp = await cardFingerprint(meta.title, meta.company);
    const matches = await getAllSeenByCardFp(cfp);
    if (matches.length) return matches[0].status || "";
    return "";
  }

  // ---------- Fingerprinty ----------
  function normalizeText(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function sha256(str) {
    if (crypto && crypto.subtle) {
      try {
        const buf = new TextEncoder().encode(str);
        const hash = await crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
      } catch (e) { /* fallback poniżej */ }
    }
    // Fallback FNV-1a (gdy crypto.subtle niedostępny).
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return "fnv:" + (h >>> 0).toString(16);
  }

  async function cardFingerprint(title, company) {
    return "c:" + await sha256(normalizeText(title) + "|" + normalizeText(company));
  }
  async function detailFingerprint(title, company, descriptionText) {
    return "d:" + await sha256(normalizeText(title) + "|" + normalizeText(company) + "|" + normalizeText(descriptionText));
  }

  // ---------- Scrapowanie ----------
  function textClean(el) {
    return (el && el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findDetailRoot() {
    // Known containers across LinkedIn jobs layouts (search, view, collections, recommended).
    const direct = document.querySelector(
      ".jobs-search__job-details--wrapper, " +
      ".jobs-search__job-details--container, " +
      ".jobs-search__job-details, " +
      ".job-view-layout, " +
      ".jobs-job-view-layout, " +
      ".jobs-job-view-content, " +
      ".jobs-search-results__detail-panel, " +
      ".scaffold-layout__detail, " +
      ".scaffold-layout__list-detail, " +
      ".job-details-jobs-unified-top-card, " +
      ".topcard, " +
      ".jobs-s-main-content"
    );
    if (direct) return direct;

    // Fallback: walk up from #job-details to the nearest sensible container
    // (one that also contains the unified top-card with title/company).
    const desc = document.querySelector("#job-details");
    if (desc) {
      // Climb ancestors until we find one containing the top-card title or company.
      let node = desc.parentElement;
      while (node && node !== document.body) {
        if (node.querySelector(
          ".job-details-jobs-unified-top-card__job-title, " +
          ".job-details-jobs-unified-top-card__company-name, " +
          ".jobs-unified-top-card__job-title, " +
          ".topcard__title, " +
          ".topcard__flavor, " +
          "h1"
        )) {
          return node;
        }
        node = node.parentElement;
      }
      // Last resort: the closest known wrapper class.
      return desc.closest(
        ".jobs-description, .job-view-layout, .jobs-job-view-layout, " +
        ".jobs-search__job-details--container, .jobs-search__job-details--wrapper, " +
        ".jobs-search__job-details, .scaffold-layout__detail, .scaffold-layout__list-detail, " +
        ".jobs-job-view-content"
      );
    }

    // Standalone /jobs/view/<id>/ pages: topcard layout (no #job-details id).
    const topcard = document.querySelector(".topcard, .jobs-top-card");
    if (topcard) {
      // Walk up to a container that also has the description.
      let node = topcard.parentElement;
      while (node && node !== document.body) {
        if (node.querySelector(".jobs-description, .description, .jobs-box__group")) {
          return node;
        }
        node = node.parentElement;
      }
      return topcard;
    }

    // Heuristic fallback: "About the job" heading OR Save/Easy Apply button.
    // LinkedIn sometimes ships obfuscated class names (hashes that change
    // between builds), making CSS selectors unreliable. Stable signals:
    //   - a button with aria-label "Save the job" / "Saved" (header actions)
    //   - a link with aria-label "Easy Apply to this job"
    //   - an H2 with text "About the job" (description section)
    // We prefer the Save/Easy Apply container (the job header) as the root so
    // the toolbar is injected in the header, next to LinkedIn's own buttons —
    // not down in the description section.
    const saveBtn = document.querySelector(
      'button[aria-label="Save the job"], button[aria-label="Save"], button[aria-label="Saved"], ' +
      'button[aria-label*="Save the job"], button.jobs-save-button'
    );
    const easyApply = saveBtn || document.querySelector(
      'a[aria-label="Easy Apply to this job"], a[aria-label*="Easy Apply"], ' +
      'button[aria-label*="Easy Apply"], ' +
      // External "Apply" (off-site).
      'a[aria-label="Apply"], a[aria-label^="Apply to"], a[aria-label*="Apply on company website"], ' +
      'button[aria-label="Apply"], button[aria-label^="Apply to"], ' +
      // Class-based fallbacks (stable across LinkedIn builds).
      'button.jobs-apply-button, a.jobs-apply-button'
    );
    if (easyApply) {
      // Climb to the outermost header container that holds title + actions.
      // Stop when we reach an ancestor that also contains a paragraph with
      // the job title (matches document.title's first segment) OR multiple
      // paragraphs (title + metadata row).
      const docTitle = (document.title || "").replace(/\s*\|\s*LinkedIn\s*$/i, "");
      const titleSeg = docTitle.split(/\s*\|\s*/)[0]?.trim() || "";
      let node = easyApply;
      let header = null;
      while (node && node !== document.body) {
        const ps = node.querySelectorAll("p");
        // Header contains the title paragraph (matches document.title) or
        // at least 2 paragraphs (title + location metadata).
        if (titleSeg) {
          for (const p of ps) {
            if ((p.textContent || "").trim() === titleSeg) { header = node; break; }
          }
        }
        if (!header && ps.length >= 2) { header = node; }
        if (header) break;
        node = node.parentElement;
      }
      if (header) return header;
      // Fallback: climb to a section-like ancestor.
      return easyApply.closest("section, article, main") || easyApply.parentElement || document.body;
    }

    const aboutHeading = findAboutJobHeading();
    if (aboutHeading) {
      let node = aboutHeading.parentElement;
      while (node && node !== document.body) {
        if (node.children.length >= 2) {
          return node;
        }
        node = node.parentElement;
      }
      return aboutHeading.parentElement || document.body;
    }

    // Heuristic fallback: JSON-LD JobPosting schema.
    if (hasJobPostingLd()) {
      return document.querySelector("main") || document.querySelector("article") || document.body;
    }

    // Final fallback: unified top-card alone (better than nothing).
    return document.querySelector(".jobs-unified-top-card") || null;
  }

  // Find an H2 (or any heading) whose text content is "About the job".
  // LinkedIn localizes this but English locale is most common; also try
  // a few other languages (German, Polish, French) as a best effort.
  const ABOUT_JOB_TEXTS = [
    "about the job",
    "über den job", "über die stelle", "stellenbeschreibung",
    "o stanowisku", "o pracy",
    "à propos du poste", "à propos de l'offre",
    "sulla posizione", "informazioni sul lavoro",
    "sobre el puesto", "sobre el trabajo",
    "over de functie", "over de baan",
  ];
  function findAboutJobHeading() {
    const headings = document.querySelectorAll("h1, h2, h3, h4");
    for (const h of headings) {
      const t = (h.textContent || "").trim().toLowerCase();
      if (ABOUT_JOB_TEXTS.includes(t)) return h;
    }
    return null;
  }

  // Detect a JSON-LD JobPosting script in the document.
  function hasJobPostingLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent || "");
        if (data && data["@type"] === "JobPosting") return true;
        if (Array.isArray(data) && data.some(d => d && d["@type"] === "JobPosting")) return true;
        if (data && data["@graph"] && Array.isArray(data["@graph"]) && data["@graph"].some(d => d && d["@type"] === "JobPosting")) return true;
      } catch (e) { /* ignore malformed */ }
    }
    return false;
  }

  // Extract job metadata from JSON-LD JobPosting (used as a fallback when
  // CSS selectors fail — e.g. LinkedIn ships a new layout revision).
  function scrapeFromJobPostingLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        let data = JSON.parse(s.textContent || "");
        if (Array.isArray(data)) data = data.find(d => d && d["@type"] === "JobPosting");
        if (data && data["@graph"] && Array.isArray(data["@graph"])) {
          data = data["@graph"].find(d => d && d["@type"] === "JobPosting") || data;
        }
        if (!data || data["@type"] !== "JobPosting") continue;
        const title = data.title || "";
        const descHtml = data.description || "";
        // description is HTML in JSON-LD; strip tags for plain text.
        const descText = descHtml ? descHtml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
        const company = (data.hiringOrganization && (data.hiringOrganization.name || data.hiringOrganization.alternateName)) || "";
        const location = data.jobLocation
          ? (data.jobLocation.address
              ? [data.jobLocation.address.addressLocality, data.jobLocation.address.addressRegion, data.jobLocation.address.addressCountry].filter(Boolean).join(", ")
              : "")
          : (data.jobLocationType || "");
        const url = data.url || location.href || "";
        const jobIdMatch = url.match(/\/jobs\/view\/(\d+)/) || location.pathname.match(/\/jobs\/view\/(\d+)/);
        const jobId = jobIdMatch ? jobIdMatch[1] : "";
        return { title, company, location, descHtml, descText, url, jobId };
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function currentJobId(root) {
    // PRIORITY: signals that are bound to the actually-rendered detail panel.
    // On SPA transitions (collections/recommended), the URL param currentJobId
    // and the active card can lag behind the detail panel by a tick — scraping
    // jobId from inside the detail root avoids mismatched (title, jobId) pairs.

    // 1) Any element with data-job-id inside the detail root (e.g. apply button)
    if (root) {
      const el = root.querySelector("[data-job-id]");
      if (el) return el.getAttribute("data-job-id");
    }
    // 2) Apply button anywhere in the document
    const anyApply = document.querySelector(".jobs-apply-button[data-job-id], [data-live-test-job-apply-button][data-job-id]");
    if (anyApply) return anyApply.getAttribute("data-job-id");
    // 3) URL path /jobs/view/<id>
    const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1];
    // 4) URL query param currentJobId=<id>
    const qm = location.search.match(/[?&]currentJobId=(\d+)/);
    if (qm) return qm[1];
    // 5) Active job card on the list (two-pane view: search / collections / recommended)
    const active = document.querySelector(
      ".job-card-container[data-job-id].jobs-search-results-list__list-item--active, " +
      ".job-card-container[data-job-id][aria-current='page'], " +
      ".job-card-container[data-job-id].job-card-list--active, " +
      ".job-card-container[data-job-id].active, " +
      ".jobs-search-results__list-item--active .job-card-list[data-job-id], " +
      ".jobs-search-results__list-item--active .job-card-container[data-job-id], " +
      ".jobs-search-results__list-item--active-wrapper .job-card-container[data-job-id], " +
      ".scaffold-layout__list .job-card-container[data-job-id].job-card-list--active, " +
      ".scaffold-layout__list .job-card-container[data-job-id][aria-current='page']"
    );
    if (active) return active.getAttribute("data-job-id");
    // 6) og:url meta or canonical with /jobs/view/<id>/
    const og = document.querySelector('meta[property="og:url"][content]');
    if (og) {
      const om = og.getAttribute("content").match(/\/jobs\/view\/(\d+)/);
      if (om) return om[1];
    }
    const canon = document.querySelector('link[rel="canonical"][href]');
    if (canon) {
      const cm = canon.getAttribute("href").match(/\/jobs\/view\/(\d+)/);
      if (cm) return cm[1];
    }
    return null;
  }

  function scrapeFromDetail(root, jobId) {
    const titleEl = root.querySelector(
      ".job-details-jobs-unified-top-card__job-title h1, " +
      ".job-details-jobs-unified-top-card__job-title a, " +
      ".job-details-jobs-unified-top-card__job-title, " +
      ".jobs-unified-top-card__job-title h1, " +
      ".jobs-unified-top-card__job-title a, " +
      ".jobs-unified-top-card__job-title, " +
      ".topcard__title, " +
      ".topcard h1, " +
      "h1"
    );
    const companyEl = root.querySelector(
      ".job-details-jobs-unified-top-card__company-name a, " +
      ".job-details-jobs-unified-top-card__company-name, " +
      ".jobs-unified-top-card__company-name a, " +
      ".jobs-unified-top-card__company-name, " +
      ".topcard__flavor, " +
      ".topcard__company-name, " +
      ".artdeco-entity-lockup__subtitle"
    );
    const locEl = root.querySelector(
      ".job-details-jobs-unified-top-card__tertiary-description-container .tvm__text, " +
      ".jobs-unified-top-card__tertiary-description-container .tvm__text, " +
      ".job-details-jobs-unified-top-card__bullet, " +
      ".jobs-unified-top-card__bullet, " +
      ".job-details-jobs-unified-top-card__subtitle, " +
      ".jobs-unified-top-card__subtitle, " +
      ".topcard__flavor--metadata, " +
      ".topcard .posting-topcard__flavor--location, " +
      ".topcard__location"
    );
    const descEl = root.querySelector("#job-details") ||
      root.querySelector(".jobs-description-content__text--stretch") ||
      root.querySelector(".jobs-description__content") ||
      root.querySelector(".jobs-description-content") ||
      root.querySelector(".jobs-description") ||
      root.querySelector("#job-view-description") ||
      root.querySelector(".description") ||
      root.querySelector(".jobs-box__group--description");

    // Workplace type: LinkedIn exposes it in .job-details-fit-level-preferences
    // via visually-hidden text "workplace type is Remote" / "workplace type is Hybrid" etc.
    // This is more reliable than parsing location (which may only say "Germany").
    let workplaceType = "";
    const fitPrefs = root.querySelectorAll(".job-details-fit-level-preferences button .visually-hidden, .job-details-fit-level-preferences .visually-hidden");
    for (const v of fitPrefs) {
      const t = (v.textContent || "").toLowerCase();
      const m = t.match(/workplace type is (remote|hybrid|on[-\s]?site)/i);
      if (m) {
        workplaceType = m[1].replace(/\s+/g, "").replace("onsite", "onsite").replace("onsite", "onsite");
        if (workplaceType === "onsite") workplaceType = "onsite";
        else if (workplaceType === "onsite") workplaceType = "onsite";
        break;
      }
    }
    // Also check visible labels in fit-level buttons (fallback if visually-hidden missing).
    if (!workplaceType) {
      const fitBtns = root.querySelectorAll(".job-details-fit-level-preferences button");
      for (const b of fitBtns) {
        const label = (b.textContent || "").trim().toLowerCase();
        if (/\bremote\b/.test(label) && !/\bhybrid\b/.test(label)) { workplaceType = "remote"; break; }
        if (/\bhybrid\b/.test(label)) { workplaceType = "hybrid"; break; }
        if (/\bon[-\s]?site\b/.test(label) || /\bin[-\s]?office\b/.test(label)) { workplaceType = "onsite"; break; }
      }
    }

    // Location: try the tertiary description first, then the active job card on the left
    // (in two-pane view the card often has the full "City, Country (Workplace)" string).
    let location = textClean(locEl);
    if (!location) {
      const activeCard = document.querySelector(
        ".job-card-container[data-job-id].jobs-search-results-list__list-item--active, " +
        ".job-card-container[data-job-id][aria-current='page']"
      );
      if (activeCard) {
        const cardLoc = activeCard.querySelector(".job-card-container__metadata-wrapper li, .artdeco-entity-lockup__caption li");
        location = textClean(cardLoc);
      }
    }
    // Also check the sticky header which sometimes has "Company · City, Country (Workplace)".
    if (!location) {
      const sticky = root.querySelector(".job-details-jobs-unified-top-card__sticky-header .t-14, .job-details-jobs-unified-top-card__title-container .t-14");
      if (sticky) {
        const t = textClean(sticky);
        // "SPD Technology · Germany (Remote)" → take part after "·".
        const parts = t.split("·").map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) location = parts.slice(1).join(" · ");
      }
    }

    const _descText = descEl ? descEl.innerText : "";
    // Run analyzeLocation as fallback for workplace type (if fit-level buttons didn't yield it)
    // and to extract city.
    const _wa = analyzeLocation(location, _descText);
    if (!workplaceType) workplaceType = _wa.workplaceType;
    const city = _wa.city;

    // Salary: LinkedIn sometimes shows it in the top-card metadata area (a tvm__text
    // with currency symbols) or in the description text. We try both paths.
    const salary = scrapeSalary(root, _descText);

    // Sanity check: prefer data-job-id from inside the detail root (apply button)
    // over the passed-in jobId, which may come from a stale URL on SPA transitions.
    let finalJobId = String(jobId);
    const applyBtn = root.querySelector("[data-job-id]");
    if (applyBtn) {
      const rootJobId = applyBtn.getAttribute("data-job-id");
      if (rootJobId && String(rootJobId) !== finalJobId) {
        console.warn("[LJS] jobId mismatch — URL/card said", finalJobId, "but detail root says", rootJobId, "(trusting detail root)");
        finalJobId = String(rootJobId);
      }
    }

    let titleStr = textClean(titleEl);
    let companyStr = textClean(companyEl);
    let locationStr = location;
    let descHtml = descEl ? descEl.innerHTML : "";
    let descStr = _descText;

    // Cross-row contamination guard: on SPA transitions (collections/recommended)
    // LinkedIn updates the apply button's data-job-id BEFORE the top-card
    // re-renders, so for a brief window the apply button references the NEW job
    // while the title link / company / location / description still show the
    // PREVIOUS job. The title link's /jobs/view/<id>/ always matches the
    // actually-rendered title/company/description, so we trust it as the source
    // of truth for finalJobId instead of bailing out. This way the user can
    // still save/translate the job they SEE, and we never mix a new jobId with
    // an old company (which would cause cross-row contamination in Options).
    const _titleLink = titleEl
      ? (titleEl.tagName === "A" ? titleEl : titleEl.querySelector('a[href*="/jobs/view/"]'))
      : null;
    if (_titleLink && finalJobId) {
      const m = (_titleLink.getAttribute("href") || "").match(/\/jobs\/view\/(\d+)/);
      if (m && String(m[1]) !== String(finalJobId)) {
        console.warn("[LJS] top-card mid-transition — title link jobId", m[1],
          "≠ apply/URL jobId", finalJobId, "(trusting title-link jobId; matches rendered content)");
        finalJobId = String(m[1]);
      }
    }

    // Fallback 1: "About the job" heading heuristic.
    // On layouts with obfuscated class names, find the H2 with text
    // "About the job" and grab its sibling/parent container as the description.
    if (!descStr) {
      const aboutH = findAboutJobHeading();
      if (aboutH) {
        // The description is typically the next sibling element after the heading,
        // or the heading's parent's next sibling.
        let descContainer = aboutH.nextElementSibling;
        if (!descContainer && aboutH.parentElement) {
          descContainer = aboutH.parentElement.nextElementSibling;
        }
        if (descContainer) {
          descHtml = descContainer.innerHTML;
          descStr = descContainer.innerText;
        }
      }
    }

    // Fallback 2: title from <title> tag ("Lead Software Engineer (m/w/d) | Career Factory GmbH | LinkedIn")
    if (!titleStr) {
      const docTitle = document.title || "";
      // Strip " | LinkedIn" suffix and company (after " | ").
      const withoutSuffix = docTitle.replace(/\s*\|\s*LinkedIn\s*$/i, "");
      const parts = withoutSuffix.split(/\s*\|\s*/);
      if (parts.length >= 1) titleStr = parts[0].trim();
      if (!companyStr && parts.length >= 2) companyStr = parts[parts.length - 1].trim();
    }

    // Fallback 2b: obfuscated layout — scrape from header structure by content.
    // Title: the <p> whose text matches document.title's first segment.
    // Company: the <a href*="linkedin.com/company/"> text.
    // Location: first <span> in the paragraph containing "·" (metadata row).
    if (!titleStr || !companyStr || !locationStr) {
      const docTitle = (document.title || "").replace(/\s*\|\s*LinkedIn\s*$/i, "");
      const titleSeg = docTitle.split(/\s*\|\s*/)[0]?.trim() || "";
      if (!titleStr && titleSeg) {
        // Find a <p> whose text matches the title segment.
        const ps = root.querySelectorAll("p");
        for (const p of ps) {
          if ((p.textContent || "").trim() === titleSeg) { titleStr = titleSeg; break; }
        }
      }
      if (!companyStr) {
        const companyLink = root.querySelector('a[href*="linkedin.com/company/"][href*="/life/"], a[href*="linkedin.com/company/"]');
        if (companyLink) companyStr = (companyLink.textContent || "").trim();
      }
      if (!locationStr) {
        // Metadata paragraph: "Germany · Reposted 6 days ago · Over 100 applicants"
        const ps = root.querySelectorAll("p");
        for (const p of ps) {
          const t = (p.textContent || "").trim();
          if (t.includes("·") && /repost|applicants|ago|promoted/i.test(t)) {
            const firstSpan = p.querySelector("span");
            if (firstSpan) locationStr = (firstSpan.textContent || "").trim();
            break;
          }
        }
      }
    }

    // Fallback 3: JSON-LD JobPosting (last resort).
    if (!titleStr && !companyStr && !descStr) {
      const ld = scrapeFromJobPostingLd();
      if (ld) {
        if (ld.title) titleStr = ld.title;
        if (ld.company) companyStr = ld.company;
        if (ld.location) locationStr = ld.location;
        if (ld.descHtml) descHtml = ld.descHtml;
        if (ld.descText) descStr = ld.descText;
        if (!finalJobId && ld.jobId) finalJobId = String(ld.jobId);
        console.log("[LJS] used JSON-LD fallback for scraping");
      }
    }

    return {
      jobId: finalJobId,
      title: titleStr,
      company: companyStr,
      location: locationStr,
      workplaceType,
      city,
      salary,
      url: "https://www.linkedin.com/jobs/view/" + finalJobId + "/",
      descriptionHtml: descHtml,
      descriptionText: descStr,
    };
  }

  // Try to extract a salary string from the detail page.
  // Path 1: LinkedIn's salary UI element (varies by listing / locale).
  //   - .job-details-jobs-unified-top-card__salary, .job-details-jobs-unified-top-card__salary-info
  //   - a tvm__text containing a currency symbol (€/$/£/PLN/EUR/USD) or "per year/month"
  // Path 2: regex over the description text (fallback).
  function scrapeSalary(root, descText) {
    // Path 1: dedicated salary containers.
    const salaryEls = root.querySelectorAll(
      ".job-details-jobs-unified-top-card__salary, " +
      ".job-details-jobs-unified-top-card__salary-info, " +
      ".jobs-unified-top-card__salary-info, " +
      ".job-details-jobs-unified-top-card__body--secondary .tvm__text"
    );
    for (const el of salaryEls) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      // Must contain a currency indicator to be a salary, not just "Full-time".
      if (/[€$£]|EUR|USD|PLN|GBP|per\s+(year|month|hour|annum|year)|jährlich|monatlich|stündlich|\/\s*(year|month|hour|Jahr|Monat)/i.test(t)) {
        const cleaned = t.replace(/\s+/g, " ").trim();
        if (cleaned.length >= 3 && cleaned.length <= 120) return cleaned;
      }
    }
    // Path 2: regex over description text.
    const desc = String(descText || "");
    if (desc) {
      // Match patterns like:
      //   "Salary: €60,000 - €80,000 per year"
      //   "Compensation: $120k/year"
      //   "Vergütung: 60.000 - 80.000 € jährlich"
      //   "Remuneration: PLN 15,000 - 20,000 / month"
      //   "Salary range: £40,000 - £60,000"
      const m = desc.match(
        /(?:salary|compensation|remuneration|vergütung|entgelt|wynagrodzenie|salary range)\s*[:\-]?\s*([^\n]{3,120}?)(?:\bper\s+(?:year|month|hour|annum)|\b\/\s*(?:year|month|hour|Jahr|Monat|Stunde)|jährlich|monatlich|stündlich)/i
      );
      if (m) {
        const val = (m[0] || "").replace(/\s+/g, " ").trim();
        if (val.length >= 5 && val.length <= 200) return val;
      }
      // Looser: find a line that starts with a currency + numbers.
      const m2 = desc.match(/(?:^|\n)\s*((?:[€$£]\s?\d[\d.,\s]*k?|(?:EUR|USD|GBP|PLN)\s?\d[\d.,\s]*k?)[^\n]{0,80})/i);
      if (m2) {
        const val = m2[1].replace(/\s+/g, " ").trim();
        if (val.length >= 4 && val.length <= 120) return val;
      }
    }
    return "";
  }

  // Scraping card metadata from the list (for the "seen" badge).
  function scrapeFromCard(card) {
    const jobId = card.getAttribute("data-job-id");
    if (!jobId) return null;
    const titleEl = card.querySelector(".job-card-list__title--link, .artdeco-entity-lockup__title a, .artdeco-entity-lockup__title strong");
    const companyEl = card.querySelector(".artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .job-card-container__company-name");
    return {
      jobId: String(jobId),
      title: textClean(titleEl),
      company: textClean(companyEl),
    };
  }

  // ---------- UI: toast ----------
  function toast(msg, kind) {
    let el = document.getElementById("ljs-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ljs-toast";
      el.className = "ljs-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "ljs-toast ljs-toast--" + (kind || "info");
    requestAnimationFrame(() => el.classList.add("ljs-toast--show"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("ljs-toast--show"), 2600);
  }

  // ---------- UI: przycisk zapisu w detalu ----------
  async function isAlreadySaved(jobId) {
    try { return !!(await getJob(jobId)); }
    catch (e) { console.warn("[LJS] isAlreadySaved error", e); return false; }
  }

  async function handleSave(btn, meta) {
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.querySelector(".ljs-save-btn__icon").textContent = "…";
    try {
      if (!meta.descriptionHtml) {
        await new Promise(r => setTimeout(r, 600));
        const root = findDetailRoot();
        if (root) {
          const descEl = root.querySelector("#job-details, .jobs-description__content, #job-view-description");
          if (descEl) {
            meta.descriptionHtml = descEl.innerHTML;
            meta.descriptionText = descEl.innerText;
          }
        }
      }
      // Preserve existing status if job already in DB (e.g. user marked Apply then clicked Save).
      const existing = await getJob(meta.jobId);
      let status = (existing && existing.status) || "";
      let statusSetAt = (existing && existing.statusSetAt) || null;
      // If job has no status yet, check seen entries by cardFingerprint (title+company).
      // cardFingerprint is stable whether or not the description has loaded, unlike
      // detailFingerprint which depends on descriptionText.
      if (!status) {
        try {
          const cfp = await cardFingerprint(meta.title, meta.company);
          const matches = await getAllSeenByCardFp(cfp);
          if (matches.length && matches[0].status) {
            status = matches[0].status;
            statusSetAt = matches[0].statusSetAt || null;
          }
        } catch (e) { console.warn("[LJS] status lookup from seen failed", e); }
      }
      const job = {
        jobId: meta.jobId,
        title: meta.title,
        company: meta.company,
        location: meta.location,
        workplaceType: meta.workplaceType || "",
        city: meta.city || "",
        salary: meta.salary || "",
        url: meta.url,
        descriptionHtml: meta.descriptionHtml || "",
        descriptionText: meta.descriptionText || "",
        savedAt: new Date().toISOString(),
        sourceUrl: location.href,
        status,
        statusSetAt,
      };
      await saveJob(job);
      btn.classList.add("ljs-save-btn--saved");
      btn.querySelector(".ljs-save-btn__icon").textContent = "✓";
      toast("Saved: " + (job.title || meta.jobId), "ok");
    } catch (e) {
      console.error("[LJS] save error", e);
      btn.classList.add("ljs-save-btn--err");
      btn.querySelector(".ljs-save-btn__icon").textContent = "✕";
      toast("Save error: " + (e.message || e), "err");
      setTimeout(() => {
        btn.classList.remove("ljs-save-btn--err");
        btn.innerHTML = original;
      }, 2000);
    } finally {
      btn.disabled = false;
    }
  }

  const BTN_ID = "ljs-save-btn";
  const TOOLBAR_ID = "ljs-toolbar";
  const ACTION_BTN_CLASS = "ljs-action-btn";
  const PREF_BANNER_ID = "ljs-pref-banner";
  let injectedForJobId = null;

  function removeButton() {
    const t = document.getElementById(TOOLBAR_ID);
    if (t) t.remove();
    removePrefBanner();
    injectedForJobId = null;
  }

  function injectSaveButton() {
    if (!checkCtx()) return;
    const root = findDetailRoot();
    if (!root) { removeButton(); return; }
    const jobId = currentJobId(root);
    if (!jobId) return;

    // Readiness guard: don't inject into an empty detail panel (collections /
    // recommended layouts render the job content asynchronously into
    // .scaffold-layout__list-detail). If we inject too early, LinkedIn may
    // overwrite our toolbar when it renders, and our injectedForJobId guard
    // would then prevent re-injection. Wait for real content.
    const topCardReady = root.querySelector(
      ".job-details-jobs-unified-top-card, .jobs-unified-top-card, " +
      ".job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, " +
      ".topcard__title, .topcard h1, " +
      "h1.t-24, h1.t-16, h1.topcard__title"
    ) || findAboutJobHeading();
    const descReady = root.querySelector("#job-details, .jobs-description__content, #job-view-description, .jobs-description, .description, .jobs-box__group") || findAboutJobHeading();
    if (!topCardReady && !descReady) {
      // Panel container exists but job content hasn't loaded yet — skip this
      // cycle without setting injectedForJobId, so the MutationObserver can
      // re-trigger scanAll once LinkedIn renders the content.
      // But if a toolbar from a previous job is still in the DOM, remove it
      // so we don't show stale actions for the new (not-yet-loaded) job.
      if (injectedForJobId && injectedForJobId !== String(jobId)) {
        removeButton();
      }
      return;
    }

    if (injectedForJobId === String(jobId) && document.getElementById(TOOLBAR_ID)) return;
    removeButton();
    injectedForJobId = String(jobId);
    console.log("[LJS] injectSaveButton — jobId:", jobId, "root:", root.className);

    // Insert toolbar AFTER LinkedIn's action row (Easy Apply / Save buttons),
    // as a separate block. We do not append into LinkedIn's button container, so the
    // original layout is preserved.
    // Strategy: locate the "Save" / "Apply" buttons by aria-label OR stable class
    // (jobs-save-button / jobs-apply-button). The aria-label approach is preferred
    // (stable across obfuscated class name revisions), but on some listings the
    // Save button has NO aria-label — its accessible text lives in an inner
    // <span class="a11y-text"> — and on external-offer pages the apply button
    // is "Apply" (not "Easy Apply"), so aria-label*="Easy Apply" misses it. The
    // class-based selectors cover both cases.
    const saveJobBtn = root.querySelector(
      'button[aria-label="Save the job"], button[aria-label="Save"], button[aria-label="Saved"], ' +
      'button[aria-label*="Save the job"], button.jobs-save-button'
    );
    const applyBtnAny = root.querySelector(
      'a[aria-label="Easy Apply to this job"], a[aria-label*="Easy Apply"], ' +
      'button[aria-label*="Easy Apply"], ' +
      // External "Apply" (off-site) — link or button with "Apply" label (but NOT "Easy Apply").
      'a[aria-label="Apply"], a[aria-label^="Apply to"], a[aria-label*="Apply on company website"], ' +
      'button[aria-label="Apply"], button[aria-label^="Apply to"], ' +
      // Class-based fallbacks (stable across LinkedIn builds).
      'button.jobs-apply-button, a.jobs-apply-button'
    );
    // The "actionRow" is the OUTERMOST container that holds ONLY the action
    // buttons (Easy Apply + Save, plus any sticky-buttons-container). We insert
    // AFTER it (as its parent's next child) so the toolbar appears on its own
    // line BELOW the entire action area — not inside it (which would cause the
    // sticky-buttons-container to overlap the toolbar on listings with both
    // top-card and sticky action rows, e.g. Easy Apply + Save).
    // Heuristic: climb from the Save button up through ancestors, and pick the
    // highest ancestor that (a) contains the Save button, (b) contains at least
    // one action button, and (c) does NOT contain the job title (h1) or the
    // description (#job-details) — that guards against climbing past the action
    // area into the whole top-card.
    function isActionOnlyContainer(el) {
      if (!el || el === root) return false;
      if (!el.contains(saveJobBtn) && (!applyBtnAny || !el.contains(applyBtnAny))) return false;
      const actionKids = el.querySelectorAll(
        'button[aria-label*="Save"], button.jobs-save-button, ' +
        'a[aria-label*="Easy Apply"], button[aria-label*="Easy Apply"], ' +
        'a[aria-label*="Apply"], button[aria-label*="Apply"], ' +
        'button.jobs-apply-button, a.jobs-apply-button'
      );
      if (actionKids.length < 1) return false;
      // Reject containers that also hold the title or description — those are
      // the top-card, not the action area.
      if (el.querySelector('h1, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, #job-details, .jobs-description__content, .jobs-description')) {
        return false;
      }
      return true;
    }
    let actionRow = null;
    const climbStart = saveJobBtn || applyBtnAny;
    if (climbStart) {
      let n = climbStart;
      let best = null;
      while (n && n !== root) {
        const parent = n.parentElement;
        if (!parent) break;
        if (isActionOnlyContainer(parent)) best = parent;
        if (parent === root) break;
        n = parent;
      }
      actionRow = best || climbStart.parentElement;
    }
    // Legacy selectors as last resort.
    if (!actionRow) {
      actionRow =
        root.querySelector(".mt4 .display-flex") ||
        root.querySelector(".job-details-jobs-unified-top-card__sticky-buttons-container") ||
        root.querySelector(".jobs-unified-top-card__actions") ||
        root.querySelector(".jobs-unified-top-card__content") ||
        root.querySelector(".jobs-apply-button--preview-banner") ||
        root.querySelector(".job-details-jobs-unified-top-card__sticky-action-buttons") ||
        (root.querySelector("[data-live-test-job-apply-button]") ? root.querySelector("[data-live-test-job-apply-button]").closest(".mt4, .display-flex, .jobs-unified-top-card__actions, .job-details-jobs-unified-top-card__sticky-action-buttons") : null);
    }
    // Anchor: the parent that will receive the toolbar as a new child.
    const anchor = actionRow && actionRow.parentElement ? actionRow.parentElement : root;

    // Toolbar container: title + two rows.
    // Row 1: [Save] [Panel]     Row 2: [Apply][Consider][German][Ignore]
    const toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;
    toolbar.className = "ljs-toolbar";

    // --- Title ---
    const title = document.createElement("div");
    title.className = "ljs-toolbar__title";
    title.textContent = "LinkedIn Job Helper";
    toolbar.appendChild(title);

    // --- Preference banner slot (integrated below title) ---
    const bannerSlot = document.createElement("div");
    bannerSlot.id = PREF_BANNER_ID + "-slot";
    bannerSlot.className = "ljs-toolbar__banner-slot";
    toolbar.appendChild(bannerSlot);

    // --- Info bar: seen status, repost, action history ---
    const infoBar = document.createElement("div");
    infoBar.id = "ljs-info-bar";
    infoBar.className = "ljs-info-bar";
    toolbar.appendChild(infoBar);

    // --- Single row: Save | status buttons | Panel ---
    const row = document.createElement("div");
    row.className = "ljs-toolbar__row";

    const saveGroup = document.createElement("div");
    saveGroup.className = "ljs-toolbar__group";

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "ljs-save-btn";
    btn.type = "button";
    btn.innerHTML = '<span class="ljs-save-btn__icon">💾</span>';
    btn.title = "Save this job to the local database (LinkedIn Job Saver)";

    isAlreadySaved(jobId).then(saved => {
      if (saved) {
        btn.classList.add("ljs-save-btn--saved");
        btn.querySelector(".ljs-save-btn__icon").textContent = "✓";
      }
    });

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("[LJS] click save, jobId=", jobId);
      if (btn.classList.contains("ljs-save-btn--saved")) { toast("Already saved earlier"); return; }
      const meta = scrapeFromDetail(root, jobId);
      console.log("[LJS] scraped meta:", { title: meta.title, company: meta.company, descLen: meta.descriptionText.length });
      if (!meta.descriptionHtml) {
        console.warn("[LJS] no description yet — wait");
        toast("Description still loading — try in a second", "err");
        return;
      }
      await handleSave(btn, meta);
      refreshInfoBar(root, jobId);
    });

    saveGroup.appendChild(btn);

    // --- Translate button (opens Google Translate with the job description) ---
    const translateBtn = document.createElement("button");
    translateBtn.type = "button";
    translateBtn.className = "ljs-action-btn ljs-translate-btn";
    translateBtn.innerHTML = '<span class="ljs-action-btn__icon">🌐</span>';
    translateBtn.title = "Translate this job description to English";
    translateBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!checkCtx()) { toast("Extension reloaded — refresh page", "err"); return; }
      const meta = scrapeFromDetail(root, jobId);
      const parts = [
        meta.title ? meta.title : "",
        meta.company ? meta.company : "",
        meta.location ? meta.location : "",
        meta.descriptionText ? meta.descriptionText : "",
      ].filter(Boolean);
      const text = parts.join("\n\n");
      if (!text) { toast("Nothing to translate — content not loaded yet", "err"); return; }
      // Heuristic: if the description already looks English, confirm first.
      if (looksEnglish(text) && !confirm("This job description appears to be in English already.\n\nTranslate anyway?")) {
        return;
      }
      openTranslateOverlay(text, meta, jobId);
    });
    saveGroup.appendChild(translateBtn);

    row.appendChild(saveGroup);

    // --- Separator ---
    const sep1 = document.createElement("div");
    sep1.className = "ljs-toolbar__sep";
    row.appendChild(sep1);

    // --- Status buttons ---
    const statusGroup = document.createElement("div");
    statusGroup.className = "ljs-toolbar__group";

    // Quick-action buttons. "applied" is options-only (set via popup/options dropdowns).
    const ACTIONS = ["apply", "to-consider", "german", "ignored"];
    const STATUS_ICONS = { "apply": "✓", "to-consider": "★", "german": "🇩🇪", "ignored": "✕" };
    const actionBtns = {};
    for (const key of ACTIONS) {
      const ab = document.createElement("button");
      ab.type = "button";
      ab.className = ACTION_BTN_CLASS + " ljs-action-" + key;
      ab.innerHTML = '<span class="ljs-action-btn__icon">' + STATUS_ICONS[key] + '</span><span class="ljs-action-btn__text">' + STATUS_LABELS[key] + '</span>';
      ab.title = "Mark as: " + STATUS_LABELS[key] + (key === "ignored" ? " (removes from saved, drops description from seen)" : "");
      ab.dataset.action = key;
      ab.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const meta = scrapeFromDetail(root, jobId);
        if (!meta.title && !meta.company) {
          toast("Job details still loading — try in a second", "err");
          return;
        }
        const isAlready = ab.classList.contains(ACTION_BTN_CLASS + "--active");
        const nextStatus = isAlready ? "" : key;
        // Confirmation for "ignored" — it removes the job from saved and strips the description from seen.
        if (nextStatus === "ignored" && !confirm('Marking as "Ignore" removes the job from saved jobs and drops the description from seen storage (fingerprint + metadata are kept for repost detection).\n\nContinue?')) {
          return;
        }
        try {
          ab.disabled = true;
          await setCurrentJobStatus(meta, nextStatus);
          // Update visual state of all action buttons.
          for (const k of ACTIONS) {
            actionBtns[k].classList.toggle(ACTION_BTN_CLASS + "--active", k === key && !isAlready);
          }
          // Auto-save: apply / to-consider / german → save full job to DB if not already saved.
          // ignored → only register in seen (without description); do NOT save to jobs, and
          // remove from jobs if it was previously saved (handled in setCurrentJobStatus).
          if (!isAlready && nextStatus && nextStatus !== "ignored") {
            if (!btn.classList.contains("ljs-save-btn--saved")) {
              if (!meta.descriptionHtml) {
                // Wait briefly for description to load, then save.
                toast("Saving…");
                await new Promise(r => setTimeout(r, 600));
                const root2 = findDetailRoot();
                if (root2) {
                  const descEl = root2.querySelector("#job-details, .jobs-description__content, #job-view-description");
                  if (descEl) {
                    meta.descriptionHtml = descEl.innerHTML;
                    meta.descriptionText = descEl.innerText;
                  }
                }
              }
              if (meta.descriptionHtml) {
                await handleSave(btn, meta);
                refreshInfoBar(root, jobId);
              } else {
                toast("Description not loaded — click Save manually", "err");
              }
            }
          } else if (nextStatus === "ignored") {
            // Update Save button visual state — job was removed from saved.
            btn.classList.remove("ljs-save-btn--saved");
            btn.querySelector(".ljs-save-btn__icon").textContent = "💾";
          }
          toast(isAlready ? ("Cleared: " + STATUS_LABELS[key]) : ("Marked: " + STATUS_LABELS[key]), "ok");
          refreshInfoBar(root, jobId);
        } catch (err) {
          console.error("[LJS] status error", err);
          toast("Status error: " + (err.message || err), "err");
        } finally {
          ab.disabled = false;
        }
      });
      actionBtns[key] = ab;
      statusGroup.appendChild(ab);
    }
    row.appendChild(statusGroup);

    // --- Separator ---
    const sep2 = document.createElement("div");
    sep2.className = "ljs-toolbar__sep";
    row.appendChild(sep2);

    // --- Panel button (black, white text) ---
    const optsBtn = document.createElement("button");
    optsBtn.type = "button";
    optsBtn.className = "ljs-action-btn ljs-options-btn";
    optsBtn.innerHTML = '<span class="ljs-action-btn__icon">⚙</span><span class="ljs-action-btn__text">Panel</span>';
    optsBtn.title = "Open LinkedIn Job Helper panel (preferences, saved & seen jobs, backup)";
    optsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openOptionsOverlay();
    });
    row.appendChild(optsBtn);
    toolbar.appendChild(row);

    // Reflect existing status (async, may resolve after append).
    const meta0 = scrapeFromDetail(root, jobId);
    if (meta0.title || meta0.company) {
      getCurrentJobStatus(meta0).then(status => {
        if (status && actionBtns[status]) {
          actionBtns[status].classList.add(ACTION_BTN_CLASS + "--active");
        }
      }).catch(() => {});
    }

    // Insert AFTER the LinkedIn action row, as a sibling (own line).
    // The anchor (actionRow.parentElement) receives the toolbar as a new child
    // right after actionRow — so it appears below the Easy Apply / Save row.
    const topCard = root.querySelector(
      ".job-details-jobs-unified-top-card, .jobs-unified-top-card"
    );
    if (actionRow && actionRow.parentElement) {
      actionRow.insertAdjacentElement("afterend", toolbar);
    } else if (topCard && topCard.nextSibling) {
      root.insertBefore(toolbar, topCard.nextSibling);
    } else if (topCard) {
      root.appendChild(toolbar);
    } else {
      root.appendChild(toolbar);
    }
    console.log("[LJS] toolbar appended — in DOM:", !!document.getElementById(TOOLBAR_ID), "actionRow:", !!actionRow, "topCard:", !!topCard, "anchor:", (anchor && anchor.className || "").slice(0,60));

    // Preference banner: green if remote or (onsite/hybrid in a preferred city),
    // red if onsite/hybrid not in a preferred city, neutral/none otherwise.
    refreshPreferenceBanner(root, jobId);
    // Info bar: seen status, repost detection, action history.
    refreshInfoBar(root, jobId);
  }

  function refreshInfoBar(root, jobId) {
    const infoBar = document.getElementById("ljs-info-bar");
    if (!infoBar) return;
    const meta = scrapeFromDetail(root, jobId);
    if (!meta.title && !meta.company) { infoBar.innerHTML = ""; return; }
    cardFingerprint(meta.title, meta.company).then(async (cfp) => {
      try {
        const matches = await getAllSeenByCardFp(cfp);
        const chips = [];
        if (matches.length === 0) {
          chips.push('<span class="ljs-info-chip ljs-info-chip--new">✨ New — not seen before</span>');
        } else {
          // Aggregate info across all matching seen entries.
          const earliest = matches.reduce((a, b) => (a.firstSeenAt < b.firstSeenAt ? a : b));
          const latest = matches.reduce((a, b) => (a.lastSeenAt > b.lastSeenAt ? a : b));
          const totalSeen = matches.reduce((s, e) => s + (e.seenCount || 1), 0);
          const allJobIds = new Set();
          for (const e of matches) for (const id of (e.jobIds || [])) allJobIds.add(String(id));
          const otherIds = [...allJobIds].filter(id => id !== String(jobId));
          const days = Math.round((Date.now() - new Date(earliest.firstSeenAt).getTime()) / 86400000);
          const firstDate = new Date(earliest.firstSeenAt).toLocaleDateString("en-US");
          const lastDate = new Date(latest.lastSeenAt).toLocaleDateString("en-US");

          // Seen chip
          let seenText = "👁 Seen " + totalSeen + "×";
          if (days === 0) seenText += " (today)";
          else if (days === 1) seenText += " (1 day ago)";
          else seenText += " (" + days + " days ago)";
          chips.push('<span class="ljs-info-chip ljs-info-chip--seen">' + seenText + '</span>');

          // First/last seen
          if (firstDate !== lastDate) {
            chips.push('<span class="ljs-info-chip ljs-info-chip--muted">first: ' + firstDate + ' · last: ' + lastDate + '</span>');
          } else {
            chips.push('<span class="ljs-info-chip ljs-info-chip--muted">on ' + firstDate + '</span>');
          }

          // Repost chip
          if (otherIds.length > 0) {
            chips.push('<span class="ljs-info-chip ljs-info-chip--repost">🔁 Repost (' + otherIds.length + ' other ID' + (otherIds.length > 1 ? "s" : "") + ")</span>");
          }

          // Status chip
          const statusMatch = matches.find(e => e.status);
          if (statusMatch && statusMatch.status) {
            const st = statusMatch.status;
            const stLabels = { "apply": "Apply", "applied": "Applied", "to-consider": "Consider", "german": "German", "ignored": "Ignored" };
            const stClass = "ljs-info-chip--status-" + st;
            chips.push('<span class="ljs-info-chip ' + stClass + '">🏷 ' + (stLabels[st] || st) + '</span>');
          }

          // Saved chip
          const savedCheck = await isAlreadySaved(jobId);
          if (savedCheck) {
            chips.push('<span class="ljs-info-chip ljs-info-chip--saved">💾 Saved</span>');
          }
        }
        infoBar.innerHTML = chips.join("");
      } catch (e) {
        console.warn("[LJS] refreshInfoBar error", e);
      }
    }).catch(() => {});
  }

  function removePrefBanner() {
    const slot = document.getElementById(PREF_BANNER_ID + "-slot");
    if (slot) slot.innerHTML = "";
  }

  function refreshPreferenceBanner(root, jobId) {
    const meta = scrapeFromDetail(root, jobId);
    console.log("[LJS] refreshPreferenceBanner", {
      jobId,
      title: meta.title,
      workplaceType: meta.workplaceType,
      city: meta.city,
      location: meta.location,
      descLen: meta.descriptionText.length,
    });
    if (!meta.title && !meta.company) { removePrefBanner(); return; }
    // If workplace type unknown AND description still loading, retry once after delay.
    if (!meta.workplaceType && meta.descriptionText.length < 50) {
      console.log("[LJS] preference: description not loaded yet — retry in 1500ms");
      setTimeout(() => {
        // Only retry if still on the same job.
        if (injectedForJobId === String(jobId)) refreshPreferenceBanner(root, jobId);
      }, 1500);
    }
    getSettingsSnapshot().then(async ({ preferredCities, homeCoords, maxDistanceKm }) => {
      // Geocode the job location only if it contains a postcode or street address.
      // City-only locations still get green/red based on preferredCities match,
      // but no distance is appended.
      let jobCoords = null;
      const locStr = meta.location || "";
      if (meta.workplaceType && meta.workplaceType !== "remote" && homeCoords && hasPreciseLocation(locStr)) {
        console.log("[LJS] preference: precise location detected, geocoding:", locStr);
        jobCoords = await geocodeJobLocation(locStr);
        console.log("[LJS] preference: geocoded job coords:", jobCoords);
      }
      const ev = evaluatePreference(meta.workplaceType, meta.city, preferredCities, jobCoords, homeCoords, maxDistanceKm);
      console.log("[LJS] preference verdict:", ev, "preferredCities:", preferredCities, "homeCoords:", homeCoords, "jobCoords:", jobCoords, "maxDistanceKm:", maxDistanceKm);
      removePrefBanner();
      // Show banner for good and bad. For neutral (unknown workplace / no cities),
      // show an informational banner so the user sees the feature is active.
      const slot = document.getElementById(PREF_BANNER_ID + "-slot");
      if (!slot) return;
      const banner = document.createElement("div");
      banner.id = PREF_BANNER_ID;
      banner.className = "ljs-pref-banner ljs-pref-banner--" + ev.verdict;
      const icon = ev.verdict === "good" ? "✓" : ev.verdict === "bad" ? "✗" : "•";
      banner.innerHTML = '<span class="ljs-pref-banner__icon">' + icon + '</span><span class="ljs-pref-banner__text">' + ev.reason + '</span>';
      slot.appendChild(banner);
    }).catch((e) => console.warn("[LJS] preference banner error", e));
  }

  // ---------- Translate overlay (inline translation panel) ----------
  const LANG_NAMES = {
    de: "German", en: "English", pl: "Polish", fr: "French", es: "Spanish",
    it: "Italian", nl: "Dutch", pt: "Portuguese", ru: "Russian", tr: "Turkish",
    uk: "Ukrainian", ro: "Romanian", cs: "Czech", sv: "Swedish", da: "Danish",
    fi: "Finnish", no: "Norwegian", ar: "Arabic", zh: "Chinese", ja: "Japanese",
    ko: "Korean", hi: "Hindi", hu: "Hungarian", el: "Greek", bg: "Bulgarian",
    sk: "Slovak", hr: "Croatian", sr: "Serbian", lt: "Lithuanian", lv: "Latvian",
    et: "Estonian", sl: "Slovenian", is: "Icelandic", he: "Hebrew",
  };
  function langName(code) {
    if (!code) return "auto-detected";
    return LANG_NAMES[code] || code;
  }

  function translateViaBackground(text, targetLang) {
    return new Promise((resolve, reject) => {
      if (!checkCtx()) return reject(new Error("Extension context invalidated"));
      try {
        chrome.runtime.sendMessage(
          { type: "translate", text, targetLang },
          (res) => {
            if (!checkCtx()) return reject(new Error("Extension context invalidated"));
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!res || !res.ok) return reject(new Error((res && res.error) || "Translate failed"));
            resolve({ translatedText: res.translatedText, sourceLang: res.sourceLang });
          }
        );
      } catch (e) { reject(e); }
    });
  }

  function closeTranslateOverlay() {
    const ov = document.getElementById("ljs-translate-overlay");
    if (ov) ov.remove();
  }

  async function saveTranslation(jobId, translatedText, sourceLang) {
    // Update saved job (if present) with translation + source language.
    const jobs = await storageGet(KEY_JOBS);
    let changedJobs = false;
    if (jobs[jobId]) {
      jobs[jobId].translationEn = translatedText;
      jobs[jobId].sourceLang = sourceLang || "";
      jobs[jobId].translatedAt = new Date().toISOString();
      changedJobs = true;
    }
    if (changedJobs) await storageSet(KEY_JOBS, jobs);

    // Also store translation on the seen entry (match by cardFingerprint).
    try {
      // Read meta fresh to compute fingerprint.
      const root = findDetailRoot();
      if (root) {
        const meta = scrapeFromDetail(root, jobId);
        if (meta.title && meta.company) {
          const cfp = await cardFingerprint(meta.title, meta.company);
          const seen = await storageGet(KEY_SEEN);
          const matches = Object.values(seen).filter(e => e.cardFingerprint === cfp);
          let changedSeen = false;
          for (const e of matches) {
            e.translationEn = translatedText;
            e.sourceLang = sourceLang || "";
            e.translatedAt = new Date().toISOString();
            seen[e.fingerprint] = e;
            changedSeen = true;
          }
          if (changedSeen) await storageSet(KEY_SEEN, seen);
        }
      }
    } catch (e) { console.warn("[LJS] saveTranslation seen update failed", e); }
  }

  async function openTranslateOverlay(text, meta, jobId) {
    closeTranslateOverlay();
    const overlay = document.createElement("div");
    overlay.id = "ljs-translate-overlay";
    overlay.className = "ljs-overlay ljs-translate-overlay";
    overlay.innerHTML = `
      <div class="ljs-overlay__backdrop"></div>
      <div class="ljs-translate-card">
        <button class="ljs-overlay__close" title="Close (Esc)">✕</button>
        <div class="ljs-translate-header">
          <h2>🌐 Translate job to English</h2>
          <span class="ljs-translate-meta">${escInline(meta.title)} · ${escInline(meta.company)}</span>
        </div>
        <div class="ljs-translate-status">
          <span class="ljs-translate-status__spinner"></span>
          <span class="ljs-translate-status__text">Translating…</span>
        </div>
        <div class="ljs-translate-body">
          <div class="ljs-translate-pane">
            <div class="ljs-translate-pane__title">Original <span class="ljs-translate-lang"></span></div>
            <div class="ljs-translate-pane__text ljs-translate-original"></div>
          </div>
          <div class="ljs-translate-pane">
            <div class="ljs-translate-pane__title">English</div>
            <div class="ljs-translate-pane__text ljs-translate-result"></div>
          </div>
        </div>
        <div class="ljs-translate-actions">
          <button class="ljs-translate-save" disabled>💾 Save translation with job</button>
          <button class="ljs-translate-copy" disabled>📋 Copy translation</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => closeTranslateOverlay();
    overlay.querySelector(".ljs-overlay__close").addEventListener("click", close);
    overlay.querySelector(".ljs-overlay__backdrop").addEventListener("click", close);
    const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);

    const statusEl = overlay.querySelector(".ljs-translate-status");
    const statusText = overlay.querySelector(".ljs-translate-status__text");
    const langEl = overlay.querySelector(".ljs-translate-lang");
    const resultEl = overlay.querySelector(".ljs-translate-result");
    const originalEl = overlay.querySelector(".ljs-translate-original");
    const saveBtn = overlay.querySelector(".ljs-translate-save");
    const copyBtn = overlay.querySelector(".ljs-translate-copy");

    // Show original (render paragraphs as <p> for proper visual spacing).
    originalEl.innerHTML = renderParagraphs(text);

    // Pre-fill from stored translation if present.
    try {
      const stored = await getStoredTranslation(jobId, meta);
      if (stored && stored.translationEn) {
        resultEl.innerHTML = renderParagraphs(stored.translationEn);
        langEl.textContent = "· " + langName(stored.sourceLang);
        statusEl.style.display = "none";
        saveBtn.disabled = false;
        saveBtn.textContent = "✓ Translation saved";
        copyBtn.disabled = false;
        copyBtn.textContent = "📋 Copy translation";
        // Wire save to re-persist (overwrite timestamp).
        saveBtn.onclick = async () => {
          saveBtn.disabled = true;
          await saveTranslation(jobId, stored.translationEn, stored.sourceLang);
          saveBtn.disabled = false;
          saveBtn.textContent = "✓ Translation saved";
          toast("Translation saved with job", "ok");
        };
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(stored.translationEn).then(() => {
            const o = copyBtn.textContent; copyBtn.textContent = "✓ Copied";
            setTimeout(() => (copyBtn.textContent = o), 1500);
          });
        };
        return;
      }
    } catch (e) { /* ignore — proceed to fresh translation */ }

    // Fresh translation via background SW.
    let translatedText = "";
    let sourceLang = "";
    try {
      const res = await translateViaBackground(text, "en");
      translatedText = res.translatedText;
      sourceLang = res.sourceLang;
      resultEl.innerHTML = renderParagraphs(translatedText);
      langEl.textContent = "· " + langName(sourceLang);
      statusEl.style.display = "none";
      saveBtn.disabled = false;
      copyBtn.disabled = false;
      toast("Translated from " + langName(sourceLang), "ok");
    } catch (err) {
      console.error("[LJS] translate error", err);
      statusText.textContent = "Translation failed: " + (err.message || err);
      statusEl.classList.add("ljs-translate-status--err");
      return;
    }

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      const orig = saveBtn.textContent;
      saveBtn.textContent = "Saving…";
      try {
        await saveTranslation(jobId, translatedText, sourceLang);
        saveBtn.textContent = "✓ Translation saved";
        toast("Translation saved with job", "ok");
      } catch (e) {
        console.error("[LJS] save translation error", e);
        saveBtn.textContent = orig;
        saveBtn.disabled = false;
        toast("Save error: " + (e.message || e), "err");
      }
    });

    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(translatedText).then(() => {
        const o = copyBtn.textContent; copyBtn.textContent = "✓ Copied";
        setTimeout(() => (copyBtn.textContent = o), 1500);
      });
    });
  }

  async function getStoredTranslation(jobId, meta) {
    const jobs = await storageGet(KEY_JOBS);
    if (jobs[jobId] && jobs[jobId].translationEn) {
      return { translationEn: jobs[jobId].translationEn, sourceLang: jobs[jobId].sourceLang };
    }
    // Try seen by cardFingerprint.
    const cfp = await cardFingerprint(meta.title, meta.company);
    const matches = await getAllSeenByCardFp(cfp);
    for (const e of matches) {
      if (e.translationEn) return { translationEn: e.translationEn, sourceLang: e.sourceLang };
    }
    return null;
  }

  function escInline(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  // Heuristic: detect whether text is already English.
  // Uses common English stopwords + diacritic check. If the text contains
  // a high ratio of English function words and no heavy diacritics, treat
  // it as English.
  function looksEnglish(text) {
    const t = String(text || "").toLowerCase();
    if (t.length < 20) return false;
    const englishStops = [" the ", " and ", " of ", " to ", " in ", " is ", " are ", " you ", " for ", " with ", " that ", " this ", " we ", " our ", " will ", " as ", " on ", " by "];
    let hits = 0;
    for (const w of englishStops) if (t.includes(w)) hits++;
    // Diacritics typical of German/Polish/French/etc.
    const diacritics = (t.match(/[äöüßąćęłńóśźżàâéèêëîïôûçñ]/g) || []).length;
    const ratio = hits / englishStops.length;
    return ratio >= 0.4 && diacritics < 3;
  }

  // Render multi-line text as <p> paragraphs (split on blank lines) with
  // <br> for soft line breaks within a paragraph. Gives proper visual
  // spacing between paragraphs (CSS margins) instead of relying on
  // pre-wrap rendering of "\n\n".
  function renderParagraphs(text) {
    const t = String(text || "").replace(/\r\n/g, "\n");
    const paragraphs = t.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    if (paragraphs.length === 0) return '<p class="ljs-translate-empty">(empty)</p>';
    return paragraphs.map(p => {
      const inner = escInline(p).replace(/\n/g, "<br>");
      return "<p>" + inner + "</p>";
    }).join("");
  }

  // ---------- Options overlay (full options page in an iframe) ----------
  const OVERLAY_ID = "ljs-options-overlay";

  function closeOptionsOverlay() {
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.remove();
  }

  function openOptionsOverlay() {
    if (!checkCtx()) {
      alert("LinkedIn Job Saver: extension was reloaded. Please reload this LinkedIn page to use the Options overlay.");
      return;
    }
    closeOptionsOverlay();
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "ljs-overlay";
    let optionsUrl;
    try { optionsUrl = chrome.runtime.getURL("options/options.html"); }
    catch (e) {
      alert("LinkedIn Job Saver: extension context invalidated. Please reload this LinkedIn page.");
      return;
    }
    overlay.innerHTML = `
      <div class="ljs-overlay__backdrop"></div>
      <div class="ljs-overlay__card ljs-overlay__card--full">
        <button class="ljs-overlay__close" title="Close (Esc)">✕</button>
        <iframe class="ljs-overlay__iframe" src="${optionsUrl}" title="LinkedIn Job Saver — Options"></iframe>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => closeOptionsOverlay();
    overlay.querySelector(".ljs-overlay__close").addEventListener("click", close);
    overlay.querySelector(".ljs-overlay__backdrop").addEventListener("click", close);
    const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
  }

  // ---------- Auto-registering seen jobs (detail) ----------
  let lastSeenFp = null;
  let seenTimer = null;

  async function recordSeen(meta) {
    if (!meta.descriptionText || meta.descriptionText.length < 50) return;
    try {
      const fp = await detailFingerprint(meta.title, meta.company, meta.descriptionText);
      const cfp = await cardFingerprint(meta.title, meta.company);
      if (fp === lastSeenFp) return; // already registered in this view session
      lastSeenFp = fp;
      const existing = await getSeenByFp(fp);
      const now = new Date().toISOString();
      if (existing) {
        existing.lastSeenAt = now;
        existing.seenCount = (existing.seenCount || 1) + 1;
        if (!existing.jobIds.includes(meta.jobId)) existing.jobIds.push(meta.jobId);
        // Refresh workplace/city if they were missing (e.g. description loaded since first view).
        if (!existing.workplaceType && meta.workplaceType) existing.workplaceType = meta.workplaceType;
        if (!existing.city && meta.city) existing.city = meta.city;
        if (!existing.location && meta.location) existing.location = meta.location;
        if (!existing.salary && meta.salary) existing.salary = meta.salary;
        await upsertSeen(existing);
      } else {
        await upsertSeen({
          fingerprint: fp,
          cardFingerprint: cfp,
          title: meta.title,
          company: meta.company,
          location: meta.location || "",
          workplaceType: meta.workplaceType || "",
          city: meta.city || "",
          salary: meta.salary || "",
          descriptionText: meta.descriptionText,
          descriptionHtml: meta.descriptionHtml || "",
          jobIds: [meta.jobId],
          firstSeenAt: now,
          lastSeenAt: now,
          seenCount: 1,
          status: "",
          statusSetAt: null,
        });
      }
      // After registering, show banner if repost.
      showRepostBannerIfApplicable(fp, meta);
    } catch (e) {
      console.warn("[LJS] recordSeen error", e);
    }
  }

  function scheduleRecordSeen(meta) {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => recordSeen(meta), 2000);
  }

  // ---------- Banner: repost ----------
  function showRepostBannerIfApplicable(fp, meta) {
    getSeenByFp(fp).then(existing => {
      if (!existing) return;
      // Show banner only if same content was seen under a DIFFERENT jobId before.
      const otherIds = existing.jobIds.filter(id => id !== meta.jobId);
      if (otherIds.length === 0) return;
      const firstDate = new Date(existing.firstSeenAt).toLocaleDateString("en-US");
      showDetailBanner(
        "👁 This job was already seen on " + firstDate +
        " (under jobId " + otherIds.join(", ") + "). " +
        "This is likely a repost (seenCount: " + existing.seenCount + ").",
        "repost"
      );
    }).catch(() => {});
  }

  function showDetailBanner(msg, kind) {
    let el = document.getElementById("ljs-detail-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "ljs-detail-banner";
      el.className = "ljs-detail-banner";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "ljs-detail-banner ljs-detail-banner--" + (kind || "info");
    el.style.display = "block";
  }
  function hideDetailBanner() {
    const el = document.getElementById("ljs-detail-banner");
    if (el) el.style.display = "none";
  }

  // Check whether the current detail matches an already-seen job (on button injection).
  async function checkDetailSeen(root, jobId) {
    const meta = scrapeFromDetail(root, jobId);
    if (!meta.descriptionText || meta.descriptionText.length < 50) return;
    try {
      const fp = await detailFingerprint(meta.title, meta.company, meta.descriptionText);
      const existing = await getSeenByFp(fp);
      if (existing && existing.jobIds.some(id => id !== jobId)) {
        const firstDate = new Date(existing.firstSeenAt).toLocaleDateString("en-US");
        showDetailBanner(
          "👁 This job was already seen on " + firstDate +
          " (under jobId " + existing.jobIds.filter(id => id !== jobId).join(", ") + "). " +
          "Repost (seenCount: " + existing.seenCount + ").",
          "repost"
        );
      } else {
        hideDetailBanner();
      }
    } catch {}
  }

  // ---------- Badge na kartach na liście ----------
  const CARD_BADGE_FLAG = "data-ljs-badge";

  async function injectCardBadges() {
    const cards = document.querySelectorAll('.job-card-container[data-job-id]:not([' + CARD_BADGE_FLAG + '])');
    if (cards.length === 0) return;
    // Ogranicz: tylko karty, które mają już tytuł+firma.
    const candidates = [];
    for (const card of cards) {
      const meta = scrapeFromCard(card);
      if (meta && meta.title && meta.company) candidates.push({ card, meta });
      else card.setAttribute(CARD_BADGE_FLAG, "skip"); // spróbuj później
    }
    if (candidates.length === 0) return;

    // Dla każdej karty oblicz cardFp i sprawdź w store.
    for (const { card, meta } of candidates) {
      try {
        const cfp = await cardFingerprint(meta.title, meta.company);
        const matches = await getAllSeenByCardFp(cfp);
        if (matches.length > 0) {
          // Weź najwcześniejsze firstSeenAt.
          const earliest = matches.reduce((a, b) => (a.firstSeenAt < b.firstSeenAt ? a : b));
          const days = Math.round((Date.now() - new Date(earliest.firstSeenAt).getTime()) / 86400000);
          const when = days < 1 ? "today" : days < 2 ? "yesterday" : days + " days ago";
          const repost = matches.some(m => m.jobIds.length > 1 || (m.jobIds[0] && m.jobIds[0] !== meta.jobId));
          addBadgeToCard(card, when, repost);
        }
        card.setAttribute(CARD_BADGE_FLAG, "1");
      } catch (e) {
        card.setAttribute(CARD_BADGE_FLAG, "err");
      }
    }
  }

  function addBadgeToCard(card, when, repost) {
    const host =
      card.querySelector(".job-card-list__footer-wrapper") ||
      card.querySelector(".job-card-container__footer-wrapper") ||
      card.querySelector(".artdeco-entity-lockup__caption") ||
      card.querySelector(".artdeco-entity-lockup__content") ||
      card;
    const badge = document.createElement("span");
    badge.className = "ljs-seen-badge" + (repost ? " ljs-seen-badge--repost" : "");
    badge.title = repost ? "This job was already seen under a different jobId — repost." : "This job was already seen.";
    badge.textContent = (repost ? "🔁 " : "👁 ") + when;
    host.appendChild(badge);
  }

  // ---------- Orkiestracja ----------
  let scanTimer;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAll, 300);
  }

  function scanAll() {
    const root = findDetailRoot();
    const jobId = root ? currentJobId(root) : null;
    console.log("[LJS] scanAll — root:", root ? root.className.slice(0,80) : "null", "jobId:", jobId);
    injectSaveButton();
    injectCardBadges();

    // Auto-record seen dla bieżącego detalu.
    if (root && jobId) {
      const meta = scrapeFromDetail(root, jobId);
      if (meta.descriptionText && meta.descriptionText.length > 50) {
        scheduleRecordSeen(meta);
        checkDetailSeen(root, jobId);
      }
    }
  }

  const observer = new MutationObserver(() => { if (checkCtx()) scheduleScan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Reakcja na zmianę URL (SPA).
  let lastUrl = location.href;
  setInterval(() => {
    if (!checkCtx()) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      injectedForJobId = null;
      lastSeenFp = null;
      removeButton();
      hideDetailBanner();
      scheduleScan();
    }
  }, 500);

  scanAll();
  console.log("[LJS] content script active (chrome.storage.local backend)");
})();