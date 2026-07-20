# AniGUI 🌸

AniGUI is a premium, beautifully-designed desktop anime companion app that merges the lightning-fast CLI streaming of `ani-cli` with a gorgeous, modern graphical interface. 

Built with Tauri 2 and Rust, AniGUI lets you browse trending anime, watch episodes directly on your desktop, and automatically sync your progress with your AniList account.

## ✨ Features

- **Real-Time Catalog:** Browse trending, highly-rated, and popular anime directly from AniList, or search the entire database instantly.
- **Lightning Fast Playback:** Seamlessly streams episodes via `ani-cli` directly into a native `mpv` video player window.
- **Downloads Manager:** Download entire batches of episodes to your hard drive and manage/play them natively from the built-in Downloads tab.
- **Exact-Second Resume:** Native Lua scripts track exactly where you close the video player. If you reopen the episode later, it instantly resumes from the exact second you left off!
- **Smart Auto-Sync (AniSkip integration):** Connect your AniList account, and AniGUI will automatically update your "Currently Watching" progress when you finish an episode. We use the AniSkip API to dynamically fetch the exact timestamp of the ending song, guaranteeing that your progress is only updated when you actually finish the episode!
- **Related Media:** Instantly jump to prequels, sequels, spin-offs, and movies from any anime's info page.

## 📦 Prerequisites (Windows)

Because AniGUI acts as a beautiful graphical shell for `ani-cli` and `mpv`, you must have them installed on your system. We highly recommend using **Scoop** to install them in one click.

1. **Install Git for Windows (Bash)**
   AniGUI relies on Git Bash to execute the streaming commands. 
   Download it here: [Git for Windows](https://git-scm.com/download/win)

2. **Install Scoop (Optional but recommended)**
   Open PowerShell and run:
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
   ```

3. **Install MPV and Ani-cli**
   Using Scoop, simply run:
   ```powershell
   scoop install mpv
   scoop install ani-cli
   ```

## 🚀 Installation & Running

The easiest way to install AniGUI is to download the latest pre-compiled binary:
1. Head over to the **[Releases](https://github.com/fbgs006/ani-gui/releases)** tab on this repository.
2. Download the latest `AniGUI-Portable.exe` (or the setup installer).
3. Ensure you have installed the Prerequisites (Git, MPV, Ani-cli) above.
4. Run the `.exe` and enjoy!

### Building from Source (For Developers)

1. Clone this repository.
2. Ensure you have [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/) installed.
3. Open a terminal in the `anigui-tauri/` folder.
4. Run `npm install` to install frontend dependencies.
5. Run `npm run tauri dev` to launch the app in development mode.

## ⚙️ Settings Setup

Once you launch AniGUI for the first time, click the **Settings ⚙️** icon in the bottom left corner:
1. Ensure the **Bash Path** is pointing to your `bash.exe` (usually `C:\Program Files\Git\bin\bash.exe`).
2. Log in with your **AniList Account** using the secure PIN method to enable progress syncing and the "Continue Watching" tab!
3. Toggle on **Auto-Sync Progress to AniList** to enable the smart AniSkip tracker.

## 🛠️ Architecture
- **Frontend:** TypeScript, HTML, Vanilla CSS (Custom Design System).
- **Backend:** Rust (Tauri), executing shell commands via Git Bash.
- **Tracking:** Native `mpv` Lua scripts communicating with the Rust backend via JSON AppData files.

---

*Note: This project is a collaboration between Human and AI. The Human (creator) acts as the Director and Project Manager—generating the ideas, making design decisions, and finding issues—while the AI acts as the Lead Developer, actively writing the code, building the app, and fixing the bugs.*

*Disclaimer: AniGUI is a graphical wrapper for ani-cli. It does not host or store any copyrighted video material.*
