// Background service worker — auto-backup bazy do pliku + auto-prune widzianych.
//
// Mechanika:
// - chrome.storage.onChanged nasłuchuje zmian ljs_jobs / ljs_seen / ljs_settings
// - debounce 2 s (żeby nie pisać pliku przy każdej pojedynczej ofercie)
// - snapshot → JSON → chrome.downloads.download (auto, bez dialogu)
// - ustawienia w ljs_settings: { autoBackup, backupMode, seenRetentionDays, lastBackupAt, lastPruneAt }

const KEY_SETTINGS = "ljs_settings";
const KEY_JOBS = "ljs_jobs";
const KEY_SEEN = "ljs_seen";

const DEFAULT_SETTINGS = {
  autoBackup: true,
  backupMode: "overwrite",      // "overwrite" | "timestamp"
  seenRetentionDays: 90,         // 0 = wyłącz auto-prune
  homeAddress: "",                // free-text address (street / postcode / city) geocoded via Nominatim
  homeLat: null,                  // cached geocode result (latitude)
  homeLon: null,                  // cached geocode result (longitude)
  maxDistanceKm: 30,              // max acceptable haversine distance from home
  preferredCities: "",            // comma-separated list of preferred cities for onsite/hybrid
  lastBackupAt: null,
  lastBackupFile: null,
  lastBackupCount: 0,
  lastPruneAt: null,
  lastPruneCount: 0,
};

let backupTimer = null;
let pruneTimer = null;

function log(...args) { console.log("[LJS-bg]", ...args); }

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(KEY_SETTINGS, (res) => {
      resolve({ ...DEFAULT_SETTINGS, ...(res[KEY_SETTINGS] || {}) });
    });
  });
}
async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY_SETTINGS]: next }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(next);
    });
  });
}

function snapshotAll(data) {
  return {
    schema: "linkedin-job-saver",
    version: 1,
    exportedAt: new Date().toISOString(),
    saved: data[KEY_JOBS] || {},
    seen: data[KEY_SEEN] || {},
  };
}

async function doBackup() {
  const settings = await getSettings();
  if (!settings.autoBackup) return;
  try {
    const data = await new Promise((res) =>
      chrome.storage.local.get([KEY_JOBS, KEY_SEEN], res)
    );
    const payload = snapshotAll(data);
    const json = JSON.stringify(payload, null, 2);
    const savedCount = Object.keys(payload.saved).length;
    const seenCount = Object.keys(payload.seen).length;

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = settings.backupMode === "timestamp"
      ? `linkedin-jobs-backup/linkedin-jobs-${ts}.json`
      : `linkedin-jobs-backup/linkedin-jobs-latest.json`;

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({
      url,
      filename,
      conflictAction: settings.backupMode === "timestamp" ? "uniquify" : "overwrite",
      saveAs: false,
    }, (downloadId) => {
      URL.revokeObjectURL(url);
      if (chrome.runtime.lastError) {
        console.error("[LJS-bg] download error", chrome.runtime.lastError);
        return;
      }
      setSettings({
        lastBackupAt: new Date().toISOString(),
        lastBackupFile: filename,
        lastBackupCount: savedCount + seenCount,
      });
      log("backup saved:", filename, `(saved:${savedCount} seen:${seenCount})`);
    });
  } catch (e) {
    console.error("[LJS-bg] backup failed", e);
  }
}

function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(doBackup, 2000);
}

// ---------- Auto-prune widzianych ----------
// Usuwa wpisy seen starsze niż seenRetentionDays dni (po lastSeenAt).
// seenRetentionDays = 0 → wyłącz. Uruchamiane: raz przy starcie SW, potem po każdej
// zmianie ljs_seen (debounced 10 s, żeby nie robić tego przy każdym nowym odczycie).
async function doPrune() {
  const settings = await getSettings();
  const days = Number(settings.seenRetentionDays) || 0;
  if (days <= 0) return;
  try {
    const seen = await new Promise((res) =>
      chrome.storage.local.get(KEY_SEEN, (r) => res(r[KEY_SEEN] || {}))
    );
    const cutoff = Date.now() - days * 86400000;
    const keep = {};
    let removed = 0;
    for (const [fp, entry] of Object.entries(seen)) {
      const ts = entry.lastSeenAt ? new Date(entry.lastSeenAt).getTime() : 0;
      if (ts >= cutoff) keep[fp] = entry;
      else removed++;
    }
    if (removed === 0) return;
    await new Promise((res, rej) => {
      chrome.storage.local.set({ [KEY_SEEN]: keep }, () => {
        if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
        else res();
      });
    });
    await setSettings({
      lastPruneAt: new Date().toISOString(),
      lastPruneCount: removed,
    });
    log("pruned seen:", removed, "entries older than", days, "days");
  } catch (e) {
    console.error("[LJS-bg] prune failed", e);
  }
}

function schedulePrune() {
  const settings = getSettings();
  settings.then(s => {
    if ((Number(s.seenRetentionDays) || 0) <= 0) return;
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(doPrune, 10000);
  });
}

// ---------- Storage usage estimate (dla UI) ----------
async function getUsage() {
  if (!chrome.storage.local.getBytesInUse) return null;
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(bytes);
    });
  });
}

// ---------- Translation (unofficial Google Translate endpoint) ----------
// Uses translate.googleapis.com/translate_a/single?client=gtx — the same API
// that the public Google Translate website uses. No API key, no daily limit.
// Returns JSON array; we extract translated text and detected source language.
//
// Google limits ~5000 chars per request, so we chunk by paragraphs.
async function translateChunk(text, targetLang) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx"
    + "&sl=auto&tl=" + encodeURIComponent(targetLang)
    + "&dt=t&q=" + encodeURIComponent(text);
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("Translate HTTP " + res.status);
  const data = await res.json();
  // data[0] = array of [translatedChunk, originalChunk, ...] segments
  // data[2] = detected source language code (e.g. "de")
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Translate: unexpected response");
  }
  let translated = "";
  for (const seg of data[0]) {
    if (Array.isArray(seg) && typeof seg[0] === "string") translated += seg[0];
  }
  const sourceLang = (typeof data[2] === "string") ? data[2] : "";
  return { text: translated, sourceLang };
}

async function translateText(text, targetLang) {
  const MAX_CHUNK = 4500; // Google's per-request limit is ~5000 chars; keep margin.
  if (text.length <= MAX_CHUNK) return translateChunk(text, targetLang);

  // Split by blank lines into paragraphs; translate each paragraph separately
  // so we can re-insert blank-line separators in the output (Google's segment
  // response tends to collapse paragraph breaks). Long paragraphs are further
  // hard-split to stay under the per-request limit.
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  for (const p of paragraphs) {
    if (!p) continue;
    if (p.length <= MAX_CHUNK) {
      chunks.push(p);
    } else {
      // Hard-split a single long paragraph by single newlines, then by length.
      const lines = p.split(/\n/);
      let cur = "";
      for (const line of lines) {
        if ((cur + "\n" + line).length > MAX_CHUNK) {
          if (cur) chunks.push(cur);
          if (line.length > MAX_CHUNK) {
            for (let i = 0; i < line.length; i += MAX_CHUNK) {
              chunks.push(line.slice(i, i + MAX_CHUNK));
            }
            cur = "";
          } else {
            cur = line;
          }
        } else {
          cur = cur ? cur + "\n" + line : line;
        }
      }
      if (cur) chunks.push(cur);
    }
  }
  const results = await Promise.all(chunks.map(c => translateChunk(c, targetLang)));
  // Join translated paragraphs with blank line, preserving original structure.
  return {
    text: results.map(r => r.text).join("\n\n"),
    sourceLang: results[0] ? results[0].sourceLang : "",
  };
}

// Nasłuchuj zmian w storage — content script i popup/options piszą do tych samych kluczy.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEY_JOBS] || changes[KEY_SEEN]) {
    scheduleBackup();
  }
  if (changes[KEY_SEEN]) {
    schedulePrune();
  }
});

// Komendy z popup/options.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "backup-now") {
    doBackup().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "prune-now") {
    doPrune().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "get-settings") {
    getSettings().then(s => sendResponse({ ok: true, settings: s }));
    return true;
  }
  if (msg.type === "set-settings") {
    setSettings(msg.patch || {}).then(s => sendResponse({ ok: true, settings: s }));
    return true;
  }
  if (msg.type === "get-usage") {
    getUsage().then(bytes => sendResponse({ ok: true, bytes }));
    return true;
  }
  if (msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "geocode") {
    const q = String(msg.query || "").trim();
    if (!q) { sendResponse({ ok: true, coords: null }); return false; }
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(q);
    fetch(url, { headers: { "Accept-Language": "en" } })
      .then(res => res.ok ? res.json() : null)
      .then(arr => {
        if (!Array.isArray(arr) || arr.length === 0) { sendResponse({ ok: true, coords: null }); return; }
        const hit = arr[0];
        sendResponse({ ok: true, coords: [parseFloat(hit.lat), parseFloat(hit.lon)], label: hit.display_name || q });
      })
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "translate") {
    const text = String(msg.text || "");
    const target = String(msg.targetLang || "en");
    if (!text) { sendResponse({ ok: true, translatedText: "", sourceLang: "" }); return false; }
    translateText(text, target)
      .then(res => sendResponse({ ok: true, translatedText: res.text, sourceLang: res.sourceLang }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  log("installed");
  getSettings().then(s => setSettings({}));   // inicjalizuj domyślne
  doPrune();                                   // prune przy instalacji/aktualizacji
});

// Prune przy starcie SW (SW może być restartowany w czasie sesji).
doPrune();

log("sw active");