// ─── Downloads View ───────────────────────────────────────────────────────────
import './downloads.css';

import { invoke } from '@tauri-apps/api/core';
import { state } from '../state';
import { toast } from '../components/toast';

export async function loadDownloads() {
  state.currentTab = "downloads";
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", false));
  document.getElementById("btn-browse")?.classList.remove("active");
  document.getElementById("btn-downloads")?.classList.add("active");

  const sidebar = document.getElementById("sidebar-list")!;
  sidebar.innerHTML = `<div class="sidebar-empty">Downloads are shown in the main panel.</div>`;

  const main = document.getElementById("main-panel")!;
  main.innerHTML = `<div class="downloads-empty"><h2>⬇ Downloads</h2><p>Loading your downloaded episodes...</p></div>`;

  try {
    const files = await invoke<any[]>("get_downloads");

    if (!files || !files.length) {
      main.innerHTML = `<div class="downloads-empty"><h2>No Downloads Yet</h2><p>Episodes you download will appear here.</p></div>`;
      return;
    }

    // Group files by Anime Title
    const groups: Record<string, any[]> = {};
    for (const f of files) {
      let animeName = "Unknown Anime";
      let epNum: string | number = "?";
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
      eps.sort((a, b) => (parseInt(a.epNum) || 0) - (parseInt(b.epNum) || 0));
      html += `<div class="download-group">
        <div class="download-group-title" onclick="searchAndLoadAnime('${anime.replace(/'/g, "\\'")}')">${anime}</div>
        <div class="download-items">`;
      for (const ep of eps) {
        const sizeMb = (ep.size / (1024 * 1024)).toFixed(1);
        html += `
          <div class="download-item">
            <div class="download-info" style="display:flex;align-items:center;">
              <span class="download-ep-num">Episode ${ep.epNum}</span>
              <span class="download-size">${sizeMb} MB</span>
            </div>
            <div class="download-actions">
              <button class="btn btn-primary btn-play-dl" data-path="${ep.path}">▶ Play</button>
              <button class="btn btn-outline btn-del-dl" data-path="${ep.path}">🗑 Delete</button>
            </div>
          </div>`;
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
        loadDownloads();
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

// Exposed globally so the inline onclick in download group titles can call it
// (avoids having to rewrite all the HTML to use event delegation)
(window as any).searchAndLoadAnime = async (title: string) => {
  const main = document.getElementById("main-panel")!;
  main.innerHTML = `<div class="browse-loading"><div class="spinner"></div><div>Searching...</div></div>`;
  try {
    const result = await invoke<any>("advanced_search", { search: title });
    if (result?.data?.Page?.media?.length > 0) {
      const { selectMedia } = await import('./detail');
      selectMedia(result.data.Page.media[0]);
    } else {
      main.innerHTML = `<div class="downloads-empty"><h2>Not Found</h2><p>Could not find ${title} on AniList.</p></div>`;
    }
  } catch (e) {
    console.error(e);
  }
};
