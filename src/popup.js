const statusDot = document.querySelector("#statusDot");
const connectButton = document.querySelector("#connectButton");
const pollButton = document.querySelector("#pollButton");
const signOutButton = document.querySelector("#signOutButton");
const testGmailButton = document.querySelector("#testGmailButton");
const testCalendarButton = document.querySelector("#testCalendarButton");
const summaryText = document.querySelector("#summaryText");
const summaryNote = document.querySelector("#summaryNote");
const oauthFields = document.querySelector("#oauthFields");

const oauthClientIdInput = document.querySelector("#oauthClientIdInput");
const oauthClientSecretInput = document.querySelector("#oauthClientSecretInput");
const redirectUriInput = document.querySelector("#redirectUriInput");
const gmailEnabledInput = document.querySelector("#gmailEnabledInput");
const calendarEnabledInput = document.querySelector("#calendarEnabledInput");
const pollIntervalInput = document.querySelector("#pollIntervalInput");
const gmailQueryInput = document.querySelector("#gmailQueryInput");
const calendarList = document.querySelector("#calendarList");
const tabButtons = document.querySelectorAll("[data-tab]");
const tabPanels = document.querySelectorAll("[data-tab-panel]");
const gmailTabStatus = document.querySelector("#gmailTabStatus");
const calendarTabStatus = document.querySelector("#calendarTabStatus");
let lastHasToken = false;
let lastEnabled = true;
let lastGmailEnabled = true;
let lastCalendarEnabled = true;
let lastCalendarIds = ["primary"];
let calendarOptionsLoaded = false;
let saveTimer = null;
let isRendering = false;
let lastNote = "";
let lastNoteIsError = false;

connectButton.addEventListener("click", () => runAction("signIn", "Connected.", { settings: readSettings() }));
pollButton.addEventListener("click", () => runAction("pollNow", "Poll complete."));
signOutButton.addEventListener("click", () => runAction("signOut", "Signed out."));
testGmailButton.addEventListener("click", () => runAction("testGmailNotification", "Gmail test notification sent."));
testCalendarButton.addEventListener("click", () => runAction("testCalendarNotification", "Calendar test notification sent."));
statusDot.addEventListener("click", () => updateEnabled(!lastEnabled));
oauthClientIdInput.addEventListener("input", () => scheduleAutoSave());
oauthClientSecretInput.addEventListener("input", () => scheduleAutoSave());
gmailEnabledInput.addEventListener("change", () => scheduleAutoSave());
calendarEnabledInput.addEventListener("change", () => scheduleAutoSave());
gmailEnabledInput.addEventListener("change", () => updateTabStatusIndicators());
calendarEnabledInput.addEventListener("change", () => updateTabStatusIndicators());
pollIntervalInput.addEventListener("input", () => scheduleAutoSave());
gmailQueryInput.addEventListener("input", () => scheduleAutoSave());
tabButtons.forEach((button) => {
  button.addEventListener("click", () => selectTab(button.dataset.tab));
});

renderInitialStatus();
refreshStatus();

async function refreshStatus() {
  const response = await sendMessage({ type: "getStatus" });
  renderStatus(response);
  await refreshCalendarOptions(response);
}

async function runAction(type, successMessage, extra = {}) {
  setBusy(true);
  setSummaryNote("");

  try {
    const response = await sendMessage({ type, ...extra });
    renderStatus(response);
    await refreshCalendarOptions(response);
    setSummaryNote(buildFeedback(type, response, successMessage));
  } catch (error) {
    await refreshStatus().catch(() => {});
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
  statusDot.className = "dot";
  summaryText.textContent = "No sync yet.";
  setSummaryNote("");
  renderStatusDot({ enabled: true, hasError: false });
}

function renderStatus({ settings, state, hasToken, nextAlarm, redirectUri }) {
  isRendering = true;
  try {
    oauthClientIdInput.value = settings.oauthClientId;
    oauthClientSecretInput.value = settings.oauthClientSecret;
    redirectUriInput.value = redirectUri || "";
    gmailEnabledInput.checked = settings.gmailEnabled;
    calendarEnabledInput.checked = settings.calendarEnabled;
    updateTabStatusIndicators();
    pollIntervalInput.value = settings.pollIntervalMinutes;
    gmailQueryInput.value = settings.gmailQuery;
    lastEnabled = settings.enabled;
    lastGmailEnabled = settings.gmailEnabled;
    lastCalendarEnabled = settings.calendarEnabled;
    lastCalendarIds = settings.calendarIds;

    connectButton.classList.toggle("hiddenAction", hasToken);
    signOutButton.classList.toggle("hiddenAction", !hasToken);
    connectButton.disabled = hasToken;
    pollButton.disabled = !hasToken || !settings.enabled || !hasEnabledService();
    signOutButton.disabled = !hasToken;
    testGmailButton.disabled = !settings.gmailEnabled;
    testCalendarButton.disabled = !settings.calendarEnabled;
    lastHasToken = hasToken;
    oauthFields.classList.toggle("hidden", hasToken);
    gmailQueryInput.disabled = !settings.gmailEnabled;

    const connectionNote = buildConnectionNote(hasToken, nextAlarm);
    if (!settings.enabled) {
      renderStatusDot({ enabled: false, hasError: false });
      summaryText.textContent = buildSummary(settings, state, hasToken);
      syncSummaryNoteFromState(state);
      return;
    }

    if (!hasEnabledService()) {
      renderStatusDot({ enabled: true, hasError: false });
      summaryText.textContent = buildSummary(settings, state, hasToken);
      syncSummaryNoteFromState(state);
      return;
    }

    if (state.lastError) {
      renderStatusDot({ enabled: true, hasError: true });
      summaryText.textContent = buildSummary(settings, state, hasToken);
      syncSummaryNoteFromState(state);
      return;
    }

    if (hasToken) {
      renderStatusDot({ enabled: true, hasError: false });
    } else {
      renderStatusDot({ enabled: true, hasError: false });
    }

    summaryText.textContent = buildSummary(settings, state, hasToken);
    syncSummaryNoteFromState(state, connectionNote);
  } finally {
    isRendering = false;
  }
}

function readSettings() {
  const settings = {
    enabled: lastEnabled,
    gmailEnabled: gmailEnabledInput.checked,
    calendarEnabled: calendarEnabledInput.checked,
    calendarIds: readSelectedCalendarIds(),
    pollIntervalMinutes: Number(pollIntervalInput.value),
    gmailQuery: gmailQueryInput.value
  };

  if (!lastHasToken) {
    settings.oauthClientId = oauthClientIdInput.value;
    settings.oauthClientSecret = oauthClientSecretInput.value;
  }

  return settings;
}

function setBusy(isBusy) {
  if (isBusy) {
    for (const element of [connectButton, pollButton, signOutButton, testGmailButton, testCalendarButton, statusDot]) {
      element.disabled = true;
    }
    return;
  }

  connectButton.disabled = lastHasToken;
  pollButton.disabled = !lastHasToken || !lastEnabled || !hasEnabledService();
  signOutButton.disabled = !lastHasToken;
  testGmailButton.disabled = !lastGmailEnabled;
  testCalendarButton.disabled = !lastCalendarEnabled;
  statusDot.disabled = false;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildSummary(settings, state, hasToken) {
  if (!settings.enabled) {
    return hasToken ? "Plugin is paused. Background checks and notifications are off." : "Plugin is paused.";
  }

  if (!settings.gmailEnabled && !settings.calendarEnabled) {
    return "Gmail and Calendar checks are off.";
  }

  if (!state.lastPollAt) {
    const serviceText = buildEnabledServicesText(settings);
    return hasToken ? `Signed in. ${serviceText} ready. No sync yet.` : `${serviceText} ready. No sync yet.`;
  }

  const parts = [
    `Services: ${buildEnabledServicesText(settings)}`,
    `Last sync ${formatTime(state.lastPollAt)}`
  ];
  if (settings.gmailEnabled) {
    parts.splice(1, 0, `Unread estimate: ${state.unreadEstimate || 0}`);
  }
  return parts.join(" | ");
}

function buildFeedback(type, response, fallback) {
  if (type === "pollNow") {
    const unread = response?.state?.unreadEstimate || 0;
    return `Poll complete. Current unread estimate: ${unread}.`;
  }

  return fallback;
}

function buildConnectionNote(hasToken, nextAlarm) {
  if (!hasToken) {
    return "";
  }

  const alarmText = nextAlarm?.scheduledTime ? ` Next poll ${formatTime(nextAlarm.scheduledTime)}.` : "";
  return `Connected.${alarmText}`;
}

async function refreshCalendarOptions({ settings, hasToken }) {
  if (!hasToken) {
    calendarOptionsLoaded = false;
    renderCalendarList([], settings.calendarIds, "Connect Google to load calendars.");
    return;
  }

  if (calendarOptionsLoaded) {
    return;
  }

  renderCalendarList([], settings.calendarIds, "Loading calendars...");
  try {
    const response = await sendMessage({ type: "getCalendarList" });
    renderCalendarList(response.calendars ?? [], settings.calendarIds);
    calendarOptionsLoaded = true;
  } catch (error) {
    renderCalendarList([], settings.calendarIds, error.message);
  }
}

function renderCalendarList(calendars, selectedIds, message = "") {
  const selected = new Set(selectedIds?.length ? selectedIds : ["primary"]);
  calendarList.textContent = "";

  if (message) {
    const note = document.createElement("p");
    note.className = "calendarListNote";
    note.textContent = message;
    calendarList.append(note);
    return;
  }

  if (calendars.length === 0) {
    const note = document.createElement("p");
    note.className = "calendarListNote";
    note.textContent = "No calendars found.";
    calendarList.append(note);
    return;
  }

  for (const calendar of calendars) {
    const color = calendar.backgroundColor || "#98a2b3";
    const label = document.createElement("label");
    label.className = "calendarChip";
    label.style.setProperty("--calendar-color", color);
    label.style.setProperty("--calendar-foreground", getReadableTextColor(color));

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = calendar.id;
    input.checked = selected.has(calendar.id);
    input.addEventListener("change", () => {
      lastCalendarIds = readSelectedCalendarIds();
      scheduleAutoSave();
    });

    const swatch = document.createElement("span");
    swatch.className = "calendarSwatch";

    const name = document.createElement("span");
    name.textContent = calendar.primary ? `${calendar.summary} (primary)` : calendar.summary;

    label.append(input, swatch, name);
    calendarList.append(label);
  }
}

function readSelectedCalendarIds() {
  const inputs = [...calendarList.querySelectorAll("input[type='checkbox']")];
  if (inputs.length === 0) {
    return lastCalendarIds;
  }

  const selected = inputs
    .filter((input) => input.checked)
    .map((input) => input.value)
    .filter(Boolean);

  return selected;
}

function getReadableTextColor(color) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (!match) {
    return "#fff";
  }

  const red = parseInt(match[1], 16);
  const green = parseInt(match[2], 16);
  const blue = parseInt(match[3], 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? "#18212f" : "#fff";
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

function hasEnabledService() {
  return lastGmailEnabled || lastCalendarEnabled;
}

function buildEnabledServicesText(settings) {
  if (settings.gmailEnabled && settings.calendarEnabled) {
    return "Gmail and Calendar";
  }

  return settings.gmailEnabled ? "Gmail" : "Calendar";
}

function selectTab(tabName) {
  tabButtons.forEach((button) => {
    const isSelected = button.dataset.tab === tabName;
    button.setAttribute("aria-selected", String(isSelected));
  });

  tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  });
}

function updateTabStatusIndicators() {
  gmailTabStatus.classList.toggle("enabled", gmailEnabledInput.checked);
  calendarTabStatus.classList.toggle("enabled", calendarEnabledInput.checked);
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

function syncSummaryNoteFromState(state, fallback = "") {
  if (state.lastError) {
    setSummaryNote(state.lastError, true);
    return;
  }

  if (lastNote) {
    setSummaryNote(lastNote, lastNoteIsError);
    return;
  }

  summaryNote.textContent = fallback;
  summaryNote.classList.toggle("error", false);
}
