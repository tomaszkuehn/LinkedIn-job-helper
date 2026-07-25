import { getAllJobs, deleteJob, getAllSeen, deleteSeen, saveJob, saveSeen } from "../lib/db.js";

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
    ? `${jobs.length} zapisanych`
    : activeTab === "seen"
      ? `${seen.length} widzianych`
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
      ? "Brak wyników dla tego wyszukiwania."
      : activeTab === "saved"
        ? "Brak zapisanych ofert. Otwórz linkedin.com/jobs i kliknij „💾 Zapisz do bazy” w panelu detali."
        : "Brak widzianych ofert. Przeglądaj oferty na LinkedIn — zostaną zarejestrowane automatycznie.";
    return;
  }
  if (activeTab === "saved") renderSaved(filtered);
  else renderSeen(filtered);
}

function renderSaved(list) {
  for (const job of list) {
    const node = rowTpl.content.cloneNode(true);
    const title = node.querySelector(".row__title");
    title.textContent = job.title || job.jobId;
    title.href = job.url || `https://www.linkedin.com/jobs/view/${job.jobId}/`;
    node.querySelector(".row__company").textContent = job.company || "";
    node.querySelector(".row__loc").textContent = job.location || "";
    node.querySelector(".row__date").textContent = job.savedAt ? new Date(job.savedAt).toLocaleString("pl-PL") : "";
    node.querySelector(".row__desc").textContent = (job.descriptionText || "").slice(0, 300) + ((job.descriptionText || "").length > 300 ? "…" : "");
    node.querySelector(".row__copy").addEventListener("click", () => {
      const txt = [job.title, job.company, job.location, job.url, "---", job.descriptionText].filter(Boolean).join("\n");
      navigator.clipboard.writeText(txt).then(() => flash(node, "Skopiowano"), () => flash(node, "Błąd"));
    });
    node.querySelector(".row__delete").addEventListener("click", async () => {
      if (!confirm(`Usunąć ofertę „${job.title || job.jobId}”?`)) return;
      await deleteJob(job.jobId);
      await refresh();
    });
    listEl.appendChild(node);
  }
}

function renderSeen(list) {
  for (const s of list) {
    const node = seenRowTpl.content.cloneNode(true);
    node.querySelector(".row__title").textContent = s.title || "(brak tytułu)";
    node.querySelector(".row__company").textContent = s.company || "";
    const repost = (s.jobIds || []).length > 1;
    node.querySelector(".row__seen-count").textContent = "👁 " + (s.seenCount || 1) + "× widziana" + (repost ? " (ponowna publikacja!)" : "");
    node.querySelector(".row__first").textContent = "pierwszy raz: " + (s.firstSeenAt ? new Date(s.firstSeenAt).toLocaleDateString("pl-PL") : "?");
    node.querySelector(".row__last").textContent = "ostatnio: " + (s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleDateString("pl-PL") : "?");
    node.querySelector(".row__ids").textContent = "jobIds: " + (s.jobIds || []).join(", ");
    node.querySelector(".row__desc").textContent = (s.descriptionText || "").slice(0, 200) + ((s.descriptionText || "").length > 200 ? "…" : "");
    node.querySelector(".row__copy-seen").addEventListener("click", () => {
      const txt = [s.title, s.company, s.descriptionText].filter(Boolean).join("\n");
      navigator.clipboard.writeText(txt).then(() => flash(node, "Skopiowano"), () => flash(node, "Błąd"));
    });
    node.querySelector(".row__forget").addEventListener("click", async () => {
      if (!confirm(`Zapomnieć widzianą ofertę „${s.title || s.fingerprint}”?`)) return;
      await deleteSeen(s.fingerprint);
      await refresh();
    });
    listEl.appendChild(node);
  }
}

function flash(node, msg) {
  const btn = node.querySelector(".row__copy, .row__copy-seen");
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => (btn.textContent = orig), 1500);
}

searchEl.addEventListener("input", render);

document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("tab--active"));
    t.classList.add("tab--active");
    activeTab = t.getAttribute("data-tab");
    countEl.textContent = activeTab === "saved"
      ? `${jobs.length} zapisanych`
      : activeTab === "seen"
        ? `${seen.length} widzianych`
        : "Backup";
    render();
  });
});

// ----- Backup panel -----
const autoChk = document.getElementById("auto-backup");
const modeSel = document.getElementById("backup-mode");
const statusEl = document.getElementById("backup-status");
const backupNowBtn = document.getElementById("backup-now");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");

function sendMsg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refreshBackupPanel() {
  const res = await sendMsg({ type: "get-settings" });
  const s = (res && res.settings) || {};
  autoChk.checked = !!s.autoBackup;
  modeSel.value = s.backupMode || "overwrite";
  let txt = "Backup auto: <b>" + (s.autoBackup ? "WŁĄCZONY" : "wyłączony") + "</b><br>";
  txt += "Tryb: " + (s.backupMode === "timestamp" ? "kolejne pliki z timestampem" : "nadpisuj „latest.json”") + "<br>";
  if (s.lastBackupAt) {
    txt += "Ostatni backup: <b>" + new Date(s.lastBackupAt).toLocaleString("pl-PL") + "</b><br>";
    txt += "Plik: <code>" + (s.lastBackupFile || "?") + "</code><br>";
    txt += "Pozycji: " + (s.lastBackupCount || 0);
  } else {
    txt += "Brak backupu dotychczas.";
  }
  statusEl.innerHTML = txt;
}

autoChk.addEventListener("change", async () => {
  await sendMsg({ type: "set-settings", patch: { autoBackup: autoChk.checked } });
  refreshBackupPanel();
});
modeSel.addEventListener("change", async () => {
  await sendMsg({ type: "set-settings", patch: { backupMode: modeSel.value } });
  refreshBackupPanel();
});

backupNowBtn.addEventListener("click", async () => {
  backupNowBtn.disabled = true;
  backupNowBtn.textContent = "Zapisuję…";
  const res = await sendMsg({ type: "backup-now" });
  backupNowBtn.disabled = false;
  backupNowBtn.textContent = "Zrób backup teraz";
  if (res && res.ok) {
    setTimeout(refreshBackupPanel, 500); // daj czas na download
  } else {
    alert("Backup nieudany: " + (res && res.error ? res.error : "?"));
  }
});

importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm(`Wczytać plik „${file.name}”?\nZastąpi to bieżącą bazę (zapisane + widziane).`)) {
    importFile.value = "";
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    let savedArr = [];
    let seenArr = [];
    if (Array.isArray(data)) savedArr = data;                          // stary format
    else if (data && typeof data === "object") {
      if (Array.isArray(data.saved)) savedArr = data.saved;             // nowy format (array)
      else if (data.saved && typeof data.saved === "object") savedArr = Object.values(data.saved);  // format backupu (map)
      if (Array.isArray(data.seen)) seenArr = data.seen;
      else if (data.seen && typeof data.seen === "object") seenArr = Object.values(data.seen);
    }
    // UWAGA: import ZASTĘPUJE bazę — najpierw wyczyść.
    const { clearAll } = await import("../lib/db.js");
    await clearAll();
    let n = 0, m = 0;
    for (const j of savedArr) { if (j && j.jobId) { await saveJob(j); n++; } }
    for (const s of seenArr) { if (s && s.fingerprint) { await saveSeen(s); m++; } }
    alert(`Wczytano: ${n} zapisanych, ${m} widzianych.`);
    await refresh();
  } catch (err) {
    alert("Błąd wczytywania: " + err.message);
  } finally {
    importFile.value = "";
  }
});

// ----- Eksport z popup -----
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