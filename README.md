# AniGUI

AniGUI is a desktop anime companion app for browsing, watching, downloading, and syncing progress with AniList. The repository combines a Tauri 2 application with a small Python prototype and a UI redesign mockup, so the public GitHub page shows the full evolution of the project instead of only the finished app.

This project is AI-assisted and human-managed: AI helped with parts of the implementation and documentation, while the structure, review, and ongoing decisions are guided by a person.

## What this repo contains

- `anigui-tauri/` - the main Tauri app built with Rust, TypeScript, HTML, and CSS
- `anicli_gui.py` - an earlier Python-based GUI prototype
- `anigui_redesign.html` - a visual mockup used while shaping the interface

## Main features

- Browse trending anime and search the catalog in real time
- Connect an AniList account for watch progress and status sync
- Play episodes through ani-cli and mpv from the desktop app
- Download episodes directly to a chosen folder
- See related anime entries such as sequels, prequels, movies, and spin-offs

## Requirements

| Tool | Purpose |
|---|---|
| [Git for Windows](https://git-scm.com/download/win) | Provides the bash shell ani-cli expects on Windows |
| [ani-cli](https://github.com/pystardust/ani-cli) | Streams and downloads episodes |
| [mpv](https://mpv.io/) | Video player used by ani-cli |
| [Node.js LTS](https://nodejs.org/) | Frontend tooling for the Tauri app |
| [Rust](https://rustup.rs/) | Backend and Tauri build toolchain |
| [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | Native build support on Windows |

## Running locally

1. Open a terminal in `anigui-tauri/`.
2. Install dependencies with `npm install`.
3. Start development mode with `npm run tauri dev`.

The first launch takes longer because Rust dependencies must compile. Later launches are much faster.

## Project layout

| Path | Description |
|---|---|
| `anigui-tauri/src/` | Frontend app code and styles |
| `anigui-tauri/src-tauri/` | Rust backend for the desktop shell |
| `anicli_gui.py` | Python prototype retained for reference |
| `anigui_redesign.html` | UI concept and layout exploration |

## Notes

- AniList login and token handling are managed from inside the app.
- Episode playback relies on a valid bash path on Windows, usually from Git for Windows.
- If you publish screenshots on GitHub, add them under a new `assets/` or `docs/` folder and reference them from this readme.
