// TLDW - Background Script
// Handles transcript fetching and Gemini API calls

// --- Utilities ---

// Fetch with AbortController-based timeout (prevents indefinite hangs)
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Resolves with the first promise that fulfills; rejects only if ALL reject
function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    let rejectCount = 0;
    const errors = [];
    for (const p of promises) {
      p.then(resolve).catch(err => {
        errors.push(err);
        rejectCount++;
        if (rejectCount === promises.length) {
          reject(new Error(errors.join("; ")));
        }
      });
    }
  });
}

// --- Transcript Cache ---

const transcriptCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCachedTranscript(videoId) {
  const entry = transcriptCache.get(videoId);
  if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
    return entry.data;
  }
  transcriptCache.delete(videoId);
  return null;
}

function cacheTranscript(videoId, data) {
  if (transcriptCache.size > 50) {
    const oldest = transcriptCache.keys().next().value;
    transcriptCache.delete(oldest);
  }
  transcriptCache.set(videoId, { data, timestamp: Date.now() });
}

// Open settings page when toolbar icon is clicked
browser.browserAction.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_CAPTION_URL") {
    fetchAndParseCaptions(message.captionUrl)
      .then(transcript => {
        if (transcript) {
          sendResponse({ ok: true, transcript });
        } else {
          sendResponse({ ok: false, error: "Failed to parse captions." });
        }
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "GET_TRANSCRIPT") {
    const cached = getCachedTranscript(message.videoId);
    if (cached) { sendResponse(cached); return true; }
    getTranscript(message.videoId).then(result => {
      if (result.ok) cacheTranscript(message.videoId, result);
      sendResponse(result);
    });
    return true;
  }
  if (message.type === "GET_TRANSCRIPT_VIA_TAB") {
    const cached = getCachedTranscript(message.videoId);
    if (cached) { sendResponse(cached); return true; }
    getTranscriptViaBackgroundTab(message.videoId).then(result => {
      if (result.ok) cacheTranscript(message.videoId, result);
      sendResponse(result);
    });
    return true;
  }
  if (message.type === "SCRAPE_TRANSCRIPT") {
    // This is handled by the content script, not background
    sendResponse({ ok: false, error: "Wrong target for SCRAPE_TRANSCRIPT" });
    return false;
  }
  if (message.type === "SUMMARIZE") {
    summarize(message.transcript, message.videoTitle).then(sendResponse);
    return true;
  }
});

// --- Transcript Extraction via Background Tab ---
// Opens the video in a tab, lets the content script scrape the transcript,
// then closes the tab. Used when TLDW is clicked from the homepage feed.

async function getTranscriptViaBackgroundTab(videoId) {
  let tab = null;
  let originalTabId = null;

  // Helper: try scraping transcript from the tab
  async function tryScrape() {
    const result = await Promise.race([
      browser.tabs.sendMessage(tab.id, { type: "SCRAPE_TRANSCRIPT", videoId }),
      new Promise((_, reject) => setTimeout(() => reject("timeout"), 1000))
    ]);
    if (result && result.ok) return result;
    throw new Error("no transcript");
  }

  try {
    // Remember the currently active tab so we can switch back
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      originalTabId = activeTab.id;
    }

    // Create the tab as inactive initially
    tab = await browser.tabs.create({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      active: false
    });

    // Wait for the tab to finish loading (15s timeout — fail fast)
    await waitForTabLoad(tab.id);

    let meta = null;

    // --- First activation: trigger YouTube's visibility/focus handlers ---
    await browser.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 500));

    // Switch back to original tab
    if (originalTabId) {
      try { await browser.tabs.update(originalTabId, { active: true }); } catch {}
    }

    // Try scraping after first activation
    try {
      const result = await tryScrape();
      try { meta = await browser.tabs.sendMessage(tab.id, { type: "SCRAPE_META" }); } catch {}
      await browser.tabs.remove(tab.id);
      return { ...result, meta };
    } catch {}

    // --- Second activation: YouTube needs a second focus to fully render transcript ---
    await browser.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 250));

    // Switch back again
    if (originalTabId) {
      try { await browser.tabs.update(originalTabId, { active: true }); } catch {}
    }

    // Try scraping after second activation
    try {
      const result = await tryScrape();
      try { meta = await browser.tabs.sendMessage(tab.id, { type: "SCRAPE_META" }); } catch {}
      await browser.tabs.remove(tab.id);
      return { ...result, meta };
    } catch {}

    // --- Final retries (tab stays in background now) ---
    const delays = [1000, 2000, 3000];
    for (const delay of delays) {
      await new Promise(r => setTimeout(r, delay));
      try {
        if (!meta) {
          try { meta = await browser.tabs.sendMessage(tab.id, { type: "SCRAPE_META" }); } catch {}
        }
        const result = await tryScrape();
        await browser.tabs.remove(tab.id);
        return { ...result, meta };
      } catch {}
    }

    // Close the tab
    await browser.tabs.remove(tab.id);
    return { ok: false, error: "Could not extract transcript from background tab." };
  } catch (err) {
    // Clean up
    if (tab) {
      try { await browser.tabs.remove(tab.id); } catch {}
    }
    if (originalTabId) {
      try { await browser.tabs.update(originalTabId, { active: true }); } catch {}
    }
    return { ok: false, error: "Background tab transcript extraction failed: " + err.message };
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timed out"));
    }, 15000);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    browser.tabs.onUpdated.addListener(listener);
  });
}

// --- Transcript Extraction (API methods — raced in parallel) ---

async function getTranscript(videoId) {
  try {
    // Race the two fastest methods
    const fast = await firstSuccess([
      fetchTranscriptViaInnertube(videoId).then(t => t ? { ok: true, transcript: t } : Promise.reject("no innertube")),
      fetchTranscriptFromTimedText(videoId).then(t => t ? { ok: true, transcript: t } : Promise.reject("no timedtext"))
    ]).catch(() => null);

    if (fast) return fast;

    // Fallback: WatchPage HTML (expensive but reliable)
    const transcript2 = await fetchTranscriptFromWatchPage(videoId);
    if (transcript2) return { ok: true, transcript: transcript2 };

    return { ok: false, error: "No transcript available for this video." };
  } catch (err) {
    return { ok: false, error: "Failed to fetch transcript: " + err.message };
  }
}

async function fetchTranscriptViaInnertube(videoId) {
  try {
    const res = await fetchWithTimeout("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240101.00.00",
            hl: "en"
          }
        }
      })
    }, 8000);

    if (!res.ok) return null;

    const data = await res.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return null;

    const track = tracks.find(t => t.languageCode === "en") || tracks[0];
    return await fetchAndParseCaptions(track.baseUrl);
  } catch {
    return null;
  }
}

async function fetchTranscriptFromWatchPage(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetchWithTimeout(url, {}, 10000);
    const html = await res.text();

    const captionMatch = html.match(/"captionTracks"\s*:\s*(\[.*?\])\s*,/s);
    if (captionMatch) {
      try {
        const tracksJson = captionMatch[1].replace(/\\u0026/g, "&");
        const tracks = JSON.parse(tracksJson);
        if (tracks && tracks.length > 0) {
          const track = tracks.find(t => t.languageCode === "en") || tracks[0];
          const captionUrl = track.baseUrl.replace(/\\u0026/g, "&");
          return await fetchAndParseCaptions(captionUrl);
        }
      } catch {}
    }

    const patterns = [
      /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*var\s/s,
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match) continue;
      try {
        const data = JSON.parse(match[1]);
        const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks && tracks.length > 0) {
          const track = tracks.find(t => t.languageCode === "en") || tracks[0];
          return await fetchAndParseCaptions(track.baseUrl);
        }
      } catch {}
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchAndParseCaptions(captionUrl) {
  const cleanUrl = captionUrl.replace(/\\u0026/g, "&");
  const res = await fetchWithTimeout(cleanUrl, {}, 8000);
  const text = await res.text();

  const xmlResult = parseTranscriptXml(text);
  if (xmlResult) return xmlResult;

  try {
    const data = JSON.parse(text);
    if (data.events) {
      return data.events
        .filter(e => e.segs)
        .map(e => e.segs.map(s => s.utf8).join(""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim() || null;
    }
  } catch {}

  return null;
}

// Fire all language codes in parallel — first success wins
async function fetchTranscriptFromTimedText(videoId) {
  const langs = ["en", "en-US", "en-GB", ""];

  const attempts = langs.map(async (lang) => {
    const langParam = lang ? `&lang=${lang}` : "";
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}${langParam}&fmt=json3`;
    const res = await fetchWithTimeout(url, {}, 6000);
    if (!res.ok) throw new Error("not ok");
    const text = await res.text();
    if (!text || text.length < 10) throw new Error("empty");
    const data = JSON.parse(text);
    if (!data.events) throw new Error("no events");
    const transcript = data.events
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8).join(""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!transcript) throw new Error("empty transcript");
    return transcript;
  });

  try {
    return await firstSuccess(attempts);
  } catch {
    // All lang codes failed — try the list endpoint as last resort
    try {
      const listUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&type=list`;
      const listRes = await fetchWithTimeout(listUrl, {}, 6000);
      const listText = await listRes.text();
      const langMatch = listText.match(/lang_code="([^"]+)"/);
      if (langMatch) {
        const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${langMatch[1]}&fmt=json3`;
        const res = await fetchWithTimeout(url, {}, 6000);
        const data = await res.json();
        if (data.events) {
          const transcript = data.events
            .filter(e => e.segs)
            .map(e => e.segs.map(s => s.utf8).join(""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (transcript) return transcript;
        }
      }
    } catch {}
    return null;
  }
}

function parseTranscriptXml(xml) {
  const segments = [];
  const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    let text = m[1];
    text = text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, " ");
    segments.push(text.trim());
  }
  return segments.join(" ").replace(/\s+/g, " ").trim() || null;
}

// --- Gemini API ---

let lastSuccessfulModel = null;

async function summarize(transcript, videoTitle) {
  const apiKeys = await getApiKeys();
  if (apiKeys.length === 0) {
    return { ok: false, error: "API key not set. Please configure it in the TLDW extension settings." };
  }

  if (!transcript || transcript.trim().length < 20) {
    console.warn("[tLDw] Transcript too short or empty:", transcript?.length || 0, "chars");
    return { ok: false, error: "Transcript was empty or too short to summarize." };
  }

  console.log("[tLDw] Summarizing transcript:", transcript.length, "chars, title:", videoTitle || "(none)", "keys:", apiKeys.length);

  // Truncate transcript to stay within Gemini free tier input limits
  // Gemini 2.5 Flash supports 1M tokens; even lite models handle 128k+ tokens
  // ~4 chars per token → 300k chars ≈ 75k tokens, safely within all model limits
  // This covers ~2-3 hours of spoken content
  const maxChars = 300000;
  let trimmedTranscript = transcript;
  if (transcript.length > maxChars) {
    trimmedTranscript = transcript.substring(0, maxChars) + "\n\n[Transcript truncated for length]";
  }

  const titleContext = videoTitle ? `\nVideo title: "${videoTitle}"\n` : "";

  // Check for custom prompt from settings
  const { customPrompt } = await browser.storage.local.get("customPrompt");

  let prompt;
  if (customPrompt) {
    // Replace placeholders in custom prompt
    prompt = customPrompt
      .replace(/\{title\}/g, titleContext)
      .replace(/\{transcript\}/g, trimmedTranscript);
  } else {
    prompt = `Summarize this YouTube video transcript. Your response MUST follow this exact format:
${titleContext}
**TLDW:** [Answer the video title's question or explain the main point of the video in 1-5 sentences. Cut straight to the chase — what is the actual answer, conclusion, or takeaway? If the title asks a question, answer it directly. If the title is vague or clickbait, state what the video is actually about. Be blunt and concise.]

**Key Points:**
[Then provide a bullet-point summary of the valuable insights and key points. For each major point, include the approximate timestamp from the transcript as a source reference (e.g. [2:15]). Reduce filler content.]

Transcript:
` + trimmedTranscript;
  }

  // Try models — prioritize last successful model
  const models = [
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.0-flash"
  ];

  // Reorder: put last successful model first
  if (lastSuccessfulModel && models.includes(lastSuccessfulModel)) {
    const idx = models.indexOf(lastSuccessfulModel);
    models.splice(idx, 1);
    models.unshift(lastSuccessfulModel);
  }

  // Try each API key — if all models fail on one key, move to the next
  for (let k = 0; k < apiKeys.length; k++) {
    const apiKey = apiKeys[k];
    const keyLabel = apiKeys.length > 1 ? ` (key ${k + 1}/${apiKeys.length})` : "";

    for (let i = 0; i < models.length; i += 2) {
      const batch = models.slice(i, i + 2);
      const attempts = batch.map(model => tryGeminiModel(model, apiKey, prompt));

      try {
        return await firstSuccess(attempts);
      } catch (batchErr) {
        console.warn("[tLDw] Batch failed" + keyLabel + ":", batch.join(", "), "—", batchErr.message);
        continue;
      }
    }

    if (k < apiKeys.length - 1) {
      console.log("[tLDw] All models failed on key", k + 1, "— trying next key...");
    }
  }

  return { ok: false, error: "All models failed across all API keys. This is usually a temporary rate limit — wait a minute and try again." };
}

async function tryGeminiModel(model, apiKey, prompt) {
  // Longer transcripts need more processing time — scale timeout with prompt length
  const timeoutMs = Math.min(60000, Math.max(15000, Math.round(prompt.length / 10)));
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    },
    timeoutMs
  );

  if (res.status === 429) throw new Error(`${model}: quota exceeded`);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${model}: ${res.status} - ${errText.substring(0, 100)}`);
  }

  const data = await res.json();
  const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!summary) throw new Error(`${model}: empty response`);

  lastSuccessfulModel = model;
  return { ok: true, summary, model };
}

async function getApiKeys() {
  const result = await browser.storage.local.get(["geminiApiKey", "geminiApiKeys"]);
  const keys = [];

  // Support new multi-key format
  if (result.geminiApiKeys && Array.isArray(result.geminiApiKeys)) {
    result.geminiApiKeys.forEach(k => {
      if (k && k.trim().length >= 10) keys.push(k.trim());
    });
  }

  // Backward compat: if old single key exists and isn't already in the array
  if (result.geminiApiKey && !keys.includes(result.geminiApiKey.trim())) {
    keys.unshift(result.geminiApiKey.trim());
  }

  return keys;
}
