const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const connectButton = document.querySelector("#connectButton");
const pollButton = document.querySelector("#pollButton");
const signOutButton = document.querySelector("#signOutButton");
const summaryText = document.querySelector("#summaryText");
const summaryNote = document.querySelector("#summaryNote");
const oauthFields = document.querySelector("#oauthFields");

const oauthClientIdInput = document.querySelector("#oauthClientIdInput");
const oauthClientSecretInput = document.querySelector("#oauthClientSecretInput");
const redirectUriInput = document.querySelector("#redirectUriInput");
const pollIntervalInput = document.querySelector("#pollIntervalInput");
const gmailQueryInput = document.querySelector("#gmailQueryInput");
let lastHasToken = false;
let lastEnabled = true;
let saveTimer = null;
let isRendering = false;
let lastNote = "";
let lastNoteIsError = false;

connectButton.addEventListener("click", () => runAction("signIn", "Connected.", { settings: readSettings() }));
pollButton.addEventListener("click", () => runAction("pollNow", "Poll complete."));
signOutButton.addEventListener("click", () => runAction("signOut", "Signed out."));
statusDot.addEventListener("click", () => updateEnabled(!lastEnabled));
oauthClientIdInput.addEventListener("input", () => scheduleAutoSave());
oauthClientSecretInput.addEventListener("input", () => scheduleAutoSave());
pollIntervalInput.addEventListener("input", () => scheduleAutoSave());
gmailQueryInput.addEventListener("input", () => scheduleAutoSave());

renderInitialStatus();
refreshStatus();

async function refreshStatus() {
  const response = await sendMessage({ type: "getStatus" });
  renderStatus(response);
}

async function runAction(type, successMessage, extra = {}) {
  setBusy(true);
  setSummaryNote("");

  try {
    const response = await sendMessage({ type, ...extra });
    renderStatus(response);
    setSummaryNote(buildFeedback(type, response, successMessage));
  } catch (error) {
    setSummaryNote(error.message, true);
    renderStatusDot({ enabled: lastEnabled, hasError: true });
  } finally {
    setBusy(false);
  }
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Extension request failed.");
  }
  return response;
}

function renderInitialStatus() {
  statusText.textContent = "Checking Google connection...";
  statusDot.className = "dot";
  summaryText.textContent = "No sync yet.";
  setSummaryNote("");
  renderStatusDot({ enabled: true, hasError: false });
}

function renderStatus({ settings, state, hasToken, nextAlarm, redirectUri, auth }) {
  isRendering = true;
  try {
    oauthClientIdInput.value = settings.oauthClientId;
    oauthClientSecretInput.value = settings.oauthClientSecret;
    redirectUriInput.value = redirectUri || "";
    pollIntervalInput.value = settings.pollIntervalMinutes;
    gmailQueryInput.value = settings.gmailQuery;
    lastEnabled = settings.enabled;

    connectButton.classList.toggle("hiddenAction", hasToken);
    signOutButton.classList.toggle("hiddenAction", !hasToken);
    connectButton.disabled = hasToken;
    pollButton.disabled = !hasToken || !settings.enabled;
    signOutButton.disabled = !hasToken;
    lastHasToken = hasToken;
    oauthFields.classList.toggle("hidden", hasToken);

    const alarmText = nextAlarm?.scheduledTime ? ` Next poll ${formatTime(nextAlarm.scheduledTime)}.` : "";
    if (!settings.enabled) {
      statusText.textContent = hasToken ? "Plugin paused." : "Plugin paused before sign-in.";
      renderStatusDot({ enabled: false, hasError: false });
      summaryText.textContent = buildSummary(settings, state, auth);
      syncSummaryNoteFromState(state);
      return;
    }

    if (state.lastError) {
      statusText.textContent = hasToken
        ? `Connected, but sync needs attention: ${state.lastError}`
        : `Needs attention: ${state.lastError}`;
      renderStatusDot({ enabled: true, hasError: true });
      summaryText.textContent = buildSummary(settings, state, auth);
      syncSummaryNoteFromState(state);
      return;
    }

    if (hasToken) {
      statusText.textContent = `Connected.${alarmText}`;
      renderStatusDot({ enabled: true, hasError: false });
    } else {
      statusText.textContent = "Connect Google to start polling.";
      renderStatusDot({ enabled: true, hasError: false });
    }

    summaryText.textContent = buildSummary(settings, state, auth);
    syncSummaryNoteFromState(state);
  } finally {
    isRendering = false;
  }
}

function readSettings() {
  return {
    oauthClientId: oauthClientIdInput.value,
    oauthClientSecret: oauthClientSecretInput.value,
    enabled: lastEnabled,
    pollIntervalMinutes: Number(pollIntervalInput.value),
    gmailQuery: gmailQueryInput.value
  };
}

function setBusy(isBusy) {
  if (isBusy) {
    for (const element of [connectButton, pollButton, signOutButton, statusDot]) {
      element.disabled = true;
    }
    return;
  }

  connectButton.disabled = lastHasToken;
  pollButton.disabled = !lastHasToken || !lastEnabled;
  signOutButton.disabled = !lastHasToken;
  statusDot.disabled = false;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildSummary(settings, state, auth) {
  if (!settings.enabled) {
    return hasStoredAuth(auth) ? "Plugin is paused. Background checks and notifications are off." : "Plugin is paused.";
  }

  if (!state.lastPollAt) {
    return hasStoredAuth(auth) ? "Signed in. No sync yet." : "No sync yet.";
  }

  const parts = [
    `Unread estimate: ${state.unreadEstimate || 0}`,
    `Last sync ${formatTime(state.lastPollAt)}`
  ];
  return parts.join(" | ");
}

function buildFeedback(type, response, fallback) {
  if (type === "pollNow") {
    const unread = response?.state?.unreadEstimate || 0;
    return `Poll complete. Current unread estimate: ${unread}.`;
  }

  return fallback;
}

function hasStoredAuth(auth) {
  return Boolean(auth?.accessToken || auth?.refreshToken);
}

async function updateEnabled(enabled) {
  if (lastEnabled === enabled) {
    return;
  }

  lastEnabled = enabled;
  renderStatusDot({ enabled, hasError: false });
  await runAction("saveSettings", enabled ? "Plugin enabled." : "Plugin paused.", {
    settings: readSettings()
  });
}

function scheduleAutoSave() {
  if (isRendering) {
    return;
  }

  setSummaryNote("Saving...");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    runAction("saveSettings", "Settings saved.", {
      settings: readSettings()
    });
  }, 350);
}

function renderStatusDot({ enabled, hasError }) {
  statusDot.className = "dot";
  if (!enabled) {
    statusDot.classList.add("paused");
    statusDot.setAttribute("aria-pressed", "false");
    statusDot.title = "Plugin paused. Click to enable.";
    return;
  }

  if (hasError) {
    statusDot.classList.add("error");
  } else {
    statusDot.classList.add("ready");
  }
  statusDot.setAttribute("aria-pressed", "true");
  statusDot.title = "Plugin enabled. Click to pause.";
}

function setSummaryNote(message, isError = false) {
  lastNote = message || "";
  lastNoteIsError = Boolean(isError && message);
  summaryNote.textContent = lastNote;
  summaryNote.classList.toggle("error", lastNoteIsError);
}

function syncSummaryNoteFromState(state) {
  if (state.lastError) {
    setSummaryNote(state.lastError, true);
    return;
  }

  setSummaryNote(lastNote, lastNoteIsError);
}
