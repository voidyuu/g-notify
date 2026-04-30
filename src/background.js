import { getPublicAuth, getAuthToken, revokeStoredToken } from "./auth.js";
import { createTestCalendarNotification, listCalendars, pollCalendar } from "./calendar.js";
import { createTestGmailNotification, pollGmail } from "./gmail.js";
import {
  clearNotificationTargets,
  forgetNotificationTarget,
  handleNotificationClick
} from "./notifications.js";
import { DEFAULT_SETTINGS, getPublicSettings, sanitizeSettings } from "./settings.js";
import {
  DEFAULT_STATE,
  clearAuth,
  getAuth,
  getSettings,
  getState,
  initializeStorage,
  setSettings,
  setState
} from "./storage.js";

const POLL_ALARM = "g-notify:poll";

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollAll({ interactive: false, reason: "alarm" });
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  handleNotificationClick(notificationId);
});

chrome.notifications.onClosed.addListener((notificationId) => {
  forgetNotificationTarget(notificationId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
  return true;
});

initializeExtension();

async function initializeExtension() {
  await initializeStorage();
  await ensureAlarm();
  await updateBadge();
}

async function handleMessage(message) {
  switch (message?.type) {
    case "getStatus":
      return getStatus();
    case "getCalendarList":
      return getCalendarList();
    case "signIn":
      if (message.settings) {
        await saveSettings(message.settings);
      }
      {
        const token = await getAuthToken({ interactive: true });
        await setState({
          ...(await getState()),
          lastError: null
        });
        await pollAll({ interactive: false, reason: "signIn", token, throwOnError: true });
      }
      return getStatus();
    case "signOut":
      await signOut();
      return getStatus();
    case "pollNow":
      await pollAll({ interactive: true, reason: "manual", throwOnError: true });
      return getStatus();
    case "testGmailNotification":
      await createTestGmailNotification();
      return getStatus();
    case "testCalendarNotification":
      await createTestCalendarNotification();
      return getStatus();
    case "saveSettings":
      await saveSettings(message.settings);
      return getStatus();
    default:
      throw new Error("Unknown message type.");
  }
}

async function getCalendarList() {
  const token = await getAuthToken({ interactive: false });
  return {
    calendars: await listCalendars(token)
  };
}

async function getStatus() {
  const [settings, state, auth] = await Promise.all([
    getSettings(),
    getState(),
    getAuth()
  ]);
  const hasToken = Boolean(auth.accessToken || auth.refreshToken);

  return {
    settings: getPublicSettings(settings, hasToken),
    state,
    hasToken,
    auth: getPublicAuth(auth, hasToken),
    nextAlarm: await chrome.alarms.get(POLL_ALARM),
    redirectUri: chrome.identity.getRedirectURL("oauth2")
  };
}

async function saveSettings(partialSettings) {
  const current = await getSettings();
  const settings = sanitizeSettings({ ...current, ...partialSettings });
  if (
    (current.oauthClientId && settings.oauthClientId !== current.oauthClientId) ||
    (current.oauthClientSecret && settings.oauthClientSecret !== current.oauthClientSecret)
  ) {
    await revokeStoredToken(await getAuth());
    await clearAuth();
  }

  await setSettings(settings);
  await ensureAlarm();
}

async function ensureAlarm() {
  const settings = await getSettings();

  if (!settings.enabled) {
    await chrome.alarms.clear(POLL_ALARM);
    return;
  }

  const periodInMinutes = Math.max(0.5, Number(settings.pollIntervalMinutes) || DEFAULT_SETTINGS.pollIntervalMinutes);
  await chrome.alarms.create(POLL_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes
  });
}

async function pollAll({ interactive, reason, token: providedToken = null, throwOnError = false }) {
  const settings = await getSettings();
  if (!settings.enabled && reason !== "manual" && reason !== "signIn") {
    return { ok: true, skipped: true };
  }

  if (!settings.gmailEnabled && !settings.calendarEnabled) {
    await setState({
      ...(await getState()),
      lastError: null
    });
    await updateBadge();
    return { ok: true, skipped: true };
  }

  let partialErrors = [];
  let pollResult = { ok: true, error: null };

  try {
    const token = providedToken || await getAuthToken({ interactive });
    const state = await getState();
    let nextState = state;

    if (settings.gmailEnabled) {
      const gmailResult = await pollGmail(token, settings, state);
      partialErrors = gmailResult.errors ?? [];
      nextState = gmailResult.state;
      await setState({
        ...nextState,
        lastError: partialErrors.length > 0 ? partialErrors.join(" ") : null
      });
    }

    if (settings.calendarEnabled) {
      const calendarResult = await pollCalendar(token, settings, nextState);
      nextState = calendarResult.state;
    }

    const lastError = partialErrors.length > 0 ? partialErrors.join(" ") : null;
    await setState({
      ...nextState,
      lastError,
      lastPollAt: new Date().toISOString()
    });
    pollResult = { ok: !lastError, error: lastError };
  } catch (error) {
    const message = [...partialErrors, normalizeError(error)].join(" ");
    await setState({
      ...(await getState()),
      lastError: message,
      lastPollAt: new Date().toISOString()
    });
    pollResult = { ok: false, error: message };
  } finally {
    await updateBadge();
  }

  if (!pollResult.ok && throwOnError) {
    throw new Error(pollResult.error);
  }
  return pollResult;
}

async function signOut() {
  const auth = await getAuth();
  await revokeStoredToken(auth);
  await clearAuth();
  await clearNotificationTargets();

  await setState({
    ...DEFAULT_STATE,
    lastError: null
  });
  await updateBadge();
}

async function updateBadge() {
  const [settings, state] = await Promise.all([getSettings(), getState()]);
  const text = state.lastError ? "!" : settings.gmailEnabled && state.unreadEstimate ? String(Math.min(state.unreadEstimate, 99)) : "";
  await chrome.action.setBadgeBackgroundColor({ color: state.lastError ? "#d92d20" : "#1a73e8" });
  await chrome.action.setBadgeText({ text });
}

function normalizeError(error) {
  if (!error) {
    return "Unknown error.";
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || "Unknown error.";
}
