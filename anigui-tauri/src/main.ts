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
  idMal?: number;
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
  theme: string;
  auto_sync: boolean;
}

// ─── State ────────────────────────────────────────────────────────────────────

let config: Config = { bash_path: "", quality: "best", confirm_before_sync: true, anilist_token: "", download_dir: "", theme: "purple", auto_sync: false };
let currentTab: "continue" | "trending" | "search" | "planning" | "downloads" = "trending";
let sidebarItems: Media[] = [];
let sidebarPage = 1;
let sidebarHasMore = false;
let sidebarLoading = false;
let selectedMedia: Media | null = null;
let selectedEp: number | null = null;
let pendingSyncEp: number | null = null;
let pendingSyncAnimeId: number | null = null;
let viewerName: string | null = null;
let playLaunching = false;
let activePlayingAnimeId: number | null = null;
let activePlayingEp: number | null = null;
let downloadLogBuffer: string = "";

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

// ─── Downloads View ──────────────────────────────────────────────────────────

async function loadDownloads() {
  currentTab = "downloads";
  document.getElementById("btn-browse")?.classList.remove("active");
  document.getElementById("btn-downloads")?.classList.add("active");
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.classList.toggle("active", false);
  });
  
  const sidebar = document.getElementById("sidebar-list")!;
  sidebar.innerHTML = `<div class="sidebar-empty">Downloads are shown in the main panel.</div>`;
  
  const main = document.getElementById("main-panel")!;
  main.innerHTML = `<div class="downloads-empty"><h2>⬇ Downloads</h2><p>Loading your downloaded episodes...</p></div>`;
  
  try {
    const files = await invoke<any>("get_downloads");
    
    if (!files || !files.length) {
      main.innerHTML = `<div class="downloads-empty"><h2>No Downloads Yet</h2><p>Episodes you download will appear here.</p></div>`;
      return;
    }
    
    // Group files by Anime Title
    const groups: Record<string, any[]> = {};
    for (const f of files) {
      let animeName = "Unknown Anime";
      let epNum = "?";
      
      const match = f.name.match(/^(.*?)[\s_]+Episode[\s_]+(\d+)/i);
      if (match) {
        animeName = match[1].replace(/_/g, " ").trim();
        epNum = match[2];
      } else {
        animeName = f.name.replace(/\.(mp4|mkv)$/i, "");
      }
      
      if (!groups[animeName]) groups[animeName] = [];
      f.epNum = epNum;
      groups[animeName].push(f);
    }
    
    let html = `<div class="downloads-container"><h2 style="margin-bottom: 20px; font-weight: 500;">Offline Downloads</h2>`;
    
    for (const [anime, eps] of Object.entries(groups)) {
      html += `<div class="download-group"><div class="download-group-title" style="cursor: pointer; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'" onclick="searchAndLoadAnime('${anime.replace(/'/g, "\\'")}')">${anime}</div><div class="download-items">`;
      
      eps.sort((a, b) => {
        const nA = parseInt(a.epNum) || 0;
        const nB = parseInt(b.epNum) || 0;
        return nA - nB;
      });
      
      for (const ep of eps) {
        const sizeMb = (ep.size / (1024 * 1024)).toFixed(1);
        html += `
          <div class="download-item">
            <div class="download-info" style="display: flex; align-items: center;">
              <span class="download-ep-num">Episode ${ep.epNum}</span>
              <span class="download-size">${sizeMb} MB</span>
            </div>
            <div class="download-actions">
              <button class="btn btn-primary btn-play-dl" data-path="${ep.path}">▶ Play</button>
              <button class="btn btn-outline btn-del-dl" data-path="${ep.path}">🗑 Delete</button>
            </div>
          </div>
        `;
      }
      html += `</div></div>`;
    }
    html += `</div>`;
    
    main.innerHTML = html;
    
    main.querySelectorAll(".btn-play-dl").forEach(b => b.addEventListener("click", async (e) => {
      const path = (e.currentTarget as HTMLElement).dataset.path!;
      await invoke("play_local_file", { path });
    }));
    
    main.querySelectorAll(".btn-del-dl").forEach(b => b.addEventListener("click", async (e) => {
      const path = (e.currentTarget as HTMLElement).dataset.path!;
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Deleting...";
      try {
        await invoke("delete_local_file", { path });
        loadDownloads(); // Refresh
      } catch (err) {
        toast(`Failed to delete: ${err}`, "error");
        btn.disabled = false;
        btn.textContent = "🗑 Delete";
      }
    }));
    
  } catch (err) {
    main.innerHTML = `<div class="welcome"><p style="color:var(--red)">Failed to load downloads: ${err}</p></div>`;
  }
}

// ─── Search and Load Anime helper ─────────────────────────────────────────────

(window as any).searchAndLoadAnime = async (title: string) => {
  const main = document.getElementById("main-panel")!;
  main.innerHTML = `<div class="browse-loading"><div class="spinner"></div><div>Searching...</div></div>`;
  
  try {
    const result = await invoke<any>("advanced_search", { search: title });
    if (result?.data?.Page?.media?.length > 0) {
      selectMedia(result.data.Page.media[0]);
    } else {
      main.innerHTML = `<div class="downloads-empty"><h2>Not Found</h2><p>Could not find ${title} on AniList.</p></div>`;
    }
  } catch (e) {
    console.error(e);
  }
};

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
      <button class="btn-icon btn-browse" id="btn-downloads" title="Downloads Manager" aria-label="Downloads Manager">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>Downloads</span>
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
          <label class="form-label">Theme</label>
          <select class="form-input status-select" id="s-theme" style="border-radius:8px;">
            <option value="purple">Purple (Default)</option>
            <option value="crimson">Crimson</option>
            <option value="ocean">Ocean</option>
            <option value="emerald">Emerald</option>
            <option value="monochrome">Monochrome</option>
          </select>
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
        <div class="form-group" style="display: flex; align-items: center; justify-content: space-between;">
          <label class="form-label" style="margin-bottom: 0;">Auto-Sync Progress to AniList</label>
          <input type="checkbox" id="s-autosync" style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--accent);" />
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
  const nextBtn = document.getElementById("play-next");
  if (nextBtn) {
    nextBtn.addEventListener("click", (e) => playEpisode(nextEp, e.currentTarget as HTMLElement));
    if (activePlayingAnimeId === m.id && activePlayingEp === nextEp) {
      nextBtn.dataset.originalText = nextBtn.innerHTML;
      nextBtn.innerHTML = "⏳ Playing...";
      nextBtn.classList.add("playing-active");
    }
  }
  
  const manualBtn = document.getElementById("play-manual");
  if (manualBtn) {
    manualBtn.addEventListener("click", (e) => {
      const episode = Number((document.getElementById("manual-episode") as HTMLInputElement).value);
      if (Number.isInteger(episode) && episode > 0) playEpisode(episode, e.currentTarget as HTMLElement);
      else toast("Enter a valid episode number.", "error");
    });
    if (activePlayingAnimeId === m.id && activePlayingEp === nextEp) {
      manualBtn.dataset.originalText = manualBtn.innerHTML;
      manualBtn.innerHTML = "⏳ Playing...";
      manualBtn.classList.add("playing-active");
    }
  }

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
        const actions = document.getElementById("ep-actions");
        if (actions) {
          actions.classList.remove("hidden");
          const playBtn = document.getElementById("btn-play-selected");
          if (playBtn) {
            if (selectedMedia?.id === activePlayingAnimeId && i === activePlayingEp) {
              playBtn.dataset.originalText = playBtn.dataset.originalText || playBtn.innerHTML;
              playBtn.innerHTML = "⏳ Playing...";
              playBtn.classList.add("playing-active");
            } else {
              if (playBtn.dataset.originalText) {
                playBtn.innerHTML = playBtn.dataset.originalText;
                playBtn.classList.remove("playing-active");
              }
            }
          }
        }
      }
    });
    chip.addEventListener("dblclick", (e) => playEpisode(i, e.currentTarget as HTMLElement));
    if (selectedMedia?.id === activePlayingAnimeId && i === activePlayingEp) {
      chip.classList.add("playing-active");
    }
    grid.appendChild(chip);
  }

  document.getElementById("btn-play-selected")?.addEventListener("click", (e) => {
    if (selectedEp) playEpisode(selectedEp, e.currentTarget as HTMLElement);
  });
  document.getElementById("btn-dl-selected")?.addEventListener("click", () => {
    if (selectedEp) downloadEpisode(selectedEp);
  });
}

// ─── Playback ─────────────────────────────────────────────────────────────────

async function playEpisode(ep: number, triggerElement?: HTMLElement) {
  if (!selectedMedia) return;
  if (playLaunching) {
    toast("A video player is already opening.", "info");
    return;
  }
  playLaunching = true;
  activePlayingAnimeId = selectedMedia.id;
  activePlayingEp = ep;
  
  // Visual feedback on buttons
  const playBtn = document.getElementById("btn-play-selected");
  const nextBtn = document.getElementById("play-next");
  const chip = document.querySelector(`.ep-chip[data-ep="${ep}"]`);
  
  if (triggerElement) {
    triggerElement.dataset.originalText = triggerElement.dataset.originalText || triggerElement.innerHTML;
    triggerElement.innerHTML = "⏳ Playing...";
    triggerElement.classList.add("playing-active");
  } else {
    if (playBtn && playBtn.style.display !== "none") playBtn.innerHTML = "⏳ Playing...";
    if (nextBtn) nextBtn.innerHTML = "⏳ Playing...";
  }
  if (chip) chip.classList.add("playing-active");

  const title = selectedMedia.title.english || selectedMedia.title.romaji;
  toast(`Launching EP ${ep}…`, "info");

  const result = await invoke<{ error?: string; success?: boolean }>("play_episode", {
    title,
    epNum: ep,
  });

  if (result.error) {
    toast(result.error, "error");
    playLaunching = false;
    resetPlayButtons();
  }
}

function resetPlayButtons() {
  const playBtn = document.getElementById("btn-play-selected");
  if (playBtn) playBtn.innerHTML = "▶ Play";
  const nextBtn = document.getElementById("play-next");
  if (nextBtn) nextBtn.innerHTML = "▶ Play Next";
  document.querySelectorAll(".playing-active").forEach(el => {
    el.classList.remove("playing-active");
    if ((el as HTMLElement).dataset.originalText) {
      el.innerHTML = (el as HTMLElement).dataset.originalText!;
    }
  });
}

async function downloadEpisode(ep: number) {
  if (!selectedMedia) return;
  const title = selectedMedia.title.english || selectedMedia.title.romaji;

  // Open download modal
  $("#modal-download").classList.add("open");
  const log = $("#download-log") as HTMLElement;
  const status = $("#download-status") as HTMLElement;
  log.innerHTML = "";
  downloadLogBuffer = "";
  status.textContent = "Starting download…";

  await invoke("start_download", { title, epNum: ep });
}

// ─── Browse View ──────────────────────────────────────────────────────────────

async function loadBrowse() {
  selectedMedia = null;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("btn-downloads")?.classList.remove("active");
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

  let searchPage = 1;
  let hasNextSearchPage = false;
  let searchMatches: Media[] = [];
  let searchLoading = false;
  let searchDebounce: number | null = null;

  const performSearch = async (loadMore = false) => {
    if (!loadMore) {
      searchPage = 1;
      searchMatches = [];
      contentDiv.innerHTML = `<div class="browse-empty">Searching AniList...</div>`;
    } else {
      searchPage++;
      const btn = contentDiv.querySelector("#load-more-btn");
      if (btn) btn.innerHTML = "Loading...";
    }
    searchLoading = true;

    try {
      const query = titleFilter.value.trim();
      const genres = Array.from(activeGenres);
      const year = yearFilter.value ? Number(yearFilter.value) : null;
      const season = seasonFilter.value || null;
      const format = formatFilter.value || null;
      let sort = null;
      if (sortFilter.value === "score_desc") sort = ["SCORE_DESC"];
      else if (sortFilter.value === "score_asc") sort = ["SCORE_ASC"];
      else if (sortFilter.value === "year_desc") sort = ["START_DATE_DESC"];
      else if (sortFilter.value === "year_asc") sort = ["START_DATE_ASC"];

      const res = await invoke<any>("advanced_search", {
        search: query || null,
        genres: genres.length ? genres : null,
        year,
        season,
        format,
        sort,
        page: searchPage
      });

      const pageInfo = res?.data?.Page?.pageInfo;
      hasNextSearchPage = pageInfo?.hasNextPage ?? false;
      const media = res?.data?.Page?.media ?? [];
      
      if (!loadMore) {
        searchMatches = media;
      } else {
        searchMatches.push(...media);
      }

      if (!searchMatches.length) {
        contentDiv.innerHTML = `<div class="browse-empty">Nothing matches your current filters. Try relaxing them.</div>`;
        return;
      }

      contentDiv.innerHTML = "";
      const grid = el("div", "browse-grid fade-in");
      searchMatches.forEach((m: Media) => grid.appendChild(drawCard(m, searchMatches)));
      contentDiv.appendChild(grid);

      if (hasNextSearchPage) {
        const loadMoreBtn = el("button", "btn");
        loadMoreBtn.className = "btn btn-outline";
        loadMoreBtn.id = "load-more-btn";
        loadMoreBtn.style.margin = "20px auto";
        loadMoreBtn.style.display = "block";
        loadMoreBtn.textContent = "Load More Results";
        loadMoreBtn.addEventListener("click", () => {
          if (!searchLoading) performSearch(true);
        });
        contentDiv.appendChild(loadMoreBtn);
      }
    } catch (e) {
      toast(`Search failed: ${e}`, "error");
    } finally {
      searchLoading = false;
    }
  };

  const drawRows = () => {
    const query = titleFilter.value.trim().toLowerCase();
    const hasFilters = activeGenres.size > 0 || query || yearFilter.value || seasonFilter.value || formatFilter.value || sortFilter.value !== "default";
    
    if (hasFilters) {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = window.setTimeout(() => performSearch(false), 400);
    } else {
      if (searchDebounce) clearTimeout(searchDebounce);
      contentDiv.innerHTML = "";
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
    document.getElementById("btn-downloads")?.classList.remove("active");
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
  document.body.setAttribute("data-theme", config.theme);
  updateLoginStatus();
  fetchViewerName(); // non-blocking, updates header when done

  // Load trending on start
  loadTab("trending");

  // Tab buttons
  document.getElementById("tab-trending")!.addEventListener("click", () => loadTab("trending"));
  document.getElementById("tab-continue")!.addEventListener("click", () => loadTab("continue"));
  document.getElementById("tab-planning")!.addEventListener("click", () => loadTab("planning"));

  // Browse & Downloads buttons
  document.getElementById("btn-browse")!.addEventListener("click", () => loadBrowse());
  document.getElementById("btn-downloads")!.addEventListener("click", loadDownloads);

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
    if (!pendingSyncAnimeId || !pendingSyncEp) return;
    const syncAnimeId = pendingSyncAnimeId;
    const syncEp = pendingSyncEp;
    hideSyncBar();
    pendingSyncEp = null;
    pendingSyncAnimeId = null;
    try {
      await invoke("sync_progress", { mediaId: syncAnimeId, epNum: syncEp });
      // Update local progress only if the user is still viewing the same anime
      if (selectedMedia?.id === syncAnimeId) {
        if (selectedMedia.mediaListEntry) {
          selectedMedia.mediaListEntry.progress = syncEp;
        } else {
          selectedMedia.mediaListEntry = { id: 0, progress: syncEp, status: "CURRENT" };
        }
        renderDetail();
        renderSidebar();
      }
      toast(`Synced EP ${syncEp}!`, "success");
    } catch (e: any) {
      toast("Sync failed: " + e, "error");
    }
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
  await listen("player_closed", () => {
    playLaunching = false;
    resetPlayButtons();
  });

  await listen("playback_finished", async (event: any) => {
    const { epNum, percent, timePos, elapsed } = event.payload;
    if (!config.anilist_token) return;

    // Don't sync if the player was open for less than 60 seconds — prevents a false
    // trigger when the user skips to the outro immediately after opening the episode.
    if ((elapsed ?? 0) < 60) return;

    // Capture these NOW before any awaits — the user may navigate to a different
    // anime while the AniSkip fetch is in flight, changing activePlayingAnimeId.
    const capturedAnimeId = activePlayingAnimeId;
    const capturedEp = activePlayingEp;

    let isFinished = percent > 0.85;

    // Try to get AniSkip data if we have the MAL ID.
    // Use capturedAnimeId to look up idMal in case selectedMedia has changed.
    const playedMedia = sidebarItems.find(m => m.id === capturedAnimeId) ?? selectedMedia;
    if (playedMedia?.idMal && timePos > 0) {
      try {
        const skipRes = await fetch(`https://api.aniskip.com/v2/skip-times/${playedMedia.idMal}/${epNum}?types=ed&episodeLength=0`);
        if (skipRes.ok) {
          const skipData = await skipRes.json();
          const ed = skipData.results?.find((r: any) => r.skipType === "ed");
          if (ed && ed.interval?.startTime) {
            // If they reached within 10 seconds of the ending song start, it's finished!
            isFinished = timePos >= (ed.interval.startTime - 10);
          }
        }
      } catch (err) {
        console.error("AniSkip fetch failed", err);
      }
    }

    if (isFinished) {
      if (config.auto_sync) {
        // Auto-sync silently in background using the captured IDs
        try {
          await invoke("sync_progress", { mediaId: capturedAnimeId, epNum: capturedEp });
          toast(`Auto-synced Episode ${capturedEp}`, "success");
        } catch (err: any) {
          toast(`Failed to auto-sync: ${err}`, "error");
        }
      } else if (config.confirm_before_sync) {
        // Store the captured IDs so the sync-yes handler uses the correct anime
        // even if the user has already clicked something else in the sidebar.
        pendingSyncEp = epNum;
        pendingSyncAnimeId = capturedAnimeId;
        showSyncBar(epNum);
      }
    }
  });

  await listen("download_chunk", (event: any) => {
    const log = document.getElementById("download-log");
    if (log) {
      downloadLogBuffer += event.payload.chunk;
      const clean = downloadLogBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      const finalLines = clean.split('\n').map(l => {
          const parts = l.split('\r');
          return parts[parts.length - 1];
      });
      
      log.innerHTML = "";
      for (const fl of finalLines) {
          if (fl.trim() !== "") {
              const div = el("div");
              div.textContent = fl;
              log.appendChild(div);
          }
      }
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
  (document.getElementById("s-token") as HTMLInputElement).value = config.anilist_token || "";
  (document.getElementById("s-bash") as HTMLInputElement).value = config.bash_path || "";
  (document.getElementById("s-dldir") as HTMLInputElement).value = config.download_dir || "";
  (document.getElementById("s-theme") as HTMLSelectElement).value = config.theme || "purple";
  (document.getElementById("s-quality") as HTMLSelectElement).value = config.quality || "best";
  (document.getElementById("s-autosync") as HTMLInputElement).checked = config.auto_sync || false;
  document.getElementById("modal-settings")!.classList.add("open");
}

async function saveSettings() {
  config.anilist_token = (document.getElementById("s-token") as HTMLInputElement).value.trim();
  config.bash_path = (document.getElementById("s-bash") as HTMLInputElement).value.trim();
  config.download_dir = (document.getElementById("s-dldir") as HTMLInputElement).value.trim();
  config.theme = (document.getElementById("s-theme") as HTMLSelectElement).value;
  config.quality = (document.getElementById("s-quality") as HTMLSelectElement).value;
  config.auto_sync = (document.getElementById("s-autosync") as HTMLInputElement).checked;

  await invoke("save_config", { config });
  
  // Apply theme immediately
  document.body.setAttribute("data-theme", config.theme);
  
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

// ─── Dev-only Sync Test Helper ────────────────────────────────────────────────
// Only available in `tauri dev` builds (stripped in production).
// Usage from the browser devtools console:
//   __testSync()              ← uses currently selected anime + next episode
//   __testSync(5)             ← forces episode 5
//   __testSync(5, 0.9)        ← forces ep 5, 90% watched (triggers 85% fallback)
//   __testSync(5, 0.9, 1260)  ← forces ep 5, 90% watched, timePos 1260s (21 min)

if (import.meta.env.DEV) {
  (window as any).__testSync = async (
    overrideEp?: number,
    overridePercent = 0.92,
    overrideTimePos = 1300,
  ) => {
    if (!selectedMedia) {
      console.warn("[testSync] No anime selected. Click one in the sidebar first.");
      return;
    }
    const ep    = overrideEp ?? (selectedMedia.mediaListEntry?.progress ?? 0) + 1;
    const fakePayload = { epNum: ep, percent: overridePercent, timePos: overrideTimePos, elapsed: 9999 };
    console.info("[testSync] Simulating playback_finished →", fakePayload, "for:", selectedMedia.title.romaji);

    // Temporarily set the active IDs so captured* consts resolve correctly
    activePlayingAnimeId = selectedMedia.id;
    activePlayingEp = ep;

    // Re-use the same logic as the real listener by emitting a fake Tauri event
    // into the handler. We do this by directly dispatching through the internal
    // listen callback — simplest approach is to just duplicate the check here.
    let isFinished = overridePercent > 0.85;

    const playedMedia = sidebarItems.find(m => m.id === selectedMedia!.id) ?? selectedMedia;
    if (playedMedia?.idMal && overrideTimePos > 0) {
      try {
        const skipRes = await fetch(
          `https://api.aniskip.com/v2/skip-times/${playedMedia.idMal}/${ep}?types=ed&episodeLength=0`
        );
        if (skipRes.ok) {
          const skipData = await skipRes.json();
          const ed = skipData.results?.find((r: any) => r.skipType === "ed");
          if (ed?.interval?.startTime) {
            isFinished = overrideTimePos >= (ed.interval.startTime - 10);
            console.info(`[testSync] AniSkip ED starts at ${ed.interval.startTime}s → isFinished = ${isFinished}`);
          } else {
            console.info("[testSync] AniSkip returned no ED data, falling back to percent check.");
          }
        }
      } catch (err) {
        console.warn("[testSync] AniSkip fetch failed:", err);
      }
    }

    if (isFinished) {
      if (config.auto_sync) {
        try {
          await invoke("sync_progress", { mediaId: selectedMedia!.id, epNum: ep });
          toast(`[DEV] Auto-synced Episode ${ep}`, "success");
          console.info("[testSync] Auto-sync fired successfully.");
        } catch (err) {
          toast(`[DEV] Auto-sync failed: ${err}`, "error");
        }
      } else if (config.confirm_before_sync) {
        pendingSyncEp = ep;
        pendingSyncAnimeId = selectedMedia!.id;
        showSyncBar(ep);
        console.info("[testSync] Sync confirm bar shown. Click 'Yes' to complete.");
      }
    } else {
      console.info(`[testSync] Episode NOT considered finished (percent=${overridePercent}, isFinished=${isFinished}). Try a higher overridePercent or a timePos near the ED.`);
      toast(`[DEV] Not finished — percent=${(overridePercent * 100).toFixed(0)}%`, "info");
    }
  };
  console.info("%c[AniGUI Dev] __testSync() is available. Type __testSync() in the console to test auto-sync.", "color: #a855f7; font-weight: bold;");
}
