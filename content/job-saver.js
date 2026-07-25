// Content script — saving jobs + identification of already-seen jobs
// (even when re-posted with a new jobId) based on content fingerprints.
// Self-contained (MV3 content scripts nie wspierają ES import).

(function () {
  "use strict";

  // ---------- Storage: chrome.storage.local ----------
  // IndexedDB strony jest partycjonowany/blokowany przez Brave (requestStorageAccess denied).
  // chrome.storage.local to storage rozszerzenia — omija partycjonowanie strony.
  const KEY_JOBS = "ljs_jobs";
  const KEY_SEEN = "ljs_seen";

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (res) => resolve(res[key] || {}));
      } catch (e) {
        console.warn("[LJS] storage.get error", e);
        resolve({});
      }
    });
  }
  function storageSet(key, value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(value);
        });
      } catch (e) { reject(e); }
    });
  }

  async function saveJob(job) {
    job.savedAt = job.savedAt || new Date().toISOString();
    const jobs = await storageGet(KEY_JOBS);
    jobs[job.jobId] = job;
    await storageSet(KEY_JOBS, jobs);
    return job;
  }
  async function getJob(jobId) {
    const jobs = await storageGet(KEY_JOBS);
    return jobs[jobId] || null;
  }
  async function upsertSeen(entry) {
    const seen = await storageGet(KEY_SEEN);
    seen[entry.fingerprint] = entry;
    await storageSet(KEY_SEEN, seen);
    return entry;
  }
  async function getSeenByFp(fingerprint) {
    const seen = await storageGet(KEY_SEEN);
    return seen[fingerprint] || null;
  }
  async function getAllSeenByCardFp(cardFingerprint) {
    const seen = await storageGet(KEY_SEEN);
    return Object.values(seen).filter(s => s.cardFingerprint === cardFingerprint);
  }

  // ---------- Status (apply / to-consider / german / ignored) ----------
  const VALID_STATUSES = new Set(["apply", "to-consider", "german", "ignored"]);
  const STATUS_LABELS = {
    "apply": "Apply",
    "to-consider": "Consider",
    "german": "German",
    "ignored": "Ignore",
  };

  // ---------- Workplace type + city detection (inline copy of lib/db.js) ----------
  const WORKPLACE_PATTERNS = [
    { type: "remote", re: /\b(fully\s+remote|100%?\s*%?\s*remote|work\s+from\s+home|wfh|remote\s+first|remote-?first|fully\s*distributed|anywhere\s+in\s+the\s+world)\b/i },
    { type: "remote", re: /\bremote\b/i },
    { type: "hybrid", re: /\bhybrid\b/i },
    { type: "onsite", re: /\b(?:on[-\s]?site|in[-\s]?office|office[-\s]?based|in\s+person)\b/i },
  ];
  const COUNTRIES_SET = new Set(["germany", "poland", "united states", "usa", "uk", "united kingdom", "france", "netherlands", "spain", "italy", "sweden", "switzerland", "austria", "ireland", "portugal", "romania", "czech republic", "belgium", "denmark", "finland", "norway", "india", "canada"]);

  function analyzeLocation(location, descriptionText) {
    let workplaceType = "";
    let city = "";
    const loc = String(location || "").trim();
    if (loc) {
      const locLower = loc.toLowerCase();
      if (/\bremote\b/.test(locLower) && !/\bhybrid\b/.test(locLower)) workplaceType = "remote";
      else if (/\bhybrid\b/.test(locLower)) workplaceType = "hybrid";
      else if (/\bon[-\s]?site\b/.test(locLower) || /\bin[-\s]?office\b/.test(locLower)) workplaceType = "onsite";
      let cleaned = loc.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*·\s*.*$/, "").trim();
      cleaned = cleaned.replace(/\s*(remote|hybrid|on[-\s]?site|in[-\s]?office)\b.*$/i, "").trim();
      if (cleaned) {
        const parts = cleaned.split(",").map(s => s.trim()).filter(Boolean);
        if (parts.length > 1) city = parts[0];
        else if (parts.length === 1 && !/remote|hybrid|onsite|on-site/i.test(parts[0])) {
          if (!COUNTRIES_SET.has(parts[0].toLowerCase())) city = parts[0];
        }
      }
    }
    if (!workplaceType && descriptionText) {
      const desc = String(descriptionText);
      const m = desc.match(/(?:location|workplace|work\s*location|workplace\s*type)\s*[:\-]\s*([^\n]{1,80})/i);
      if (m) {
        const line = m[1];
        if (/\bremote\b/i.test(line) && !/\bhybrid\b/i.test(line)) workplaceType = "remote";
        else if (/\bhybrid\b/i.test(line)) workplaceType = "hybrid";
        else if (/\bon[-\s]?site\b/i.test(line) || /\bin[-\s]?office\b/i.test(line)) workplaceType = "onsite";
        if (!city) {
          const cleanLine = line.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*(remote|hybrid|on[-\s]?site|in[-\s]?office)\b.*$/i, "").trim();
          const parts = cleanLine.split(",").map(s => s.trim()).filter(Boolean);
          if (parts.length >= 1) city = parts[0];
        }
      }
      if (!workplaceType) {
        for (const p of WORKPLACE_PATTERNS) {
          if (p.re.test(desc)) { workplaceType = p.type; break; }
        }
      }
    }
    return { workplaceType, city };
  }

  // Compute detailFingerprint for current detail, get/create seen entry, set status.
  // Status lookup/match uses cardFingerprint (title+company) so it's stable whether
  // or not the description has loaded yet — detailFingerprint depends on descriptionText
  // and would produce different keys before vs after the description renders.
  async function setCurrentJobStatus(meta, status) {
    if (status && !VALID_STATUSES.has(status)) throw new Error("Invalid status: " + status);
    const cfp = await cardFingerprint(meta.title, meta.company);
    const fp = meta.descriptionText
      ? await detailFingerprint(meta.title, meta.company, meta.descriptionText)
      : null;
    const seen = await storageGet(KEY_SEEN);
    const now = new Date().toISOString();

    // Apply status to: (a) the detail entry if it exists/gets created, and
    // (b) any other seen entries sharing the same cardFingerprint (e.g. previous
    // view before description loaded, or older repost entries).
    const matches = Object.values(seen).filter(e => e.cardFingerprint === cfp);
    let entry = fp ? seen[fp] : null;
    if (fp && !entry) {
      entry = {
        fingerprint: fp,
        cardFingerprint: cfp,
        title: meta.title || "",
        company: meta.company || "",
        location: meta.location || "",
        workplaceType: meta.workplaceType || "",
        city: meta.city || "",
        descriptionText: meta.descriptionText || "",
        descriptionHtml: meta.descriptionHtml || "",
        jobIds: [String(meta.jobId)],
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
        status: "",
        statusSetAt: null,
      };
      seen[fp] = entry;
      matches.push(entry);
    }

    // Apply status to all matching entries (including the detail entry).
    for (const e of matches) {
      e.status = status || "";
      e.statusSetAt = status ? now : null;
      if (status === "ignored") {
        e.descriptionText = "";
        e.descriptionHtml = "";
      }
      seen[e.fingerprint] = e;
    }

    await storageSet(KEY_SEEN, seen);

    // Mirror to saved jobs if present — match by any jobId across all matching entries.
    const allJobIds = new Set();
    for (const e of matches) for (const jid of (e.jobIds || [])) allJobIds.add(String(jid));
    const jobs = await storageGet(KEY_JOBS);
    let jobsChanged = false;
    for (const jid of allJobIds) {
      if (jobs[jid]) {
        jobs[jid].status = status || "";
        jobs[jid].statusSetAt = status ? now : null;
        if (status === "ignored") {
          jobs[jid].descriptionText = "";
          jobs[jid].descriptionHtml = "";
        }
        jobsChanged = true;
      }
    }
    if (jobsChanged) await storageSet(KEY_JOBS, jobs);
    return entry || (matches[0] || null);
  }

  async function getCurrentJobStatus(meta) {
    // Always look up by cardFingerprint — works whether description loaded or not.
    const cfp = await cardFingerprint(meta.title, meta.company);
    const matches = await getAllSeenByCardFp(cfp);
    if (matches.length) return matches[0].status || "";
    return "";
  }

  // ---------- Fingerprinty ----------
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
    // Fallback FNV-1a (gdy crypto.subtle niedostępny).
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return "fnv:" + (h >>> 0).toString(16);
  }

  async function cardFingerprint(title, company) {
    return "c:" + await sha256(normalizeText(title) + "|" + normalizeText(company));
  }
  async function detailFingerprint(title, company, descriptionText) {
    return "d:" + await sha256(normalizeText(title) + "|" + normalizeText(company) + "|" + normalizeText(descriptionText));
  }

  // ---------- Scrapowanie ----------
  function textClean(el) {
    return (el && el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findDetailRoot() {
    return (
      document.querySelector(".jobs-search__job-details--wrapper") ||
      document.querySelector(".jobs-search__job-details--container") ||
      document.querySelector(".job-view-layout") ||
      document.querySelector(".jobs-job-view-layout") ||
      (document.querySelector("#job-details") ? document.querySelector("#job-details").closest(
        ".jobs-description, .job-view-layout, .jobs-job-view-layout, .jobs-search__job-details--container, .jobs-search__job-details--wrapper"
      ) : null) ||
      null
    );
  }

  function currentJobId(root) {
    const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1];
    const active = document.querySelector(
      ".job-card-container[data-job-id].jobs-search-results-list__list-item--active, " +
      ".job-card-container[data-job-id][aria-current='page']"
    );
    if (active) return active.getAttribute("data-job-id");
    if (root) {
      const applyBtn = root.querySelector("[data-job-id]");
      if (applyBtn) return applyBtn.getAttribute("data-job-id");
    }
    const anyApply = document.querySelector(".jobs-apply-button[data-job-id], [data-live-test-job-apply-button][data-job-id]");
    if (anyApply) return anyApply.getAttribute("data-job-id");
    return null;
  }

  function scrapeFromDetail(root, jobId) {
    const titleEl = root.querySelector(
      ".job-details-jobs-unified-top-card__job-title h1, " +
      ".job-details-jobs-unified-top-card__job-title a, " +
      ".job-details-jobs-unified-top-card__job-title, " +
      "h1"
    );
    const companyEl = root.querySelector(
      ".job-details-jobs-unified-top-card__company-name a, " +
      ".job-details-jobs-unified-top-card__company-name"
    );
    const locEl = root.querySelector(
      ".job-details-jobs-unified-top-card__tertiary-description-container .tvm__text"
    );
    const descEl = root.querySelector("#job-details") ||
      root.querySelector(".jobs-description-content__text--stretch") ||
      root.querySelector(".jobs-description__content") ||
      root.querySelector("#job-view-description");
    const _location = textClean(locEl);
    const _descText = descEl ? descEl.innerText : "";
    const _wa = analyzeLocation(_location, _descText);
    return {
      jobId: String(jobId),
      title: textClean(titleEl),
      company: textClean(companyEl),
      location: _location,
      workplaceType: _wa.workplaceType,
      city: _wa.city,
      url: "https://www.linkedin.com/jobs/view/" + jobId + "/",
      descriptionHtml: descEl ? descEl.innerHTML : "",
      descriptionText: _descText,
    };
  }

  // Scraping card metadata from the list (for the "seen" badge).
  function scrapeFromCard(card) {
    const jobId = card.getAttribute("data-job-id");
    if (!jobId) return null;
    const titleEl = card.querySelector(".job-card-list__title--link, .artdeco-entity-lockup__title a, .artdeco-entity-lockup__title strong");
    const companyEl = card.querySelector(".artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .job-card-container__company-name");
    return {
      jobId: String(jobId),
      title: textClean(titleEl),
      company: textClean(companyEl),
    };
  }

  // ---------- UI: toast ----------
  function toast(msg, kind) {
    let el = document.getElementById("ljs-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ljs-toast";
      el.className = "ljs-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "ljs-toast ljs-toast--" + (kind || "info");
    requestAnimationFrame(() => el.classList.add("ljs-toast--show"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("ljs-toast--show"), 2600);
  }

  // ---------- UI: przycisk zapisu w detalu ----------
  async function isAlreadySaved(jobId) {
    try { return !!(await getJob(jobId)); }
    catch (e) { console.warn("[LJS] isAlreadySaved error", e); return false; }
  }

  async function handleSave(btn, meta) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Saving…";
    try {
      if (!meta.descriptionHtml) {
        await new Promise(r => setTimeout(r, 600));
        const root = findDetailRoot();
        if (root) {
          const descEl = root.querySelector("#job-details, .jobs-description__content, #job-view-description");
          if (descEl) {
            meta.descriptionHtml = descEl.innerHTML;
            meta.descriptionText = descEl.innerText;
          }
        }
      }
      // Preserve existing status if job already in DB (e.g. user marked Apply then clicked Save).
      const existing = await getJob(meta.jobId);
      let status = (existing && existing.status) || "";
      let statusSetAt = (existing && existing.statusSetAt) || null;
      // If job has no status yet, check seen entries by cardFingerprint (title+company).
      // cardFingerprint is stable whether or not the description has loaded, unlike
      // detailFingerprint which depends on descriptionText.
      if (!status) {
        try {
          const cfp = await cardFingerprint(meta.title, meta.company);
          const matches = await getAllSeenByCardFp(cfp);
          if (matches.length && matches[0].status) {
            status = matches[0].status;
            statusSetAt = matches[0].statusSetAt || null;
          }
        } catch (e) { console.warn("[LJS] status lookup from seen failed", e); }
      }
      const job = {
        jobId: meta.jobId,
        title: meta.title,
        company: meta.company,
        location: meta.location,
        workplaceType: meta.workplaceType || "",
        city: meta.city || "",
        url: meta.url,
        descriptionHtml: meta.descriptionHtml || "",
        descriptionText: meta.descriptionText || "",
        savedAt: new Date().toISOString(),
        sourceUrl: location.href,
        status,
        statusSetAt,
      };
      await saveJob(job);
      btn.classList.add("ljs-save-btn--saved");
      btn.textContent = "✓ Saved";
      toast("Saved: " + (job.title || meta.jobId), "ok");
    } catch (e) {
      console.error("[LJS] save error", e);
      btn.classList.add("ljs-save-btn--err");
      btn.textContent = "Error!";
      toast("Save error: " + (e.message || e), "err");
      setTimeout(() => {
        btn.classList.remove("ljs-save-btn--err");
        btn.textContent = original;
      }, 2000);
    } finally {
      btn.disabled = false;
    }
  }

  const BTN_ID = "ljs-save-btn";
  const TOOLBAR_ID = "ljs-toolbar";
  const ACTION_BTN_CLASS = "ljs-action-btn";
  let injectedForJobId = null;

  function removeButton() {
    const t = document.getElementById(TOOLBAR_ID);
    if (t) t.remove();
    injectedForJobId = null;
  }

  function injectSaveButton() {
    const root = findDetailRoot();
    if (!root) { removeButton(); return; }
    const jobId = currentJobId(root);
    if (!jobId) return;
    if (injectedForJobId === String(jobId) && document.getElementById(TOOLBAR_ID)) return;
    removeButton();
    injectedForJobId = String(jobId);

    // Insert toolbar AFTER LinkedIn's action row (mt4 .display-flex with Easy Apply / Save),
    // as a separate block. We do not append into LinkedIn's button container, so the
    // original layout is preserved.
    const actionRow =
      root.querySelector(".mt4 .display-flex") ||
      root.querySelector(".job-details-jobs-unified-top-card__sticky-buttons-container") ||
      (root.querySelector("[data-live-test-job-apply-button]") ? root.querySelector("[data-live-test-job-apply-button]").closest(".mt4, .display-flex") : null);
    const anchor = actionRow && actionRow.parentElement ? actionRow.parentElement : root;

    // Toolbar container: Save button + 4 quick-action buttons.
    const toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;
    toolbar.className = "ljs-toolbar";

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "ljs-save-btn";
    btn.type = "button";
    btn.textContent = "💾 Save to DB";
    btn.title = "Save this job to the local database (LinkedIn Job Saver)";

    isAlreadySaved(jobId).then(saved => {
      if (saved) {
        btn.classList.add("ljs-save-btn--saved");
        btn.textContent = "✓ Saved";
      }
    });

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("[LJS] click save, jobId=", jobId);
      if (btn.classList.contains("ljs-save-btn--saved")) { toast("Already saved earlier"); return; }
      const meta = scrapeFromDetail(root, jobId);
      console.log("[LJS] scraped meta:", { title: meta.title, company: meta.company, descLen: meta.descriptionText.length });
      if (!meta.descriptionHtml) {
        console.warn("[LJS] no description yet — wait");
        toast("Description still loading — try in a second", "err");
        return;
      }
      await handleSave(btn, meta);
    });

    toolbar.appendChild(btn);

    // Quick-action buttons.
    const ACTIONS = ["apply", "to-consider", "german", "ignored"];
    const actionBtns = {};
    for (const key of ACTIONS) {
      const ab = document.createElement("button");
      ab.type = "button";
      ab.className = ACTION_BTN_CLASS + " ljs-action-" + key;
      ab.textContent = STATUS_LABELS[key];
      ab.title = "Mark as: " + STATUS_LABELS[key] + (key === "ignored" ? " (removes description from storage)" : "");
      ab.dataset.action = key;
      ab.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const meta = scrapeFromDetail(root, jobId);
        if (!meta.title && !meta.company) {
          toast("Job details still loading — try in a second", "err");
          return;
        }
        const isAlready = ab.classList.contains(ACTION_BTN_CLASS + "--active");
        const nextStatus = isAlready ? "" : key;
        // Confirmation for "ignored" — it strips the description from storage.
        if (nextStatus === "ignored" && !confirm('Marking as "Ignore" removes the job description from storage to save space (fingerprint + metadata are kept for repost detection).\n\nContinue?')) {
          return;
        }
        try {
          ab.disabled = true;
          await setCurrentJobStatus(meta, nextStatus);
          // Update visual state of all action buttons.
          for (const k of ACTIONS) {
            actionBtns[k].classList.toggle(ACTION_BTN_CLASS + "--active", k === key && !isAlready);
          }
          toast(isAlready ? ("Cleared: " + STATUS_LABELS[key]) : ("Marked: " + STATUS_LABELS[key]), "ok");
        } catch (err) {
          console.error("[LJS] status error", err);
          toast("Status error: " + (err.message || err), "err");
        } finally {
          ab.disabled = false;
        }
      });
      actionBtns[key] = ab;
      toolbar.appendChild(ab);
    }

    // Reflect existing status (async, may resolve after append).
    const meta0 = scrapeFromDetail(root, jobId);
    if (meta0.title || meta0.company) {
      getCurrentJobStatus(meta0).then(status => {
        if (status && actionBtns[status]) {
          actionBtns[status].classList.add(ACTION_BTN_CLASS + "--active");
        }
      }).catch(() => {});
    }

    // Insert AFTER the LinkedIn action row, as a sibling. Falls back to append at end.
    if (actionRow && actionRow.nextSibling) {
      anchor.insertBefore(toolbar, actionRow.nextSibling);
    } else if (actionRow) {
      anchor.appendChild(toolbar);
    } else {
      root.appendChild(toolbar);
    }
  }

  // ---------- Auto-registering seen jobs (detail) ----------
  let lastSeenFp = null;
  let seenTimer = null;

  async function recordSeen(meta) {
    if (!meta.descriptionText || meta.descriptionText.length < 50) return;
    try {
      const fp = await detailFingerprint(meta.title, meta.company, meta.descriptionText);
      const cfp = await cardFingerprint(meta.title, meta.company);
      if (fp === lastSeenFp) return; // already registered in this view session
      lastSeenFp = fp;
      const existing = await getSeenByFp(fp);
      const now = new Date().toISOString();
      if (existing) {
        existing.lastSeenAt = now;
        existing.seenCount = (existing.seenCount || 1) + 1;
        if (!existing.jobIds.includes(meta.jobId)) existing.jobIds.push(meta.jobId);
        // Refresh workplace/city if they were missing (e.g. description loaded since first view).
        if (!existing.workplaceType && meta.workplaceType) existing.workplaceType = meta.workplaceType;
        if (!existing.city && meta.city) existing.city = meta.city;
        if (!existing.location && meta.location) existing.location = meta.location;
        await upsertSeen(existing);
      } else {
        await upsertSeen({
          fingerprint: fp,
          cardFingerprint: cfp,
          title: meta.title,
          company: meta.company,
          location: meta.location || "",
          workplaceType: meta.workplaceType || "",
          city: meta.city || "",
          descriptionText: meta.descriptionText,
          descriptionHtml: meta.descriptionHtml || "",
          jobIds: [meta.jobId],
          firstSeenAt: now,
          lastSeenAt: now,
          seenCount: 1,
          status: "",
          statusSetAt: null,
        });
      }
      // After registering, show banner if repost.
      showRepostBannerIfApplicable(fp, meta);
    } catch (e) {
      console.warn("[LJS] recordSeen error", e);
    }
  }

  function scheduleRecordSeen(meta) {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => recordSeen(meta), 2000);
  }

  // ---------- Banner: repost ----------
  function showRepostBannerIfApplicable(fp, meta) {
    getSeenByFp(fp).then(existing => {
      if (!existing) return;
      // Show banner only if same content was seen under a DIFFERENT jobId before.
      const otherIds = existing.jobIds.filter(id => id !== meta.jobId);
      if (otherIds.length === 0) return;
      const firstDate = new Date(existing.firstSeenAt).toLocaleDateString("en-US");
      showDetailBanner(
        "👁 This job was already seen on " + firstDate +
        " (under jobId " + otherIds.join(", ") + "). " +
        "This is likely a repost (seenCount: " + existing.seenCount + ").",
        "repost"
      );
    }).catch(() => {});
  }

  function showDetailBanner(msg, kind) {
    let el = document.getElementById("ljs-detail-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "ljs-detail-banner";
      el.className = "ljs-detail-banner";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "ljs-detail-banner ljs-detail-banner--" + (kind || "info");
    el.style.display = "block";
  }
  function hideDetailBanner() {
    const el = document.getElementById("ljs-detail-banner");
    if (el) el.style.display = "none";
  }

  // Check whether the current detail matches an already-seen job (on button injection).
  async function checkDetailSeen(root, jobId) {
    const meta = scrapeFromDetail(root, jobId);
    if (!meta.descriptionText || meta.descriptionText.length < 50) return;
    try {
      const fp = await detailFingerprint(meta.title, meta.company, meta.descriptionText);
      const existing = await getSeenByFp(fp);
      if (existing && existing.jobIds.some(id => id !== jobId)) {
        const firstDate = new Date(existing.firstSeenAt).toLocaleDateString("en-US");
        showDetailBanner(
          "👁 This job was already seen on " + firstDate +
          " (under jobId " + existing.jobIds.filter(id => id !== jobId).join(", ") + "). " +
          "Repost (seenCount: " + existing.seenCount + ").",
          "repost"
        );
      } else {
        hideDetailBanner();
      }
    } catch {}
  }

  // ---------- Badge na kartach na liście ----------
  const CARD_BADGE_FLAG = "data-ljs-badge";

  async function injectCardBadges() {
    const cards = document.querySelectorAll('.job-card-container[data-job-id]:not([' + CARD_BADGE_FLAG + '])');
    if (cards.length === 0) return;
    // Ogranicz: tylko karty, które mają już tytuł+firma.
    const candidates = [];
    for (const card of cards) {
      const meta = scrapeFromCard(card);
      if (meta && meta.title && meta.company) candidates.push({ card, meta });
      else card.setAttribute(CARD_BADGE_FLAG, "skip"); // spróbuj później
    }
    if (candidates.length === 0) return;

    // Dla każdej karty oblicz cardFp i sprawdź w store.
    for (const { card, meta } of candidates) {
      try {
        const cfp = await cardFingerprint(meta.title, meta.company);
        const matches = await getAllSeenByCardFp(cfp);
        if (matches.length > 0) {
          // Weź najwcześniejsze firstSeenAt.
          const earliest = matches.reduce((a, b) => (a.firstSeenAt < b.firstSeenAt ? a : b));
          const days = Math.round((Date.now() - new Date(earliest.firstSeenAt).getTime()) / 86400000);
          const when = days < 1 ? "today" : days < 2 ? "yesterday" : days + " days ago";
          const repost = matches.some(m => m.jobIds.length > 1 || (m.jobIds[0] && m.jobIds[0] !== meta.jobId));
          addBadgeToCard(card, when, repost);
        }
        card.setAttribute(CARD_BADGE_FLAG, "1");
      } catch (e) {
        card.setAttribute(CARD_BADGE_FLAG, "err");
      }
    }
  }

  function addBadgeToCard(card, when, repost) {
    const host =
      card.querySelector(".job-card-list__footer-wrapper") ||
      card.querySelector(".job-card-container__footer-wrapper") ||
      card.querySelector(".artdeco-entity-lockup__caption") ||
      card.querySelector(".artdeco-entity-lockup__content") ||
      card;
    const badge = document.createElement("span");
    badge.className = "ljs-seen-badge" + (repost ? " ljs-seen-badge--repost" : "");
    badge.title = repost ? "This job was already seen under a different jobId — repost." : "This job was already seen.";
    badge.textContent = (repost ? "🔁 " : "👁 ") + when;
    host.appendChild(badge);
  }

  // ---------- Orkiestracja ----------
  let scanTimer;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAll, 300);
  }

  function scanAll() {
    injectSaveButton();
    injectCardBadges();

    // Auto-record seen dla bieżącego detalu.
    const root = findDetailRoot();
    const jobId = root ? currentJobId(root) : null;
    if (root && jobId) {
      const meta = scrapeFromDetail(root, jobId);
      if (meta.descriptionText && meta.descriptionText.length > 50) {
        scheduleRecordSeen(meta);
        checkDetailSeen(root, jobId);
      }
    }
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Reakcja na zmianę URL (SPA).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      injectedForJobId = null;
      lastSeenFp = null;
      removeButton();
      hideDetailBanner();
      scheduleScan();
    }
  }, 500);

  scanAll();
  console.log("[LJS] content script active (v0.3 — chrome.storage.local backend)");
})();