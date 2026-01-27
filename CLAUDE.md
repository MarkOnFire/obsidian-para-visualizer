# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PARA Visualizer is a desktop-only Obsidian plugin that provides 12 interactive visualizations for vaults organized using the PARA method (Projects, Areas, Resources, Archive). It has a soft dependency on the Quick PARA plugin for `para` and `para_history` frontmatter properties.

## Development Model

This is a **pre-compiled, single-file plugin** — there is no build step, no npm dependencies, no TypeScript, and no bundler. The entire plugin lives in `main.js` (vanilla JavaScript), `styles.css`, and `manifest.json`.

### Deployment (no build required)

```bash
# First time: configure vault paths (stored in .env.local, gitignored)
./deploy.sh --setup

# Deploy to test vault (default)
./deploy.sh

# Deploy to production vault
./deploy.sh --prod

# Deploy to both
./deploy.sh --both
```

After deploying, toggle the plugin off/on in Obsidian Settings or restart Obsidian.

### CI/CD

The GitHub Actions workflow (`.github/workflows/build.yml`) only validates that `main.js`, `manifest.json`, and `styles.css` exist and that `manifest.json` is valid JSON. There is no compilation or test suite.

## Architecture

### Single-file structure

All plugin logic is in `main.js` (~3,000 lines). There are two classes and three constant objects:

- **`PARA_COLORS`** (line 5) — color scheme for the five PARA locations
- **`DEFAULT_REVIEW_INTERVALS`** (line 14) — review cadence defaults per PARA location (in days)
- **`PARAVisualizerView`** (extends `ItemView`) — contains all data collection, rendering, and interaction logic
- **`PARAVisualizerPlugin`** (extends `Plugin`) — entry point: registers the view, ribbon icon, and commands; checks mobile and dependencies

### Data flow

1. `collectVaultData()` scans all markdown files, builds `this.vaultData` (notes array, tags Map, paraLocations object, activity Map, links array, tasks object)
2. `updateCurrentNoteData()` builds `this.currentNoteData` for the active file (incoming/outgoing links, siblings, related-by-tag)
3. `render()` dispatches to one of 12 `render*()` methods based on `this.scope` (vault/note) and `this.currentView`
4. Event listeners on `active-leaf-change`, `modify`, `rename`, `delete` trigger re-collection or re-render

### Visualization renderers

**Vault scope (9):** `renderHeatmap`, `renderGraph`, `renderSankey`, `renderTaskAnalytics`, `renderReviewRadar`, `renderPipelineTimeline`, `renderTaskCalendar`, `renderTagCloud`, `renderStats`

**Note scope (3):** `renderNoteContext`, `renderNoteHistory`, `renderNoteTasks`

Canvas API is used for the force-directed graph, radar chart, Sankey diagram, and task velocity chart. All other visualizations use DOM elements.

### DOM creation pattern

Uses Obsidian's DOM API (`container.createDiv()`, `createEl()`, `createSpan()`) for structure, CSS classes for static styles, and inline styles for dynamic properties (colors, sizes). Complex layouts sometimes use `innerHTML`.

### Key Obsidian APIs used

- `metadataCache.getFileCache(file)` — frontmatter, links, tags
- `vault.read(file)` — raw file content (used for task parsing)
- `vault.getMarkdownFiles()` — enumerate all notes
- `workspace.getActiveFile()` / `workspace.openLinkText()` — navigation
- `plugins.plugins` / `plugins.enabledPlugins` — Quick PARA dependency check

## Conventions

- **Mobile disabled:** Plugin returns early on `this.app.isMobile` with a Notice
- **No external dependencies:** Everything is vanilla JS and Canvas API
- **Frontmatter contract:** Expects `para` property for PARA location, `para_history` for movement tracking, optional `review_interval`/`review_every`/`review` for custom review cadence
- **Task parsing:** Regex-based extraction of `- [ ]`/`- [x]` with emoji date markers (`📅` due, `✅` completed, `➕` created)
- **System tags filtered:** Tags named `all`, `inbox`, `projects`, `areas`, `resources`, `archive` are excluded from tag cloud and related-by-tag calculations
- **Time range:** Default 90 days, configurable via UI (30d, 90d, 180d, 365d, all)

## Adding a New Visualization

1. Add a tab entry to the `tabs` array in `renderTabs()`
2. Add a case to the switch in `render()`
3. Create a `render*()` method on `PARAVisualizerView`
4. Add corresponding `.para-*` CSS classes to `styles.css`
