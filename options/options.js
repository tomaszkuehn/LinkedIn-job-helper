import {
  getAllJobs, deleteJob, saveJob, clearJobs,
  getAllSeen, deleteSeen, saveSeen, clearSeen,
} from "../lib/db.js";

let jobs = [];
let seen = [];

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

function renderSaved() {
  const q = (document.getElementById("search-saved").value || "").toLowerCase().trim();
  const filtered = q
    ? jobs.filter(j => [j.title, j.company, j.location, j.descriptionText].some(v => (v || "").toLowerCase().includes(q)))
    : jobs;
  const tbody = document.getElementById("rows-saved");
  tbody.innerHTML = "";
  for (const job of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><a href="${escAttr(job.url || "")}" target="_blank" rel="noopener">${escHtml(job.title || job.jobId)}</a></td>
      <td>${escHtml(job.company || "")}</td>
      <td>${escHtml(job.location || "")}</td>
      <td>${job.savedAt ? new Date(job.savedAt).toLocaleString("en-US") : ""}</td>
      <td><div class="desc">${escHtml((job.descriptionText || "").slice(0, 400))}${(job.descriptionText || "").length > 400 ? "…" : ""}</div></td>
      <td><button data-del-saved="${escAttr(job.jobId)}" class="danger">Usuń</button></td>
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
}

function renderSeen() {
  const q = (document.getElementById("search-seen").value || "").toLowerCase().trim();
  const filtered = q
    ? seen.filter(s => [s.title, s.company, s.descriptionText].some(v => (v || "").toLowerCase().includes(q)))
    : seen;
  const tbody = document.getElementById("rows-seen");
  tbody.innerHTML = "";
  for (const s of filtered) {
    const repost = (s.jobIds || []).length > 1;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escHtml(s.title || "(brak)")}</td>
      <td>${escHtml(s.company || "")}</td>
      <td class="${repost ? "repost" : ""}">${repost ? "🔁 repost" : "1×"} (seenCount: ${s.seenCount || 1})</td>
      <td>${s.firstSeenAt ? new Date(s.firstSeenAt).toLocaleDateString("en-US") : "?"}</td>
      <td>${s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleDateString("en-US") : "?"}</td>
      <td class="ids">${(s.jobIds || []).join(", ")}</td>
      <td><div class="desc">${escHtml((s.descriptionText || "").slice(0, 400))}${(s.descriptionText || "").length > 400 ? "…" : ""}</div></td>
      <td><button data-del-seen="${escAttr(s.fingerprint)}" class="danger">Forget</button></td>
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
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escAttr(s) { return escHtml(s); }

document.getElementById("search-saved").addEventListener("input", renderSaved);
document.getElementById("search-seen").addEventListener("input", renderSeen);

// Export JSON (saved + seen combined)
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

document.getElementById("export-seen").addEventListener("click", () => {
  const headers = ["fingerprint", "title", "company", "seenCount", "firstSeenAt", "lastSeenAt", "jobIds", "descriptionText"];
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

refresh();