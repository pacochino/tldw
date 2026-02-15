// TLDW - Settings Script

const apiKeyInputs = [
  document.getElementById("apiKey1"),
  document.getElementById("apiKey2"),
  document.getElementById("apiKey3")
];
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

const promptInput = document.getElementById("customPrompt");
const savePromptBtn = document.getElementById("savePromptBtn");
const resetPromptBtn = document.getElementById("resetPromptBtn");
const promptStatusEl = document.getElementById("promptStatus");

const DEFAULT_PROMPT = `Summarize this YouTube video transcript. Your response MUST follow this exact format:
{title}
**TLDW:** [Answer the video title's question or explain the main point of the video in 1-5 sentences. Cut straight to the chase — what is the actual answer, conclusion, or takeaway? If the title asks a question, answer it directly. If the title is vague or clickbait, state what the video is actually about. Be blunt and concise.]

**Key Points:**
[Then provide a bullet-point summary of the valuable insights and key points. For each major point, include the approximate timestamp from the transcript as a source reference (e.g. [2:15]). Reduce filler content.]

Transcript:
{transcript}`;

// Load existing settings on page open
browser.storage.local.get(["geminiApiKey", "geminiApiKeys", "customPrompt"]).then((result) => {
  // Load multi-key format first
  if (result.geminiApiKeys && Array.isArray(result.geminiApiKeys)) {
    result.geminiApiKeys.forEach((key, i) => {
      if (apiKeyInputs[i] && key) apiKeyInputs[i].value = key;
    });
  }
  // Backward compat: if old single key exists and slot 1 is empty, put it there
  if (result.geminiApiKey && !apiKeyInputs[0].value) {
    apiKeyInputs[0].value = result.geminiApiKey;
  }
  promptInput.value = result.customPrompt || DEFAULT_PROMPT;
});

saveBtn.addEventListener("click", () => {
  const keys = apiKeyInputs.map(input => input.value.trim());
  const primaryKey = keys[0];

  if (!primaryKey) {
    showStatus("Please enter at least a primary API key.", "error");
    return;
  }

  if (primaryKey.length < 10) {
    showStatus("That doesn't look like a valid API key.", "error");
    return;
  }

  // Validate fallback keys if provided
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] && keys[i].length < 10) {
      showStatus("Fallback key " + i + " doesn't look valid.", "error");
      return;
    }
  }

  // Save both formats: geminiApiKey (backward compat) + geminiApiKeys (new)
  browser.storage.local.set({
    geminiApiKey: primaryKey,
    geminiApiKeys: keys.filter(k => k.length >= 10)
  }).then(() => {
    const count = keys.filter(k => k.length >= 10).length;
    showStatus("Saved " + count + " key" + (count > 1 ? "s" : "") + ".", "success");
  }).catch((err) => {
    showStatus("Failed to save: " + err.message, "error");
  });
});

savePromptBtn.addEventListener("click", () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showPromptStatus("Prompt cannot be empty.", "error");
    return;
  }
  browser.storage.local.set({ customPrompt: prompt }).then(() => {
    showPromptStatus("Prompt saved.", "success");
  }).catch((err) => {
    showPromptStatus("Failed to save: " + err.message, "error");
  });
});

resetPromptBtn.addEventListener("click", () => {
  promptInput.value = DEFAULT_PROMPT;
  browser.storage.local.remove("customPrompt").then(() => {
    showPromptStatus("Reset to default.", "success");
  });
});

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + type;
}

function showPromptStatus(msg, type) {
  promptStatusEl.textContent = msg;
  promptStatusEl.className = "status " + type;
}

// --- Summary Counter ---
const counterDisplay = document.getElementById("counterDisplay");
const resetCounterBtn = document.getElementById("resetCounterBtn");
const toggleCounterBtn = document.getElementById("toggleCounterBtn");
const counterStatusEl = document.getElementById("counterStatus");

// Load counter values
browser.storage.local.get(["tldwSummaryCount", "tldwHideCounter"]).then((result) => {
  const count = result.tldwSummaryCount || 0;
  const hidden = result.tldwHideCounter || false;
  counterDisplay.textContent = count;
  toggleCounterBtn.textContent = hidden ? "Show Counter" : "Hide Counter";
});

resetCounterBtn.addEventListener("click", () => {
  browser.storage.local.set({ tldwSummaryCount: 0 }).then(() => {
    counterDisplay.textContent = "0";
    showCounterStatus("Counter reset to 0.", "success");
  });
});

toggleCounterBtn.addEventListener("click", () => {
  browser.storage.local.get("tldwHideCounter").then((result) => {
    const newState = !result.tldwHideCounter;
    return browser.storage.local.set({ tldwHideCounter: newState }).then(() => {
      toggleCounterBtn.textContent = newState ? "Show Counter" : "Hide Counter";
      showCounterStatus(newState ? "Counter hidden." : "Counter visible.", "success");
    });
  });
});

function showCounterStatus(msg, type) {
  counterStatusEl.textContent = msg;
  counterStatusEl.className = "status " + type;
}
