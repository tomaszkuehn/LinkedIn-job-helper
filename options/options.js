import {
  getAllJobs, deleteJob, saveJob, clearJobs,
  getAllSeen, deleteSeen, saveSeen, clearSeen,
  setJobStatus, setSeenStatus,
  geocodeAddress,
  seenToSaved,
} from "../lib/db.js";

let jobs = [];
let seen = [];

// ----- Preferred cities -----
const KEY_SETTINGS = "ljs_settings";
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(KEY_SETTINGS, (res) => resolve(res[KEY_SETTINGS] || {}));
  });
}
function setSettings(patch) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(KEY_SETTINGS, (res) => {
      const cur = res[KEY_SETTINGS] || {};
      const next = { ...cur, ...patch };
      chrome.storage.local.set({ [KEY_SETTINGS]: next }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(next);
      });
    });
  });
}

const preferredCitiesEl = document.getElementById("preferred-cities");
const homeAddressEl = document.getElementById("home-address");
const maxDistanceEl = document.getElementById("max-distance");
const saveCitiesBtn = document.getElementById("save-cities");
const citiesSavedEl = document.getElementById("cities-saved");

async function loadCities() {
  const s = await getSettings();
  preferredCitiesEl.value = s.preferredCities || "";
  homeAddressEl.value = s.homeAddress || "";
  maxDistanceEl.value = Number.isFinite(s.maxDistanceKm) ? s.maxDistanceKm : 30;
}
saveCitiesBtn.addEventListener("click", async () => {
  const preferredCities = preferredCitiesEl.value.trim();
  const homeAddress = homeAddressEl.value.trim();
  const maxDistanceKm = Math.max(0, parseInt(maxDistanceEl.value, 10) || 30);
  saveCitiesBtn.disabled = true;
  citiesSavedEl.style.color = "#777";
  citiesSavedEl.textContent = homeAddress ? "Geocoding…" : "Saving…";
  let homeLat = null, homeLon = null;
  if (homeAddress) {
    const geo = await geocodeAddress(homeAddress);
    if (!geo) {
      citiesSavedEl.style.color = "#b00020";
      citiesSavedEl.textContent = "Geocoding failed — check the address";
      saveCitiesBtn.disabled = false;
      return;
    }
    homeLat = geo.lat;
    homeLon = geo.lon;
  }
  await setSettings({ preferredCities, homeAddress, homeLat, homeLon, maxDistanceKm });
  citiesSavedEl.style.color = "#057642";
  citiesSavedEl.textContent = "Saved" + (homeLat !== null ? " (" + homeLat.toFixed(4) + ", " + homeLon.toFixed(4) + ")" : "");
  saveCitiesBtn.disabled = false;
  setTimeout(() => (citiesSavedEl.textContent = ""), 4000);
});
loadCities();

async function refresh() {
  jobs = await getAllJobs();
  jobs.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  seen = await getAllSeen();
  seen.sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
  document.getElementById("saved-count").textContent = `${jobs.length} saved jobs`;
  document.getElementById("seen-count").textContent = `${seen.length} seen jobs`;
  renderSaved();
  renderSeen();
}

const WP_LABELS_OPT = { remote: "🌐 Remote", hybrid: "🔀 Hybrid", onsite: "🏢 On-site" };

function renderSaved() {
  const q = (document.getElementById("search-saved").value || "").toLowerCase().trim();
  const sf = document.getElementById("filter-status-saved").value;
  const wpf = document.getElementById("filter-wp-saved").value;
  const filtered = jobs.filter(j => {
    if (q && ![j.title, j.company, j.location, j.descriptionText].some(v => (v || "").toLowerCase().includes(q))) return false;
    if (sf === "__none__") return !j.status;
    if (sf) return j.status === sf;
    if (wpf === "__none__") return !j.workplaceType;
    if (wpf) return j.workplaceType === wpf;
    return true;
  });
  const tbody = document.getElementById("rows-saved");
  tbody.innerHTML = "";
  for (const job of filtered) {
    const tr = document.createElement("tr");
    if (job.status === "german") tr.classList.add("row-status-german");
    tr.innerHTML = `
      <td><a href="${escAttr(job.url || "")}" target="_blank" rel="noopener">${escHtml(job.title || job.jobId)}</a></td>
      <td>${escHtml(job.company || "")}</td>
      <td>${escHtml(job.location || "")}</td>
      <td>${escHtml(WP_LABELS_OPT[job.workplaceType] || "—")}</td>
      <td>${escHtml(job.salary || "—")}</td>
      <td>
        <select data-job-status="${escAttr(job.jobId)}" style="padding:4px;border:1px solid #ccc;border-radius:4px;font:inherit;">
          <option value=""${!job.status ? " selected" : ""}>—</option>
          <option value="apply"${job.status === "apply" ? " selected" : ""}>Apply</option>
          <option value="applied"${job.status === "applied" ? " selected" : ""}>Applied</option>
          <option value="to-consider"${job.status === "to-consider" ? " selected" : ""}>Consider</option>
          <option value="german"${job.status === "german" ? " selected" : ""}>German</option>
          <option value="ignored"${job.status === "ignored" ? " selected" : ""}>Ignore</option>
        </select>
      </td>
      <td>${job.savedAt ? new Date(job.savedAt).toLocaleString("en-US") : ""}</td>
      <td>${descLabel(job.descriptionText)}</td>
      <td>
        <span class="icon-group">
          <button data-view-saved="${escAttr(job.jobId)}" class="icon-btn icon-btn--view" title="View">👁</button>
          <button data-copy-saved="${escAttr(job.jobId)}" class="icon-btn icon-btn--copy" title="Copy content">📋</button>
          <button data-del-saved="${escAttr(job.jobId)}" class="icon-btn icon-btn--delete" title="Delete">🗑</button>
        </span>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-del-saved]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del-saved");
      if (!confirm("Delete this job?")) return;
      await deleteJob(id);
      await refresh();
    });
  });
  tbody.querySelectorAll("[data-view-saved]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-view-saved");
      const job = jobs.find(j => String(j.jobId) === String(id));
      if (job) showPreview(job, "saved");
    });
  });
  tbody.querySelectorAll("[data-copy-saved]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-copy-saved");
      const job = jobs.find(j => String(j.jobId) === String(id));
      if (!job) return;
      const txt = [job.title, job.company, job.location, job.url, "---", job.descriptionText].filter(Boolean).join("\n");
      navigator.clipboard.writeText(txt).then(() => {
        const orig = btn.textContent;
        btn.textContent = "✓";
        setTimeout(() => (btn.textContent = orig), 1200);
      });
    });
  });
  tbody.querySelectorAll("[data-job-status]").forEach(sel => {
    sel.addEventListener("change", async () => {
      const id = sel.getAttribute("data-job-status");
      const job = jobs.find(j => String(j.jobId) === String(id));
      if (sel.value === "ignored" && !confirm('Marking as "Ignore" removes the job from saved jobs and drops the description from seen storage (fingerprint + metadata are kept for repost detection).\n\nContinue?')) {
        sel.value = (job && job.status) || "";
        return;
      }
      try { await setJobStatus(id, sel.value); await refresh(); }
      catch (e) { alert("Status error: " + e.message); }
    });
  });
}

function renderSeen() {
  const q = (document.getElementById("search-seen").value || "").toLowerCase().trim();
  const sf = document.getElementById("filter-status-seen").value;
  const wpf = document.getElementById("filter-wp-seen").value;
  const filtered = seen.filter(s => {
    if (q && ![s.title, s.company, s.location, s.descriptionText].some(v => (v || "").toLowerCase().includes(q))) return false;
    if (sf === "__none__") return !s.status;
    if (sf) return s.status === sf;
    if (wpf === "__none__") return !s.workplaceType;
    if (wpf) return s.workplaceType === wpf;
    return true;
  });
  const tbody = document.getElementById("rows-seen");
  tbody.innerHTML = "";
  for (const s of filtered) {
    const repost = (s.jobIds || []).length > 1;
    const ignored = s.status === "ignored";
    const tr = document.createElement("tr");
    if (s.status === "german") tr.classList.add("row-status-german");
    tr.innerHTML = `
      <td>${escHtml(s.title || "(untitled)")}</td>
      <td>${escHtml(s.company || "")}</td>
      <td>${escHtml(WP_LABELS_OPT[s.workplaceType] || "—")}</td>
      <td>${escHtml(s.salary || "—")}</td>
      <td class="${repost ? "repost" : ""}">${repost ? "🔁 repost" : "1×"} (seenCount: ${s.seenCount || 1})</td>
      <td>
        <select data-seen-status="${escAttr(s.fingerprint)}" style="padding:4px;border:1px solid #ccc;border-radius:4px;font:inherit;">
          <option value=""${!s.status ? " selected" : ""}>—</option>
          <option value="apply"${s.status === "apply" ? " selected" : ""}>Apply</option>
          <option value="applied"${s.status === "applied" ? " selected" : ""}>Applied</option>
          <option value="to-consider"${s.status === "to-consider" ? " selected" : ""}>Consider</option>
          <option value="german"${s.status === "german" ? " selected" : ""}>German</option>
          <option value="ignored"${s.status === "ignored" ? " selected" : ""}>Ignore</option>
        </select>
        ${ignored ? "<span style='color:#999;font-size:11px'> (desc dropped)</span>" : ""}
      </td>
      <td>${s.firstSeenAt ? new Date(s.firstSeenAt).toLocaleDateString("en-US") : "?"}</td>
      <td>${s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleDateString("en-US") : "?"}</td>
      <td class="ids">${(s.jobIds || []).join(", ")}</td>
      <td>${descLabel(s.descriptionText)}</td>
      <td>
        <span class="icon-group">
          <button data-view-seen="${escAttr(s.fingerprint)}" class="icon-btn icon-btn--view" title="View">👁</button>
          <button data-copy-seen="${escAttr(s.fingerprint)}" class="icon-btn icon-btn--copy" title="Copy content">📋</button>
          <button data-to-saved="${escAttr(s.fingerprint)}" class="icon-btn icon-btn--copy" title="Copy to saved">↳</button>
          <button data-del-seen="${escAttr(s.fingerprint)}" class="icon-btn icon-btn--delete" title="Forget">🗑</button>
        </span>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-del-seen]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const fp = btn.getAttribute("data-del-seen");
      if (!confirm("Forget this seen job?")) return;
      await deleteSeen(fp);
      await refresh();
    });
  });
  tbody.querySelectorAll("[data-view-seen]").forEach(btn => {
    btn.addEventListener("click", () => {
      const fp = btn.getAttribute("data-view-seen");
      const s = seen.find(x => x.fingerprint === fp);
      if (s) showPreview(s, "seen");
    });
  });
  tbody.querySelectorAll("[data-copy-seen]").forEach(btn => {
    btn.addEventListener("click", () => {
      const fp = btn.getAttribute("data-copy-seen");
      const s = seen.find(x => x.fingerprint === fp);
      if (!s) return;
      const url = s.url || (s.jobIds && s.jobIds.length ? "https://www.linkedin.com/jobs/view/" + s.jobIds[0] + "/" : "");
      const txt = [s.title, s.company, s.location, url, "---", s.descriptionText].filter(Boolean).join("\n");
      navigator.clipboard.writeText(txt).then(() => {
        const orig = btn.textContent;
        btn.textContent = "✓";
        setTimeout(() => (btn.textContent = orig), 1200);
      });
    });
  });
  tbody.querySelectorAll("[data-to-saved]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const fp = btn.getAttribute("data-to-saved");
      btn.disabled = true;
      try {
        const job = await seenToSaved(fp);
        if (!job) { alert("Seen entry not found"); return; }
        await refresh();
      } catch (e) {
        alert("Copy error: " + e.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
  tbody.querySelectorAll("[data-seen-status]").forEach(sel => {
    sel.addEventListener("change", async () => {
      const fp = sel.getAttribute("data-seen-status");
      const s = seen.find(x => x.fingerprint === fp);
      if (sel.value === "ignored" && !confirm('Marking as "Ignore" removes the job from saved jobs and drops the description from seen storage (fingerprint + metadata are kept for repost detection).\n\nContinue?')) {
        sel.value = (s && s.status) || "";
        return;
      }
      try { await setSeenStatus(fp, sel.value); await refresh(); }
      catch (e) { alert("Status error: " + e.message); }
    });
  });
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escAttr(s) { return escHtml(s); }

// Compact description indicator: full / short / none.
function descLabel(text) {
  const len = (text || "").length;
  if (!len) return '<span style="color:#999">none</span>';
  if (len < 200) return '<span style="color:#915907">short</span>';
  return '<span style="color:#057642">full</span>';
}

document.getElementById("search-saved").addEventListener("input", renderSaved);
document.getElementById("search-seen").addEventListener("input", renderSeen);
document.getElementById("filter-status-saved").addEventListener("change", renderSaved);
document.getElementById("filter-status-seen").addEventListener("change", renderSeen);
document.getElementById("filter-wp-saved").addEventListener("change", renderSaved);
document.getElementById("filter-wp-seen").addEventListener("change", renderSeen);

// Export JSON (saved + seen combined)
document.getElementById("export-json").addEventListener("click", () => {
  const payload = { saved: jobs, seen, exportedAt: new Date().toISOString() };
  download("linkedin-jobs.json", JSON.stringify(payload, null, 2), "application/json");
});

document.getElementById("export-csv").addEventListener("click", () => {
  const headers = ["jobId", "title", "company", "location", "workplaceType", "url", "status", "savedAt", "descriptionText"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const rows = [headers.join(",")];
  for (const j of jobs) rows.push(headers.map(h => esc(j[h])).join(","));
  download("linkedin-jobs.csv", "\uFEFF" + rows.join("\r\n"), "text/csv");
});

document.getElementById("export-seen").addEventListener("click", () => {
  const headers = ["fingerprint", "title", "company", "location", "workplaceType", "seenCount", "status", "firstSeenAt", "lastSeenAt", "jobIds", "descriptionText"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const rows = [headers.join(",")];
  for (const s of seen) {
    rows.push(headers.map(h => esc(h === "jobIds" ? (s.jobIds || []).join("|") : s[h])).join(","));
  }
  download("linkedin-seen.csv", "\uFEFF" + rows.join("\r\n"), "text/csv");
});

// Import JSON (handles both legacy format [array] and new {saved, seen})
document.getElementById("import-json").addEventListener("click", () => {
  document.getElementById("import-file").click();
});
document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); }
  catch { alert("Invalid JSON"); return; }

  let savedArr = [];
  let seenArr = [];
  if (Array.isArray(data)) savedArr = data;
  else if (data && typeof data === "object") {
    if (Array.isArray(data.saved)) savedArr = data.saved;
    if (Array.isArray(data.seen)) seenArr = data.seen;
  }

  let n = 0;
  for (const j of savedArr) {
    if (!j || !j.jobId) continue;
    await saveJob(j);
    n++;
  }
  let m = 0;
  for (const s of seenArr) {
    if (!s || !s.fingerprint) continue;
    await saveSeen(s);
    m++;
  }
  alert(`Imported: ${n} saved, ${m} seen.`);
  await refresh();
});

document.getElementById("clear-saved").addEventListener("click", async () => {
  if (!confirm(`Delete ALL ${jobs.length} saved jobs?`)) return;
  await clearJobs();
  await refresh();
});
document.getElementById("clear-seen").addEventListener("click", async () => {
  if (!confirm(`Delete ALL ${seen.length} seen jobs?`)) return;
  await clearSeen();
  await refresh();
});

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Job preview modal ----------
const STATUS_LABELS_FULL = {
  "apply": "Apply",
  "applied": "Applied",
  "to-consider": "Consider",
  "german": "German",
  "ignored": "Ignored",
};

const previewModal = document.getElementById("preview-modal");
const previewContent = document.getElementById("preview-content");
const previewClose = document.getElementById("preview-close");

const LANG_NAMES_OPT = {
  de: "German", en: "English", pl: "Polish", fr: "French", es: "Spanish",
  it: "Italian", nl: "Dutch", pt: "Portuguese", ru: "Russian", tr: "Turkish",
  uk: "Ukrainian", ro: "Romanian", cs: "Czech", sv: "Swedish", da: "Danish",
  fi: "Finnish", no: "Norwegian", ar: "Arabic", zh: "Chinese", ja: "Japanese",
  ko: "Korean", hi: "Hindi", hu: "Hungarian", el: "Greek", bg: "Bulgarian",
};
function langNameOpt(code) { return LANG_NAMES_OPT[code] || code || "auto"; }

function showPreview(job, kind) {
  const status = job.status || "";
  const statusLabel = status ? STATUS_LABELS_FULL[status] || status : "—";
  const dateLabel = kind === "saved"
    ? (job.savedAt ? "Saved: " + new Date(job.savedAt).toLocaleString("en-US") : "")
    : (job.firstSeenAt ? "First seen: " + new Date(job.firstSeenAt).toLocaleDateString("en-US") : "")
      + (job.lastSeenAt ? " · Last seen: " + new Date(job.lastSeenAt).toLocaleDateString("en-US") : "");
  const url = job.url || (job.jobIds && job.jobIds.length ? "https://www.linkedin.com/jobs/view/" + job.jobIds[0] + "/" : "");
  const desc = job.descriptionHtml || "";
  const descText = job.descriptionText || "";

  previewContent.innerHTML = `
    <h2 class="pv-title">${escHtml(job.title || (kind === "seen" ? "(untitled)" : job.jobId))}</h2>
    <div class="pv-company">${escHtml(job.company || "")}</div>
    <div class="pv-meta">
      ${job.location ? "<span>📍 " + escHtml(job.location) + "</span>" : ""}
      ${job.workplaceType ? "<span>" + escHtml(WP_LABELS_OPT[job.workplaceType] || job.workplaceType) + "</span>" : ""}
      ${job.salary ? "<span>💰 " + escHtml(job.salary) + "</span>" : ""}
      <span class="pv-status pv-status--${escAttr(status || "none")}">Status: ${escHtml(statusLabel)}</span>
      ${dateLabel ? "<span>" + escHtml(dateLabel) + "</span>" : ""}
      ${kind === "seen" && job.seenCount ? "<span>Seen " + job.seenCount + "×</span>" : ""}
      ${kind === "seen" && (job.jobIds || []).length > 1 ? "<span class='repost'>🔁 repost</span>" : ""}
    </div>
    ${url ? "<div class='pv-url'><a href='" + escAttr(url) + "' target='_blank' rel='noopener'>Open on LinkedIn ↗</a></div>" : ""}
    <div class="pv-toolbar">
      <button id="pv-copy">Copy content</button>
      <button id="pv-copy-text" class="ghost">Copy as plain text</button>
    </div>
    <div class="pv-desc">${desc ? desc : (descText ? "<pre style='white-space:pre-wrap;font:inherit;margin:0'>" + escHtml(descText) + "</pre>" : "<p class='pv-empty'>No description stored for this job.</p>")}</div>
    ${job.translationEn ? '<div class="pv-translation-note">🌐 Translated from ' + escHtml(langNameOpt(job.sourceLang)) + ' (saved ' + (job.translatedAt ? new Date(job.translatedAt).toLocaleDateString("en-US") : "") + ')</div><div class="pv-translation">' + escHtml(job.translationEn) + '</div>' : ""}
  `;

  const copyBtn = document.getElementById("pv-copy");
  const copyTextBtn = document.getElementById("pv-copy-text");
  if (copyBtn) copyBtn.addEventListener("click", () => {
    const txt = [job.title, job.company, job.location, url, "---", descText].filter(Boolean).join("\n");
    navigator.clipboard.writeText(txt).then(() => { copyBtn.textContent = "Copied"; setTimeout(() => (copyBtn.textContent = "Copy content"), 1500); });
  });
  if (copyTextBtn) copyTextBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(descText || "").then(() => { copyTextBtn.textContent = "Copied"; setTimeout(() => (copyTextBtn.textContent = "Copy as plain text"), 1500); });
  });

  previewModal.hidden = false;
}

function hidePreview() { previewModal.hidden = true; previewContent.innerHTML = ""; }
previewClose.addEventListener("click", hidePreview);
previewModal.querySelector(".modal__backdrop").addEventListener("click", hidePreview);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !previewModal.hidden) hidePreview(); });

refresh();