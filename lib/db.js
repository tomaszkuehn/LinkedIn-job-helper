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

// ----- combined -----
export async function clearAll() {
  await clearJobs();
  await clearSeen();
  return true;
}