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