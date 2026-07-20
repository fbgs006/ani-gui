import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MediaTitle { romaji: string; english?: string; }
interface CoverImage { medium: string; large: string; }
interface MediaListEntry { id: number; progress: number; status: string; }
interface RelatedNode {
  id: number;
  title: MediaTitle;
  coverImage: { medium: string };
  type: string;
  format: string;
}
interface RelationEdge {
  relationType: string;
  node: RelatedNode;
}
interface Media {
  id: number;
  title: MediaTitle;
  format?: string;
  episodes?: number;
  averageScore?: number;
  status: string;
  season?: string;
  seasonYear?: number;
  genres: string[];
  description?: string;
  coverImage: CoverImage;
  mediaListEntry?: MediaListEntry;
  relations?: { edges: RelationEdge[] };
}

interface Config {
  bash_path: string;
  quality: string;
  confirm_before_sync: boolean;
  anilist_token: string;
  download_dir: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

let config: Config = { bash_path: "", quality: "best", confirm_before_sync: true, anilist_token: "", download_dir: "" };
let currentTab: "continue" | "trending" | "search" | "planning" = "trending";
let sidebarItems: Media[] = [];
let sidebarPage = 1;
let sidebarHasMore = false;
let sidebarLoading = false;
let selectedMedia: Media | null = null;
let selectedEp: number | null = null;
let pendingSyncEp: number | null = null;
let viewerName: string | null = null;
let playLaunching = false;

// ─── Season Helpers ───────────────────────────────────────────────────────────

function getSeason(date = new Date()): { season: string; year: number } {
  const m = date.getMonth() + 1;
  const year = date.getFullYear();
  const season = m <= 3 ? "WINTER" : m <= 6 ? "SPRING" : m <= 9 ? "SUMMER" : "FALL";
  return { season, year };
}

function getNextSeason(): { season: string; year: number } {
  const { season, year } = getSeason();
  const seq = ["WINTER", "SPRING", "SUMMER", "FALL"];
  const i = seq.indexOf(season);
  return i === 3 ? { season: "WINTER", year: year + 1 } : { season: seq[i + 1], year };
}

function seasonLabel(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

// ─── DOM Helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(sel: string, parent: ParentNode = document) =>
  parent.querySelector<T>(sel)!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", html = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg: string, type: "success" | "error" | "info" = "info") {
  const c = $("#toast-container");
  const t = el("div", `toast ${type}`);
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ─── Render HTML ──────────────────────────────────────────────────────────────

function renderApp() {
  document.getElementById("app")!.innerHTML = `
  <!-- Header -->
  <header class="header">
    <span class="logo">⬡ AniGUI</span>
    <div class="search-wrap">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input class="search-input" id="search-input" type="text" placeholder="Search anime…" autocomplete="off" />
    </div>
    <div class="header-actions">
      <button class="btn-icon btn-browse" id="btn-browse" title="Browse anime" aria-label="Browse anime">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        <span>Browse</span>
      </button>
      <button class="btn-icon" id="btn-settings" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <div class="login-status" id="login-status">
        <span class="dot"></span>
        <span id="login-label">Not logged in</span>
      </div>
    </div>
  </header>

  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="sidebar-tabs">
      <button class="tab-btn active" id="tab-trending" data-tab="trending">Trending</button>
      <button class="tab-btn" id="tab-continue" data-tab="continue">Watching</button>
      <button class="tab-btn" id="tab-planning" data-tab="planning">Planning</button>
    </div>
    <div class="sidebar-list" id="sidebar-list"></div>
  </aside>

  <!-- Main -->
  <main class="main" id="main-panel">
    <div class="welcome">
      <h2>AniGUI</h2>
      <p>Pick an anime from the sidebar to get started, or search for something.</p>
    </div>
  </main>

  <!-- Toast container -->
  <div class="toast-container" id="toast-container"></div>

  <!-- Sync confirm bar -->
  <div class="sync-confirm" id="sync-confirm">
    <p>Finished episode <strong id="sync-ep-label"></strong>. Sync to AniList?</p>
    <button class="btn btn-primary" id="sync-yes" style="padding:6px 14px;font-size:12px;">Yes</button>
    <button class="btn btn-outline" id="sync-no" style="padding:6px 14px;font-size:12px;">Skip</button>
  </div>

  <!-- Settings Modal -->
  <div class="modal-overlay" id="modal-settings">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Settings</span>
        <button class="btn-icon" id="close-settings">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">AniList Token</label>
          <input class="form-input" id="s-token" type="password" placeholder="Paste token here…" />
          <button class="btn btn-outline" id="s-open-anilist" style="align-self:flex-start;margin-top:4px;font-size:12px;padding:6px 14px;">Open AniList Login →</button>
        </div>
        <div class="form-group">
          <label class="form-label">Bash / Git Bash Path</label>
          <input class="form-input" id="s-bash" type="text" placeholder="e.g. C:\\Program Files\\Git\\bin\\bash.exe" />
        </div>
        <div class="form-group">
          <label class="form-label">Download Directory</label>
          <div class="form-row">
            <input class="form-input" id="s-dldir" type="text" placeholder="~/Downloads" />
            <button class="btn btn-outline" id="s-browse" style="font-size:12px;padding:8px 14px;white-space:nowrap;">Browse…</button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Quality</label>
          <select class="form-input status-select" id="s-quality" style="border-radius:8px;">
            <option value="best">Best</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
            <option value="360">360p</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" id="cancel-settings">Cancel</button>
        <button class="btn btn-primary" id="save-settings">Save</button>
      </div>
    </div>
  </div>

  <!-- Download Modal -->
  <div class="modal-overlay" id="modal-download">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Downloading…</span>
        <button class="btn-icon" id="close-download">✕</button>
      </div>
      <div class="modal-body">
        <div class="download-log" id="download-log"></div>
        <p id="download-status" style="font-size:12px;color:var(--text3);text-align:center;"></p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" id="close-download2">Close</button>
      </div>
    </div>
  </div>
  `;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function renderSidebar() {
  const list = $("#sidebar-list");
  list.innerHTML = "";

  if (sidebarItems.length === 0) {
    const msg = currentTab === "continue" ? "Log in to see your watch list."
      : currentTab === "planning" ? "Log in to see your plan-to-watch list."
      : "Nothing to show.";
    list.innerHTML = `<div class="empty-state">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>
      <span>${msg}</span>
    </div>`;
    return;
  }

  sidebarItems.forEach((media) => {
    const title = media.title.english || media.title.romaji;
    const cover = media.coverImage.medium;
    const progress = media.mediaListEntry?.progress ?? 0;
    const eps = media.episodes ?? 0;
    const pct = eps ? Math.round((progress / eps) * 100) : 0;
    const isActive = selectedMedia?.id === media.id;

    const item = el("div", `sidebar-item${isActive ? " active" : ""}`);
    item.innerHTML = `
      <img class="item-cover" src="${cover}" alt="" loading="lazy" onerror="this.style.opacity=0.3"/>
      <div class="item-info">
        <div class="item-title">${title}</div>
        <div class="item-meta">${progress ? `EP ${progress}${eps ? "/" + eps : ""}` : (eps ? eps + " eps" : "Ongoing")}</div>
        ${eps ? `<div class="progress-bar-mini"><div class="progress-bar-mini-fill" style="width:${pct}%"></div></div>` : ""}
      </div>
    `;
    item.addEventListener("click", () => selectMedia(media));
    list.appendChild(item);
  });

  // Load-more indicator
  if (sidebarHasMore) {
    const indicator = el("div", "load-more-indicator");
    indicator.textContent = "Scroll for more…";
    list.appendChild(indicator);
  }
}


function renderSkeletons(n = 8) {
  const list = $("#sidebar-list");
  list.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const item = el("div", "sidebar-item");
    item.innerHTML = `
      <div class="item-cover skeleton"></div>
      <div class="item-info">
        <div class="skeleton" style="height:12px;width:90%;border-radius:4px;margin-bottom:6px;"></div>
        <div class="skeleton" style="height:10px;width:60%;border-radius:4px;"></div>
      </div>`;
    list.appendChild(item);
  }
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

function selectMedia(media: Media) {
  selectedMedia = media;
  selectedEp = null;

  // Update sidebar highlight
  document.querySelectorAll(".sidebar-item").forEach((el, i) => {
    el.classList.toggle("active", sidebarItems[i]?.id === media.id);
    (el as HTMLElement).style.setProperty("--active", "");
  });
  // Re-render sidebar to update active class reliably
  renderSidebar();

  renderDetail();
}

function renderDetail() {
  if (!selectedMedia) return;
  const m = selectedMedia;
  const title = m.title.english || m.title.romaji;
  const progress = m.mediaListEntry?.progress ?? 0;
  const eps = m.episodes ?? 0;
  const pct = eps ? Math.round((progress / eps) * 100) : 0;
  const nextEp = progress + 1;

  const main = $("#main-panel");
  main.innerHTML = `
    <div class="detail-hero fade-in">
      <img class="detail-cover" src="${m.coverImage.large || m.coverImage.medium}" alt="${title}" />
      <div class="detail-info">
        <div class="detail-title">${title}</div>
        <div class="detail-meta-row">
          ${m.genres.slice(0, 4).map(g => `<span class="genre-pill">${g}</span>`).join("")}
          ${m.averageScore ? `<span class="score-badge">★ ${m.averageScore}%</span>` : ""}
          ${m.season ? `<span class="season-badge">${m.season} ${m.seasonYear ?? ""}</span>` : ""}
        </div>
        ${m.description ? `<p class="detail-desc">${m.description.replace(/<[^>]*>/g, "").trim()}</p>` : ""}
        ${eps ? `
        <div class="progress-section">
          <div class="progress-label">
            <span>Progress</span>
            <span>EP ${progress}/${eps} · ${pct}%</span>
          </div>
          <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        </div>` : ""}
        <div class="action-row">
          ${eps && nextEp <= eps ? `<button class="btn btn-primary" id="play-next">▶ Play EP ${nextEp}</button>` : ""}
          <select class="status-select" id="detail-status">
            <option value="Not in List">Not in List</option>
            <option value="CURRENT">Watching</option>
            <option value="COMPLETED">Completed</option>
            <option value="PLANNING">Plan to Watch</option>
            <option value="DROPPED">Dropped</option>
            <option value="PAUSED">Paused</option>
          </select>
        </div>
      </div>
    </div>

    ${eps ? `
    <div class="card fade-in">
      <div class="section-title">Episodes</div>
      <div class="ep-grid" id="ep-grid"></div>
      <div style="margin-top:16px;display:flex;gap:10px;" id="ep-actions" class="hidden">
        <button class="btn btn-primary" id="btn-play-selected">▶ Play</button>
        <button class="btn btn-outline" id="btn-dl-selected">⬇ Download</button>
      </div>
    </div>` : ""}

    ${renderRelations(m)}
  `;

  // AniList does not always publish a total for airing shows. They can still
  // be played, so offer the next episode and a manual episode picker.
  if (!eps) {
    const actions = main.querySelector<HTMLElement>(".action-row");
    if (actions) {
      actions.insertAdjacentHTML("afterbegin", `<button class="btn btn-primary" id="play-next">Play EP ${nextEp}</button><div class="manual-episode"><label for="manual-episode">Episode</label><input id="manual-episode" type="number" min="1" value="${nextEp}" /><button class="btn btn-outline" id="play-manual">Play</button></div>`);
    }
  }

  // Populate status select
  const sel = $("#detail-status") as HTMLSelectElement;
  if (m.mediaListEntry?.status) {
    sel.value = m.mediaListEntry.status;
  } else {
    sel.value = "Not in List";
  }
  if (!config.anilist_token) sel.disabled = true;
  sel.addEventListener("change", async () => {
    if (!m.id) return;
    await invoke("update_status", { mediaId: m.id, status: sel.value });
    toast("Status updated!", "success");
  });

  // Play next button
  document.getElementById("play-next")?.addEventListener("click", () => playEpisode(nextEp));
  document.getElementById("play-manual")?.addEventListener("click", () => {
    const episode = Number((document.getElementById("manual-episode") as HTMLInputElement).value);
    if (Number.isInteger(episode) && episode > 0) playEpisode(episode);
    else toast("Enter a valid episode number.", "error");
  });

  // Episode grid
  if (eps) buildEpGrid(eps, progress);

  // Wire up relation card clicks after HTML is injected
  attachRelationClicks();
}

function buildEpGrid(eps: number, progress: number) {
  const grid = document.getElementById("ep-grid");
  if (!grid) return;
  grid.innerHTML = "";

  for (let i = 1; i <= eps; i++) {
    const chip = el("div", `ep-chip${i <= progress ? " watched" : i === progress + 1 ? " next" : ""}`);
    chip.textContent = String(i);
    chip.dataset.ep = String(i);
    chip.addEventListener("click", () => {
      // Toggle selection
      if (selectedEp === i) {
        selectedEp = null;
        chip.classList.remove("selected");
        document.getElementById("ep-actions")?.classList.add("hidden");
      } else {
        document.querySelectorAll(".ep-chip").forEach(c => c.classList.remove("selected"));
        chip.classList.add("selected");
        selectedEp = i;
        document.getElementById("ep-actions")?.classList.remove("hidden");
      }
    });
    chip.addEventListener("dblclick", () => playEpisode(i));
    grid.appendChild(chip);
  }

  document.getElementById("btn-play-selected")?.addEventListener("click", () => {
    if (selectedEp) playEpisode(selectedEp);
  });
  document.getElementById("btn-dl-selected")?.addEventListener("click", () => {
    if (selectedEp) downloadEpisode(selectedEp);
  });
}

// ─── Playback ─────────────────────────────────────────────────────────────────

async function playEpisode(ep: number) {
  if (!selectedMedia) return;
  if (playLaunching) {
    toast("A video player is already opening.", "info");
    return;
  }
  playLaunching = true;
  const title = selectedMedia.title.english || selectedMedia.title.romaji;
  toast(`Launching EP ${ep}…`, "info");

  const result = await invoke<{ error?: string; success?: boolean }>("play_episode", {
    title,
    epNum: ep,
  });

  if (result.error) {
    toast(result.error, "error");
  }
  playLaunching = false;
}

async function downloadEpisode(ep: number) {
  if (!selectedMedia) return;
  const title = selectedMedia.title.english || selectedMedia.title.romaji;

  // Open download modal
  $("#modal-download").classList.add("open");
  const log = $("#download-log") as HTMLElement;
  const status = $("#download-status") as HTMLElement;
  log.innerHTML = "";
  status.textContent = "Starting download…";

  await invoke("start_download", { title, epNum: ep });
}

// ─── Browse View ──────────────────────────────────────────────────────────────

async function loadBrowse() {
  selectedMedia = null;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("btn-browse")!.classList.add("active");

  const main = document.getElementById("main-panel")!;
  main.innerHTML = `<div class="browse-loading">
    <div class="spinner"></div>
    <span>Loading browse…</span>
  </div>`;

  const { season, year } = getSeason();
  const { season: nextSeason, year: nextYear } = getNextSeason();
  const seasonName = `${seasonLabel(season)} ${year}`;
  const nextSeasonName = `${seasonLabel(nextSeason)} ${nextYear}`;

  try {
    const [trending, popular, upcoming, allTime] = await Promise.all([
      invoke<any>("get_trending", { page: 1 }),
      invoke<any>("get_popular_this_season", { season, year, page: 1 }),
      invoke<any>("get_upcoming_season", { season: nextSeason, year: nextYear, page: 1 }),
      invoke<any>("get_all_time_popular", { page: 1 }),
    ]);

    const rows: { title: string; items: Media[]; tab?: typeof currentTab }[] = [
      { title: "🔥 Trending Now", items: trending?.data?.Page?.media ?? [], tab: "trending" },
      { title: `⭐ Popular This Season — ${seasonName}`, items: popular?.data?.Page?.media ?? [] },
      { title: `🗓 Upcoming — ${nextSeasonName}`, items: upcoming?.data?.Page?.media ?? [] },
      { title: "🏆 All Time Popular", items: allTime?.data?.Page?.media ?? [] },
    ];

    renderBrowse(rows);
  } catch (e: any) {
    main.innerHTML = `<div class="welcome"><p style="color:var(--red)">Failed to load browse: ${e}</p></div>`;
  }
}

function renderBrowseLegacy(rows: { title: string; items: Media[]; tab?: typeof currentTab }[]) {
  const main = document.getElementById("main-panel")!;
  main.innerHTML = "";

  for (const row of rows) {
    if (!row.items.length) continue;

    const section = document.createElement("div");
    section.className = "browse-section";

    const header = document.createElement("div");
    header.className = "browse-section-header";
    header.innerHTML = `
      <span class="browse-section-title">${row.title}</span>
      ${row.tab ? `<button class="btn-view-all" data-tab="${row.tab}">View All →</button>` : ""}
    `;
    section.appendChild(header);

    const scroll = document.createElement("div");
    scroll.className = "browse-scroll";

    row.items.forEach(media => {
      const card = document.createElement("div");
      card.className = "browse-card";
      const title = media.title.english || media.title.romaji;
      const score = media.averageScore;
      card.innerHTML = `
        <img src="${media.coverImage.large || media.coverImage.medium}" alt="${title}" loading="lazy" />
        <div class="browse-card-overlay">
          ${score ? `<span class="browse-card-score">★ ${score}%</span>` : ""}
          <span class="browse-card-title">${title}</span>
          ${media.seasonYear ? `<span class="browse-card-year">${media.seasonYear}</span>` : ""}
        </div>
      `;
      card.addEventListener("click", () => {
        document.getElementById("btn-browse")!.classList.remove("active");
        currentTab = "trending";
        sidebarItems = row.items;
        renderSidebar();
        selectMedia(media);
      });
      scroll.appendChild(card);
    });

    section.appendChild(scroll);
    main.appendChild(section);
  }

  // "View All" buttons
  main.querySelectorAll(".btn-view-all").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = (btn as HTMLElement).dataset.tab as typeof currentTab;
      document.getElementById("btn-browse")!.classList.remove("active");
      loadTab(tab);
    });
  });
}

// ─── Tab Loading ──────────────────────────────────────────────────────────────

// Retained temporarily while the new browse layout rolls out; keeping it referenced avoids
// breaking any future fallback that needs the compact layout.
void renderBrowseLegacy;

function renderBrowse(rows: { title: string; items: Media[]; tab?: typeof currentTab }[]) {
  const main = document.getElementById("main-panel")!;
  const allItems = rows.flatMap(row => row.items);
  // Deduplicate items for grid view
  const uniqueItemsMap = new Map<number, Media>();
  allItems.forEach(item => uniqueItemsMap.set(item.id, item));
  const uniqueItems = Array.from(uniqueItemsMap.values());
  
  const genres = ["All", "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Romance", "Sci-Fi"];
  
  // State for active genres
  const activeGenres = new Set<string>();
  
  main.innerHTML = `
    <section class="browse-hero fade-in">
      <div><span class="browse-kicker">DISCOVER ANIME</span><h1>Find your next <em>obsession.</em></h1><p>Fresh seasonal picks, upcoming shows, and the classics everyone keeps talking about.</p></div>
      <div class="browse-stats"><strong>${uniqueItems.length}</strong><span>hand-picked shows<br>to explore</span></div>
    </section>
    <div class="browse-filters fade-in"><span class="filter-label">Browse by mood</span>${genres.map((genre, index) => `<button class="genre-filter${index === 0 ? " active" : ""}" data-genre="${genre}">${genre}</button>`).join("")}</div>
    <div class="browse-content"></div>`;

  const contentDiv = main.querySelector<HTMLElement>(".browse-content")!;
  const years = [...new Set(uniqueItems.map(media => media.seasonYear).filter((year): year is number => Boolean(year)))].sort((a, b) => b - a);
  const formats = [...new Set(uniqueItems.map(media => media.format).filter((format): format is string => Boolean(format)))].sort();
  const advanced = el("div", "browse-advanced-filters fade-in");
  advanced.innerHTML = `<input id="browse-title-filter" type="search" placeholder="Search titles or genres…" />
    <select id="browse-year-filter"><option value="">Any year</option>${years.map(year => `<option value="${year}">${year}</option>`).join("")}</select>
    <select id="browse-season-filter"><option value="">Any season</option><option value="WINTER">Winter</option><option value="SPRING">Spring</option><option value="SUMMER">Summer</option><option value="FALL">Fall</option></select>
    <select id="browse-format-filter"><option value="">Any format</option>${formats.map(format => `<option value="${format}">${format.replace("_", " ")}</option>`).join("")}</select>
    <select id="browse-sort-filter"><option value="default">Default Sort</option><option value="score_desc">Highest Rated</option><option value="score_asc">Lowest Rated</option><option value="year_desc">Newest</option><option value="year_asc">Oldest</option></select>
    <button class="btn btn-outline" id="browse-clear-filters">Clear</button>`;
  main.querySelector(".browse-filters")!.after(advanced);
  
  const titleFilter = advanced.querySelector<HTMLInputElement>("#browse-title-filter")!;
  const yearFilter = advanced.querySelector<HTMLSelectElement>("#browse-year-filter")!;
  const seasonFilter = advanced.querySelector<HTMLSelectElement>("#browse-season-filter")!;
  const formatFilter = advanced.querySelector<HTMLSelectElement>("#browse-format-filter")!;
  const sortFilter = advanced.querySelector<HTMLSelectElement>("#browse-sort-filter")!;
  
  const drawCard = (media: Media, rowItems?: Media[]) => {
    const card = el("article", "browse-card");
    const title = media.title.english || media.title.romaji;
    const score = media.averageScore;
    const format = media.format?.replace("_", " ") ?? "Anime";
    const episodes = media.episodes ? `${media.episodes} eps` : "Coming soon";
    card.innerHTML = `<img src="${media.coverImage.large || media.coverImage.medium}" alt="${title}" loading="lazy" onerror="this.style.opacity=0.3" /><div class="browse-card-overlay"><div class="browse-card-topline">${score ? `<span class="browse-card-score">★ ${score}%</span>` : ""}<span>${format}</span></div><span class="browse-card-title">${title}</span><span class="browse-card-year">${episodes}${media.seasonYear ? ` · ${media.seasonYear}` : ""}</span></div>`;
    card.addEventListener("click", () => {
      document.getElementById("btn-browse")!.classList.remove("active");
      currentTab = "trending";
      sidebarItems = rowItems || uniqueItems;
      renderSidebar();
      selectMedia(media);
    });
    return card;
  };

  const drawRows = () => {
    contentDiv.innerHTML = "";
    const query = titleFilter.value.trim().toLowerCase();
    
    const hasFilters = activeGenres.size > 0 || query || yearFilter.value || seasonFilter.value || formatFilter.value || sortFilter.value !== "default";
    
    if (hasFilters) {
      // GRID VIEW
      let matches = uniqueItems.filter(media => {
        const title = (media.title.english || media.title.romaji).toLowerCase();
        const searchableGenres = media.genres.join(" ").toLowerCase();
        
        let genreMatch = true;
        if (activeGenres.size > 0) {
          for (const g of activeGenres) {
            if (!media.genres.includes(g)) {
              genreMatch = false;
              break;
            }
          }
        }
        
        return genreMatch
          && (!query || title.includes(query) || searchableGenres.includes(query))
          && (!yearFilter.value || String(media.seasonYear) === yearFilter.value)
          && (!seasonFilter.value || media.season === seasonFilter.value)
          && (!formatFilter.value || media.format === formatFilter.value);
      });
      
      if (sortFilter.value === "score_desc") {
        matches.sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0));
      } else if (sortFilter.value === "score_asc") {
        matches.sort((a, b) => (a.averageScore || 0) - (b.averageScore || 0));
      } else if (sortFilter.value === "year_desc") {
        matches.sort((a, b) => (b.seasonYear || 0) - (a.seasonYear || 0));
      } else if (sortFilter.value === "year_asc") {
        matches.sort((a, b) => (a.seasonYear || 0) - (b.seasonYear || 0));
      }
      
      if (!matches.length) {
        contentDiv.innerHTML = `<div class="browse-empty">Nothing matches your current filters. Try relaxing them.</div>`;
        return;
      }
      
      const grid = el("div", "browse-grid fade-in");
      matches.forEach(media => grid.appendChild(drawCard(media, matches)));
      contentDiv.appendChild(grid);
      
    } else {
      // ROWS VIEW
      let rendered = 0;
      for (const row of rows) {
        if (!row.items.length) continue;
        rendered++;
        const section = el("section", "browse-section fade-in");
        section.innerHTML = `<div class="browse-section-header"><span class="browse-section-title">${row.title}</span><span class="browse-count">${row.items.length} titles</span></div><div class="browse-scroll"></div>`;
        const scroll = section.querySelector<HTMLElement>(".browse-scroll")!;
        row.items.forEach(media => scroll.appendChild(drawCard(media, row.items)));
        contentDiv.appendChild(section);
      }
      if (!rendered) contentDiv.innerHTML = `<div class="browse-empty">Nothing to show right now.</div>`;
    }
  };
  
  drawRows();
  
  main.querySelectorAll(".genre-filter").forEach(button => button.addEventListener("click", () => {
    const genre = (button as HTMLElement).dataset.genre!;
    if (genre === "All") {
      activeGenres.clear();
      main.querySelectorAll(".genre-filter").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
    } else {
      const allBtn = main.querySelector('.genre-filter[data-genre="All"]')!;
      allBtn.classList.remove("active");
      
      if (activeGenres.has(genre)) {
        activeGenres.delete(genre);
        button.classList.remove("active");
        if (activeGenres.size === 0) allBtn.classList.add("active");
      } else {
        activeGenres.add(genre);
        button.classList.add("active");
      }
    }
    drawRows();
  }));
  
  [titleFilter, yearFilter, seasonFilter, formatFilter, sortFilter].forEach(filter => filter.addEventListener("input", drawRows));
  
  advanced.querySelector("#browse-clear-filters")!.addEventListener("click", () => {
    titleFilter.value = "";
    yearFilter.value = "";
    seasonFilter.value = "";
    formatFilter.value = "";
    sortFilter.value = "default";
    activeGenres.clear();
    main.querySelectorAll(".genre-filter").forEach(item => item.classList.remove("active"));
    main.querySelector('.genre-filter[data-genre="All"]')!.classList.add("active");
    drawRows();
  });
}

async function loadTab(tab: typeof currentTab, query = "", page = 1) {
  if (page === 1) {
    currentTab = tab;
    document.getElementById("btn-browse")?.classList.remove("active");
    sidebarPage = 1;
    sidebarItems = [];
    document.querySelectorAll(".tab-btn").forEach(b => {
      b.classList.toggle("active", (b as HTMLElement).dataset.tab === tab);
    });
    renderSkeletons();
  }

  sidebarLoading = true;
  try {
    let items: Media[] = [];
    let hasMore = false;

    if (tab === "trending") {
      const data = await invoke<any>("get_trending", { page });
      items = data?.data?.Page?.media ?? [];
      hasMore = data?.data?.Page?.pageInfo?.hasNextPage ?? false;
    } else if (tab === "continue") {
      if (!config.anilist_token) {
        toast("Log in with AniList to see your watch list.", "info");
      } else {
        const data = await invoke<any>("get_continue_watching");
        const lists = data?.data?.MediaListCollection?.lists ?? [];
        items = lists.flatMap((l: any) =>
          l.entries.map((e: any) => ({ ...e.media, mediaListEntry: { id: e.id, progress: e.progress, status: e.status } }))
        );
      }
    } else if (tab === "planning") {
      if (!config.anilist_token) {
        toast("Log in with AniList to see your plan-to-watch list.", "info");
      } else {
        const data = await invoke<any>("get_planning");
        const lists = data?.data?.MediaListCollection?.lists ?? [];
        items = lists.flatMap((l: any) =>
          l.entries.map((e: any) => ({ ...e.media, mediaListEntry: { id: e.id, progress: e.progress, status: e.status } }))
        );
      }
    } else if (tab === "search" && query) {
      const data = await invoke<any>("search_anime", { query, page });
      items = data?.data?.Page?.media ?? [];
      hasMore = data?.data?.Page?.pageInfo?.hasNextPage ?? false;
    }

    if (page === 1) {
      sidebarItems = items;
    } else {
      sidebarItems = [...sidebarItems, ...items];
    }
    sidebarHasMore = hasMore;
    sidebarPage = page;
  } catch (e: any) {
    toast("Failed to load: " + e, "error");
    if (page === 1) sidebarItems = [];
  }

  sidebarLoading = false;
  renderSidebar();
}

async function loadMore() {
  if (sidebarLoading || !sidebarHasMore) return;
  await loadTab(currentTab, "", sidebarPage + 1);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  renderApp();

  // Load config
  config = await invoke<Config>("get_config");
  updateLoginStatus();
  fetchViewerName(); // non-blocking, updates header when done

  // Load trending on start
  loadTab("trending");

  // Tab buttons
  document.getElementById("tab-trending")!.addEventListener("click", () => loadTab("trending"));
  document.getElementById("tab-continue")!.addEventListener("click", () => loadTab("continue"));
  document.getElementById("tab-planning")!.addEventListener("click", () => loadTab("planning"));

  // Browse button
  document.getElementById("btn-browse")!.addEventListener("click", () => loadBrowse());

  // Sidebar infinite scroll
  document.getElementById("sidebar-list")!.addEventListener("scroll", (e) => {
    const el = e.target as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      loadMore();
    }
  });

  // Search
  let searchTimer: ReturnType<typeof setTimeout>;
  document.getElementById("search-input")!.addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) {
      if (!q) loadTab("trending");
      return;
    }
    searchTimer = setTimeout(() => loadTab("search", q), 400);
  });

  // Settings
  document.getElementById("btn-settings")!.addEventListener("click", openSettings);
  document.getElementById("close-settings")!.addEventListener("click", () => $("#modal-settings").classList.remove("open"));
  document.getElementById("cancel-settings")!.addEventListener("click", () => $("#modal-settings").classList.remove("open"));
  document.getElementById("save-settings")!.addEventListener("click", saveSettings);
  document.getElementById("s-open-anilist")!.addEventListener("click", () => invoke("open_anilist_login"));
  document.getElementById("s-browse")!.addEventListener("click", async () => {
    try {
      const dir = await dialogOpen({ directory: true, multiple: false }) as string | null;
      if (dir) (document.getElementById("s-dldir") as HTMLInputElement).value = dir;
    } catch { /* dialog plugin not available */ }
  });

  // Login status click → open settings
  document.getElementById("login-status")!.addEventListener("click", openSettings);

  // Download modal close
  document.getElementById("close-download")!.addEventListener("click", () => $("#modal-download").classList.remove("open"));
  document.getElementById("close-download2")!.addEventListener("click", () => $("#modal-download").classList.remove("open"));

  // Sync confirm
  document.getElementById("sync-yes")!.addEventListener("click", async () => {
    if (!selectedMedia || !pendingSyncEp) return;
    hideSyncBar();
    try {
      await invoke("sync_progress", { mediaId: selectedMedia.id, epNum: pendingSyncEp });
      // Update local progress
      if (selectedMedia.mediaListEntry) {
        selectedMedia.mediaListEntry.progress = pendingSyncEp;
      } else {
        selectedMedia.mediaListEntry = { id: 0, progress: pendingSyncEp, status: "CURRENT" };
      }
      renderDetail();
      renderSidebar();
      toast(`Synced EP ${pendingSyncEp}!`, "success");
    } catch (e: any) {
      toast("Sync failed: " + e, "error");
    }
    pendingSyncEp = null;
  });
  document.getElementById("sync-no")!.addEventListener("click", () => {
    hideSyncBar();
    pendingSyncEp = null;
  });

  // Close modals on overlay click
  document.getElementById("modal-settings")!.addEventListener("click", (e) => {
    if (e.target === document.getElementById("modal-settings")) {
      document.getElementById("modal-settings")!.classList.remove("open");
    }
  });

  // Tauri events
  await listen("playback_finished", (event: any) => {
    const { epNum, elapsed } = event.payload;
    if (elapsed > 60 && config.anilist_token) {
      if (config.confirm_before_sync) {
        pendingSyncEp = epNum;
        showSyncBar(epNum);
      } else {
        pendingSyncEp = epNum;
        document.getElementById("sync-yes")!.click();
      }
    }
  });

  await listen("download_log", (event: any) => {
    const log = document.getElementById("download-log");
    if (log) {
      const line = el("div");
      line.textContent = event.payload.line;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    }
  });

  await listen("download_finished", (event: any) => {
    const status = document.getElementById("download-status");
    if (status) {
      status.textContent = event.payload.success ? "✓ Download complete!" : "✗ Download failed.";
      status.style.color = event.payload.success ? "var(--green)" : "var(--red)";
    }
    toast(event.payload.success ? "Download complete!" : "Download failed.", event.payload.success ? "success" : "error");
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function openSettings() {
  (document.getElementById("s-token") as HTMLInputElement).value = config.anilist_token;
  (document.getElementById("s-bash") as HTMLInputElement).value = config.bash_path;
  (document.getElementById("s-dldir") as HTMLInputElement).value = config.download_dir;
  (document.getElementById("s-quality") as HTMLSelectElement).value = config.quality;
  document.getElementById("modal-settings")!.classList.add("open");
}

async function saveSettings() {
  config.anilist_token = (document.getElementById("s-token") as HTMLInputElement).value.trim();
  config.bash_path = (document.getElementById("s-bash") as HTMLInputElement).value.trim();
  config.download_dir = (document.getElementById("s-dldir") as HTMLInputElement).value.trim();
  config.quality = (document.getElementById("s-quality") as HTMLSelectElement).value;

  await invoke("save_config", { config });
  viewerName = null; // reset; will re-fetch
  updateLoginStatus();
  await fetchViewerName();
  document.getElementById("modal-settings")!.classList.remove("open");
  toast("Settings saved!", "success");

  // Reload current tab to apply token changes
  loadTab(currentTab);
}

function updateLoginStatus() {
  const statusEl = document.getElementById("login-status");
  const label = document.getElementById("login-label");
  if (statusEl && label) {
    if (config.anilist_token) {
      statusEl.classList.add("logged-in");
      label.textContent = viewerName ?? "Logged in";
    } else {
      statusEl.classList.remove("logged-in");
      viewerName = null;
      label.textContent = "Not logged in";
    }
  }
}

async function fetchViewerName() {
  if (!config.anilist_token) return;
  try {
    const data = await invoke<any>("get_viewer_info");
    viewerName = data?.data?.Viewer?.name ?? null;
    updateLoginStatus();
  } catch { /* not logged in or network error */ }
}

// ─── Sync Bar ─────────────────────────────────────────────────────────────────

function showSyncBar(ep: number) {
  const bar = document.getElementById("sync-confirm")!;
  document.getElementById("sync-ep-label")!.textContent = String(ep);
  bar.classList.add("show");
}

function hideSyncBar() {
  document.getElementById("sync-confirm")!.classList.remove("show");
}

// ─── Related Anime ─────────────────────────────────────────────────────────────

const RELATION_LABEL: Record<string, string> = {
  PREQUEL: "Prequel",
  SEQUEL: "Sequel",
  SIDE_STORY: "Side Story",
  PARENT: "Parent Story",
  ALTERNATIVE: "Alternative",
  SPIN_OFF: "Spin-off",
  SUMMARY: "Summary",
  CHARACTER: "Character",
  OTHER: "Other",
};

function renderRelations(m: Media): string {
  const edges = m.relations?.edges ?? [];
  const relevant = edges.filter(e =>
    ["PREQUEL", "SEQUEL", "SIDE_STORY", "PARENT", "ALTERNATIVE", "SPIN_OFF"].includes(e.relationType)
  );
  if (!relevant.length) return "";

  const cards = relevant.map(e => {
    const t = e.node.title.english || e.node.title.romaji;
    const label = RELATION_LABEL[e.relationType] ?? e.relationType;
    const fmt = e.node.format ? e.node.format.replace(/_/g, " ") : "";
    return `
      <div class="relation-card" data-id="${e.node.id}" title="${t}">
        <img src="${e.node.coverImage.medium}" alt="" onerror="this.style.opacity=0.3" />
        <div class="relation-info">
          <span class="relation-type">${label}</span>
          <span class="relation-title">${t}</span>
          <span class="relation-fmt">${fmt}</span>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="card fade-in" id="relations-card">
      <div class="section-title">Related</div>
      <div class="relations-grid">${cards}</div>
    </div>`;
}

function attachRelationClicks() {
  document.querySelectorAll(".relation-card").forEach(card => {
    card.addEventListener("click", async () => {
      const id = Number((card as HTMLElement).dataset.id);
      if (!id) return;
      // Search by ID — fetch via trending/search and match, or just search by title
      const title = (card as HTMLElement).title;
      if (!title) return;
      toast(`Loading ${title}…`, "info");
      try {
        const data = await invoke<any>("search_anime", { query: title, page: 1 });
        const results: Media[] = data?.data?.Page?.media ?? [];
        const match = results.find(r => r.id === id) ?? results[0];
        if (match) {
          currentTab = "search";
          sidebarItems = results;
          renderSidebar();
          selectMedia(match);
        }
      } catch (e: any) {
        toast("Failed to load: " + e, "error");
      }
    });
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", init);
