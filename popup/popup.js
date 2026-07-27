import { getAllJobs, deleteJob, getAllSeen, deleteSeen, saveJob, saveSeen, setJobStatus, setSeenStatus, seenToSaved } from "../lib/db.js";

const listEl = document.getElementById("list");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");
const searchEl = document.getElementById("search");
const rowTpl = document.getElementById("row-tpl");
const seenRowTpl = document.getElementById("seen-row-tpl");
const savedNEl = document.getElementById("saved-n");
const seenNEl = document.getElementById("seen-n");
const toolbarList = document.getElementById("toolbar-list");
const panelBackup = document.getElementById("panel-backup");

let activeTab = "saved";
let jobs = [];
let seen = [];

async function refresh() {
  jobs = await getAllJobs();
  jobs.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  seen = await getAllSeen();
  seen.sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
  savedNEl.textContent = jobs.length;
  seenNEl.textContent = seen.length;
  countEl.textContent = activeTab === "saved"
    ? `${jobs.length} saved`
    : activeTab === "seen"
      ? `${seen.length} seen`
      : "Backup";
  render();
}

function render() {
  const isListTab = activeTab === "saved" || activeTab === "seen";
  toolbarList.style.display = isListTab ? "" : "none";
  listEl.style.display = isListTab ? "" : "none";
  panelBackup.hidden = activeTab !== "backup";
  emptyEl.hidden = true;

  if (activeTab === "backup") {
    refreshBackupPanel();
    return;
  }

  const q = (searchEl.value || "").toLowerCase().trim();
  const source = activeTab === "saved" ? jobs : seen;
  const filtered = q
    ? source.filter(j => [j.title, j.company, j.descriptionText].some(v => (v || "").toLowerCase().includes(q)))
    : source;

  listEl.innerHTML = "";
  if (filtered.length === 0) {
    emptyEl.hidden = false;
    emptyEl.textContent = q
      ? "No results match your search."
      : activeTab === "saved"
        ? "No saved jobs yet. Open linkedin.com/jobs and click \"💾 Save to DB\" in the job detail panel."
        : "No seen jobs yet. Browse jobs on LinkedIn — they will be registered automatically.";
    return;
  }
  if (activeTab === "saved") renderSaved(filtered);
  else renderSeen(filtered);
}

function renderSaved(list) {
  for (const job of list) {
    const node = rowTpl.content.cloneNode(true);
    const li = node.querySelector(".row");
    if (job.status === "german") li.classList.add("row--status-german");
    const title = node.querySelector(".row__title");
    title.textContent = job.title || job.jobId;
    title.href = job.url || `https://www.linkedin.com/jobs/view/${job.jobId}/`;
    node.querySelector(".row__company").textContent = job.company || "";
    node.querySelector(".row__loc").textContent = job.location || "";
    node.querySelector(".row__wp").textContent = formatWorkplace(job.workplaceType);
    node.querySelector(".row__salary").textContent = job.salary ? "💰 " + job.salary : "";
    node.querySelector(".row__date").textContent = job.savedAt ? new Date(job.savedAt).toLocaleString("en-US") : "";
    node.querySelector(".row__desc").textContent = (job.descriptionText || "").slice(0, 300) + ((job.descriptionText || "").length > 300 ? "…" : "");
    const translationEl = node.querySelector(".row__translation");
    if (job.translationEn) {
      const langName = LANG_NAMES[job.sourceLang] || job.sourceLang || "auto";
      translationEl.innerHTML = '<div class="row__translation-note">🌐 Translated from ' + escInline(langName) + '</div><div class="row__translation-text">' + escInline(job.translationEn.slice(0, 400) + (job.translationEn.length > 400 ? "…" : "")) + '</div>';
      translationEl.style.display = "";
    } else {
      translationEl.style.display = "none";
    }
    const statusSel = node.querySelector(".row__status");
    statusSel.value = job.status || "";
    statusSel.addEventListener("change", async () => {
      if (statusSel.value === "ignored" && !await confirmModal('Marking as "Ignore" removes the job from saved jobs and drops the description from seen storage (fingerprint + metadata are kept for repost detection).\n\nContinue?')) {
        statusSel.value = job.status || "";
        return;
      }
      try { await setJobStatus(job.jobId, statusSel.value); toast("Status updated"); }
      catch (e) { alert("Status error: " + e.message); }
    });
    node.querySelector(".row__copy").addEventListener("click", () => {
      const txt = [job.title, job.company, job.location, job.url, "---", job.descriptionText].filter(Boolean).join("\n");
      navigator.clipboard.writeText(txt).then(() => flash(node, "Copied"), () => flash(node, "Error"));
    });
    node.querySelector(".row__delete").addEventListener("click", async () => {
      if (!await confirmModal(`Delete job "${job.title || job.jobId}"?`)) return;
      await deleteJob(job.jobId);
      await refresh();
    });
    listEl.appendChild(node);
  }
}

function renderSeen(list) {
  for (const s of list) {
    const node = seenRowTpl.content.cloneNode(true);
    const li = node.querySelector(".row");
    if (s.status === "german") li.classList.add("row--status-german");
    node.querySelector(".row__title").textContent = s.title || "(untitled)";
    node.querySelector(".row__company").textContent = s.company || "";
    const repost = (s.jobIds || []).length > 1;
    node.querySelector(".row__seen-count").textContent = "👁 " + (s.seenCount || 1) + "× seen" + (repost ? " (repost!)" : "");
    node.querySelector(".row__wp").textContent = formatWorkplace(s.workplaceType);
    node.querySelector(".row__salary").textContent = s.salary ? "💰 " + s.salary : "";
    node.querySelector(".row__first").textContent = "first: " + (s.firstSeenAt ? new Date(s.firstSeenAt).toLocaleDateString("en-US") : "?");
    node.querySelector(".row__last").textContent = "last: " + (s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleDateString("en-US") : "?");
    node.querySelector(".row__ids").textContent = "jobIds: " + (s.jobIds || []).join(", ");
    node.querySelector(".row__desc").textContent = (s.descriptionText || "").slice(0, 200) + ((s.descriptionText || "").length > 200 ? "…" : "");
    const translationEl = node.querySelector(".row__translation");
    if (s.translationEn) {
      const langName = LANG_NAMES[s.sourceLang] || s.sourceLang || "auto";
      translationEl.innerHTML = '<div class="row__translation-note">🌐 Translated from ' + escInline(langName) + '</div><div class="row__translation-text">' + escInline(s.translationEn.slice(0, 400) + (s.translationEn.length > 400 ? "…" : "")) + '</div>';
      translationEl.style.display = "";
    } else {
      translationEl.style.display = "none";
    }
    const statusSel = node.querySelector(".row__status");
    statusSel.value = s.status || "";
    statusSel.addEventListener("change", async () => {
      if (statusSel.value === "ignored" && !await confirmModal('Marking as "Ignore" removes the job from saved jobs and drops the description from seen storage (fingerprint + metadata are kept for repost detection).\n\nContinue?')) {
        statusSel.value = s.status || "";
        return;
      }
      try { await setSeenStatus(s.fingerprint, statusSel.value); await refresh(); }
      catch (e) { alert("Status error: " + e.message); }
    });
    node.querySelector(".row__copy-seen").addEventListener("click", () => {
      const txt = [s.title, s.company, s.descriptionText].filter(Boolean).join("\n");
      navigator.clipboard.writeText(txt).then(() => flash(node, "Copied"), () => flash(node, "Error"));
    });
    const toSavedBtn = node.querySelector(".row__to-saved");
    toSavedBtn.addEventListener("click", async () => {
      toSavedBtn.disabled = true;
      try {
        await seenToSaved(s.fingerprint);
        toast("Copied to saved: " + (s.title || s.fingerprint));
        await refresh();
      } catch (e) {
        alert("Copy error: " + e.message);
      } finally {
        toSavedBtn.disabled = false;
      }
    });
    node.querySelector(".row__forget").addEventListener("click", async () => {
      if (!await confirmModal(`Forget seen job "${s.title || s.fingerprint}"?`)) return;
      await deleteSeen(s.fingerprint);
      await refresh();
    });
    listEl.appendChild(node);
  }
}

function flash(node, msg) {
  toast(msg);
}

function toast(msg) {
  let el = document.getElementById("ljs-popup-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "ljs-popup-toast";
    el.style.cssText = "position:fixed;bottom:8px;left:50%;transform:translateX(-50%);background:#057642;color:#fff;padding:6px 12px;border-radius:4px;font-size:12px;z-index:9999;opacity:0;transition:opacity .2s;";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.style.opacity = "0"), 1500);
}

const WP_LABELS = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };
const WP_EMOJI = { remote: "🌐", hybrid: "🔀", onsite: "🏢" };
function formatWorkplace(wp) {
  if (!wp) return "";
  return (WP_EMOJI[wp] || "") + " " + (WP_LABELS[wp] || wp);
}

const LANG_NAMES = {
  de: "German", en: "English", pl: "Polish", fr: "French", es: "Spanish",
  it: "Italian", nl: "Dutch", pt: "Portuguese", ru: "Russian", tr: "Turkish",
  uk: "Ukrainian", ro: "Romanian", cs: "Czech", sv: "Swedish", da: "Danish",
  fi: "Finnish", no: "Norwegian", ar: "Arabic", zh: "Chinese", ja: "Japanese",
  ko: "Korean", hi: "Hindi", hu: "Hungarian", el: "Greek", bg: "Bulgarian",
};
function escInline(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// Inline confirm modal — replaces window.confirm() which hangs in MV3 popups.
function confirmModal(msg) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const msgEl = document.getElementById("confirm-msg");
    const ok = document.getElementById("confirm-ok");
    const cancel = document.getElementById("confirm-cancel");
    const backdrop = modal.querySelector(".modal__backdrop");
    msgEl.textContent = msg;
    modal.hidden = false;
    const close = (result) => {
      modal.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onKey = (e) => { if (e.key === "Escape") close(false); if (e.key === "Enter") close(true); };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

searchEl.addEventListener("input", render);

document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("tab--active"));
    t.classList.add("tab--active");
    activeTab = t.getAttribute("data-tab");
    countEl.textContent = activeTab === "saved"
      ? `${jobs.length} saved`
      : activeTab === "seen"
        ? `${seen.length} seen`
        : "Backup";
    render();
  });
});

// ----- Backup panel -----
const autoChk = document.getElementById("auto-backup");
const modeSel = document.getElementById("backup-mode");
const retentionSel = document.getElementById("seen-retention");
const pruneNowBtn = document.getElementById("prune-now");
const statusEl = document.getElementById("backup-status");
const backupNowBtn = document.getElementById("backup-now");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const storageBar = document.getElementById("storage-bar");
const storageLabel = document.getElementById("storage-label");
const storageFill = document.getElementById("storage-fill");
const storageHint = document.getElementById("storage-hint");

function sendMsg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refreshBackupPanel() {
  const res = await sendMsg({ type: "get-settings" });
  const s = (res && res.settings) || {};
  autoChk.checked = !!s.autoBackup;
  modeSel.value = s.backupMode || "overwrite";
  retentionSel.value = String(s.seenRetentionDays ?? 90);
  let txt = "Auto-backup: <b>" + (s.autoBackup ? "ENABLED" : "disabled") + "</b><br>";
  txt += "Mode: " + (s.backupMode === "timestamp" ? "sequential timestamped files" : "overwrite \"latest.json\"") + "<br>";
  const rd = Number(s.seenRetentionDays) || 0;
  txt += "Seen retention: " + (rd > 0 ? rd + " days" : "off (manual only)");
  if (s.lastPruneAt && (Number(s.lastPruneCount) || 0) > 0) {
    txt += " <span style='color:#777'>— last prune: " + new Date(s.lastPruneAt).toLocaleString("en-US") + " (" + s.lastPruneCount + " removed)</span>";
  }
  txt += "<br>";
  if (s.lastBackupAt) {
    txt += "Last backup: <b>" + new Date(s.lastBackupAt).toLocaleString("en-US") + "</b><br>";
    txt += "File: <code>" + (s.lastBackupFile || "?") + "</code><br>";
    txt += "Entries: " + (s.lastBackupCount || 0);
  } else {
    txt += "No backup yet.";
  }
  statusEl.innerHTML = txt;

  // Storage usage
  const usageRes = await sendMsg({ type: "get-usage" });
  if (usageRes && usageRes.ok && usageRes.bytes != null) {
    const bytes = usageRes.bytes;
    const limit = 10 * 1024 * 1024;  // ~10 MB chrome.storage.local
    const pct = Math.min(100, (bytes / limit) * 100);
    storageLabel.textContent = "Storage: " + formatBytes(bytes) + " / ~10 MB (" + pct.toFixed(1) + "%)";
    storageFill.style.width = pct + "%";
    storageFill.className = "storage-bar__fill";
    if (pct > 85) storageFill.classList.add("storage-bar__fill--crit");
    else if (pct > 60) storageFill.classList.add("storage-bar__fill--warn");
    storageHint.textContent = pct > 85
      ? "Near quota — reduce retention window or clear old data."
      : pct > 60
        ? "Getting full — consider lowering retention."
        : "Plenty of headroom.";
    storageBar.hidden = false;
  } else {
    storageBar.hidden = true;
  }
}

function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(2) + " MB";
}

autoChk.addEventListener("change", async () => {
  await sendMsg({ type: "set-settings", patch: { autoBackup: autoChk.checked } });
  refreshBackupPanel();
});
modeSel.addEventListener("change", async () => {
  await sendMsg({ type: "set-settings", patch: { backupMode: modeSel.value } });
  refreshBackupPanel();
});
retentionSel.addEventListener("change", async () => {
  await sendMsg({ type: "set-settings", patch: { seenRetentionDays: Number(retentionSel.value) } });
  refreshBackupPanel();
});
pruneNowBtn.addEventListener("click", async () => {
  pruneNowBtn.disabled = true;
  pruneNowBtn.textContent = "Pruning…";
  const res = await sendMsg({ type: "prune-now" });
  pruneNowBtn.disabled = false;
  pruneNowBtn.textContent = "Prune now";
  if (res && res.ok) {
    await refresh();
    refreshBackupPanel();
  } else {
    alert("Prune failed: " + (res && res.error ? res.error : "?"));
  }
});

backupNowBtn.addEventListener("click", async () => {
  backupNowBtn.disabled = true;
  backupNowBtn.textContent = "Saving…";
  const res = await sendMsg({ type: "backup-now" });
  backupNowBtn.disabled = false;
  backupNowBtn.textContent = "Back up now";
  if (res && res.ok) {
    setTimeout(refreshBackupPanel, 500);
  } else {
    alert("Backup failed: " + (res && res.error ? res.error : "?"));
  }
});

importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!await confirmModal(`Load file "${file.name}"?\nThis will REPLACE the current database (saved + seen).`)) {
    importFile.value = "";
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    let savedArr = [];
    let seenArr = [];
    if (Array.isArray(data)) savedArr = data;                          // legacy format
    else if (data && typeof data === "object") {
      if (Array.isArray(data.saved)) savedArr = data.saved;             // export format (array)
      else if (data.saved && typeof data.saved === "object") savedArr = Object.values(data.saved);  // backup format (map)
      if (Array.isArray(data.seen)) seenArr = data.seen;
      else if (data.seen && typeof data.seen === "object") seenArr = Object.values(data.seen);
    }
    // NOTE: import REPLACES the database — clear first.
    const { clearAll } = await import("../lib/db.js");
    await clearAll();
    let n = 0, m = 0;
    for (const j of savedArr) { if (j && j.jobId) { await saveJob(j); n++; } }
    for (const s of seenArr) { if (s && s.fingerprint) { await saveSeen(s); m++; } }
    alert(`Loaded: ${n} saved, ${m} seen.`);
    await refresh();
  } catch (err) {
    alert("Load error: " + err.message);
  } finally {
    importFile.value = "";
  }
});

// ----- Export from popup -----
document.getElementById("export-json").addEventListener("click", () => {
  const payload = { saved: jobs, seen, exportedAt: new Date().toISOString() };
  download("linkedin-jobs.json", JSON.stringify(payload, null, 2), "application/json");
});
document.getElementById("export-csv").addEventListener("click", () => {
  const headers = ["jobId", "title", "company", "location", "url", "savedAt", "descriptionText"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const rows = [headers.join(",")];
  for (const j of jobs) rows.push(headers.map(h => esc(j[h])).join(","));
  download("linkedin-jobs.csv", "\uFEFF" + rows.join("\r\n"), "text/csv");
});
document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

refresh();