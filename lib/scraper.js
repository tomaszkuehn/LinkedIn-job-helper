// Scrapowanie danych oferty z DOM LinkedIn.
// Najpierw próba z panelu bocznego na bieżącej stronie, potem fallback do fetch /jobs/view/<id>.

function textClean(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

// Scrapuje metadane z carda na liście.
export function scrapeFromCard(card) {
  const jobId = card.getAttribute("data-job-id");
  if (!jobId) return null;

  const titleEl = card.querySelector(".job-card-list__title--link, .artdeco-entity-lockup__title a, strong");
  const companyEl = card.querySelector(".artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .job-card-container__company-name");
  const locationEl = card.querySelector(".job-card-container__metadata-wrapper li, .artdeco-entity-lockup__caption li");

  const linkEl = card.querySelector("a[href*='/jobs/view/']");
  let url = linkEl ? linkEl.getAttribute("href") : `/jobs/view/${jobId}/`;
  if (url.startsWith("/")) url = "https://www.linkedin.com" + url;

  return {
    jobId,
    title: textClean(titleEl),
    company: textClean(companyEl),
    location: textClean(locationEl),
    url,
  };
}

// Scrapuje pełną treść z panelu bocznego detali oferty na bieżącej stronie.
// LinkedIn trzyma detale w iframe lub w div .jobs-search__job-details--container.
export function scrapeDetailsFromPage(targetJobId) {
  // Przypadek 1: detale w div na głównej stronie
  const detailsRoot =
    document.querySelector(".jobs-search__job-details--container") ||
    document.querySelector(".job-view-layout") ||
    document.querySelector("#job-view-description")?.closest(".jobs-job-view-layout") ||
    null;
  if (!detailsRoot) return null;

  // Weryfikacja, że panel dotyczy właściwej oferty.
  const jobIdMeta = detailsRoot.querySelector("[data-job-id]");
  if (jobIdMeta && jobIdMeta.getAttribute("data-job-id") !== String(targetJobId)) {
    // Panel pokazuje inną ofertę — nie używamy.
    return null;
  }

  const descEl =
    detailsRoot.querySelector("#job-view-description") ||
    detailsRoot.querySelector(".jobs-description__content") ||
    detailsRoot.querySelector(".description__text");
  if (!descEl) return null;

  return {
    descriptionHtml: descEl.innerHTML,
    descriptionText: descEl.innerText,
  };
}

// Fallback: fetch strony /jobs/view/<id> i wyciągnij opis z HTML.
export async function scrapeViaFetch(jobId) {
  const url = `https://www.linkedin.com/jobs/view/${jobId}/`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const descEl =
    doc.querySelector("#job-view-description") ||
    doc.querySelector(".jobs-description__content") ||
    doc.querySelector(".description__text");

  // Tytuł/firma/lokalizacja z metadanych strony (jeśli card ich nie miał).
  const title = textClean(doc.querySelector(".job-details-jobs-unified-top-card__job-title, .topcard__title, h1"));
  const company = textClean(doc.querySelector(".job-details-jobs-unified-top-card__primary-description, .topcard__flavor, .job-details-jobs-unified-top-card__company-name a"));
  const location = textClean(doc.querySelector(".job-details-jobs-unified-top-card__bullet, .topcard__flavor--bullet"));

  return {
    descriptionHtml: descEl ? descEl.innerHTML : "",
    descriptionText: descEl ? descEl.innerText : "",
    title: title || undefined,
    company: company || undefined,
    location: location || undefined,
  };
}