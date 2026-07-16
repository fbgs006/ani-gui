"""
ani-cli GUI
A modern Webview-like desktop GUI wrapper around ani-cli using a local Python HTTP server,
Microsoft Edge in App Mode (Chromium), and AniList progress sync.

Requires:
  - ani-cli installed and reachable from Git Bash / bash
  - mpv player (used by ani-cli)
  - Python 3.9+
  - pip install pillow
"""

import io
import json
import os
import queue
import re
import socket
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler

# ──────────────────────────────────────────────────────────────────────────────
# Constants & Config
# ──────────────────────────────────────────────────────────────────────────────

APP_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "anicli-gui")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
ANILIST_API = "https://graphql.anilist.co"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

ANILIST_CLIENT_ID = "45898"  # Set to your client ID

# ──────────────────────────────────────────────────────────────────────────────
# Config & Environment Helpers
# ──────────────────────────────────────────────────────────────────────────────

def load_config():
    os.makedirs(APP_DIR, exist_ok=True)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except Exception:
                return {}
    return {}


def save_config(cfg):
    os.makedirs(APP_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def find_bash():
    candidates = [
        shutil.which("bash"),
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


# ──────────────────────────────────────────────────────────────────────────────
# AniList API Helper
# ──────────────────────────────────────────────────────────────────────────────

def anilist_query(query, variables, token=None):
    body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(ANILIST_API, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"AniList API error {e.code}: {e.read().decode('utf-8', 'ignore')}")


# ──────────────────────────────────────────────────────────────────────────────
# GraphQL Queries
# ──────────────────────────────────────────────────────────────────────────────

MEDIA_FIELDS = """
fragment mediaFields on Media {
  id
  title { romaji english }
  episodes
  averageScore
  status
  season
  seasonYear
  genres
  description(asHtml: false)
  coverImage { medium large }
}
"""

SEARCH_QUERY = MEDIA_FIELDS + """
query ($search: String, $page: Int) {
  Page(page: $page, perPage: 20) {
    pageInfo { hasNextPage }
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      ...mediaFields
      mediaListEntry { id progress status }
    }
  }
}
"""

TRENDING_QUERY = MEDIA_FIELDS + """
query ($page: Int) {
  Page(page: $page, perPage: 20) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: TRENDING_DESC) {
      ...mediaFields
      mediaListEntry { id progress status }
    }
  }
}
"""

VIEWER_QUERY = """
query {
  Viewer { id }
}
"""

CURRENT_QUERY = MEDIA_FIELDS + """
query ($userId: Int) {
  MediaListCollection(userId: $userId, type: ANIME, status: CURRENT) {
    lists {
      entries {
        id
        progress
        status
        media { ...mediaFields }
      }
    }
  }
}
"""

UPDATE_MUTATION = """
mutation ($mediaId: Int, $progress: Int) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress) {
    id
    progress
    status
  }
}
"""

UPDATE_STATUS_MUTATION = """
mutation ($mediaId: Int, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, status: $status) {
    id
    progress
    status
  }
}
"""

DELETE_MUTATION = """
mutation ($id: Int) {
  DeleteMediaListEntry(id: $id) {
    deleted
  }
}
"""

# ──────────────────────────────────────────────────────────────────────────────
# Event Broadcasting Queue System
# ──────────────────────────────────────────────────────────────────────────────

active_queues = []
active_queues_lock = threading.Lock()

def broadcast_event(event_type, **kwargs):
    evt = {"type": event_type, **kwargs}
    with active_queues_lock:
        for q in active_queues:
            q.put(evt)


# ──────────────────────────────────────────────────────────────────────────────
# Native Logic API Class
# ──────────────────────────────────────────────────────────────────────────────

class AppApi:
    def __init__(self):
        self.cfg = load_config()
        self.bash_path = self.cfg.get("bash_path") or find_bash()
        self.token = self.cfg.get("anilist_token")
        self.download_proc = None
        self.download_stopped = False

    def get_config(self):
        return {
            "bash_path": self.bash_path or "",
            "quality": self.cfg.get("quality", "best"),
            "confirm_before_sync": self.cfg.get("confirm_before_sync", True),
            "anilist_token": self.token or "",
            "download_dir": self.cfg.get("download_dir") or os.path.join(os.path.expanduser("~"), "Downloads")
        }

    def save_config(self, cfg_json):
        self.bash_path = cfg_json.get("bash_path") or None
        self.token = cfg_json.get("anilist_token") or None
        self.cfg["bash_path"] = self.bash_path
        self.cfg["anilist_token"] = self.token
        self.cfg["quality"] = cfg_json.get("quality") or "best"
        self.cfg["confirm_before_sync"] = cfg_json.get("confirm_before_sync", True)
        self.cfg["download_dir"] = cfg_json.get("download_dir")
        save_config(self.cfg)
        return True

    def browse_folder(self):
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.lift()
        folder = filedialog.askdirectory(parent=root)
        root.destroy()
        return folder or ""

    def open_anilist_login_url(self):
        url = (
            f"https://anilist.co/api/v2/oauth/authorize"
            f"?client_id={ANILIST_CLIENT_ID}&response_type=token"
        )
        webbrowser.open(url)
        return True

    def search_anime(self, query, page=1):
        try:
            return anilist_query(SEARCH_QUERY, {"search": query, "page": page}, self.token)
        except Exception as e:
            return {"error": str(e)}

    def get_trending(self, page=1):
        try:
            return anilist_query(TRENDING_QUERY, {"page": page}, self.token)
        except Exception as e:
            return {"error": str(e)}

    def get_continue_watching(self):
        if not self.token:
            return {"error": "Not logged in"}
        try:
            viewer = anilist_query(VIEWER_QUERY, {}, self.token)
            user_id = viewer["data"]["Viewer"]["id"]
            return anilist_query(CURRENT_QUERY, {"userId": user_id}, self.token)
        except Exception as e:
            return {"error": str(e)}

    def play_episode(self, title, ep_num):
        if not self.bash_path:
            return {"error": "bash not found"}
        
        quality = self.cfg.get("quality", "best")
        
        def _play():
            safe_title = title.replace('"', '')
            cmd = f'ani-cli "{safe_title}" -S 1 -e {ep_num} -q {quality} --exit-after-play'
            start = time.time()
            try:
                subprocess.run([self.bash_path, "-lc", cmd])
            except Exception as e:
                broadcast_event("notification", message=f"Playback error: {str(e)}", notifyType="error")
                return
            
            elapsed = time.time() - start
            if self.token:
                broadcast_event("playback_finished", epNum=ep_num, elapsed=elapsed)

        threading.Thread(target=_play, daemon=True).start()
        return {"success": True}

    def sync_progress(self, media_id, ep_num):
        try:
            res = anilist_query(UPDATE_MUTATION, {"mediaId": media_id, "progress": ep_num}, self.token)
            return {"success": True, "entry": res.get("data", {}).get("SaveMediaListEntry")}
        except Exception as e:
            return {"error": str(e)}

    def update_status(self, media_id, status_str):
        try:
            res = anilist_query(UPDATE_STATUS_MUTATION, {"mediaId": media_id, "status": status_str}, self.token)
            return {"success": True, "entry": res.get("data", {}).get("SaveMediaListEntry")}
        except Exception as e:
            return {"error": str(e)}

    def delete_status(self, entry_id):
        try:
            anilist_query(DELETE_MUTATION, {"id": entry_id}, self.token)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    def start_download(self, title, episodes, quality, out_dir, season_num=1):
        if not self.bash_path:
            return {"error": "bash not found"}
        
        self.download_stopped = False
        
        def _download():
            safe_folder = re.sub(r'[\\/:*?"<>|]', "_", title).strip()
            season_folder = f"S{season_num}"
            final_dir = os.path.join(out_dir, safe_folder, season_folder)
            
            try:
                os.makedirs(final_dir, exist_ok=True)
                broadcast_event("log", message=f"📁 Directory ready: {final_dir}")
            except Exception as ex:
                broadcast_event("log", message=f"✗ Could not create directory: {ex}")
                broadcast_event("download_finished", success=False)
                return
            
            safe_title = title.replace('"', '')
            completed = 0
            
            for idx, ep in enumerate(episodes, 1):
                if self.download_stopped:
                    broadcast_event("log", message="⚠ Download cancelled by user.")
                    break
                
                broadcast_event("download_progress", current=idx - 1, total=len(episodes), text=f"Downloading Episode {ep}...")
                broadcast_event("log", message=f"→ Downloading episode {ep}...")
                
                cmd = f'ani-cli "{safe_title}" -S 1 -e {ep} -q {quality} -d'
                try:
                    self.download_proc = subprocess.Popen(
                        [self.bash_path, "-lc", cmd],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        cwd=final_dir, text=True
                    )
                    stdout, stderr = self.download_proc.communicate()
                    self.download_proc = None
                    
                    if self.download_stopped:
                        break
                    
                    if (stdout or "").strip():
                        broadcast_event("log", message=stdout.strip())
                    if self.download_proc and self.download_proc.returncode != 0 and (stderr or "").strip():
                        broadcast_event("log", message=f"  ⚠ {stderr.strip()}")
                    else:
                        completed += 1
                        broadcast_event("log", message=f"  ✓ Episode {ep} saved.")
                except Exception as exc:
                    broadcast_event("log", message=f"  ✗ Error: {exc}")
            
            broadcast_event("download_progress", current=len(episodes), total=len(episodes), text="All done!")
            broadcast_event("download_finished", success=(completed == len(episodes)))

        threading.Thread(target=_download, daemon=True).start()
        return {"success": True}

    def stop_download(self):
        self.download_stopped = True
        if self.download_proc and self.download_proc.poll() is None:
            try:
                self.download_proc.kill()
            except Exception:
                pass
        return True


# Global api instance
api = AppApi()

# ──────────────────────────────────────────────────────────────────────────────
# Local Python Web Server Request Handler
# ──────────────────────────────────────────────────────────────────────────────

class AppRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress logging request noise
        return

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/" or url.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_CONTENT.encode("utf-8"))
        elif url.path == "/api/config":
            self.send_json(api.get_config())
        elif url.path == "/api/trending":
            query_params = urllib.parse.parse_qs(url.query)
            page = int(query_params.get("page", [1])[0])
            self.send_json(api.get_trending(page))
        elif url.path == "/api/continue":
            self.send_json(api.get_continue_watching())
        elif url.path == "/api/search":
            query_params = urllib.parse.parse_qs(url.query)
            q = query_params.get("q", [""])[0]
            page = int(query_params.get("page", [1])[0])
            self.send_json(api.search_anime(q, page))
        elif url.path == "/api/browse_folder":
            self.send_json({"folder": api.browse_folder()})
        elif url.path == "/api/auth_url":
            api.open_anilist_login_url()
            self.send_json({"success": True})
        elif url.path == "/api/logs":
            self.handle_log_stream()
        else:
            self.send_error(404)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode('utf-8')
        params = json.loads(post_data) if post_data else {}
        
        if url.path == "/api/save_config":
            res = api.save_config(params)
            self.send_json({"success": res})
        elif url.path == "/api/play":
            res = api.play_episode(params.get("title"), params.get("ep"))
            self.send_json(res)
        elif url.path == "/api/sync":
            res = api.sync_progress(params.get("mediaId"), params.get("ep"))
            self.send_json(res)
        elif url.path == "/api/update_status":
            res = api.update_status(params.get("mediaId"), params.get("status"))
            self.send_json(res)
        elif url.path == "/api/delete_status":
            res = api.delete_status(params.get("id"))
            self.send_json(res)
        elif url.path == "/api/start_download":
            res = api.start_download(
                params.get("title"),
                params.get("episodes"),
                params.get("quality"),
                params.get("out_dir"),
                params.get("season_num", 1)
            )
            self.send_json(res)
        elif url.path == "/api/stop_download":
            res = api.stop_download()
            self.send_json({"success": res})
        else:
            self.send_error(404)

    def send_json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def handle_log_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        
        q = queue.Queue()
        with active_queues_lock:
            active_queues.append(q)
            
        try:
            while True:
                try:
                    evt = q.get(timeout=1.0)
                    self.wfile.write(f"data: {json.dumps(evt)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    # Send a keepalive comment
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            with active_queues_lock:
                active_queues.remove(q)


# ──────────────────────────────────────────────────────────────────────────────
# Embedded HTML, CSS & JS Code for Frontend
# ──────────────────────────────────────────────────────────────────────────────

HTML_CONTENT = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AniGUI</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    /* Custom scrollbars and styling overrides */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: #14161b;
    }
    ::-webkit-scrollbar-thumb {
      background: #262932;
      border-radius: 8px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #4f525c;
    }
  </style>
</head>
<body class="bg-[#14161b] text-[#e8e9ec] font-sans antialiased select-none h-screen flex flex-col overflow-hidden">

  <!-- ── Header ── -->
  <header class="flex items-center justify-between px-6 py-3 bg-[#1a1c23] border-bottom border-[#262932] h-[58px] shrink-0">
    <div class="flex items-center gap-3">
      <div class="w-7 h-7 rounded-lg bg-[#6c5ce7] flex items-center justify-center font-bold text-[#ffffff]">🎌</div>
      <span class="font-bold text-lg tracking-wide bg-gradient-to-r from-[#6c5ce7] to-[#c97abf] bg-clip-text text-transparent">AniGUI</span>
      
      <!-- Live Search Entry -->
      <div class="relative ml-6 w-[280px]">
        <input type="text" id="search-input" placeholder="Search anime..." 
               class="w-full h-8 pl-9 pr-3 rounded-lg border border-[#2c303a] bg-[#20232b] text-[#e8e9ec] text-sm focus:outline-none focus:border-[#6c5ce7] transition-all placeholder-[#4f525c]" />
        <svg class="absolute left-3 top-2 w-4 h-4 text-[#4f525c]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
      </div>
    </div>
    
    <!-- Navigation toolbar -->
    <div class="flex items-center gap-2">
      <button id="btn-trending" onclick="loadTrending(1)" class="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#20232b] text-[#a9acb5] hover:bg-[#262a35] hover:text-[#e8e9ec] transition-all">Trending</button>
      <button id="btn-continue" onclick="loadContinueWatching()" class="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#20232b] text-[#a9acb5] hover:bg-[#262a35] hover:text-[#e8e9ec] transition-all">Continue watching</button>
      <button id="btn-login" onclick="openLoginModal()" class="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#20232b] text-[#a9acb5] hover:bg-[#262a35] hover:text-[#e8e9ec] transition-all">AniList Login</button>
      <button onclick="openSettingsModal()" class="px-2.5 py-1.5 rounded-lg text-xs bg-[#20232b] hover:bg-[#262a35] text-[#a9acb5] transition-all">⚙</button>
      
      <!-- Status indicator -->
      <div class="flex items-center gap-2 ml-4">
        <span id="status-label" class="text-xs text-[#8b8e97]">Ready</span>
        <div id="status-dot" class="w-2.5 h-2.5 rounded-full bg-[#5eba82] transition-colors"></div>
      </div>
    </div>
  </header>

  <!-- ── Main Workspace ── -->
  <main class="flex flex-1 overflow-hidden">
    
    <!-- Left Sidebar -->
    <section class="w-[240px] border-r border-[#262932] flex flex-col bg-[#14161b] shrink-0">
      <div id="results-list" class="flex-1 overflow-y-auto p-2.5 space-y-1.5">
        <!-- Rows populated dynamically -->
      </div>
    </section>

    <!-- Right Content Frame -->
    <section class="flex-1 flex flex-col bg-[#14161b] p-5 overflow-y-auto">
      <div class="max-w-[760px] w-full mx-auto space-y-4">
        
        <!-- Detail Card -->
        <div id="detail-card" class="bg-[#20232b] rounded-xl p-5 flex gap-5 border border-[#262932] opacity-0 transition-opacity duration-300">
          <!-- Thumbnail -->
          <div id="detail-cover" class="w-[110px] h-[158px] rounded-lg overflow-hidden bg-[#262a35] shrink-0 border border-[#262932]">
            <img id="detail-cover-img" src="" class="w-full h-full object-cover hidden" />
          </div>
          
          <!-- Metadata Info -->
          <div class="flex-1 min-w-0 flex flex-col justify-between py-0.5">
            <div>
              <h1 id="detail-title" class="text-lg font-bold truncate">Select a title</h1>
              <p id="detail-meta" class="text-xs text-[#8b8e97] mt-1"></p>
              
              <!-- Genre pills row -->
              <div id="detail-genres" class="flex flex-wrap gap-1.5 mt-3"></div>
            </div>
            
            <!-- Watch Progress & Dropdown -->
            <div class="flex items-end justify-between mt-3 gap-4">
              <!-- Combobox -->
              <div>
                <label class="block text-[10px] text-[#8b8e97] mb-1">AniList Status</label>
                <select id="detail-status-select" onchange="onStatusSelectChange()"
                        class="h-8 px-2 rounded-lg border border-[#2c303a] bg-[#14161b] text-xs text-[#e8e9ec] focus:outline-none focus:border-[#6c5ce7]">
                  <option value="Not in List">Not in List</option>
                  <option value="PLANNING">Plan to Watch</option>
                  <option value="CURRENT">Watching</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="PAUSED">Paused</option>
                  <option value="DROPPED">Dropped</option>
                </select>
              </div>
              
              <!-- Determinate Progress Bar -->
              <div id="progress-container" class="flex-1 hidden">
                <div class="flex justify-between text-[11px] text-[#8b8e97] mb-1">
                  <span id="progress-text">Watching · episode 18 of 25</span>
                  <span id="progress-percent">72%</span>
                </div>
                <div class="h-1.5 rounded-full bg-[#2c303a] overflow-hidden">
                  <div id="progress-bar-fill" class="h-full bg-[#6c5ce7] rounded-full transition-all duration-300" style="width: 72%;"></div>
                </div>
              </div>
            </div>

          </div>
        </div>

        <!-- Synopsis/Description Card -->
        <div id="synopsis-card" class="bg-[#20232b] rounded-xl p-4 border border-[#262932] hidden">
          <p id="detail-desc" class="text-xs text-[#8b8e97] leading-relaxed max-h-[72px] overflow-y-auto pr-1"></p>
        </div>

        <!-- Now Playing Banner -->
        <div id="banner" class="bg-[#6c5ce7] text-[#ffffff] font-semibold text-xs py-2 px-4 rounded-lg hidden text-center shadow-lg transition-all duration-300 animate-pulse">
          ▶ Launching anime player...
        </div>

        <!-- Action buttons -->
        <div id="action-bar" class="grid grid-cols-2 gap-3.5 hidden">
          <button id="btn-play-action" onclick="playSelectedEpisode()" class="h-10 rounded-lg bg-[#6c5ce7] hover:bg-[#8475f0] text-sm font-semibold flex items-center justify-center gap-2 shadow-lg transition-all">
            <span>▶</span> <span id="btn-play-text">Play Episode</span>
          </button>
          <button id="btn-download-action" onclick="openDownloadModal()" class="h-10 rounded-lg bg-[#20232b] border border-[#2c303a] hover:bg-[#262a35] text-sm font-semibold flex items-center justify-center gap-2 transition-all">
            <span>⬇</span> <span id="btn-download-text">Download Episodes</span>
          </button>
        </div>

        <!-- Episode Grid Card -->
        <div id="episodes-card" class="bg-[#20232b] rounded-xl p-5 border border-[#262932] hidden">
          <div class="flex items-center justify-between mb-4 border-b border-[#262932] pb-2">
            <h2 class="font-bold text-sm">Episodes</h2>
            <span id="episodes-count" class="text-xs text-[#8b8e97]">18/25 watched</span>
          </div>
          <div id="episodes-grid" class="grid grid-cols-8 gap-2">
            <!-- Episode Chips dynamically added -->
          </div>
        </div>

      </div>
    </section>

  </main>

  <!-- ── Settings Modal Overlay ── -->
  <div id="modal-settings" class="fixed inset-0 bg-[#000000]/60 backdrop-blur-sm flex items-center justify-center z-50 hidden transition-opacity duration-300">
    <div class="bg-[#20232b] w-[460px] rounded-xl border border-[#262932] shadow-2xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-[#262932] pb-2">
        <h2 class="font-bold text-sm">⚙ Settings</h2>
        <button onclick="closeSettingsModal()" class="text-[#8b8e97] hover:text-[#e8e9ec]">✕</button>
      </div>
      
      <div class="space-y-3.5">
        <div>
          <label class="block text-xs text-[#8b8e97] mb-1">bash.exe path</label>
          <input type="text" id="cfg-bash" class="w-full h-8 px-3 rounded-lg border border-[#2c303a] bg-[#14161b] text-sm focus:outline-none focus:border-[#6c5ce7]" />
        </div>
        
        <div>
          <label class="block text-xs text-[#8b8e97] mb-1">Quality (best / worst / 1080 / 720 / ...)</label>
          <input type="text" id="cfg-quality" class="w-full h-8 px-3 rounded-lg border border-[#2c303a] bg-[#14161b] text-sm focus:outline-none focus:border-[#6c5ce7]" />
        </div>

        <div class="flex items-center gap-3">
          <div class="flex-1">
            <label class="block text-xs text-[#8b8e97] mb-1">Download Base Directory</label>
            <input type="text" id="cfg-download-dir" class="w-full h-8 px-3 rounded-lg border border-[#2c303a] bg-[#14161b] text-xs focus:outline-none focus:border-[#6c5ce7]" readonly />
          </div>
          <button onclick="browseDownloadFolder()" class="h-8 px-3 mt-5 bg-[#262a35] hover:bg-[#323746] text-xs font-semibold rounded-lg transition-all">Browse</button>
        </div>
        
        <div class="flex items-start gap-2.5 pt-2">
          <input type="checkbox" id="cfg-confirm" class="w-4 h-4 rounded border-[#2c303a] text-[#6c5ce7] focus:ring-[#6c5ce7]" />
          <div>
            <label for="cfg-confirm" class="text-xs font-medium block">Ask before marking watched on AniList</label>
            <span class="text-[10px] text-[#4f525c]">(mpv closing doesn't guarantee finished playback)</span>
          </div>
        </div>
      </div>
      
      <div class="flex gap-2.5 justify-end pt-3">
        <button onclick="closeSettingsModal()" class="px-4 py-2 bg-[#262a35] hover:bg-[#323746] text-xs font-semibold rounded-lg transition-all">Cancel</button>
        <button onclick="saveSettings()" class="px-4 py-2 bg-[#6c5ce7] hover:bg-[#8475f0] text-xs font-semibold rounded-lg shadow-md transition-all">Save Settings</button>
      </div>
    </div>
  </div>

  <!-- ── Login Modal Overlay ── -->
  <div id="modal-login" class="fixed inset-0 bg-[#000000]/60 backdrop-blur-sm flex items-center justify-center z-50 hidden transition-opacity duration-300">
    <div class="bg-[#20232b] w-[420px] rounded-xl border border-[#262932] shadow-2xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-[#262932] pb-2">
        <h2 class="font-bold text-sm">🔑 AniList Login</h2>
        <button onclick="closeLoginModal()" class="text-[#8b8e97] hover:text-[#e8e9ec]">✕</button>
      </div>
      
      <p class="text-xs text-[#8b8e97] leading-relaxed">
        Linking your AniList account syncs your watch progression back automatically. Click to authorize, then paste the code shown on screen below.
      </p>
      
      <button onclick="startAniListAuth()" class="w-full py-2 bg-[#6c5ce7] hover:bg-[#8475f0] text-xs font-bold rounded-lg shadow-md transition-all flex items-center justify-center gap-2">
        <span>🔗</span> Authorize on AniList
      </button>
      
      <div class="pt-2">
        <label class="block text-[11px] text-[#8b8e97] mb-1">Access Token / Authorization Code</label>
        <input type="password" id="login-token" placeholder="Paste token here..." 
               class="w-full h-8 px-3 rounded-lg border border-[#2c303a] bg-[#14161b] text-xs focus:outline-none focus:border-[#6c5ce7]" />
      </div>
      
      <div class="flex gap-2.5 justify-end pt-2">
        <button onclick="closeLoginModal()" class="px-4 py-2 bg-[#262a35] hover:bg-[#323746] text-xs font-semibold rounded-lg transition-all">Cancel</button>
        <button onclick="submitLogin()" class="px-4 py-2 bg-[#6c5ce7] hover:bg-[#8475f0] text-xs font-semibold rounded-lg shadow-md transition-all">Link Account</button>
      </div>
    </div>
  </div>

  <!-- ── Download Modal Overlay ── -->
  <div id="modal-download" class="fixed inset-0 bg-[#000000]/60 backdrop-blur-sm flex items-center justify-center z-50 hidden transition-opacity duration-300">
    <div class="bg-[#20232b] w-[500px] rounded-xl border border-[#262932] shadow-2xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-[#262932] pb-2">
        <h2 class="font-bold text-sm flex items-center gap-2"><span>⬇</span> Download Episodes</h2>
        <button onclick="closeDownloadModal()" class="text-[#8b8e97] hover:text-[#e8e9ec]">✕</button>
      </div>
      
      <div class="space-y-4">
        <div>
          <h3 id="dl-title" class="font-bold text-sm text-[#ffffff] leading-snug">Anime Title</h3>
        </div>
        
        <!-- Mode selectors -->
        <div class="flex gap-4 bg-[#14161b] p-1.5 rounded-lg border border-[#2c303a]">
          <label class="flex-1 flex items-center justify-center gap-2 h-7 rounded-md cursor-pointer text-xs font-semibold text-[#8b8e97] select-none hover:text-[#e8e9ec] transition-all">
            <input type="radio" name="dl-mode" value="single" checked onchange="toggleDlMode()" class="sr-only" />
            <span class="dl-mode-label text-center w-full py-0.5 rounded-md">Single Ep</span>
          </label>
          <label class="flex-1 flex items-center justify-center gap-2 h-7 rounded-md cursor-pointer text-xs font-semibold text-[#8b8e97] select-none hover:text-[#e8e9ec] transition-all">
            <input type="radio" name="dl-mode" value="range" onchange="toggleDlMode()" class="sr-only" />
            <span class="dl-mode-label text-center w-full py-0.5 rounded-md">Range</span>
          </label>
          <label class="flex-1 flex items-center justify-center gap-2 h-7 rounded-md cursor-pointer text-xs font-semibold text-[#8b8e97] select-none hover:text-[#e8e9ec] transition-all">
            <input type="radio" name="dl-mode" value="all" onchange="toggleDlMode()" class="sr-only" />
            <span class="dl-mode-label text-center w-full py-0.5 rounded-md">All</span>
          </label>
        </div>

        <!-- Range grid -->
        <div class="grid grid-cols-3 gap-3">
          <div>
            <label id="dl-lbl-from" class="block text-[10px] text-[#8b8e97] mb-1">Episode</label>
            <input type="number" id="dl-input-from" min="1" class="w-full h-8 px-2.5 rounded-lg border border-[#2c303a] bg-[#14161b] text-sm focus:outline-none focus:border-[#6c5ce7]" />
          </div>
          
          <div id="dl-range-to-container" class="hidden">
            <label class="block text-[10px] text-[#8b8e97] mb-1">To Episode</label>
            <input type="number" id="dl-input-to" min="1" class="w-full h-8 px-2.5 rounded-lg border border-[#2c303a] bg-[#14161b] text-sm focus:outline-none focus:border-[#6c5ce7]" />
          </div>
          
          <div>
            <label class="block text-[10px] text-[#8b8e97] mb-1">Season</label>
            <input type="number" id="dl-input-season" min="1" value="1" class="w-full h-8 px-2.5 rounded-lg border border-[#2c303a] bg-[#14161b] text-sm focus:outline-none focus:border-[#6c5ce7]" />
          </div>
        </div>
      </div>
      
      <div class="flex gap-2.5 justify-end pt-3">
        <button onclick="closeDownloadModal()" class="px-4 py-2 bg-[#262a35] hover:bg-[#323746] text-xs font-semibold rounded-lg transition-all">Cancel</button>
        <button onclick="startDownload()" class="px-4 py-2 bg-[#6c5ce7] hover:bg-[#8475f0] text-xs font-bold rounded-lg shadow-md transition-all flex items-center gap-1.5">
          <span>⬇</span> Start Download
        </button>
      </div>
    </div>
  </div>

  <!-- ── Download Log Modal Overlay ── -->
  <div id="modal-download-log" class="fixed inset-0 bg-[#000000]/60 backdrop-blur-sm flex items-center justify-center z-50 hidden transition-opacity duration-300">
    <div class="bg-[#20232b] w-[600px] h-[460px] rounded-xl border border-[#262932] shadow-2xl p-5 flex flex-col">
      <div class="flex items-center justify-between border-b border-[#262932] pb-2 shrink-0">
        <h2 id="dll-header" class="font-bold text-sm">Downloading Anime</h2>
        <button id="btn-dll-close" onclick="closeDownloadLogModal()" class="text-[#8b8e97] hover:text-[#e8e9ec] hidden">✕</button>
      </div>
      
      <div class="mt-4 space-y-2 shrink-0">
        <div class="flex justify-between text-xs text-[#8b8e97]">
          <span id="dll-progress-txt">Starting download...</span>
          <span id="dll-progress-pct">0%</span>
        </div>
        <div class="h-2 rounded-full bg-[#2c303a] overflow-hidden">
          <div id="dll-progress-fill" class="h-full bg-[#6c5ce7] rounded-full transition-all duration-300" style="width: 0%;"></div>
        </div>
      </div>
      
      <!-- Logs list -->
      <div class="flex-1 min-h-0 bg-[#14161b] rounded-lg mt-4 border border-[#2c303a] p-3 overflow-y-auto">
        <pre id="dll-logs" class="text-[10px] font-mono text-[#8b8e97] leading-relaxed whitespace-pre-wrap select-text"></pre>
      </div>
      
      <div class="flex justify-center pt-4 shrink-0">
        <button id="btn-dll-cancel" onclick="stopDownload()" class="px-5 py-2 bg-red-600/80 hover:bg-red-500 text-xs font-semibold rounded-lg shadow-md transition-all">✕ Cancel Download</button>
      </div>
    </div>
  </div>

  <!-- ── Prompt Dialog Overlay ── -->
  <div id="modal-prompt" class="fixed inset-0 bg-[#000000]/60 backdrop-blur-sm flex items-center justify-center z-50 hidden">
    <div class="bg-[#20232b] w-[360px] rounded-xl border border-[#262932] shadow-2xl p-5 space-y-4">
      <h3 class="font-bold text-sm">Update watch progress?</h3>
      <p id="prompt-desc" class="text-xs text-[#8b8e97] leading-relaxed"></p>
      
      <div class="flex gap-2.5 justify-end pt-2">
        <button onclick="submitPrompt(false)" class="px-4 py-2 bg-[#262a35] hover:bg-[#323746] text-xs font-semibold rounded-lg transition-all">No</button>
        <button onclick="submitPrompt(true)" class="px-4 py-2 bg-[#6c5ce7] hover:bg-[#8475f0] text-xs font-semibold rounded-lg shadow-md transition-all">Yes</button>
      </div>
    </div>
  </div>

  <!-- ── Custom Toast Notification ── -->
  <div id="toast" class="fixed bottom-5 right-5 px-4.5 py-2.5 rounded-lg text-xs font-semibold bg-[#262a35] border border-[#2c303a] shadow-xl translate-y-[100px] opacity-0 transition-all duration-300 z-50 flex items-center gap-2">
    <span id="toast-icon">✓</span>
    <span id="toast-msg">Notification message</span>
  </div>

  <!-- ── Script Logic ── -->
  <script>
    let currentMode = "trending";
    let page = 1;
    let hasMore = false;
    let loadingMore = false;
    
    let searchTimeout = null;
    let results = [];
    let selectedMedia = null;
    let selectedEpisode = 1;
    
    let config = {};
    let promptResolve = null;

    // Connect to Server-Sent Events for Python-to-JS bridge pushes
    const eventSource = new EventSource('/api/logs');
    eventSource.onmessage = (event) => {
      const evt = JSON.parse(event.data);
      if (evt.type === 'log') {
        addDownloadLog(evt.message);
      } else if (evt.type === 'download_progress') {
        onDownloadProgress(evt.current, evt.total, evt.text);
      } else if (evt.type === 'download_finished') {
        onDownloadFinished(evt.success);
      } else if (evt.type === 'playback_finished') {
        onPlaybackFinished(evt.epNum, evt.elapsed);
      } else if (evt.type === 'notification') {
        showNotification(evt.message, evt.notifyType);
      }
    };

    window.addEventListener('DOMContentLoaded', () => {
      loadConfig();
      
      const searchInput = document.getElementById('search-input');
      searchInput.addEventListener('input', () => {
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          const q = searchInput.value.trim();
          if (q) {
            currentMode = "search";
            page = 1;
            fetchResults(q, 1);
          }
        }, 420);
      });
      
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          searchInput.blur();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
          e.preventDefault();
          searchInput.focus();
          searchInput.select();
        }
      });
      
      const scrollBox = document.getElementById('results-list');
      scrollBox.addEventListener('scroll', () => {
        if (loadingMore || !hasMore || currentMode === "continue") return;
        const scrollPct = (scrollBox.scrollTop + scrollBox.clientHeight) / scrollBox.scrollHeight;
        if (scrollPct >= 0.85) {
          loadingMore = true;
          loadMore();
        }
      });
    });

    // ── HTTP API Wrapper Helpers ──
    function apiPost(endpoint, data = {}) {
      return fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(r => r.json());
    }

    function apiGet(endpoint) {
      return fetch(endpoint).then(r => r.json());
    }

    function loadConfig() {
      apiGet('/api/config').then(cfg => {
        config = cfg;
        document.getElementById('cfg-bash').value = cfg.bash_path;
        document.getElementById('cfg-quality').value = cfg.quality;
        document.getElementById('cfg-download-dir').value = cfg.download_dir;
        document.getElementById('cfg-confirm').checked = cfg.confirm_before_sync;
        
        if (cfg.anilist_token) {
          loadContinueWatching();
        } else {
          loadTrending(1);
        }
      });
    }

    function setStatus(text, state = "ok") {
      document.getElementById('status-label').innerText = text;
      const dot = document.getElementById('status-dot');
      dot.className = "w-2.5 h-2.5 rounded-full transition-colors " + 
        (state === "loading" ? "bg-orange-400 animate-pulse" : 
         state === "error" ? "bg-red-500" : "bg-[#5eba82]");
    }

    function setNavActive(mode) {
      currentMode = mode;
      const btnTrend = document.getElementById('btn-trending');
      const btnCont = document.getElementById('btn-continue');
      
      btnTrend.className = "px-4 py-1.5 rounded-lg text-xs font-semibold transition-all " + 
        (mode === "trending" ? "bg-[#6c5ce7] text-[#ffffff]" : "bg-[#20232b] text-[#a9acb5] hover:bg-[#262a35] hover:text-[#e8e9ec]");
      btnCont.className = "px-4 py-1.5 rounded-lg text-xs font-semibold transition-all " + 
        (mode === "continue" ? "bg-[#6c5ce7] text-[#ffffff]" : "bg-[#20232b] text-[#a9acb5] hover:bg-[#262a35] hover:text-[#e8e9ec]");
    }

    function fetchResults(query, pageNum) {
      setStatus("Searching...", "loading");
      apiGet(`/api/search?q=${encodeURIComponent(query)}&page=${pageNum}`).then(res => {
        if (res.error) {
          showNotification(res.error, "error");
          setStatus("Search failed.", "error");
          loadingMore = false;
          return;
        }
        
        const media = res.data.Page.media;
        hasMore = res.data.Page.pageInfo.hasNextPage;
        
        if (pageNum === 1) {
          results = media;
          populateResultsList();
        } else {
          results = results.concat(media);
          appendResultsRows(media, results.length - media.length);
        }
        
        setStatus(results.length + " result(s)");
        loadingMore = false;
      });
    }

    function loadTrending(pageNum) {
      setNavActive("trending");
      setStatus("Loading trending...", "loading");
      apiGet(`/api/trending?page=${pageNum}`).then(res => {
        if (res.error) {
          showNotification(res.error, "error");
          setStatus("Failed to load trending", "error");
          loadingMore = false;
          return;
        }
        
        const media = res.data.Page.media;
        hasMore = res.data.Page.pageInfo.hasNextPage;
        
        if (pageNum === 1) {
          results = media;
          populateResultsList();
        } else {
          results = results.concat(media);
          appendResultsRows(media, results.length - media.length);
        }
        
        setStatus("Loaded trending (" + results.length + ")");
        loadingMore = false;
      });
    }

    function loadContinueWatching() {
      setNavActive("continue");
      setStatus("Loading watch list...", "loading");
      apiGet('/api/continue').then(res => {
        if (res.error) {
          showNotification(res.error, "error");
          setStatus("Failed to load watch list", "error");
          return;
        }
        
        const media = [];
        const lists = res.data.MediaListCollection.lists;
        for (const list of lists) {
          for (const entry of list.entries) {
            const m = entry.media;
            m.mediaListEntry = {
              id: entry.id,
              progress: entry.progress,
              status: entry.status
            };
            media.push(m);
          }
        }
        
        results = media;
        hasMore = false;
        populateResultsList();
        setStatus("Loaded " + results.length + " watching");
      });
    }

    function loadMore() {
      page++;
      if (currentMode === "trending") {
        loadTrending(page);
      } else if (currentMode === "search") {
        const q = document.getElementById('search-input').value.trim();
        fetchResults(q, page);
      }
    }

    function populateResultsList() {
      const container = document.getElementById('results-list');
      container.innerHTML = '';
      container.scrollTop = 0;
      
      if (results.length === 0) {
        container.innerHTML = `<div class="text-xs text-[#8b8e97] text-center py-10">No items found.</div>`;
        return;
      }
      
      appendResultsRows(results, 0);
    }

    function appendResultsRows(mediaList, startIdx) {
      const container = document.getElementById('results-list');
      
      mediaList.forEach((m, idx) => {
        const itemIdx = startIdx + idx;
        const row = document.createElement('div');
        row.id = `row-item-${itemIdx}`;
        row.onclick = () => selectAnime(itemIdx);
        row.className = "flex gap-2.5 p-2 rounded-lg cursor-pointer transition-all bg-[#20232b] hover:bg-[#262a35] relative group overflow-hidden border border-transparent";
        
        const borderIndicator = document.createElement('div');
        borderIndicator.className = "absolute left-0 top-0 bottom-0 w-0.75 bg-transparent group-hover:bg-[#8475f0] transition-colors";
        row.appendChild(borderIndicator);
        
        const imgUrl = m.coverImage.medium || m.coverImage.large;
        const img = document.createElement('img');
        img.src = imgUrl;
        img.className = "w-[38px] h-[52px] rounded-md object-cover bg-[#262a35] shrink-0";
        row.appendChild(img);
        
        const contentDiv = document.createElement('div');
        contentDiv.className = "flex-1 min-w-0 flex flex-col justify-center";
        
        const title = document.createElement('div');
        title.className = "text-[12px] font-semibold text-[#e8e9ec] truncate leading-tight";
        title.innerText = m.title.english || m.title.romaji;
        contentDiv.appendChild(title);
        
        const info = document.createElement('div');
        info.className = "text-[10px] text-[#8b8e97] mt-1";
        
        const eps = m.episodes || "?";
        const score = m.averageScore ? `${m.averageScore}%` : "N/A";
        let progressTxt = "";
        if (m.mediaListEntry) {
          progressTxt = `  ·  ${m.mediaListEntry.progress}/${eps} watched`;
        }
        info.innerText = `${eps} eps  ·  ${score}${progressTxt}`;
        contentDiv.appendChild(info);
        
        if (m.mediaListEntry && m.mediaListEntry.status) {
          const badge = document.createElement('span');
          const badgeState = getBadgeState(m.mediaListEntry.status);
          badge.className = `inline-block self-start text-[8px] font-bold px-1.5 py-0.5 rounded-md mt-1.5 uppercase tracking-wide bg-[${badgeState.bg}] text-[${badgeState.fg}]`;
          badge.innerText = badgeState.lbl;
          badge.style.backgroundColor = badgeState.bg;
          badge.style.color = badgeState.fg;
          contentDiv.appendChild(badge);
        }
        
        row.appendChild(contentDiv);
        container.appendChild(row);
      });
    }

    function getBadgeState(status) {
      switch (status) {
        case "CURRENT": return { lbl: "Watching", bg: "#2a2440", fg: "#b9aaf7" };
        case "COMPLETED": return { lbl: "Completed", bg: "#233327", fg: "#8fd19e" };
        case "PLANNING": return { lbl: "Plan to watch", bg: "#2c303a", fg: "#a9acb5" };
        case "PAUSED": return { lbl: "Paused", bg: "#5a3500", fg: "#f5a543" };
        case "DROPPED": return { lbl: "Dropped", bg: "#6b1a1a", fg: "#f08080" };
        default: return { lbl: status, bg: "#2c303a", fg: "#a9acb5" };
      }
    }

    function selectAnime(itemIdx) {
      const selectedRow = document.querySelector('.results-selected-border');
      if (selectedRow) {
        selectedRow.className = selectedRow.className.replace(' border-[#6c5ce7] bg-[#262a35] results-selected-border', ' border-transparent');
        selectedRow.querySelector('div').className = selectedRow.querySelector('div').className.replace(' bg-[#6c5ce7]', ' bg-transparent');
      }
      
      const newSel = document.getElementById(`row-item-${itemIdx}`);
      if (newSel) {
        newSel.className = newSel.className.replace(' border-transparent', ' border-[#6c5ce7] bg-[#262a35] results-selected-border');
        newSel.querySelector('div').className = newSel.querySelector('div').className.replace(' bg-transparent', ' bg-[#6c5ce7]');
      }

      selectedMedia = results[itemIdx];
      
      const detailCard = document.getElementById('detail-card');
      detailCard.classList.remove('opacity-0');
      detailCard.classList.add('opacity-100');
      
      document.getElementById('detail-title').innerText = selectedMedia.title.english || selectedMedia.title.romaji;
      
      const season = selectedMedia.season ? selectedMedia.season.charAt(0).toUpperCase() + selectedMedia.season.slice(1).toLowerCase() : "";
      const year = selectedMedia.seasonYear || "";
      const status = selectedMedia.status ? selectedMedia.status.replace('_', ' ').toLowerCase() : "";
      const statusCapitalized = status ? status.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : "";
      const totalEps = selectedMedia.episodes || "";
      const epsTxt = totalEps ? ` · ${totalEps} episodes` : "";
      
      document.getElementById('detail-meta').innerText = `${season} ${year}  ·  ${statusCapitalized}${epsTxt}`.trim();
      
      const cover = document.getElementById('detail-cover-img');
      cover.src = selectedMedia.coverImage.large || selectedMedia.coverImage.medium;
      cover.classList.remove('hidden');
      
      const genresDiv = document.getElementById('detail-genres');
      genresDiv.innerHTML = '';
      
      (selectedMedia.genres || []).slice(0, 3).forEach(g => {
        const pill = document.createElement('span');
        pill.className = "text-[10px] font-semibold px-2.5 py-0.5 rounded-full bg-[#2a2440] text-[#b9aaf7]";
        pill.innerText = g;
        genresDiv.appendChild(pill);
      });
      
      if (selectedMedia.averageScore) {
        const scorePill = document.createElement('span');
        scorePill.className = "text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-[#233327] text-[#8fd19e] ml-auto";
        scorePill.innerText = `★ ${selectedMedia.averageScore}%`;
        genresDiv.appendChild(scorePill);
      }
      
      const selectBox = document.getElementById('detail-status-select');
      if (!config.anilist_token) {
        selectBox.disabled = true;
        selectBox.value = "Not in List";
      } else {
        selectBox.disabled = false;
        if (selectedMedia.mediaListEntry && selectedMedia.mediaListEntry.status) {
          selectBox.value = selectedMedia.mediaListEntry.status;
        } else {
          selectBox.value = "Not in List";
        }
      }
      
      updateProgressUI();
      
      const descCard = document.getElementById('synopsis-card');
      const desc = document.getElementById('detail-desc');
      if (selectedMedia.description) {
        descCard.classList.remove('hidden');
        desc.innerHTML = selectedMedia.description.replace(/<[^>]*>/g, '').trim();
      } else {
        descCard.classList.add('hidden');
      }
      
      document.getElementById('episodes-card').classList.remove('hidden');
      document.getElementById('action-bar').classList.remove('hidden');
      populateEpisodeGrid();
    }

    function updateProgressUI() {
      const container = document.getElementById('progress-container');
      const barFill = document.getElementById('progress-bar-fill');
      const text = document.getElementById('progress-text');
      const percent = document.getElementById('progress-percent');
      
      if (selectedMedia.mediaListEntry) {
        container.classList.remove('hidden');
        const progress = selectedMedia.mediaListEntry.progress || 0;
        const total = selectedMedia.mediaListEntry.episodes || selectedMedia.episodes || 0;
        const status = getBadgeState(selectedMedia.mediaListEntry.status).lbl;
        
        if (total > 0) {
          const pct = Math.min(100, Math.floor((progress / total) * 100));
          text.innerText = `${status} · episode ${progress} of ${total}`;
          percent.innerText = `${pct}%`;
          barFill.style.width = `${pct}%`;
        } else {
          text.innerText = `${status} · episode ${progress}`;
          percent.innerText = "0%";
          barFill.style.width = "0%";
        }
      } else {
        container.classList.add('hidden');
      }
    }

    function populateEpisodeGrid() {
      const grid = document.getElementById('episodes-grid');
      grid.innerHTML = '';
      
      const total = selectedMedia.episodes || 24;
      const watched = selectedMedia.mediaListEntry ? selectedMedia.mediaListEntry.progress || 0 : 0;
      const nextEp = watched < total ? watched + 1 : null;
      
      selectedEpisode = nextEp || 1;
      
      document.getElementById('episodes-count').innerText = watched ? `${watched}/${total} watched` : `${total} total`;
      
      for (let ep = 1; ep <= total; ep++) {
        const chip = document.createElement('button');
        chip.id = `ep-chip-${ep}`;
        chip.onclick = () => selectEpisodeNum(ep);
        chip.ondblclick = () => { selectEpisodeNum(ep); playSelectedEpisode(); };
        chip.innerText = ep;
        
        setEpisodeChipStyle(chip, ep, watched, nextEp);
        
        grid.appendChild(chip);
      }
      
      selectEpisodeNum(selectedEpisode);
    }

    function setEpisodeChipStyle(chip, ep, watched, nextEp) {
      let style = "aspect-square rounded-lg text-xs font-semibold select-none flex items-center justify-center border transition-all ";
      
      if (ep <= watched) {
        style += "bg-[#20232b] text-[#5eba82] border-[#2c303a] hover:bg-[#262a35]";
      } else if (ep === nextEp) {
        style += "bg-[#6c5ce7] text-[#ffffff] border-[#6c5ce7] hover:bg-[#8475f0]";
      } else {
        style += "bg-[#181a20] text-[#565a66] border-[#2c303a] hover:bg-[#20232b] hover:text-[#e8e9ec]";
      }
      chip.className = style;
    }

    function selectEpisodeNum(epNum) {
      const total = selectedMedia.episodes || 24;
      const watched = selectedMedia.mediaListEntry ? selectedMedia.mediaListEntry.progress || 0 : 0;
      const nextEp = watched < total ? watched + 1 : null;
      
      if (selectedEpisode && selectedEpisode !== epNum) {
        const prevChip = document.getElementById(`ep-chip-${selectedEpisode}`);
        if (prevChip) setEpisodeChipStyle(prevChip, selectedEpisode, watched, nextEp);
      }
      
      selectedEpisode = epNum;
      
      const currentChip = document.getElementById(`ep-chip-${epNum}`);
      if (currentChip) {
        currentChip.className = "aspect-square rounded-lg text-xs font-bold select-none flex items-center justify-center bg-[#c97abf] text-[#ffffff] border-[#c97abf] shadow-md transition-all scale-[1.05]";
      }
      
      document.getElementById('btn-play-text').innerText = `Play Episode ${epNum}`;
      document.getElementById('btn-download-text').innerText = `Download Episode ${epNum}`;
    }

    function playSelectedEpisode() {
      if (!selectedMedia) return;
      
      const banner = document.getElementById('banner');
      banner.innerText = `▶  Launching ${selectedMedia.title.english || selectedMedia.title.romaji} — Episode ${selectedEpisode}...`;
      banner.classList.remove('hidden');
      setStatus(`Playing Ep ${selectedEpisode}...`, "loading");
      
      apiPost('/api/play', {
        title: selectedMedia.title.english || selectedMedia.title.romaji,
        ep: selectedEpisode
      }).then(res => {
        if (res && res.error) {
          banner.classList.add('hidden');
          showNotification(res.error, "error");
          setStatus("Launch failed.", "error");
        }
      });
    }

    function onPlaybackFinished(epNum, elapsed) {
      document.getElementById('banner').classList.add('hidden');
      setStatus(`Finished episode ${epNum}.`);
      
      if (config.confirm_before_sync) {
        let msg = `Mark episode ${epNum} as watched on AniList?`;
        if (elapsed < 60) {
          msg = `That closed after only ${Math.floor(elapsed)}s — still mark episode ${epNum} as watched?`;
        }
        
        document.getElementById('prompt-desc').innerText = msg;
        document.getElementById('modal-prompt').classList.remove('hidden');
        promptResolve = (choice) => {
          document.getElementById('modal-prompt').classList.add('hidden');
          if (choice) submitProgressSync(epNum);
        };
      } else {
        submitProgressSync(epNum);
      }
    }

    function submitPrompt(choice) {
      if (promptResolve) {
        promptResolve(choice);
        promptResolve = null;
      }
    }

    function submitProgressSync(epNum) {
      if (!selectedMedia) return;
      
      setStatus("Syncing with AniList...", "loading");
      apiPost('/api/sync', {
        mediaId: selectedMedia.id,
        ep: epNum
      }).then(res => {
        if (res.error) {
          showNotification(`Sync failed: ${res.error}`, "error");
          setStatus("Sync failed.", "error");
          return;
        }
        
        showNotification("Watch progress synced!", "success");
        setStatus("Synced Ep " + epNum + ".");
        
        if (!selectedMedia.mediaListEntry) selectedMedia.mediaListEntry = {};
        selectedMedia.mediaListEntry.progress = epNum;
        selectedMedia.mediaListEntry.status = res.entry.status;
        
        updateProgressUI();
        populateEpisodeGrid();
        
        document.getElementById('detail-status-select').value = res.entry.status;
        refreshRowItemProgress(selectedMedia.id, epNum, res.entry.status);
      });
    }

    function onStatusSelectChange() {
      const selectBox = document.getElementById('detail-status-select');
      const val = selectBox.value;
      
      setStatus("Updating status...", "loading");
      if (val === "Not in List") {
        if (selectedMedia.mediaListEntry && selectedMedia.mediaListEntry.id) {
          apiPost('/api/delete_status', { id: selectedMedia.mediaListEntry.id }).then(res => {
            if (res.error) {
              showNotification(res.error, "error");
              setStatus("Delete failed.", "error");
              return;
            }
            selectedMedia.mediaListEntry = null;
            updateProgressUI();
            populateEpisodeGrid();
            refreshRowItemProgress(selectedMedia.id, 0, null);
            showNotification("Removed from list", "success");
            setStatus("Ready");
          });
        }
      } else {
        apiPost('/api/update_status', {
          mediaId: selectedMedia.id,
          status: val
        }).then(res => {
          if (res.error) {
            showNotification(res.error, "error");
            setStatus("Update failed.", "error");
            return;
          }
          selectedMedia.mediaListEntry = {
            id: res.entry.id,
            progress: res.entry.progress || 0,
            status: res.entry.status
          };
          updateProgressUI();
          populateEpisodeGrid();
          refreshRowItemProgress(selectedMedia.id, res.entry.progress || 0, res.entry.status);
          showNotification(`Marked as ${getBadgeState(res.entry.status).lbl}`, "success");
          setStatus("Ready");
        });
      }
    }

    function refreshRowItemProgress(mediaId, progress, status) {
      results.forEach((m, idx) => {
        if (m.id === mediaId) {
          if (progress === 0 && status === null) {
            m.mediaListEntry = null;
          } else {
            if (!m.mediaListEntry) m.mediaListEntry = {};
            m.mediaListEntry.progress = progress;
            m.mediaListEntry.status = status;
          }
          
          const row = document.getElementById(`row-item-${idx}`);
          if (row) {
            const info = row.querySelector('div div:nth-child(2)');
            const eps = m.episodes || "?";
            const score = m.averageScore ? `${m.averageScore}%` : "N/A";
            let progressTxt = "";
            if (m.mediaListEntry) {
              progressTxt = `  ·  ${m.mediaListEntry.progress}/${eps} watched`;
            }
            info.innerText = `${eps} eps  ·  ${score}${progressTxt}`;
            
            let badge = row.querySelector('div span');
            if (status && badge) {
              const state = getBadgeState(status);
              badge.innerText = state.lbl;
              badge.style.backgroundColor = state.bg;
              badge.style.color = state.fg;
              badge.className = `inline-block self-start text-[8px] font-bold px-1.5 py-0.5 rounded-md mt-1.5 uppercase tracking-wide bg-[${state.bg}] text-[${state.fg}]`;
            } else if (status) {
              badge = document.createElement('span');
              const state = getBadgeState(status);
              badge.className = `inline-block self-start text-[8px] font-bold px-1.5 py-0.5 rounded-md mt-1.5 uppercase tracking-wide bg-[${state.bg}] text-[${state.fg}]`;
              badge.innerText = state.lbl;
              badge.style.backgroundColor = state.bg;
              badge.style.color = state.fg;
              row.querySelector('div').appendChild(badge);
            } else if (badge) {
              badge.remove();
            }
          }
        }
      });
    }

    function openSettingsModal() {
      document.getElementById('modal-settings').classList.remove('hidden');
    }

    function closeSettingsModal() {
      document.getElementById('modal-settings').classList.add('hidden');
    }

    function browseDownloadFolder() {
      apiGet('/api/browse_folder').then(res => {
        if (res && res.folder) {
          document.getElementById('cfg-download-dir').value = res.folder;
        }
      });
    }

    function saveSettings() {
      const bash = document.getElementById('cfg-bash').value.trim();
      const qual = document.getElementById('cfg-quality').value.trim();
      const folder = document.getElementById('cfg-download-dir').value.trim();
      const confirm = document.getElementById('cfg-confirm').checked;
      
      const newCfg = {
        bash_path: bash,
        quality: qual,
        download_dir: folder,
        confirm_before_sync: confirm,
        anilist_token: config.anilist_token
      };
      
      apiPost('/api/save_config', newCfg).then(ok => {
        if (ok) {
          config = newCfg;
          closeSettingsModal();
          showNotification("Settings saved successfully", "success");
        }
      });
    }

    function openLoginModal() {
      document.getElementById('login-token').value = config.anilist_token || "";
      document.getElementById('modal-login').classList.remove('hidden');
    }

    function closeLoginModal() {
      document.getElementById('modal-login').classList.add('hidden');
    }

    function startAniListAuth() {
      apiGet('/api/auth_url');
    }

    function submitLogin() {
      const token = document.getElementById('login-token').value.trim();
      if (!token) {
        showNotification("Please paste a valid token", "error");
        return;
      }
      
      config.anilist_token = token;
      apiPost('/api/save_config', config).then(ok => {
        if (ok) {
          closeLoginModal();
          showNotification("AniList account linked", "success");
          loadConfig();
        }
      });
    }

    function openDownloadModal() {
      if (!selectedMedia) return;
      
      document.getElementById('dl-title').innerText = selectedMedia.title.english || selectedMedia.title.romaji;
      
      const watched = selectedMedia.mediaListEntry ? selectedMedia.mediaListEntry.progress || 0 : 0;
      const total = selectedMedia.episodes || 24;
      const defaultEp = watched < total ? watched + 1 : 1;
      
      document.getElementById('dl-input-from').value = selectedEpisode || defaultEp;
      document.getElementById('dl-input-to').value = total;
      document.getElementById('dl-input-season').value = 1;
      
      document.querySelector('input[name="dl-mode"][value="single"]').checked = true;
      toggleDlMode();
      
      document.getElementById('modal-download').classList.remove('hidden');
    }

    function toggleDlMode() {
      const mode = document.querySelector('input[name="dl-mode"]:checked').value;
      const toContainer = document.getElementById('dl-range-to-container');
      const fromLbl = document.getElementById('dl-lbl-from');
      
      const labels = document.querySelectorAll('.dl-mode-label');
      labels.forEach(lbl => {
        const input = lbl.parentElement.querySelector('input');
        if (input.checked) {
          lbl.className = "dl-mode-label text-center w-full py-0.5 rounded-md bg-[#6c5ce7] text-[#ffffff] shadow-sm";
        } else {
          lbl.className = "dl-mode-label text-center w-full py-0.5 rounded-md bg-transparent text-[#8b8e97]";
        }
      });

      if (mode === "range") {
        toContainer.classList.remove('hidden');
        fromLbl.innerText = "From Episode";
      } else {
        toContainer.classList.add('hidden');
        fromLbl.innerText = "Episode";
      }
    }

    function closeDownloadModal() {
      document.getElementById('modal-download').classList.add('hidden');
    }

    function startDownload() {
      if (!selectedMedia) return;
      
      const mode = document.querySelector('input[name="dl-mode"]:checked').value;
      const fromEp = parseInt(document.getElementById('dl-input-from').value) || 1;
      const season = parseInt(document.getElementById('dl-input-season').value) || 1;
      
      const total = selectedMedia.episodes || 24;
      let episodes = [];
      
      if (mode === "single") {
        episodes = [fromEp];
      } else if (mode === "range") {
        const toEp = parseInt(document.getElementById('dl-input-to').value) || total;
        for (let i = fromEp; i <= toEp; i++) episodes.push(i);
      } else {
        for (let i = 1; i <= total; i++) episodes.push(i);
      }
      
      const title = selectedMedia.title.english || selectedMedia.title.romaji;
      
      closeDownloadModal();
      openDownloadLogModal(title);
      
      apiPost('/api/start_download', {
        title: title,
        episodes: episodes,
        quality: config.quality,
        out_dir: config.download_dir,
        season_num: season
      }).then(res => {
        if (res && res.error) {
          addDownloadLog("✗ Initialization error: " + res.error);
          onDownloadFinished(false);
        }
      });
    }

    function openDownloadLogModal(title) {
      document.getElementById('dll-header').innerText = `Downloading — ${title}`;
      document.getElementById('dll-progress-txt').innerText = "Initializing process...";
      document.getElementById('dll-progress-pct').innerText = "0%";
      document.getElementById('dll-progress-fill').style.width = "0%";
      document.getElementById('dll-logs').innerText = "";
      
      document.getElementById('btn-dll-close').classList.add('hidden');
      document.getElementById('btn-dll-cancel').classList.remove('hidden');
      document.getElementById('modal-download-log').classList.remove('hidden');
    }

    function closeDownloadLogModal() {
      document.getElementById('modal-download-log').classList.add('hidden');
    }

    function addDownloadLog(msg) {
      const logs = document.getElementById('dll-logs');
      logs.innerText += msg + "\\n";
      logs.parentElement.scrollTop = logs.parentElement.scrollHeight;
    }

    function onDownloadProgress(current, total, text) {
      const pct = total > 0 ? Math.floor((current / total) * 100) : 0;
      document.getElementById('dll-progress-txt').innerText = text;
      document.getElementById('dll-progress-pct').innerText = `${pct}%`;
      document.getElementById('dll-progress-fill').style.width = `${pct}%`;
    }

    function onDownloadFinished(success) {
      document.getElementById('btn-dll-close').classList.remove('hidden');
      document.getElementById('btn-dll-cancel').classList.add('hidden');
      
      if (success) {
        showNotification("All episodes downloaded!", "success");
      } else {
        showNotification("Download ended or was cancelled.", "info");
      }
    }

    function stopDownload() {
      apiPost('/api/stop_download').then(() => {
        addDownloadLog("⚠ Stopping active processes... ");
        onDownloadFinished(false);
      });
    }

    function showNotification(msg, type = "success") {
      const toast = document.getElementById('toast');
      const icon = document.getElementById('toast-icon');
      const text = document.getElementById('toast-msg');
      
      icon.innerText = type === "success" ? "✓" : type === "error" ? "✗" : "ℹ";
      icon.className = type === "success" ? "text-green-400 font-bold" : type === "error" ? "text-red-400 font-bold" : "text-blue-400 font-bold";
      text.innerText = msg;
      
      toast.classList.remove('translate-y-[100px]', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');
      
      setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-[100px]', 'opacity-0');
      }, 3000);
    }
  </script>

</body>
</html>
"""

# ──────────────────────────────────────────────────────────────────────────────
# Main Application Bootstrapper
# ──────────────────────────────────────────────────────────────────────────────

def find_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def launch_edge_app(port):
    url = f"http://127.0.0.1:{port}"
    
    # Common Microsoft Edge install paths on Windows for App Mode
    paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        os.path.join(os.environ.get("LocalAppData", ""), r"Microsoft\Edge\Application\msedge.exe"),
        shutil.which("msedge")
    ]
    
    for p in paths:
        if p and os.path.exists(p):
            try:
                subprocess.Popen([p, f"--app={url}"])
                return
            except Exception:
                pass
                
    # Try Edge URI Scheme protocol handler (very reliable on Windows 10/11)
    try:
        subprocess.Popen(f'start microsoft-edge:{url}', shell=True)
        return
    except Exception:
        pass

    # Try standard explorer shell association (opens default browser)
    try:
        subprocess.Popen(["explorer.exe", url])
        return
    except Exception:
        pass

    # Generic browser open fallback
    try:
        subprocess.Popen(f'start {url}', shell=True)
        return
    except Exception:
        pass

    webbrowser.open(url)


if __name__ == "__main__":
    port = find_free_port()
    
    # Start the local server bound to 127.0.0.1
    server = HTTPServer(('127.0.0.1', port), AppRequestHandler)
    
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    
    print(f"Server started on http://127.0.0.1:{port}")
    
    # Launch browser window in app mode
    launch_edge_app(port)
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Shutting down...")
