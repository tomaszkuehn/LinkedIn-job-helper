// Background service worker — auto-backup bazy do pliku po każdej zmianie.
//
// Mechanika:
// - chrome.storage.onChanged nasłuchuje zmian ljs_jobs / ljs_seen / ljs_settings
// - debounce 2 s (żeby nie pisać pliku przy każdej pojedynczej ofercie)
// - snapshot → JSON → chrome.downloads.download (auto, bez dialogu)
// - ustawienia w ljs_settings: { autoBackup: bool, backupMode: "overwrite"|"timestamp", lastBackupAt }

const KEY_SETTINGS = "ljs_settings";
const KEY_JOBS = "ljs_jobs";
const KEY_SEEN = "ljs_seen";

const DEFAULT_SETTINGS = {
  autoBackup: true,
  backupMode: "overwrite",   // "overwrite" | "timestamp"
  lastBackupAt: null,
  lastBackupFile: null,
  lastBackupCount: 0,
};

let backupTimer = null;

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

// Nasłuchuj zmian w storage — content script i popup/options piszą do tych samych kluczy.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEY_JOBS] || changes[KEY_SEEN]) {
    scheduleBackup();
  }
});

// Komendy z popup/options.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "backup-now") {
    doBackup().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
  if (msg.type === "get-settings") {
    getSettings().then(s => sendResponse({ ok: true, settings: s }));
    return true;
  }
  if (msg.type === "set-settings") {
    setSettings(msg.patch || {}).then(s => sendResponse({ ok: true, settings: s }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  log("installed");
  getSettings().then(s => setSettings({}));   // inicjalizuj domyślne
});

log("sw active");