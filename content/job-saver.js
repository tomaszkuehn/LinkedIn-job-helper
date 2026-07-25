// Content script — saving jobs + identification of already-seen jobs
// (even when re-posted with a new jobId) based on content fingerprints.
// Self-contained (MV3 content scripts nie wspierają ES import).

(function () {
  "use strict";

  // ---------- Storage: chrome.storage.local ----------
  // IndexedDB strony jest partycjonowany/blokowany przez Brave (requestStorageAccess denied).
  // chrome.storage.local to storage rozszerzenia — omija partycjonowanie strony.
  const KEY_JOBS = "ljs_jobs";
  const KEY_SEEN = "ljs_seen";
  const KEY_SETTINGS = "ljs_settings";

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (res) => resolve(res[key] || {}));
      } catch (e) {
        console.warn("[LJS] storage.get error", e);
        resolve({});
      }
    });
  }
  function storageSet(key, value) {
    return new Promise((resolve, reject) => {
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
  const VALID_STATUSES = new Set(["apply", "to-consider", "german", "ignored"]);
  const STATUS_LABELS = {
    "apply": "Apply",
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
  // Avoids repeated Nominatim hits when navigating between the same jobs.
  const geoCache = new Map();

  async function geocodeJobLocation(query) {
    const q = String(query || "").trim();
    if (!q) return null;
    if (geoCache.has(q)) return geoCache.get(q);
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(q);
    try {
      const res = await fetch(url, { headers: { "Accept-Language": "en" } });
      if (!res.ok) { geoCache.set(q, null); return null; }
      const arr = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) { geoCache.set(q, null); return null; }
      const hit = arr[0];
      const coords = [parseFloat(hit.lat), parseFloat(hit.lon)];
      geoCache.set(q, coords);
      return coords;
    } catch (e) {
      console.warn("[LJS] geocodeJobLocation error", e);
      geoCache.set(q, null);
      return null;
    }
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
    for (const jid of allJobIds) {
      if (jobs[jid]) {
        jobs[jid].status = status || "";
        jobs[jid].statusSetAt = status ? now : null;
        if (status === "ignored") {
          jobs[jid].descriptionText = "";
          jobs[jid].descriptionHtml = "";
        }
        jobsChanged = true;
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
    return (
      document.querySelector(".jobs-search__job-details--wrapper") ||
      document.querySelector(".jobs-search__job-details--container") ||
      document.querySelector(".job-view-layout") ||
      document.querySelector(".jobs-job-view-layout") ||
      (document.querySelector("#job-details") ? document.querySelector("#job-details").closest(
        ".jobs-description, .job-view-layout, .jobs-job-view-layout, .jobs-search__job-details--container, .jobs-search__job-details--wrapper"
      ) : null) ||
      null
    );
  }

  function currentJobId(root) {
    const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1];
    const active = document.querySelector(
      ".job-card-container[data-job-id].jobs-search-results-list__list-item--active, " +
      ".job-card-container[data-job-id][aria-current='page']"
    );
    if (active) return active.getAttribute("data-job-id");
    if (root) {
      const applyBtn = root.querySelector("[data-job-id]");
      if (applyBtn) return applyBtn.getAttribute("data-job-id");
    }
    const anyApply = document.querySelector(".jobs-apply-button[data-job-id], [data-live-test-job-apply-button][data-job-id]");
    if (anyApply) return anyApply.getAttribute("data-job-id");
    return null;
  }

  function scrapeFromDetail(root, jobId) {
    const titleEl = root.querySelector(
      ".job-details-jobs-unified-top-card__job-title h1, " +
      ".job-details-jobs-unified-top-card__job-title a, " +
      ".job-details-jobs-unified-top-card__job-title, " +
      "h1"
    );
    const companyEl = root.querySelector(
      ".job-details-jobs-unified-top-card__company-name a, " +
      ".job-details-jobs-unified-top-card__company-name"
    );
    const locEl = root.querySelector(
      ".job-details-jobs-unified-top-card__tertiary-description-container .tvm__text"
    );
    const descEl = root.querySelector("#job-details") ||
      root.querySelector(".jobs-description-content__text--stretch") ||
      root.querySelector(".jobs-description__content") ||
      root.querySelector("#job-view-description");

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

    return {
      jobId: String(jobId),
      title: textClean(titleEl),
      company: textClean(companyEl),
      location,
      workplaceType,
      city,
      url: "https://www.linkedin.com/jobs/view/" + jobId + "/",
      descriptionHtml: descEl ? descEl.innerHTML : "",
      descriptionText: _descText,
    };
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
    const original = btn.textContent;
    btn.textContent = "Saving…";
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
      btn.textContent = "✓ Saved";
      toast("Saved: " + (job.title || meta.jobId), "ok");
    } catch (e) {
      console.error("[LJS] save error", e);
      btn.classList.add("ljs-save-btn--err");
      btn.textContent = "Error!";
      toast("Save error: " + (e.message || e), "err");
      setTimeout(() => {
        btn.classList.remove("ljs-save-btn--err");
        btn.textContent = original;
      }, 2000);
    } finally {
      btn.disabled = false;
    }
  }

  const BTN_ID = "ljs-save-btn";
  const TOOLBAR_ID = "ljs-toolbar";
  const ACTION_BTN_CLASS = "ljs-action-btn";
  let injectedForJobId = null;

  function removeButton() {
    const t = document.getElementById(TOOLBAR_ID);
    if (t) t.remove();
    removePrefBanner();
    injectedForJobId = null;
  }

  function injectSaveButton() {
    const root = findDetailRoot();
    if (!root) { removeButton(); return; }
    const jobId = currentJobId(root);
    if (!jobId) return;
    if (injectedForJobId === String(jobId) && document.getElementById(TOOLBAR_ID)) return;
    removeButton();
    injectedForJobId = String(jobId);

    // Insert toolbar AFTER LinkedIn's action row (mt4 .display-flex with Easy Apply / Save),
    // as a separate block. We do not append into LinkedIn's button container, so the
    // original layout is preserved.
    const actionRow =
      root.querySelector(".mt4 .display-flex") ||
      root.querySelector(".job-details-jobs-unified-top-card__sticky-buttons-container") ||
      (root.querySelector("[data-live-test-job-apply-button]") ? root.querySelector("[data-live-test-job-apply-button]").closest(".mt4, .display-flex") : null);
    const anchor = actionRow && actionRow.parentElement ? actionRow.parentElement : root;

    // Toolbar container: Save button + 4 quick-action buttons.
    const toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;
    toolbar.className = "ljs-toolbar";

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "ljs-save-btn";
    btn.type = "button";
    btn.textContent = "💾 Save to DB";
    btn.title = "Save this job to the local database (LinkedIn Job Saver)";

    isAlreadySaved(jobId).then(saved => {
      if (saved) {
        btn.classList.add("ljs-save-btn--saved");
        btn.textContent = "✓ Saved";
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
    });

    toolbar.appendChild(btn);

    // Quick-action buttons.
    const ACTIONS = ["apply", "to-consider", "german", "ignored"];
    const actionBtns = {};
    for (const key of ACTIONS) {
      const ab = document.createElement("button");
      ab.type = "button";
      ab.className = ACTION_BTN_CLASS + " ljs-action-" + key;
      ab.textContent = STATUS_LABELS[key];
      ab.title = "Mark as: " + STATUS_LABELS[key] + (key === "ignored" ? " (removes description from storage)" : "");
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
        // Confirmation for "ignored" — it strips the description from storage.
        if (nextStatus === "ignored" && !confirm('Marking as "Ignore" removes the job description from storage to save space (fingerprint + metadata are kept for repost detection).\n\nContinue?')) {
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
          // ignored → only register in seen (without description); do NOT save to jobs.
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
              } else {
                toast("Description not loaded — click Save manually", "err");
              }
            }
          }
          toast(isAlready ? ("Cleared: " + STATUS_LABELS[key]) : ("Marked: " + STATUS_LABELS[key]), "ok");
        } catch (err) {
          console.error("[LJS] status error", err);
          toast("Status error: " + (err.message || err), "err");
        } finally {
          ab.disabled = false;
        }
      });
      actionBtns[key] = ab;
      toolbar.appendChild(ab);
    }

    // OPTIONS button — opens an inline overlay with extension settings.
    const optsBtn = document.createElement("button");
    optsBtn.type = "button";
    optsBtn.className = "ljs-action-btn ljs-options-btn";
    optsBtn.textContent = "⚙ Options";
    optsBtn.title = "Open extension options overlay";
    optsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openOptionsOverlay();
    });
    toolbar.appendChild(optsBtn);

    // Reflect existing status (async, may resolve after append).
    const meta0 = scrapeFromDetail(root, jobId);
    if (meta0.title || meta0.company) {
      getCurrentJobStatus(meta0).then(status => {
        if (status && actionBtns[status]) {
          actionBtns[status].classList.add(ACTION_BTN_CLASS + "--active");
        }
      }).catch(() => {});
    }

    // Insert AFTER the LinkedIn action row, as a sibling. Falls back to append at end.
    if (actionRow && actionRow.nextSibling) {
      anchor.insertBefore(toolbar, actionRow.nextSibling);
    } else if (actionRow) {
      anchor.appendChild(toolbar);
    } else {
      root.appendChild(toolbar);
    }

    // Preference banner: green if remote or (onsite/hybrid in a preferred city),
    // red if onsite/hybrid not in a preferred city, neutral/none otherwise.
    refreshPreferenceBanner(root, jobId);
  }

  const PREF_BANNER_ID = "ljs-pref-banner";

  function removePrefBanner() {
    const b = document.getElementById(PREF_BANNER_ID);
    if (b) b.remove();
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
      const banner = document.createElement("div");
      banner.id = PREF_BANNER_ID;
      banner.className = "ljs-pref-banner ljs-pref-banner--" + ev.verdict;
      const icon = ev.verdict === "good" ? "✓" : ev.verdict === "bad" ? "✗" : "•";
      banner.textContent = icon + " " + ev.reason;
      // Insert after the toolbar if present, else after the action row.
      const toolbar = document.getElementById(TOOLBAR_ID);
      const anchor = toolbar ? toolbar.parentElement : root;
      const ref = toolbar ? toolbar.nextSibling : null;
      if (ref) anchor.insertBefore(banner, ref);
      else anchor.appendChild(banner);
    }).catch((e) => console.warn("[LJS] preference banner error", e));
  }

  // ---------- Options overlay (full options page in an iframe) ----------
  const OVERLAY_ID = "ljs-options-overlay";

  function closeOptionsOverlay() {
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.remove();
  }

  function openOptionsOverlay() {
    closeOptionsOverlay();
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "ljs-overlay";
    overlay.innerHTML = `
      <div class="ljs-overlay__backdrop"></div>
      <div class="ljs-overlay__card ljs-overlay__card--full">
        <button class="ljs-overlay__close" title="Close (Esc)">✕</button>
        <iframe class="ljs-overlay__iframe" src="${chrome.runtime.getURL("options/options.html")}" title="LinkedIn Job Saver — Options"></iframe>
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
    injectSaveButton();
    injectCardBadges();

    // Auto-record seen dla bieżącego detalu.
    const root = findDetailRoot();
    const jobId = root ? currentJobId(root) : null;
    if (root && jobId) {
      const meta = scrapeFromDetail(root, jobId);
      if (meta.descriptionText && meta.descriptionText.length > 50) {
        scheduleRecordSeen(meta);
        checkDetailSeen(root, jobId);
      }
    }
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Reakcja na zmianę URL (SPA).
  let lastUrl = location.href;
  setInterval(() => {
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
  console.log("[LJS] content script active (v0.3 — chrome.storage.local backend)");
})();