# tLDw – Project Guide for Claude Code

## Project Overview

A Firefox browser extension that provides one-click YouTube video summarization. Users bring their own free Google Gemini API key (BYOK). No data collection, no tracking, fully private.

**Status:** Live on Firefox Add-ons Store (AMO) — v1.1.0
**Author:** pacochino
**License:** GPL v3.0
**Store URL:** https://addons.mozilla.org/firefox/addon/tldw/
**Repo:** https://github.com/pacochino/tldw
**Homepage:** https://pacochino.com

## Architecture

### How It Works
1. User visits a YouTube video page
2. `content.js` injects the tLDw widget into the YouTube UI
3. User clicks the summarize button
4. `background.js` fetches the transcript (multiple fallback methods)
5. Transcript + prompt sent to Gemini API
6. Summary rendered in the widget

### Tech Stack
- **Manifest:** V2 (Firefox)
- **Permissions:** `storage`, `tabs`, YouTube + Gemini + Google Fonts URLs
- **No build process** — all files are the source files
- **No frameworks** — vanilla JS only
- **No minification** — plain readable code

## File Structure

```
TLDW/
  manifest.json         # Extension manifest (MV2)
  background.js         # Transcript fetching + Gemini API calls
  content.js            # UI injection, widget, onboarding, theming
  styles.css            # Widget + YouTube page integration styles
  icons/
    icon-48.png
    icon-96.png
  settings/
    settings.html       # Options page
    settings.js         # API key mgmt, custom prompt, counter
  GPL3.0 License.txt
```

## Key Technical Details

### Transcript Fetching (background.js)
Four fallback methods in order:
1. YouTube innertube API
2. timedtext API
3. Watch page HTML parsing
4. Background tab DOM scraping

**Transcript limit:** 300,000 chars (~2-3 hours of video)
**API timeout:** Scales dynamically — `Math.min(60000, Math.max(15000, Math.round(prompt.length / 10)))`

**YouTube DOM (March 2026 update):** Transcript segments now use `transcript-segment-view-model` custom elements. Text is in `span.yt-core-attributed-string--link-inherit-color`, timestamps in `div.ytwTranscriptSegmentViewModelTimestamp`. Old `ytd-transcript-segment-renderer` selectors kept as fallback.

### Gemini Model Cascade (background.js)
Tries models in order, falls back on failure:
1. `gemini-2.5-flash-lite`
2. `gemini-2.0-flash-lite`
3. `gemini-2.5-flash`
4. `gemini-2.0-flash`

Supports up to 3 API keys with round-robin fallback.

### Storage Keys (browser.storage.local)
- `geminiApiKey` — primary API key (legacy single-key format)
- `geminiApiKeys` — array of up to 3 keys (current format)
- `tldwTheme` — selected color theme (persists across sessions)
- `customPrompt` — user-defined summary prompt
- `tldwSummaryCount` — lifetime summary counter
- `tldwHideCounter` — whether counter badge is hidden
- `tldwOpacity` — widget background translucency (0.2–1.0, default 1.0)
- `tldwPosition` — widget corner position (default `"bottom-right"`)

### Theming
Six themes: dark, light, blue, green, pink, orange.
Theme is loaded from storage on init and saved on selection.

### Widget State Machine (content.js)
States: `setup` → `idle` → `loading` → `summary` / `error` / `minimized` / `settings`
- `settingsPreviousState` tracks where to return when closing settings
- `lastSummaryRaw` holds the current summary text (null if none)

### Widget Position System (content.js)
- `POSITION_STYLES` map: 6 positions (`top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`)
- `FULLSCREEN_POSITION`: `bottom: 5px; right: 22%` (between corner and center, clears player controls)
- `applyPosition(widget)` — sets inline top/bottom/left/right/transform
- `applyOpacity(widget)` — injects `#tldw-translucency-style` `<style>` tag; overrides `.tldw-widget--expanded` background only with `rgba()` + `backdrop-filter: blur()`. Text and buttons remain fully opaque.
- Fullscreen: `isFullscreen` flag + `document.fullscreenchange` listener; `fullscreenDismissed` flag for the × dismiss button

### In-Widget Settings Screen (content.js)
Gear icon (⚙) on summary/error header opens settings. Clicking the idle pill also opens settings.
Settings sections:
- **About** — brief description
- **API Keys** — primary + 2 fallback inputs with Save
- **Custom Prompt** — textarea with Save / Reset
- **Preferences** — theme cycle, counter toggle, position picker (3×2 arrow grid), translucency & blur slider

Back button (yellow dot): returns to summary if one exists, otherwise closes the widget.

### AMO Compliance Notes
- **No innerHTML** — all DOM manipulation uses `createElement` / `textContent` / `appendChild`
- `el()` helper in content.js: `function el(tag, cls, txt)` — creates elements concisely
- `formatSummaryInto(container, text)` — DOM-based summary renderer (no innerHTML)
- `data_collection_permissions: { "required": ["none"] }` — declares no data collection

### Content Script Constraints
- No `innerHTML` assignments (AMO policy)
- No `eval()` or dynamic code execution
- ES5-compatible where possible
- `var` used in `showOnboarding()` DOM builder to avoid redeclaration conflicts with wire-up code

## Settings Page Features (settings/)
- API key input (primary + 2 fallbacks)
- Custom system prompt with reset-to-default
- Summary counter with reset + hide/show toggle
- Links: GitHub, pacochino.com, GPL v3.0

## Development Constraints

- **AMO policy:** No innerHTML, no eval, justified permissions only
- **MV2:** Using Manifest V2 (Firefox still supports it; MV3 migration not needed yet)
- **strict_min_version: 140.0** — required for `data_collection_permissions` field
- **Desktop only** — not targeting Android (Firefox for Android uses different extension model)
- **BYOK model** — extension never stores or transmits API keys except to Google's Gemini endpoint

## Packaging for AMO

Zip the contents (not the folder):

```powershell
# Run from inside the TLDW folder
Compress-Archive -Path .\* -DestinationPath ..\tldw.zip -Force
```

**Exclude before zipping:** `.claude/` directory, any `nul` files, `CLAUDE.md`

**AMO submission answers:**
- Source code required? **No** (no minifier, no bundler, no build process)
- Data collection? **None** (declared via `required: ["none"]` in manifest)

## Completed Work

### v1.0.0 — Initial Release (Feb 2026)
- One-click YouTube summarization via Gemini API (BYOK)
- 4-method transcript extraction with fallbacks
- 4-model Gemini cascade with multi-key fallback
- 6 color themes, persisted to storage
- Custom prompt support
- Summary counter
- Onboarding flow for new users
- AMO compliance: all innerHTML eliminated, DOM-only rendering
- Channel page sidebar button positioning
- Performance optimizations: pseudo-element gradient, specific CSS transitions, MutationObserver tuning, widget flicker fix

### v1.1.0 — QoL Update (Mar 2026)
- **YouTube DOM fix:** Updated transcript extraction for March 2026 YouTube UI (`transcript-segment-view-model`, new tab-click logic for videos with chapters, updated innertube clientVersion)
- **In-widget settings screen:** Gear icon (⚙) replaces tooltip; opens full settings panel inside the floating widget. Idle pill click also opens settings.
- **Widget position picker:** 6 positions (corners + top/bottom center), saved to storage
- **Translucency & blur:** Background-only opacity slider with proportional backdrop-filter blur (frosted glass effect); text/buttons remain opaque
- **Fullscreen auto-reposition:** Widget moves to `bottom: 5px; right: 22%` on fullscreen enter; restores on exit
- **Fullscreen dismiss button:** × badge on compact pill during fullscreen; widget restores automatically on exit
- **Home feed button:** Compact pill style (was full-width block); consistent with sidebar buttons

## If Returning to This Project

- Extension is live and stable — avoid unnecessary changes
- All files are plain source, no build step needed
- Test on YouTube by loading as temporary add-on: `about:debugging` → This Firefox → Load Temporary Add-on → select `manifest.json`
- AMO dashboard: https://addons.mozilla.org/developers/
