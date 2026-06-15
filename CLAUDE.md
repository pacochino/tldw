# tLDw – Project Guide for Claude Code

## Project Overview

A Firefox browser extension that provides one-click YouTube video summarization. Users bring their own free Google Gemini API key (BYOK). No data collection, no tracking, fully private.

**Status:** Live on Firefox Add-ons Store (AMO) — v1.1.1
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

**YouTube DOM (2026):** Transcript segments use `transcript-segment-view-model` custom elements; timestamps in `.ytwTranscriptSegmentViewModelTimestamp`. The text element's class churns (it is NOT reliably `span.yt-core-attributed-string--link-inherit-color` — that `--link-inherit-color` modifier is link-styled text and often absent on plain transcript lines). `scrapeTranscriptFromDOM` (content.js) is therefore **structure-agnostic**: its `extractSegment()` helper finds the timestamp via a class-contains selector, tries a list of known text selectors, and falls back to *full segment textContent minus the timestamp* so it works regardless of the inner text class. Three tiers attempted in order: `transcript-segment-view-model` → legacy `ytd-transcript-segment-renderer` → generic `[class*='TranscriptSegment']` rows.

**PO-token gating (2025–2026) — why DOM scrape is now primary:** YouTube enforces a proof-of-origin (PO) token on the caption/`timedtext` endpoint, especially for the `WEB` innertube client. Without it the caption `baseUrl` (carries `exp=xpe`) returns **HTTP 200 with an empty body** — no error, just no text. This degrades methods 1–3 (innertube/timedtext/HTML-parse) intermittently. The in-page **DOM scrape** runs inside YouTube's own authenticated page, which already holds a valid PO token, so it is the most reliable path. On a watch page, `handleSummarize` races DOM scrape + API and the scrape usually wins; from the homepage feed/sidebar the API is tried first, then the **background-tab DOM scrape** fallback.

**Helper-tab transcript fetch — push model (background.js `getTranscriptViaBackgroundTab` + content.js `runHelperTabFetch`):** Used for the homepage feed/sidebar path where the clicked video isn't the current page. The scrape MUST run on a **focused, fully-rendered** tab — background tabs throttle JS timers (≥1s) and YouTube skips rendering the transcript panel when hidden, so any "scrape a hidden tab" approach is unreliable. Flow:
1. `background.js` opens `watch?v=ID#tldwfetch` with `active: true` (focused), and registers a one-shot `onMessage` listener for `TAB_TRANSCRIPT_RESULT`.
2. `content.js init()` detects the `#tldwfetch` hash, skips the normal widget, calls `runHelperTabFetch()`: shows a fixed banner ("Grabbing this video's transcript — sending you back…"), runs `getTranscriptFromPage`, then **pushes** `{ type:"TAB_TRANSCRIPT_RESULT", videoId, result, meta }` back.
3. `background.js` races that push against a **25s** hard timeout (`TAB_FETCH_TIMEOUT`). The moment the result arrives (typically ~2-5s) it switches focus back to the user's original tab and closes the helper — so the helper only lingers as long as the scrape actually takes, and **always** auto-returns (even on failure/timeout).

This replaced the earlier pull model (`SCRAPE_TRANSCRIPT` + `tryScrape` race), which scraped a backgrounded tab and lingered on per-attempt timeouts. **Tradeoff:** the user's active tab briefly switches to the helper tab during the scrape before being restored — the banner explains this.

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

Zip the contents (not the folder), with the manifest at the archive root.

> ⚠️ **Do NOT use `Compress-Archive`.** Windows PowerShell 5.1 writes `\` path
> separators inside the zip, and AMO rejects them with
> *"Invalid file name in archive: icons\icon-48.png"*. Use the .NET `ZipArchive`
> API and force forward slashes:

```powershell
# Run from anywhere — paths are absolute
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = "C:\Users\chino\MCP\260105PLAYGROUND\TLDW"
$zip  = "C:\Users\chino\MCP\260105PLAYGROUND\tldw-1.1.1.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
$files = @(
  "manifest.json","background.js","content.js","styles.css",
  "README.md","LICENSE","GPL3.0 License.txt",
  "icons\icon-48.png","icons\icon-96.png",
  "settings\settings.html","settings\settings.js"
)
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, (Join-Path $root $f), ($f -replace '\\','/')) | Out-Null
  }
} finally { $archive.Dispose() }
```

This explicit allowlist also handles exclusions — dev-only files (`.claude/`, `.git/`, `CLAUDE.md`, any `nul`) are simply never added. Bump `$zip` and `manifest.json` `version` per release.

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

### v1.1.1 — Transcript Reliability Fix (Jun 2026)
- **Helper-tab fetch rewritten to a push model (root cause of homepage-feed failures):** the old flow scraped a *backgrounded* tab — YouTube throttles JS and skips rendering the transcript panel when a tab is hidden, so it frequently failed and needed a manual second tab-click. New flow opens the helper tab **focused**, the content script scrapes the fully-rendered page and **pushes** the result back, then background.js auto-returns the user to their original tab the instant it arrives (or after a 25s cap). See "Helper-tab transcript fetch" above.
- **User-facing banner** on the helper tab (styled to match the widget: dark rounded card, Sixtyfour `tLDw` logo, blinking-dot loading animation) explaining it's temporary and will return them.
- **Structure-agnostic transcript scraper:** `scrapeTranscriptFromDOM` no longer depends on the exact text-span class (which YouTube renames); it subtracts the timestamp from each segment's textContent. Fixes "Transcript panel opened but no text found" when the panel was clearly rendered.
- **Guaranteed auto-return** — original tab is always restored and helper closed, even on failure/timeout (no more lingering).
- **Bumped stale innertube clientVersion** `2.20250101.00.00` → `2.20260101.00.00`.
- **Context:** YouTube's PO-token gating on the caption endpoint (see Transcript Fetching above) is the underlying reason the API methods degraded; the fix leans on the DOM scrape (PO-token-immune, runs in YouTube's own authenticated page). No client swap (WEB→ANDROID) — the PO gate is on the caption `baseUrl` fetch, not the client list call, so a swap wouldn't bypass it.

## If Returning to This Project

- Extension is live and stable — avoid unnecessary changes
- All files are plain source, no build step needed
- Test on YouTube by loading as temporary add-on: `about:debugging` → This Firefox → Load Temporary Add-on → select `manifest.json`
- AMO dashboard: https://addons.mozilla.org/developers/
