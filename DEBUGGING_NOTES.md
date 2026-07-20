# AniGUI: Debugging Notes for Exact-Second Resume & Auto-Sync

If you are reading this, you are likely looking into why the **Exact-Second Resume** or **Auto-Sync (AniSkip)** features are failing to track progress correctly on certain Windows setups (specifically when `mpv` is installed via Scoop). 

Here is a complete breakdown of how the systems are implemented and where they might be failing.

## 1. Exact-Second Resume (The MPV Tracker)

Since `ani-cli` wraps `mpv` and does not easily allow us to extract `time-pos` via stdout, we implemented a native MPV Lua script to track timestamps.

### How it works:
1. On startup, the Rust backend (`lib.rs: install_mpv_script`) scans the system `PATH` to find `mpv.exe`.
2. It checks if `mpv` uses a `portable_config` directory (common with Scoop installations). If it does, it installs the `anigui-tracker.lua` script into `portable_config/scripts/`. Otherwise, it falls back to `%APPDATA%\mpv\scripts\`.
3. When `mpv` launches, the Lua script runs. It reads and writes to two JSON files located in `%APPDATA%\AniGUI`:
   - `timestamps.json`: Tracks the `time-pos` for the current `media-title`. If the user plays the same title later, the Lua script instantly seeks to this absolute timestamp.
   - `last_watched.json`: Whenever the player is closed or updated, it writes `{ percent: number, duration: number, time: number }`.

### Why it might be failing:
- **Sandbox / Permission Issues:** If `mpv` is installed via Scoop, it might be running in an environment that restricts Lua native `io.open` or `os.execute("mkdir ...")` calls. If the Lua script silently fails to create or write to `%APPDATA%\AniGUI\timestamps.json`, tracking will not work.
- **Title Mismatch:** `ani-cli` uses regex to strip special characters from the video title. If the title changes slightly between runs, the Lua script won`t recognize the `media-title` key in the JSON file.

---

## 2. Auto-Sync & AniSkip Integration

The Auto-Sync feature automatically updates the users AniList progress (and marks the anime as `CURRENT`) when they finish an episode.

### How it works:
1. When the user closes the player, `ani-cli` exits, and the Rust backend fires the `playback_finished` event to the frontend (`main.ts`).
2. Before firing the event, Rust reads `%APPDATA%\AniGUI\last_watched.json` to get the `percent` and `time` variables that the Lua script just saved.
3. The frontend receives these values. It then attempts to fetch the exact Outro (ED) start time from the **AniSkip API** (`https://api.aniskip.com/v2/skip-times/{idMal}/{epNum}?types=ed&episodeLength=0`).
4. If the users `time` is within 10 seconds of the AniSkip ED start time, it considers the episode "Finished" and syncs to AniList.
5. If AniSkip fails or returns no data, it falls back to checking if `percent > 0.85` (85% of the file duration).

### Why it might be failing:
- **Missing `last_watched.json`:** As mentioned above, if the Lua script fails to write to the `AniGUI` AppData folder, Rust will read `percent` and `time` as `0.0`. Since `0.0` is neither > 85% nor past the AniSkip outro, it silently aborts the sync.
- **AniSkip Episode Length Mismatch:** `ani-cli` scrapes raw `.m3u8` streams. These web rips often have different durations than the official TV broadcasts (due to missing sponsors or different padding). Because we query AniSkip with `episodeLength=0`, AniSkip might refuse to return a timestamp if the stream duration doesnt perfectly match its database hash.

## Next Steps for Debugging:
1. Open the MPV console (press `~` during playback) to see if `anigui-tracker.lua` is throwing permission errors when calling `io.open`.
2. Check if `%APPDATA%\AniGUI\last_watched.json` actually exists on the filesystem and is updating in real-time.
3. Add `console.log` inside the `playback_finished` listener in `main.ts` to see what `timePos` and `percent` the Rust backend is actually sending.
