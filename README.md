# MonstersGame — Highscore Comparator

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Userscript-blue?logo=tampermonkey)](https://www.tampermonkey.net/)
[![Version](https://img.shields.io/badge/version-4.2.5-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()
[![Platform](https://img.shields.io/badge/platform-Browser%20RPG-orange)]()

An advanced userscript for the browser RPG **MonstersGame** (moonid.net) that turns the Highscore page into a complete monitoring, comparison, and history system.

---

## 📌 About the Project

The **Highscore Comparator** automatically detects changes in player statistics every time the ranking page is visited. It compares the current state with the last valid snapshot (respecting a minimum interval of ~55 minutes), generates a visual panel with the changes, stores the history locally via IndexedDB, and produces high-resolution snapshots that are automatically uploaded to ImgBB.

Ideal for players and guilds who want to track ranking evolution accurately and visually.

---

## ✨ Features

### 📊 Real-Time Comparison
- Detects changes in **Loots**, **Gold**, **Ancestrals**, **Victories**, and **Defeats**
- Calculates position variation (up / down / stable)
- Highlights new players in the range
- Smart sorting by relevance of changes

### 📋 Data Panel
- Displays the top 20 changes for the current range
- Tooltips with full descriptions for each indicator
- Aggregate counters (rose, fell, new players, total stats)
- Click any player to scroll to them in the original table
- Floating back-to-panel button

### 🗄️ Persistent History (IndexedDB)
- Local storage by server + position range
- Up to 60 snapshots per range
- Minimum 55-minute interval between comparisons
- Data persists across sessions and page reloads

### 🖼️ High-Resolution Snapshots
- Image generation at **3× scale** (up to 8400×3300 px)
- Two snapshot types:
  - **Comparison** — detailed table with all variations
  - **Panel** — summary view with totals and top movements
- Automatic upload via Cloudflare Worker → ImgBB
- High-quality, medium, and thumbnail URLs

### 🗂️ Album / Gallery
- View all saved snapshots
- Tabs: Comparisons · Panels · Data
- Rename and delete snapshots
- Medium-quality preview + open original full-size image

### 🎛️ Tools Bar
- Position control with **🔼 / 🔽** buttons (above the table or above the panel)
- State persisted in `localStorage`
- Quick-access buttons: Album, Panel, Regenerate Images
- Real-time upload status

### 📱 Interface & UX
- Dark theme matching MonstersGame aesthetics
- Panel minimization
- Fully responsive (desktop, tablet, and mobile)
- No unwanted horizontal scrollbars
- Mouse and touchscreen compatible

---

## 🛠️ Technologies

| Technology       | Usage                                    |
|------------------|------------------------------------------|
| Tampermonkey     | Userscript execution                     |
| IndexedDB        | History persistence                      |
| SVG + Canvas     | High-resolution image generation         |
| Cloudflare Worker| Upload proxy to ImgBB                    |
| ImgBB API        | Image hosting                            |
| CSS Grid / Flex  | Responsive layout                        |
| Pointer Events   | UI interactions                          |

---

## 📥 Installation

1. Install the **[Tampermonkey](https://www.tampermonkey.net/)** extension in your browser
2. Create a new script
3. Paste the full content of `monstersgame-highscore-comparision.js`
4. Save and enable the script
5. Visit any Highscore page on MonstersGame

The script runs automatically (`@run-at document-end`).

---

## 🚀 How to Use

1. Open the **Highscore** page of the desired server
2. The comparison panel and tools bar appear automatically
3. Wait at least **1 hour** between visits to the same range to generate comparisons
4. Use the tools bar to:
   - Move the bar position
   - Open the snapshot album
   - Regenerate images
5. Click a player in the panel to jump to them in the table
6. In the album, click an image to open the full-resolution version

---

## 📁 Data Structure

Each stored snapshot contains:

```json
{
  "id": "server|range|timestamp",
  "server": "hostname",
  "range": "1-50",
  "ts": 1790116650154,
  "title": "Comparison 22/09/2026 19:30",
  "records": [ /* player data */ ],
  "baselineTs": 1790110000000,
  "images": {
    "comparison": { "url": "...", "medium": "...", "thumbnail": "..." },
    "panel": { "url": "...", "medium": "...", "thumbnail": "..." }
  },
  "upload": {
    "comparison": "ok",
    "panel": "ok"
  }
}
