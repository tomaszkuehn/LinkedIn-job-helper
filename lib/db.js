// Storage backend: chrome.storage.local (extension's own storage).
// Omija partycjonowanie IndexedDB strony. Działa w content script i extension pages.
//
// Schemat:
//   ljs_jobs: { [jobId]: job }       -- zapisane oferty
//   ljs_seen: { [fingerprint]: entry } -- auto-widziane oferty

const KEY_JOBS = "ljs_jobs";
const KEY_SEEN = "ljs_seen";

function get(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (res) => resolve(res[key] || {}));
    } catch (e) {
      console.warn("[LJS] storage.get error", e);
      resolve({});
    }
  });
}
function set(key, value) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(value);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ----- fingerprinty -----
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
  // Fallback: prosty hash (FNV-1a). Wystarczy do deduplikacji.
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ("fnv:" + (h >>> 0).toString(16));
}
export async function cardFingerprint(title, company) {
  return "c:" + await sha256(normalizeText(title) + "|" + normalizeText(company));
}
export async function detailFingerprint(title, company, descriptionText) {
  return "d:" + await sha256(normalizeText(title) + "|" + normalizeText(company) + "|" + normalizeText(descriptionText));
}

// ----- jobs -----
export async function saveJob(job) {
  job.savedAt = job.savedAt || new Date().toISOString();
  const jobs = await get(KEY_JOBS);
  jobs[job.jobId] = job;
  await set(KEY_JOBS, jobs);
  return job;
}
export async function getJob(jobId) {
  const jobs = await get(KEY_JOBS);
  return jobs[jobId] || null;
}
export async function getAllJobs() {
  const jobs = await get(KEY_JOBS);
  return Object.values(jobs);
}
export async function deleteJob(jobId) {
  const jobs = await get(KEY_JOBS);
  delete jobs[jobId];
  await set(KEY_JOBS, jobs);
  return true;
}
export async function clearJobs() {
  await set(KEY_JOBS, {});
  return true;
}

// Copy a seen entry to saved jobs. If a job with the same jobId already exists
// (first jobId in seen.jobIds), it is overwritten. Returns the saved job or null
// if the seen entry wasn't found.
export async function seenToSaved(fingerprint) {
  const seen = await get(KEY_SEEN);
  const entry = seen[fingerprint];
  if (!entry) return null;
  const jobId = String((entry.jobIds || [])[0] || fingerprint);
  const job = {
    jobId,
    title: entry.title || "",
    company: entry.company || "",
    location: entry.location || "",
    workplaceType: entry.workplaceType || "",
    city: entry.city || "",
    salary: entry.salary || "",
    url: "https://www.linkedin.com/jobs/view/" + encodeURIComponent(jobId) + "/",
    descriptionHtml: entry.descriptionHtml || "",
    descriptionText: entry.descriptionText || "",
    savedAt: new Date().toISOString(),
    sourceUrl: "",
    status: entry.status || "",
    statusSetAt: entry.statusSetAt || null,
  };
  await saveJob(job);
  return job;
}

// ----- seen -----
export async function saveSeen(entry) {
  const seen = await get(KEY_SEEN);
  seen[entry.fingerprint] = entry;
  await set(KEY_SEEN, seen);
  return entry;
}
export async function getSeenByFp(fingerprint) {
  const seen = await get(KEY_SEEN);
  return seen[fingerprint] || null;
}
export async function getAllSeen() {
  const seen = await get(KEY_SEEN);
  return Object.values(seen);
}
export async function getAllSeenByCardFp(cardFingerprint) {
  const seen = await get(KEY_SEEN);
  return Object.values(seen).filter(s => s.cardFingerprint === cardFingerprint);
}
export async function deleteSeen(fingerprint) {
  const seen = await get(KEY_SEEN);
  delete seen[fingerprint];
  await set(KEY_SEEN, seen);
  return true;
}
export async function clearSeen() {
  await set(KEY_SEEN, {});
  return true;
}

// ----- status (apply / to-consider / german / ignored) -----
// Status lives on the seen entry (always present for any viewed job) and is mirrored
// on the saved job (if any). Setting "ignored" strips descriptionText/Html from the
// seen entry to save space — fingerprint + metadata are kept for repost detection.
const VALID_STATUSES = new Set(["apply", "to-consider", "german", "ignored"]);

export function isValidStatus(s) { return VALID_STATUSES.has(s); }

// ----- workplace type + city detection -----
// Returns { workplaceType: "remote"|"hybrid"|"onsite"|"", city: "" }
// Priority: location metadata → description fallback.
const WORKPLACE_PATTERNS = [
  { type: "remote",  re: /\b(fully\s+remote|100%?\s*%?\s*remote|work\s+from\s+home|wfh|remote\s+first|remote-?first|fully\s*distributed|anywhere\s+in\s+the\s+world)\b/i },
  { type: "remote",  re: /\bremote\b/i },  // generic "remote" — checked AFTER specific phrases
  { type: "hybrid",  re: /\bhybrid\b/i },
  { type: "onsite",  re: /\b(?:on[-\s]?site|in[-\s]?office|office[-\s]?based|in\s+person)\b/i },
];

const LOCATION_PREFIX_RE = /^\s*(?:location|workplace|work\s*location|based\s+in|location\s*:\s*)\s*[:\-]?\s*/i;

export function analyzeLocation(location, descriptionText) {
  let workplaceType = "";
  let city = "";

  // 1) Parse location metadata first. LinkedIn format examples:
  //    "Hamburg, Hamburg, Germany (Hybrid)"
  //    "Germany (Remote)"
  //    "Berlin, Germany · On-site"
  //    "Remote"
  //    "Hybrid"
  const loc = String(location || "").trim();
  if (loc) {
    const locLower = loc.toLowerCase();
    if (/\bremote\b/.test(locLower) && !/\bhybrid\b/.test(locLower)) workplaceType = "remote";
    else if (/\bhybrid\b/.test(locLower)) workplaceType = "hybrid";
    else if (/\bon[-\s]?site\b/.test(locLower) || /\bin[-\s]?office\b/.test(locLower)) workplaceType = "onsite";

    // City: leading part before parenthetical / · / comma before country.
    // Strip trailing "(...)" and " · ...".
    let cleaned = loc.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*·\s*.*$/, "").trim();
    // Remove trailing workplace words if any leaked.
    cleaned = cleaned.replace(/\s*(remote|hybrid|on[-\s]?site|in[-\s]?office)\b.*$/i, "").trim();
    // If cleaned contains commas, take everything except the last segment (assumed to be country).
    // "Hamburg, Hamburg, Germany" → "Hamburg, Hamburg" → take first → "Hamburg"
    // "Berlin, Germany" → "Berlin"
    // "Germany" → "" (single token = country)
    if (cleaned) {
      const parts = cleaned.split(",").map(s => s.trim()).filter(Boolean);
      if (parts.length > 1) city = parts[0];
      else if (parts.length === 1 && !/remote|hybrid|onsite|on-site/i.test(parts[0])) {
        // Single token — likely city unless it's a workplace word or obviously a country.
        // Keep simple cities; drop known country names (rough heuristic).
        const COUNTRIES = new Set(["germany", "poland", "united states", "usa", "uk", "united kingdom", "france", "netherlands", "spain", "italy", "sweden", "switzerland", "austria", "ireland", "portugal", "romania", "czech republic", "belgium", "denmark", "finland", "norway", "india", "canada"]);
        if (!COUNTRIES.has(parts[0].toLowerCase())) city = parts[0];
      }
    }
  }

  // 2) Fallback: parse description if workplaceType still empty.
  if (!workplaceType && descriptionText) {
    const desc = String(descriptionText);
    // Look for "Location:" / "Workplace:" lines first (high-confidence).
    const m = desc.match(/(?:location|workplace|work\s*location|workplace\s*type)\s*[:\-]\s*([^\n]{1,80})/i);
    if (m) {
      const line = m[1];
      if (/\bremote\b/i.test(line) && !/\bhybrid\b/i.test(line)) workplaceType = "remote";
      else if (/\bhybrid\b/i.test(line)) workplaceType = "hybrid";
      else if (/\bon[-\s]?site\b/i.test(line) || /\bin[-\s]?office\b/i.test(line)) workplaceType = "onsite";
      // City from the same line if it has commas and no workplace word alone.
      if (!city) {
        const cleanLine = line.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*(remote|hybrid|on[-\s]?site|in[-\s]?office)\b.*$/i, "").trim();
        const parts = cleanLine.split(",").map(s => s.trim()).filter(Boolean);
        if (parts.length >= 1) city = parts[0];
      }
    }
    // Generic phrases in body (lower confidence — only if still empty).
    if (!workplaceType) {
      for (const p of WORKPLACE_PATTERNS) {
        if (p.re.test(desc)) { workplaceType = p.type; break; }
      }
    }
  }

  return { workplaceType, city };
}

// ----- approximate distance between detected city and preferred city -----
// Small built-in table of common EU (mostly DE/PL) cities. If a city isn't
// found, distance is null and the banner just says "not in preferred cities".
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
  "remote": null,
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

export function cityCoords(name) {
  if (!name) return null;
  const k = String(name).trim().toLowerCase();
  return CITY_COORDS[k] || null;
}

// ----- geocoding via Nominatim (OpenStreetMap, free, no API key) -----
// Returns { lat, lon, label } or null on failure.
export async function geocodeAddress(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(q);
  try {
    const res = await fetch(url, { headers: { "Accept-Language": "en" } });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const hit = arr[0];
    return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), label: hit.display_name || q };
  } catch (e) {
    console.warn("[LJS] geocodeAddress error", e);
    return null;
  }
}

// Heuristic: does the location string contain a postcode or street address?
// Used to decide whether to geocode the job location (precise) or fall back
// to city-only coords (which we don't use for distance per user request).
// German postcode: 5 digits. PL: 5 digits (xx-xxx). Street: number after a word.
const POSTCODE_RE = /\b\d{5}\b|\b\d{2}-\d{3}\b/;
const STREET_RE = /\b(?:str\.?|straße|strasse|ave\.?|avenue|rd\.?|road|st\.?|street|pl\.?|platz|gasse|weg|allee|boulevard|ul\.?|ulica)\b[.\s]*[a-ząćęłńóśźżäöüß\-]+(?:\s+\d+|\s+\d+\s*\w)?/i;
const STREET_NUMBER_RE = /\b\d+[a-z]?\s*(?:[\/\-]\s*\d+[a-z]?)?\b\s*(?=\s|$|,)/i;

export function hasPreciseLocation(location) {
  const s = String(location || "");
  if (!s.trim()) return false;
  return POSTCODE_RE.test(s) || STREET_RE.test(s) || STREET_NUMBER_RE.test(s);
}

// haversine between two [lat, lon] pairs
export function haversineKmLatLng(a, b) {
  if (!a || !b) return null;
  return haversineKm(a, b);
}

// Parse a comma-separated string of city names into a normalised lower array.
export function parseCityList(input) {
  return String(input || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

// ----- preference evaluation (for the green/red banner in detail) -----
// workplaceType: "remote" | "hybrid" | "onsite" | ""
// city: detected city name from the listing
// preferredCities: string (comma-separated) or array
// jobCoords: [lat, lon] | null  — geocoded job location (only if precise)
// homeCoords: [lat, lon] | null  — geocoded home point
// maxDistanceKm: number
// Logic:
//   - remote → good
//   - no workplaceType → neutral
//   - no preferredCities → neutral (feature disabled)
//   - city in preferredCities → good (matches)
//   - city not in preferredCities → bad
//   - if jobCoords + homeCoords available, append distance to reason
// Returns { verdict: "good"|"bad"|"neutral", reason: string, distanceKm: number|null }
export function evaluatePreference(workplaceType, city, preferredCities, jobCoords, homeCoords, maxDistanceKm) {
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

// Ensure a seen entry exists for the given fingerprint, creating a minimal stub
// if needed (used by quick-actions when the user hasn't navigated to the detail yet).
export async function ensureSeen(fingerprint, cardFingerprint, meta) {
  const existing = await getSeenByFp(fingerprint);
  if (existing) return existing;
  const now = new Date().toISOString();
  const entry = {
    fingerprint,
    cardFingerprint,
    title: meta.title || "",
    company: meta.company || "",
    descriptionText: "",
    descriptionHtml: "",
    jobIds: meta.jobId ? [String(meta.jobId)] : [],
    firstSeenAt: now,
    lastSeenAt: now,
    seenCount: 1,
    status: "",
    statusSetAt: null,
  };
  await saveSeen(entry);
  return entry;
}

export async function setSeenStatus(fingerprint, status) {
  if (status && !VALID_STATUSES.has(status)) throw new Error("Invalid status: " + status);
  const seen = await get(KEY_SEEN);
  const entry = seen[fingerprint];
  if (!entry) return null;
  entry.status = status || "";
  entry.statusSetAt = status ? new Date().toISOString() : null;
  // "ignored" strips description to save space; any other status keeps description.
  if (status === "ignored") {
    entry.descriptionText = "";
    entry.descriptionHtml = "";
  }
  seen[fingerprint] = entry;
  await set(KEY_SEEN, seen);
  // Mirror to saved jobs if present (matched by any of entry.jobIds).
  // "ignored" removes the job from saved; other statuses update status fields.
  if (entry.jobIds && entry.jobIds.length) {
    const jobs = await get(KEY_JOBS);
    let changed = false;
    if (status === "ignored") {
      for (const jid of entry.jobIds) {
        if (jobs[jid]) { delete jobs[jid]; changed = true; }
      }
    } else {
      for (const jid of entry.jobIds) {
        if (jobs[jid]) {
          jobs[jid].status = entry.status;
          jobs[jid].statusSetAt = entry.statusSetAt;
          changed = true;
        }
      }
    }
    if (changed) await set(KEY_JOBS, jobs);
  }
  return entry;
}

export async function setJobStatus(jobId, status) {
  if (status && !VALID_STATUSES.has(status)) throw new Error("Invalid status: " + status);
  const jobs = await get(KEY_JOBS);
  const job = jobs[jobId];
  if (!job) return null;
  if (status === "ignored") {
    // "ignored" removes the job from saved; kept only in seen (without description).
    delete jobs[jobId];
    await set(KEY_JOBS, jobs);
  } else {
    job.status = status || "";
    job.statusSetAt = status ? new Date().toISOString() : null;
    jobs[jobId] = job;
    await set(KEY_JOBS, jobs);
  }
  // Mirror to seen entry if present (match by any seen entry whose jobIds includes jobId).
  const seen = await get(KEY_SEEN);
  for (const entry of Object.values(seen)) {
    if (entry.jobIds && entry.jobIds.includes(String(jobId))) {
      entry.status = status || "";
      entry.statusSetAt = status ? new Date().toISOString() : null;
      if (status === "ignored") {
        entry.descriptionText = "";
        entry.descriptionHtml = "";
      }
      seen[entry.fingerprint] = entry;
    }
  }
  await set(KEY_SEEN, seen);
  return job;
}

export async function getAllSeenByStatus(status) {
  const seen = await get(KEY_SEEN);
  return Object.values(seen).filter(s => s.status === status);
}
export async function getAllJobsByStatus(status) {
  const jobs = await get(KEY_JOBS);
  return Object.values(jobs).filter(j => j.status === status);
}

// ----- combined -----
export async function clearAll() {
  await clearJobs();
  await clearSeen();
  return true;
}