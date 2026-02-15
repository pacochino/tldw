// TLDW - Content Script
// Injects TLDW buttons into YouTube pages and handles floating widget UI

(function () {
  const BUTTON_CLASS = "tldw-btn";
  const WIDGET_ID = "tldw-widget";
  let debounceTimer = null;

  // --- Widget State ---
  // "setup"    → first-run, light blue, click opens onboarding
  // "idle"     → red pill "tLDw", no summary yet
  // "loading"  → spinner in widget, fetching transcript/summary
  // "summary"  → expanded widget showing summary
  // "error"    → expanded widget showing error
  // "minimized"→ collapsed pill after user minimizes
  let widgetState = "idle";
  let lastSummaryRaw = null;
  let lastVideoMeta = null; // { title, channel, views, date }
  // Theme system: dark (default), light, green, blue, pink, orange
  const THEMES = ["dark", "light", "green", "blue", "pink", "orange"];
  const THEME_COLORS = {
    dark:   { accent: "#888",    star: "#888" },
    light:  { accent: "#999",    star: "#999" },
    green:  { accent: "#7dcea0", star: "#7dcea0" },
    blue:   { accent: "#7db8e0", star: "#7db8e0" },
    pink:   { accent: "#e091b8", star: "#e091b8" },
    orange: { accent: "#e0a870", star: "#e0a870" }
  };
  let currentTheme = "dark";
  let hasApiKey = false; // tracks whether API key is configured
  let loadingTimerInterval = null; // elapsed timer for loading state
  let loadingTimerStart = 0; // timestamp when loading started
  let lastElapsedTime = null; // final elapsed time string for summary pill
  let lastModelName = null; // which Gemini model answered
  let totalSummaryCount = 0; // lifetime counter loaded from storage
  let hideCounter = false; // whether to hide the counter badge
  let hasRenderedExpanded = false; // tracks if expanded widget was already shown (skip re-animation)

  // --- Inject Sixtyfour font ---
  function injectFont() {
    if (document.getElementById("tldw-sixtyfour-font")) return;
    const link = document.createElement("link");
    link.id = "tldw-sixtyfour-font";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Sixtyfour&display=swap";
    document.head.appendChild(link);
  }

  // --- Stacked Logo DOM (for floating corner pills only) ---
  // Creates the 2-row "tL / Dw" square logo used on idle, setup, minimized pills
  function createLogo(sizeClass) {
    const logo = document.createElement("span");
    logo.className = sizeClass ? "tldw-logo " + sizeClass : "tldw-logo";
    const row1 = document.createElement("span");
    row1.className = "tldw-logo-row";
    row1.textContent = "tL";
    const row2 = document.createElement("span");
    row2.className = "tldw-logo-row";
    row2.textContent = "Dw";
    logo.appendChild(row1);
    logo.appendChild(row2);
    return logo;
  }

  // --- Horizontal Logo DOM (for header, buttons) ---
  function createLogoHorizontal(sizeClass) {
    const logo = document.createElement("span");
    logo.className = sizeClass ? "tldw-logo-h " + sizeClass : "tldw-logo-h";
    logo.textContent = "tLDw";
    return logo;
  }

  // --- Initialization ---

  function init() {
    injectFont();

    const observer = new MutationObserver((mutations) => {
      // Early exit: only react to mutations that could contain video renderers
      let dominated = false;
      for (let i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) { dominated = true; break; }
      }
      if (!dominated) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(injectButtons, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Load lifetime summary count, visibility, and theme preference
    browser.storage.local.get(["tldwSummaryCount", "tldwHideCounter", "tldwTheme"]).then((result) => {
      totalSummaryCount = result.tldwSummaryCount || 0;
      hideCounter = result.tldwHideCounter || false;
      if (result.tldwTheme && THEMES.indexOf(result.tldwTheme) !== -1) {
        currentTheme = result.tldwTheme;
      }
    });

    // Check if API key is set — if not, show setup state
    browser.storage.local.get(["geminiApiKey", "geminiApiKeys"]).then((result) => {
      const hasKey = !!(result.geminiApiKey || (result.geminiApiKeys && result.geminiApiKeys.some(k => k && k.length >= 10)));
      if (!hasKey) {
        widgetState = "setup";
        hasApiKey = false;
      } else {
        hasApiKey = true;
      }
      createWidget();
    });

    // Listen for storage changes (user saves API key in onboarding or settings)
    browser.storage.onChanged.addListener((changes) => {
      if ((changes.geminiApiKey && changes.geminiApiKey.newValue) ||
          (changes.geminiApiKeys && changes.geminiApiKeys.newValue && changes.geminiApiKeys.newValue.some(k => k && k.length >= 10))) {
        hasApiKey = true;
        enableAllTldwButtons();
        if (widgetState === "setup") {
          widgetState = "idle";
          updateWidget();
        }
      }
      // Update counter visibility/value in real time (targeted, no full rebuild)
      if (changes.tldwHideCounter !== undefined) {
        hideCounter = changes.tldwHideCounter.newValue || false;
        updateCounterBadge();
      }
      if (changes.tldwSummaryCount !== undefined) {
        totalSummaryCount = changes.tldwSummaryCount.newValue || 0;
        updateCounterBadge();
      }
    });

    injectButtons();
    setTimeout(injectButtons, 2000);
    setTimeout(injectButtons, 5000);

    window.addEventListener("yt-navigate-finish", () => {
      // Reset widget on navigation (but keep setup state if no API key)
      hasRenderedExpanded = false;
      browser.storage.local.get(["geminiApiKey", "geminiApiKeys"]).then((result) => {
        const hasKey = !!(result.geminiApiKey || (result.geminiApiKeys && result.geminiApiKeys.some(k => k && k.length >= 10)));
        if (!hasKey) {
          widgetState = "setup";
          hasApiKey = false;
        } else {
          widgetState = "idle";
          hasApiKey = true;
        }
        lastSummaryRaw = null;
        lastVideoMeta = null;
        updateWidget();
      });
      setTimeout(injectButtons, 1500);
    });

    // Listen for SCRAPE_TRANSCRIPT messages from background script
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "SCRAPE_TRANSCRIPT") {
        handleScrapeTranscript(message.videoId).then(sendResponse);
        return true;
      }
      if (message.type === "SCRAPE_META") {
        sendResponse(scrapeVideoMeta());
        return false;
      }
    });
  }

  async function handleScrapeTranscript(videoId) {
    try {
      const result = await getTranscriptFromPage(videoId);
      return result;
    } catch (e) {
      return { ok: false, error: "Scrape failed: " + e.message };
    }
  }

  // --- Video Metadata Scraping ---
  // Pulls title, channel name, view count, and upload date from YouTube's DOM

  function scrapeVideoMeta() {
    const meta = { title: "", channel: "", views: "", date: "" };

    try {
      // Title
      const titleEl =
        document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
        document.querySelector("h1.title yt-formatted-string") ||
        document.querySelector("#title h1 yt-formatted-string") ||
        document.querySelector("ytd-watch-metadata h1");
      if (titleEl) meta.title = titleEl.textContent.trim();

      // Channel name
      const channelEl =
        document.querySelector("#owner #channel-name a") ||
        document.querySelector("ytd-channel-name a") ||
        document.querySelector("#upload-info #channel-name a") ||
        document.querySelector("#owner ytd-channel-name yt-formatted-string a");
      if (channelEl) meta.channel = channelEl.textContent.trim();

      // View count + date (YouTube shows "X views · Y ago" in the info area)
      const infoEl = document.querySelector("#info-strings yt-formatted-string");
      if (infoEl) {
        // e.g. "1,234,567 views  Jan 15, 2026"
        const text = infoEl.textContent.trim();
        meta.views = text; // keep the full string, it has both
      } else {
        // Try individual selectors
        const viewEl =
          document.querySelector("ytd-watch-info-text span.bold:first-child") ||
          document.querySelector("#count .ytd-video-view-count-renderer");
        if (viewEl) meta.views = viewEl.textContent.trim();

        const dateEl =
          document.querySelector("ytd-watch-info-text span:nth-child(3)") ||
          document.querySelector("#info-strings span:last-child") ||
          document.querySelector("#date yt-formatted-string");
        if (dateEl) meta.date = dateEl.textContent.trim();
      }

      // Fallback: scrape from description area info
      if (!meta.views || !meta.date) {
        const infoSpans = document.querySelectorAll("#info-text span, ytd-watch-info-text span");
        infoSpans.forEach((span) => {
          const t = span.textContent.trim();
          if (t.includes("view")) meta.views = meta.views || t;
          if (t.includes("ago") || /\d{4}/.test(t)) meta.date = meta.date || t;
        });
      }
    } catch (e) {
      // Non-critical — summary still works without metadata
    }

    return meta;
  }

  // --- Transcript Extraction via DOM Scraping ---

  async function getTranscriptFromPage(videoId) {
    try {
      let transcript = scrapeTranscriptFromDOM();
      if (transcript) return { ok: true, transcript };

      await expandDescription();

      // Adaptive backoff: short initial intervals, longer as retries increase
      let transcriptBtn = null;
      var buttonDelays = [200, 300, 500, 800, 1000, 1000];
      for (let i = 0; i < buttonDelays.length; i++) {
        transcriptBtn = findTranscriptButton();
        if (transcriptBtn) break;
        await sleep(buttonDelays[i]);
      }

      if (!transcriptBtn) {
        return { ok: false, error: "No transcript button found on page." };
      }

      const panelWasVisible = isTranscriptPanelVisible();
      transcriptBtn.click();

      // Adaptive content polling: starts fast, backs off
      var contentDelays = [150, 250, 400, 600, 800, 1000, 1200, 1500];
      for (let attempt = 0; attempt < contentDelays.length; attempt++) {
        await sleep(contentDelays[attempt]);
        transcript = scrapeTranscriptFromDOM();
        if (transcript) {
          if (!panelWasVisible) closeTranscriptPanel();
          return { ok: true, transcript };
        }
      }

      if (!panelWasVisible) closeTranscriptPanel();
      return { ok: false, error: "Transcript panel opened but no text found." };
    } catch (e) {
      return { ok: false, error: "DOM transcript extraction failed: " + e.message };
    }
  }

  async function expandDescription() {
    try {
      const expandSelectors = [
        'tp-yt-paper-button#expand',
        '#description-inline-expander tp-yt-paper-button',
        '#expand',
        'ytd-text-inline-expander #expand',
        '#snippet #expand',
        'button[aria-label="Show more"]'
      ];
      for (const sel of expandSelectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          await sleep(300);
          return;
        }
      }
      const desc = document.querySelector(
        'ytd-watch-metadata #description-inline-expander, #meta #description'
      );
      if (desc) {
        desc.click();
        await sleep(300);
      }
    } catch (e) { }
  }

  function findTranscriptButton() {
    const allButtons = document.querySelectorAll("button, ytd-button-renderer");
    for (const btn of allButtons) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === "show transcript") {
        const innerBtn = btn.querySelector("button");
        return innerBtn || btn;
      }
    }
    const ariaBtn = document.querySelector('button[aria-label*="transcript" i]');
    if (ariaBtn) return ariaBtn;
    return null;
  }

  function isTranscriptPanelVisible() {
    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]'
    );
    if (!panel) return false;
    return panel.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
  }

  function closeTranscriptPanel() {
    try {
      const panel = document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]'
      );
      if (panel) {
        const closeBtn = panel.querySelector(
          '#visibility-button button, button[aria-label="Close"]'
        );
        if (closeBtn) closeBtn.click();
      }
    } catch (e) { }
  }

  function scrapeTranscriptFromDOM() {
    const segments = document.querySelectorAll("ytd-transcript-segment-renderer");
    if (segments.length === 0) return null;

    const textParts = [];
    const seen = new Set();

    segments.forEach((seg) => {
      const textEl =
        seg.querySelector(".segment-text") ||
        seg.querySelector("yt-formatted-string:not(.segment-timestamp)");
      const timeEl =
        seg.querySelector(".segment-timestamp") ||
        seg.querySelector("yt-formatted-string.segment-timestamp");

      if (textEl) {
        const text = textEl.textContent.trim();
        const timestamp = timeEl ? timeEl.textContent.trim() : "";
        if (text.length > 0 && !seen.has(text)) {
          seen.add(text);
          if (timestamp) {
            textParts.push("[" + timestamp + "] " + text);
          } else {
            textParts.push(text);
          }
        }
      }
    });

    if (textParts.length === 0) return null;
    return textParts.join("\n");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Resolves with the first promise that fulfills; rejects only if ALL reject
  function firstSuccess(promises) {
    return new Promise((resolve, reject) => {
      var rejectCount = 0;
      var errors = [];
      for (var i = 0; i < promises.length; i++) {
        promises[i].then(resolve).catch(function (err) {
          errors.push(err);
          rejectCount++;
          if (rejectCount === promises.length) {
            reject(new Error(errors.join("; ")));
          }
        });
      }
    });
  }

  // --- Button Injection ---

  function injectButtons() {
    if (isWatchPage()) {
      injectWatchPageButton();
      injectSidebarButtons();
    }
    injectFeedButtons();
    injectChannelButtons();
  }

  function isWatchPage() {
    return location.pathname === "/watch";
  }

  function isChannelPage() {
    return location.pathname.startsWith("/@") || location.pathname.startsWith("/channel/") || location.pathname.startsWith("/c/");
  }

  function injectFeedButtons() {
    const onChannel = isChannelPage();
    const renderers = document.querySelectorAll("ytd-rich-item-renderer");
    renderers.forEach((renderer) => {
      if (renderer.querySelector("." + BUTTON_CLASS)) return;
      if (renderer.querySelector("ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer")) return;

      const link = renderer.querySelector('a#thumbnail[href*="/watch?v="], a[href*="/watch?v="]:not([href*="googleadservices"])');
      if (!link) return;

      const videoId = extractVideoIdFromHref(link.href);
      if (!videoId) return;

      // On channel pages, use compact sidebar-style buttons
      if (onChannel) {
        const lockupMeta = renderer.querySelector("yt-lockup-metadata-view-model");
        if (lockupMeta) {
          const btn = createButton(videoId);
          btn.classList.add("tldw-btn-sidebar");
          btn.dataset.sidebar = "1";
          lockupMeta.appendChild(btn);
          return;
        }
        const meta = renderer.querySelector("#meta, #metadata, #details #meta");
        if (meta) {
          const btn = createButton(videoId);
          btn.classList.add("tldw-btn-sidebar");
          btn.dataset.sidebar = "1";
          meta.style.position = "relative";
          meta.appendChild(btn);
          return;
        }
      }

      const placed = tryPlaceButton(renderer, videoId);
      if (!placed) tryPlaceButtonNewLayout(renderer, videoId);
    });

    const videoRenderers = document.querySelectorAll("ytd-video-renderer");
    videoRenderers.forEach((renderer) => {
      if (renderer.querySelector("." + BUTTON_CLASS)) return;

      const link = renderer.querySelector('a[href*="/watch?v="]:not([href*="googleadservices"])');
      if (!link) return;

      const videoId = extractVideoIdFromHref(link.href);
      if (!videoId) return;

      const menu = renderer.querySelector("#menu");
      if (menu && menu.parentElement) {
        const btn = createButton(videoId);
        menu.parentElement.insertBefore(btn, menu);
      } else {
        const meta = renderer.querySelector("#meta, #metadata");
        if (meta) {
          const btn = createButton(videoId);
          meta.appendChild(btn);
        }
      }
    });
  }

  // --- Sidebar Recommendations (watch page right column) ---
  function injectSidebarButtons() {
    // YouTube's sidebar uses yt-lockup-view-model (new layout) or ytd-compact-video-renderer (legacy)
    const selectors = [
      "ytd-watch-next-secondary-results-renderer yt-lockup-view-model",
      "ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer",
      "#secondary yt-lockup-view-model",
      "#secondary ytd-compact-video-renderer",
      "#related yt-lockup-view-model",
      "#related ytd-compact-video-renderer"
    ];
    const sidebarRenderers = document.querySelectorAll(selectors.join(", "));

    sidebarRenderers.forEach((renderer) => {
      if (renderer.querySelector("." + BUTTON_CLASS)) return;

      const link = renderer.querySelector('a[href*="/watch?v="]:not([href*="googleadservices"])');
      if (!link) return;

      const videoId = extractVideoIdFromHref(link.href);
      if (!videoId) return;

      // New layout: yt-lockup-view-model → yt-lockup-metadata-view-model
      const lockupMeta = renderer.querySelector("yt-lockup-metadata-view-model");
      if (lockupMeta) {
        const btn = createButton(videoId);
        btn.classList.add("tldw-btn-sidebar");
        btn.dataset.sidebar = "1";
        lockupMeta.appendChild(btn);
        return;
      }

      // Legacy layout: #dismissible → #metadata
      const dismissible = renderer.querySelector("#dismissible");
      const target = dismissible || renderer;
      const meta = target.querySelector("#metadata, #meta, .metadata");
      if (meta) {
        const btn = createButton(videoId);
        btn.classList.add("tldw-btn-sidebar");
        btn.dataset.sidebar = "1";
        meta.appendChild(btn);
        return;
      }

      // Last resort: append to the renderer itself
      const btn = createButton(videoId);
      btn.classList.add("tldw-btn-sidebar");
      btn.dataset.sidebar = "1";
      target.appendChild(btn);
    });
  }

  // --- Channel Page Buttons (Home tab: For You, Videos sections) ---
  function injectChannelButtons() {
    if (!isChannelPage()) return;

    // Channel pages use ytd-grid-video-renderer (older) and yt-lockup-view-model (newer)
    // inside ytd-rich-section-renderer for sections like "For You", "Videos"
    const sectionRenderers = document.querySelectorAll(
      "ytd-rich-section-renderer yt-lockup-view-model, " +
      "ytd-rich-section-renderer ytd-grid-video-renderer, " +
      "ytd-item-section-renderer yt-lockup-view-model, " +
      "ytd-item-section-renderer ytd-grid-video-renderer"
    );

    sectionRenderers.forEach((renderer) => {
      if (renderer.querySelector("." + BUTTON_CLASS)) return;

      const link = renderer.querySelector('a[href*="/watch?v="]:not([href*="googleadservices"])');
      if (!link) return;

      const videoId = extractVideoIdFromHref(link.href);
      if (!videoId) return;

      // New layout: yt-lockup-view-model
      const lockupMeta = renderer.querySelector("yt-lockup-metadata-view-model");
      if (lockupMeta) {
        const btn = createButton(videoId);
        btn.classList.add("tldw-btn-sidebar");
        btn.dataset.sidebar = "1";
        lockupMeta.appendChild(btn);
        return;
      }

      // Older layout: ytd-grid-video-renderer
      const meta = renderer.querySelector("#meta, #metadata");
      if (meta) {
        const btn = createButton(videoId);
        btn.classList.add("tldw-btn-sidebar");
        btn.dataset.sidebar = "1";
        meta.appendChild(btn);
        return;
      }

      // Last resort
      const btn = createButton(videoId);
      btn.classList.add("tldw-btn-sidebar");
      btn.dataset.sidebar = "1";
      renderer.appendChild(btn);
    });
  }

  function tryPlaceButton(renderer, videoId) {
    const dismissible = renderer.querySelector("#dismissible");
    if (!dismissible) return false;

    const menu = dismissible.querySelector(":scope > #menu, :scope > #details #menu");
    if (menu && menu.parentElement) {
      const btn = createButton(videoId);
      menu.parentElement.insertBefore(btn, menu);
      return true;
    }

    const details = dismissible.querySelector("#details, #meta");
    if (details) {
      const btn = createButton(videoId);
      btn.style.marginTop = "4px";
      details.appendChild(btn);
      return true;
    }
    return false;
  }

  function tryPlaceButtonNewLayout(renderer, videoId) {
    const lockup = renderer.querySelector("yt-lockup-view-model");
    if (!lockup) return;

    const metadataDiv = lockup.querySelector(".yt-lockup-view-model__metadata");
    if (metadataDiv) {
      const btn = createButton(videoId);
      btn.style.marginTop = "4px";
      metadataDiv.appendChild(btn);
      return;
    }

    const btn = createButton(videoId);
    btn.style.marginTop = "4px";
    lockup.appendChild(btn);
  }

  function injectWatchPageButton() {
    if (document.querySelector("#tldw-watch-btn")) return;

    const videoId = new URLSearchParams(location.search).get("v");
    if (!videoId) return;

    const btn = createButton(videoId);
    btn.id = "tldw-watch-btn";
    btn.classList.add("tldw-btn-watch");

    // Try to place before the like button (left of it)
    const actionsContainer = document.querySelector("#top-level-buttons-computed");
    if (actionsContainer && actionsContainer.firstChild) {
      actionsContainer.insertBefore(btn, actionsContainer.firstChild);
      return;
    }

    // Fallback placements
    const fallbacks = [
      "#actions ytd-menu-renderer",
      "#above-the-fold #top-row #actions",
      "ytd-watch-metadata #actions",
      "#owner",
      "#info #info-contents"
    ];

    for (const sel of fallbacks) {
      const target = document.querySelector(sel);
      if (target) {
        if (target.firstChild) {
          target.insertBefore(btn, target.firstChild);
        } else {
          target.appendChild(btn);
        }
        return;
      }
    }
  }

  function createButton(videoId) {
    const btn = document.createElement("button");
    btn.className = BUTTON_CLASS;
    btn.appendChild(createLogoHorizontal("tldw-logo-h--btn"));
    btn.dataset.videoId = videoId;

    if (!hasApiKey) {
      btn.title = "Set up your API key first";
      btn.style.opacity = "0.35";
      btn.style.cursor = "default";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Open the setup onboarding
        const widget = document.getElementById(WIDGET_ID);
        if (widget && widgetState === "setup") {
          showOnboarding(widget);
        }
      });
    } else {
      btn.title = "Summarize this video";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleSummarize(videoId, btn);
      });
    }
    return btn;
  }

  // Re-enable all tLDw buttons after API key is saved
  function enableAllTldwButtons() {
    const buttons = document.querySelectorAll("." + BUTTON_CLASS);
    buttons.forEach((btn) => {
      btn.style.opacity = "";
      btn.style.cursor = "pointer";
      btn.title = "Summarize this video";
      // Clone to remove old listeners, re-attach proper handler
      const newBtn = btn.cloneNode(true);
      newBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleSummarize(newBtn.dataset.videoId, newBtn);
      });
      btn.parentNode.replaceChild(newBtn, btn);
    });
  }

  function extractVideoIdFromHref(href) {
    try {
      const url = new URL(href);
      return url.searchParams.get("v");
    } catch {
      return null;
    }
  }

  // --- Summarize Flow ---

  async function handleSummarize(videoId, btn) {
    // Save original children so we can restore without innerHTML
    const originalChildren = Array.from(btn.childNodes).map(function (n) { return n.cloneNode(true); });
    btn.textContent = "...";
    btn.disabled = true;

    // Show loading state in widget
    widgetState = "loading";
    lastVideoMeta = null;
    updateWidget();
    updateLoadingProgress(1); // "fetching transcript..."

    try {
      // Race applicable transcript methods in parallel
      var transcriptRacers = [];
      var onWatchPage = isWatchPage();
      var isSidebarBtn = btn.dataset.sidebar === "1";

      // Sidebar buttons on a watch page should use the background tab flow,
      // NOT the DOM scrape — DOM scrape would read the CURRENT video's transcript
      if (onWatchPage && !isSidebarBtn) {
        // Watch page button: race DOM scrape + API methods (same video)
        lastVideoMeta = scrapeVideoMeta();
        transcriptRacers.push(
          getTranscriptFromPage(videoId)
            .then(function (r) { return r.ok ? r : Promise.reject(r.error); })
        );
        transcriptRacers.push(
          browser.runtime.sendMessage({ type: "GET_TRANSCRIPT", videoId: videoId })
            .then(function (r) { return r.ok ? r : Promise.reject(r.error); })
        );
      } else {
        // Homepage, feed, or sidebar: try fast API methods first, background tab as fallback
        transcriptRacers.push(
          browser.runtime.sendMessage({ type: "GET_TRANSCRIPT", videoId: videoId })
            .then(function (r) { return r.ok ? r : Promise.reject(r.error); })
        );
      }

      var result;
      try {
        result = await firstSuccess(transcriptRacers);
      } catch (raceErr) {
        // All fast methods failed — fall back to background tab
        if (!onWatchPage || isSidebarBtn) {
          var tabResult = await browser.runtime.sendMessage({ type: "GET_TRANSCRIPT_VIA_TAB", videoId: videoId });
          if (tabResult.ok) {
            if (tabResult.meta) lastVideoMeta = tabResult.meta;
            result = tabResult;
          } else {
            throw new Error(tabResult.error || "All transcript methods failed");
          }
        } else {
          throw raceErr;
        }
      }
      var transcriptText = result.transcript;
      updateLoadingProgress(2); // "summarizing..."

      // Summarize — pass video title so Gemini can answer it directly
      var videoTitle = (lastVideoMeta && lastVideoMeta.title) ? lastVideoMeta.title : "";
      var summaryResult = await browser.runtime.sendMessage({
        type: "SUMMARIZE",
        transcript: transcriptText,
        videoTitle: videoTitle
      });

      if (!summaryResult.ok) {
        widgetState = "error";
        lastSummaryRaw = summaryResult.error;
        lastElapsedTime = null;
        lastModelName = null;
      } else {
        updateLoadingProgress(3); // "done!"
        // Capture elapsed time before stopping timer
        lastElapsedTime = loadingTimerStart ? ((Date.now() - loadingTimerStart) / 1000).toFixed(1) + "s" : null;
        lastModelName = summaryResult.model || null;
        widgetState = "summary";
        lastSummaryRaw = summaryResult.summary;

        // Increment lifetime summary counter
        totalSummaryCount++;
        browser.storage.local.set({ tldwSummaryCount: totalSummaryCount });

        // Green success pulse on dots before transitioning
        pulseDotsGreen();
      }

      // Delay widget update slightly to let the green pulse show
      await new Promise(r => setTimeout(r, widgetState === "summary" ? 400 : 0));
      updateWidget();
    } catch (err) {
      widgetState = "error";
      lastSummaryRaw = "Something went wrong: " + (err.message || err);
      updateWidget();
    }

    btn.textContent = "";
    originalChildren.forEach(function (n) { btn.appendChild(n); });
    btn.disabled = false;
  }

  // --- Floating Widget UI ---

  function createWidget() {
    const existing = document.getElementById(WIDGET_ID);
    if (existing) existing.remove();

    const widget = document.createElement("div");
    widget.id = WIDGET_ID;
    widget.className = "tldw-widget";
    document.body.appendChild(widget);

    updateWidget();
  }

  // Lightweight theme swap — no DOM rebuild, no scroll loss, no animation replay
  function applyTheme() {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;

    THEMES.forEach(function (t) { widget.classList.remove("tldw-theme-" + t); });
    widget.classList.add("tldw-theme-" + currentTheme);

    // Update the star button color + title if it exists
    const themeBtn = widget.querySelector(".tldw-theme-btn");
    if (themeBtn) {
      themeBtn.style.color = THEME_COLORS[currentTheme].star;
      themeBtn.title = "Theme: " + currentTheme;
    }
  }

  // Targeted counter badge update — no DOM rebuild
  function updateCounterBadge() {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget || widgetState !== "summary") return;

    const existing = widget.querySelector(".tldw-summary-counter");
    if (hideCounter || totalSummaryCount <= 0) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      existing.textContent = "×" + totalSummaryCount;
      existing.title = totalSummaryCount + " total summaries";
    } else {
      const titleEl = widget.querySelector(".tldw-widget-title");
      if (titleEl) {
        const counter = document.createElement("span");
        counter.className = "tldw-summary-counter";
        counter.textContent = "×" + totalSummaryCount;
        counter.title = totalSummaryCount + " total summaries";
        titleEl.appendChild(counter);
      }
    }
  }

  function updateWidget() {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;

    // Stop the loading timer when leaving loading state
    if (widgetState !== "loading") {
      stopLoadingTimer();
    }

    while (widget.firstChild) widget.removeChild(widget.firstChild);
    widget.classList.remove(
      "tldw-widget--setup",
      "tldw-widget--idle",
      "tldw-widget--loading",
      "tldw-widget--expanded",
      "tldw-widget--minimized"
    );
    // Remove all theme classes
    THEMES.forEach(function (t) { widget.classList.remove("tldw-theme-" + t); });
    widget.classList.add("tldw-theme-" + currentTheme);

    if (widgetState === "setup") {
      renderSetupWidget(widget);
    } else if (widgetState === "idle") {
      renderIdleWidget(widget);
    } else if (widgetState === "loading") {
      renderLoadingWidget(widget);
    } else if (widgetState === "summary") {
      renderSummaryWidget(widget);
    } else if (widgetState === "error") {
      renderErrorWidget(widget);
    } else if (widgetState === "minimized") {
      renderMinimizedWidget(widget);
    }
  }

  // --- Setup State (First Run — No API Key) ---

  function renderSetupWidget(widget) {
    widget.classList.add("tldw-widget--setup");

    // Hint message above the blue pill
    const hint = document.createElement("div");
    hint.className = "tldw-setup-hint";
    hint.textContent = "Set up your API key to get started";
    widget.appendChild(hint);

    const logo = createLogo("tldw-logo--setup");
    widget.appendChild(logo);

    widget.addEventListener("click", () => {
      showOnboarding(widget);
    }, { once: true });
  }

  function showOnboarding(widget) {
    widget.classList.remove("tldw-widget--setup");
    widget.classList.add("tldw-widget--expanded");
    widget.classList.add("tldw-theme-" + currentTheme);
    while (widget.firstChild) widget.removeChild(widget.firstChild);

    // Header
    const header = document.createElement("div");
    header.className = "tldw-widget-header";

    const controls = document.createElement("div");
    controls.className = "tldw-window-controls";

    const closeBtn = document.createElement("button");
    closeBtn.className = "tldw-dot tldw-dot-close";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      widgetState = "setup";
      updateWidget();
    });
    controls.appendChild(closeBtn);

    const title = document.createElement("span");
    title.className = "tldw-widget-title";
    title.appendChild(createLogoHorizontal("tldw-logo-h--header"));

    const actions = document.createElement("div");
    actions.className = "tldw-header-actions";

    header.appendChild(controls);
    header.appendChild(title);
    header.appendChild(actions);

    // Body
    const body = document.createElement("div");
    body.className = "tldw-widget-body tldw-onboarding";

    // --- Onboarding content (DOM-based, no innerHTML) ---
    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    }

    body.appendChild(el("h3", "tldw-onboard-title", "Welcome to tLDw!"));
    body.appendChild(el("p", "tldw-onboard-text", "Too Lazy, Didn\u2019t Watch \u2014 a quick tool to understand videos without watching the whole thing. Great for podcasts, long-form content, and clickbait \u2014 save your time for things you\u2019d actually enjoy watching!"));

    body.appendChild(el("h4", "tldw-onboard-subtitle", "How it works"));
    body.appendChild(el("p", "tldw-onboard-text", "tLDw reads the video transcript and uses AI to give you a concise summary with timestamps. To keep this extension free, you use your own Gemini API key (also free!)."));

    body.appendChild(el("h4", "tldw-onboard-subtitle", "Get your free API key"));

    var steps = document.createElement("ol");
    steps.className = "tldw-onboard-steps";
    var step1 = document.createElement("li");
    step1.appendChild(document.createTextNode("Go to "));
    var aiLink = document.createElement("a");
    aiLink.href = "https://aistudio.google.com/apikey";
    aiLink.target = "_blank";
    aiLink.rel = "noopener";
    aiLink.textContent = "Google AI Studio";
    step1.appendChild(aiLink);
    steps.appendChild(step1);
    steps.appendChild(el("li", null, "Sign in with your Google account"));
    var step3 = document.createElement("li");
    step3.appendChild(document.createTextNode("Click "));
    var bold3 = document.createElement("strong");
    bold3.textContent = '"Create API Key"';
    step3.appendChild(bold3);
    steps.appendChild(step3);
    steps.appendChild(el("li", null, "Copy the key and paste it below"));
    body.appendChild(steps);

    body.appendChild(el("p", "tldw-onboard-note", "This is enough for many free summaries per day. Using it too often or too fast may temporarily hit rate limits \u2014 just wait a minute and try again."));

    var inputWrap = el("div", "tldw-onboard-input-wrap");
    var keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "tldw-onboard-input";
    keyInput.id = "tldw-onboard-key";
    keyInput.placeholder = "Paste your Gemini API key here";
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    inputWrap.appendChild(keyInput);
    var saveBtnEl = el("button", "tldw-onboard-save", "Save Key");
    saveBtnEl.id = "tldw-onboard-save";
    inputWrap.appendChild(saveBtnEl);
    body.appendChild(inputWrap);

    var statusP = el("p", "tldw-onboard-status");
    statusP.id = "tldw-onboard-status";
    body.appendChild(statusP);
    body.appendChild(el("p", "tldw-onboard-privacy", "Your key is stored locally and only sent to Google\u2019s Gemini API."));

    var promptToggle = el("h4", "tldw-onboard-subtitle", "\u25b8 Custom prompt");
    promptToggle.id = "tldw-prompt-toggle";
    promptToggle.style.cursor = "pointer";
    promptToggle.style.userSelect = "none";
    body.appendChild(promptToggle);

    var promptSection = document.createElement("div");
    promptSection.id = "tldw-prompt-section";
    promptSection.style.display = "none";

    var promptDesc = el("p", "tldw-onboard-text");
    promptDesc.style.fontSize = "11px";
    promptDesc.appendChild(document.createTextNode("Customize how tLDw summarizes. Use "));
    var ph1 = document.createElement("span");
    ph1.style.cssText = "color:#64b4ff;font-family:monospace;";
    ph1.textContent = "{title}";
    promptDesc.appendChild(ph1);
    promptDesc.appendChild(document.createTextNode(" and "));
    var ph2 = document.createElement("span");
    ph2.style.cssText = "color:#64b4ff;font-family:monospace;";
    ph2.textContent = "{transcript}";
    promptDesc.appendChild(ph2);
    promptDesc.appendChild(document.createTextNode(" as placeholders."));
    promptSection.appendChild(promptDesc);

    var promptTextarea = document.createElement("textarea");
    promptTextarea.id = "tldw-onboard-prompt";
    promptTextarea.style.cssText = "width:100%;min-height:120px;padding:8px 10px;background:#111;border:1px solid #333;border-radius:6px;color:#fff;font-size:11px;font-family:monospace;outline:none;resize:vertical;line-height:1.5;margin-bottom:8px;";
    promptTextarea.spellcheck = false;
    promptSection.appendChild(promptTextarea);

    var promptBtnWrap = document.createElement("div");
    promptBtnWrap.style.cssText = "display:flex;gap:8px;";
    var savePromptBtn = el("button", "tldw-onboard-save", "Save Prompt");
    savePromptBtn.id = "tldw-onboard-save-prompt";
    savePromptBtn.style.cssText = "font-size:11px;padding:6px 12px;";
    promptBtnWrap.appendChild(savePromptBtn);
    var resetPromptBtn = el("button", "tldw-onboard-save", "Reset");
    resetPromptBtn.id = "tldw-onboard-reset-prompt";
    resetPromptBtn.style.cssText = "font-size:11px;padding:6px 12px;background:#333;color:#ccc;";
    promptBtnWrap.appendChild(resetPromptBtn);
    promptSection.appendChild(promptBtnWrap);

    var promptStatus = el("p", "tldw-onboard-status");
    promptStatus.id = "tldw-onboard-prompt-status";
    promptStatus.style.fontSize = "10px";
    promptSection.appendChild(promptStatus);

    body.appendChild(promptSection);

    widget.appendChild(header);
    widget.appendChild(body);

    // Wire up save button (use refs from DOM builder above, not re-query)
    saveBtnEl.addEventListener("click", () => {
      const key = keyInput.value.trim();
      if (!key || key.length < 10) {
        statusP.textContent = "Please enter a valid API key.";
        statusP.style.color = "#f44";
        return;
      }
      // Save in both formats for compatibility
      browser.storage.local.get("geminiApiKeys").then((result) => {
        const existingKeys = (result.geminiApiKeys && Array.isArray(result.geminiApiKeys)) ? result.geminiApiKeys : [];
        // Put this key as primary, keep any existing fallbacks
        const keys = [key, ...existingKeys.filter(k => k && k !== key)].slice(0, 3);
        return browser.storage.local.set({ geminiApiKey: key, geminiApiKeys: keys });
      }).then(() => {
        statusP.textContent = "Saved! You're all set. Add fallback keys in extension settings.";
        statusP.style.color = "#4caf50";
        setTimeout(() => {
          widgetState = "idle";
          updateWidget();
        }, 1500);
      });
    });

    // --- Custom prompt toggle + editor ---
    var DEFAULT_PROMPT = 'Summarize this YouTube video transcript. Your response MUST follow this exact format:\n{title}\n**TLDW:** [Answer the video title\'s question or explain the main point of the video in 1-5 sentences. Cut straight to the chase — what is the actual answer, conclusion, or takeaway? If the title asks a question, answer it directly. If the title is vague or clickbait, state what the video is actually about. Be blunt and concise.]\n\n**Key Points:**\n[Then provide a bullet-point summary of the valuable insights and key points. For each major point, include the approximate timestamp from the transcript as a source reference (e.g. [2:15]). Reduce filler content.]\n\nTranscript:\n{transcript}';

    // Re-use DOM refs from builder above (promptToggle, promptSection, promptTextarea,
    // savePromptBtn, resetPromptBtn, promptStatus are already in scope as var)

    // Load existing prompt
    browser.storage.local.get("customPrompt").then((res) => {
      promptTextarea.value = res.customPrompt || DEFAULT_PROMPT;
    });

    promptToggle.addEventListener("click", () => {
      const isHidden = promptSection.style.display === "none";
      promptSection.style.display = isHidden ? "block" : "none";
      promptToggle.textContent = isHidden ? "▾ Custom prompt" : "▸ Custom prompt";
    });

    savePromptBtn.addEventListener("click", () => {
      const val = promptTextarea.value.trim();
      if (!val) { promptStatus.textContent = "Prompt cannot be empty."; promptStatus.style.color = "#f44"; return; }
      browser.storage.local.set({ customPrompt: val }).then(() => {
        promptStatus.textContent = "Prompt saved.";
        promptStatus.style.color = "#4caf50";
      });
    });

    resetPromptBtn.addEventListener("click", () => {
      promptTextarea.value = DEFAULT_PROMPT;
      browser.storage.local.remove("customPrompt").then(() => {
        promptStatus.textContent = "Reset to default.";
        promptStatus.style.color = "#4caf50";
      });
    });
  }

  // --- Idle State (Red "tLDw" Pill) ---

  function renderIdleWidget(widget) {
    widget.classList.add("tldw-widget--idle");

    const logo = createLogo("tldw-logo--idle");
    widget.appendChild(logo);

    widget.addEventListener("click", handleIdleClick, { once: true });
  }

  function handleIdleClick(e) {
    // Only trigger if we're actually in idle state and no summary exists
    if (widgetState !== "idle") return;
    if (lastSummaryRaw) return;

    // Don't trigger on text selection (user dragging to highlight)
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    showIdleHint();
    blinkTldwButtons();
  }

  function showIdleHint() {
    const existingHint = document.querySelector(".tldw-idle-hint");
    if (existingHint) existingHint.remove();

    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;

    const hint = document.createElement("div");
    hint.className = "tldw-idle-hint";
    hint.textContent = "Click a tLDw button on any video to get a summary";

    widget.appendChild(hint);

    setTimeout(() => {
      const h = widget.querySelector(".tldw-idle-hint");
      if (h) h.remove();
      if (widgetState === "idle") {
        widget.addEventListener("click", handleIdleClick, { once: true });
      }
    }, 4000);
  }

  function blinkTldwButtons() {
    const buttons = document.querySelectorAll("." + BUTTON_CLASS);
    buttons.forEach((btn) => {
      btn.classList.remove("tldw-btn-blink");
      // Force reflow so re-adding the class restarts the animation
      void btn.offsetWidth;
      btn.classList.add("tldw-btn-blink");
      function onEnd(e) {
        // Only listen for animations on the pseudo-element
        if (e.animationName !== "tldw-wipe-slide") return;
        btn.removeEventListener("animationend", onEnd);
        btn.classList.remove("tldw-btn-blink");
      }
      btn.addEventListener("animationend", onEnd);
    });
  }

  // --- Loading State (Progress Bar) ---

  function renderLoadingWidget(widget) {
    widget.classList.add("tldw-widget--loading");

    // Top row: progress bar + timer
    const topRow = document.createElement("div");
    topRow.className = "tldw-progress-row";

    // 9-dot horizontal progress bar
    const bar = document.createElement("div");
    bar.className = "tldw-progress-bar";
    bar.id = "tldw-progress-bar";
    for (let i = 0; i < 9; i++) {
      const dot = document.createElement("div");
      dot.className = "tldw-progress-dot";
      dot.style.animationDelay = (i * 0.08) + "s";
      bar.appendChild(dot);
    }

    // Elapsed timer
    const timer = document.createElement("span");
    timer.className = "tldw-progress-timer";
    timer.id = "tldw-progress-timer";
    timer.textContent = "0.0s";

    topRow.appendChild(bar);
    topRow.appendChild(timer);

    const label = document.createElement("span");
    label.className = "tldw-widget-loading-label tldw-brand";
    label.id = "tldw-progress-label";
    label.textContent = "starting...";

    widget.appendChild(topRow);
    widget.appendChild(label);

    // Start elapsed timer
    startLoadingTimer();
  }

  function startLoadingTimer() {
    stopLoadingTimer(); // clear any existing
    loadingTimerStart = Date.now();
    loadingTimerInterval = setInterval(function () {
      var el = document.getElementById("tldw-progress-timer");
      if (!el) { stopLoadingTimer(); return; }
      var elapsed = (Date.now() - loadingTimerStart) / 1000;
      el.textContent = elapsed.toFixed(1) + "s";
    }, 100);
  }

  function stopLoadingTimer() {
    if (loadingTimerInterval) {
      clearInterval(loadingTimerInterval);
      loadingTimerInterval = null;
    }
  }

  // Updates progress bar dots and label without re-rendering the widget
  // stage 1: dots 0-2 → "fetching transcript..."
  // stage 2: dots 3-5 → "summarizing..."
  // stage 3: dots 6-8 → "done!"
  function updateLoadingProgress(stage) {
    var bar = document.getElementById("tldw-progress-bar");
    var label = document.getElementById("tldw-progress-label");
    if (!bar || !label) return;

    var dots = bar.querySelectorAll(".tldw-progress-dot");
    var activateUpTo = stage * 3; // stage 1→3, stage 2→6, stage 3→9

    for (var i = 0; i < dots.length; i++) {
      if (i < activateUpTo) {
        // Stagger the activation slightly for visual effect
        (function (dot, delay) {
          setTimeout(function () {
            dot.classList.add("tldw-progress-dot--active");
            dot.style.animationDelay = "";
          }, delay);
        })(dots[i], (i % 3) * 80);
      }
    }

    var labels = ["starting...", "fetching transcript...", "summarizing...", "done!"];
    label.textContent = labels[stage] || "";
  }

  // Green ripple across all dots on success
  function pulseDotsGreen() {
    var bar = document.getElementById("tldw-progress-bar");
    if (!bar) return;
    var dots = bar.querySelectorAll(".tldw-progress-dot");
    for (var i = 0; i < dots.length; i++) {
      (function (dot, delay) {
        setTimeout(function () {
          dot.classList.add("tldw-progress-dot--success");
        }, delay);
      })(dots[i], i * 40);
    }
  }

  // --- Summary State ---

  function renderSummaryWidget(widget) {
    widget.classList.add("tldw-widget--expanded");
    // Skip slide/fade animations on re-renders (theme change, copy, counter update)
    if (hasRenderedExpanded) {
      widget.classList.add("tldw-no-anim");
    }
    hasRenderedExpanded = true;

    // Header
    const header = document.createElement("div");
    header.className = "tldw-widget-header";

    const controls = document.createElement("div");
    controls.className = "tldw-window-controls";

    const closeBtn = document.createElement("button");
    closeBtn.className = "tldw-dot tldw-dot-close";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      widgetState = "idle";
      lastSummaryRaw = null;
      lastVideoMeta = null;
      hasRenderedExpanded = false;
      updateWidget();
    });

    const minimizeBtn = document.createElement("button");
    minimizeBtn.className = "tldw-dot tldw-dot-minimize";
    minimizeBtn.title = "Minimize";
    minimizeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      widgetState = "minimized";
      updateWidget();
    });

    const infoIcon = document.createElement("span");
    infoIcon.className = "tldw-info-icon";
    infoIcon.textContent = "i";

    const tooltip = document.createElement("span");
    tooltip.className = "tldw-info-tooltip";
    function addTooltipLine(boldText, normalText) {
      if (tooltip.childNodes.length > 0) {
        tooltip.appendChild(document.createElement("br"));
        tooltip.appendChild(document.createElement("br"));
      }
      if (boldText) {
        var b = document.createElement("strong");
        b.textContent = boldText;
        tooltip.appendChild(b);
      }
      if (normalText) {
        tooltip.appendChild(document.createTextNode(normalText));
      }
    }
    addTooltipLine("tLDw", " \u2014 Too Lazy, Didn\u2019t Watch");
    addTooltipLine(null, "Uses your own Gemini API key (free from Google AI Studio) to summarize YouTube transcripts.");
    addTooltipLine("Speed: ", "~10s on a video page, ~20s from homepage/sidebar. Homepage clicks briefly open the video tab twice to extract the transcript \u2014 this is required by YouTube.");
    addTooltipLine("Rate limits: ", "The free tier allows many summaries per day. If you get an error, wait a minute and try again.");
    addTooltipLine("Custom prompt: ", "Customize in extension settings (right-click tLDw icon \u2192 Extension Settings).");
    addTooltipLine("Privacy: ", "Your API key is stored locally and only sent to Google\u2019s Gemini API. No data is collected.");
    infoIcon.appendChild(tooltip);

    controls.appendChild(closeBtn);
    controls.appendChild(minimizeBtn);
    controls.appendChild(infoIcon);

    const title = document.createElement("span");
    title.className = "tldw-widget-title";
    title.appendChild(createLogoHorizontal("tldw-logo-h--header"));

    // Summary counter badge
    if (totalSummaryCount > 0 && !hideCounter) {
      const counter = document.createElement("span");
      counter.className = "tldw-summary-counter";
      counter.textContent = "×" + totalSummaryCount;
      counter.title = totalSummaryCount + " total summaries";
      title.appendChild(counter);
    }

    // Actions (right side): theme toggle + copy
    const actions = document.createElement("div");
    actions.className = "tldw-header-actions";

    const themeBtn = document.createElement("button");
    themeBtn.className = "tldw-theme-btn";
    themeBtn.textContent = "✦";
    themeBtn.style.color = THEME_COLORS[currentTheme].star;
    themeBtn.title = "Theme: " + currentTheme;
    themeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = THEMES.indexOf(currentTheme);
      currentTheme = THEMES[(idx + 1) % THEMES.length];
      applyTheme(); // lightweight swap — no DOM rebuild
      browser.storage.local.set({ tldwTheme: currentTheme });
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "tldw-copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy summary to clipboard";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const copyText = buildCopyText();
      navigator.clipboard.writeText(copyText).then(() => {
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("tldw-copy-success");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("tldw-copy-success");
        }, 2000);
      });
    });

    actions.appendChild(themeBtn);
    actions.appendChild(copyBtn);

    header.appendChild(controls);
    header.appendChild(title);
    header.appendChild(actions);

    // Body (scrollable summary content)
    const body = document.createElement("div");
    body.className = "tldw-widget-body";

    // Video metadata block at top
    if (lastVideoMeta && (lastVideoMeta.title || lastVideoMeta.channel)) {
      const metaBlock = document.createElement("div");
      metaBlock.className = "tldw-video-meta";

      if (lastVideoMeta.title) {
        const t = document.createElement("div");
        t.className = "tldw-meta-title";
        t.textContent = lastVideoMeta.title;
        metaBlock.appendChild(t);
      }
      if (lastVideoMeta.channel) {
        const c = document.createElement("div");
        c.className = "tldw-meta-channel";
        c.textContent = lastVideoMeta.channel;
        metaBlock.appendChild(c);
      }

      const infoLine = [];
      if (lastVideoMeta.views) infoLine.push(lastVideoMeta.views);
      if (lastVideoMeta.date) infoLine.push(lastVideoMeta.date);
      if (infoLine.length > 0) {
        const info = document.createElement("div");
        info.className = "tldw-meta-info";
        info.textContent = infoLine.join(" · ");
        metaBlock.appendChild(info);
      }

      body.appendChild(metaBlock);
    }

    // Timer pill showing elapsed time + model name
    if (lastElapsedTime) {
      const timerPill = document.createElement("div");
      timerPill.className = "tldw-timer-pill";
      var pillText = "⏱ " + lastElapsedTime;
      if (lastModelName) {
        pillText += " · " + lastModelName;
      }
      timerPill.textContent = pillText;
      body.appendChild(timerPill);
    }

    const summaryEl = document.createElement("div");
    summaryEl.className = "tldw-summary";
    formatSummaryInto(summaryEl, lastSummaryRaw);
    body.appendChild(summaryEl);

    // Scroll-to-top button at the bottom of summary
    const scrollTopBtn = document.createElement("button");
    scrollTopBtn.className = "tldw-scroll-top";
    scrollTopBtn.textContent = "↑ Back to top";
    scrollTopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      body.scrollTo({ top: 0, behavior: "smooth" });
    });
    body.appendChild(scrollTopBtn);

    widget.appendChild(header);
    widget.appendChild(body);
  }

  function buildCopyText() {
    let text = "";
    if (lastVideoMeta) {
      if (lastVideoMeta.title) text += lastVideoMeta.title + "\n";
      if (lastVideoMeta.channel) text += lastVideoMeta.channel + "\n";
      const infoLine = [];
      if (lastVideoMeta.views) infoLine.push(lastVideoMeta.views);
      if (lastVideoMeta.date) infoLine.push(lastVideoMeta.date);
      if (infoLine.length) text += infoLine.join(" · ") + "\n";
      text += "\n";
    }
    text += lastSummaryRaw || "";
    return text;
  }

  // --- Error State ---

  function renderErrorWidget(widget) {
    widget.classList.add("tldw-widget--expanded");
    if (hasRenderedExpanded) {
      widget.classList.add("tldw-no-anim");
    }
    hasRenderedExpanded = true;

    const header = document.createElement("div");
    header.className = "tldw-widget-header";

    const controls = document.createElement("div");
    controls.className = "tldw-window-controls";

    const closeBtn = document.createElement("button");
    closeBtn.className = "tldw-dot tldw-dot-close";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      widgetState = "idle";
      lastSummaryRaw = null;
      updateWidget();
    });
    controls.appendChild(closeBtn);

    const title = document.createElement("span");
    title.className = "tldw-widget-title";
    title.appendChild(createLogoHorizontal("tldw-logo-h--header"));

    const actions = document.createElement("div");
    actions.className = "tldw-header-actions";

    header.appendChild(controls);
    header.appendChild(title);
    header.appendChild(actions);

    const body = document.createElement("div");
    body.className = "tldw-widget-body";

    const errorEl = document.createElement("p");
    errorEl.className = "tldw-error";
    errorEl.textContent = lastSummaryRaw;
    body.appendChild(errorEl);

    widget.appendChild(header);
    widget.appendChild(body);
  }

  // --- Minimized State ---

  function renderMinimizedWidget(widget) {
    widget.classList.add("tldw-widget--minimized");

    const logo = createLogo("tldw-logo--minimized");
    widget.appendChild(logo);

    widget.addEventListener("click", () => {
      widgetState = "summary";
      updateWidget();
    }, { once: true });
  }

  // --- Helpers ---

  // DOM-based summary renderer — no innerHTML, safe for AMO
  function formatSummaryInto(container, text) {
    var lines = text.split("\n");
    var currentP = null;
    var currentUl = null;

    function flushP() {
      if (currentP && currentP.childNodes.length > 0) {
        container.appendChild(currentP);
      }
      currentP = null;
    }
    function flushUl() {
      if (currentUl) {
        container.appendChild(currentUl);
        currentUl = null;
      }
    }

    // Append text with **bold** support to a parent element
    function appendRichText(parent, str) {
      var parts = str.split(/(\*\*.+?\*\*)/g);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].startsWith("**") && parts[i].endsWith("**")) {
          var strong = document.createElement("strong");
          strong.textContent = parts[i].slice(2, -2);
          parent.appendChild(strong);
        } else if (parts[i]) {
          parent.appendChild(document.createTextNode(parts[i]));
        }
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);

      if (bulletMatch) {
        flushP();
        if (!currentUl) currentUl = document.createElement("ul");
        var li = document.createElement("li");
        appendRichText(li, bulletMatch[1]);
        currentUl.appendChild(li);
      } else if (line.trim() === "") {
        flushUl();
        flushP();
      } else {
        flushUl();
        if (!currentP) currentP = document.createElement("p");
        if (currentP.childNodes.length > 0) {
          currentP.appendChild(document.createElement("br"));
        }
        appendRichText(currentP, line);
      }
    }
    flushUl();
    flushP();
  }

  // --- Start ---

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
