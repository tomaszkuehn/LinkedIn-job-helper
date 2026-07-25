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
  // Mirror to saved job if present (matched by any of entry.jobIds).
  if (entry.jobIds && entry.jobIds.length) {
    const jobs = await get(KEY_JOBS);
    let changed = false;
    for (const jid of entry.jobIds) {
      if (jobs[jid]) {
        jobs[jid].status = entry.status;
        jobs[jid].statusSetAt = entry.statusSetAt;
        if (status === "ignored") {
          jobs[jid].descriptionText = "";
          jobs[jid].descriptionHtml = "";
        }
        changed = true;
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
  job.status = status || "";
  job.statusSetAt = status ? new Date().toISOString() : null;
  if (status === "ignored") {
    job.descriptionText = "";
    job.descriptionHtml = "";
  }
  jobs[jobId] = job;
  await set(KEY_JOBS, jobs);
  // Mirror to seen entry if present (match by any seen entry whose jobIds includes jobId).
  const seen = await get(KEY_SEEN);
  for (const entry of Object.values(seen)) {
    if (entry.jobIds && entry.jobIds.includes(String(jobId))) {
      entry.status = job.status;
      entry.statusSetAt = job.statusSetAt;
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