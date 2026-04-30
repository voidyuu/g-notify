const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const API_ROOT = "https://www.googleapis.com";
const POLL_ALARM = "g-notify:poll";
const NOTIFICATION_TARGETS_STORAGE_KEY = "notificationTargets";
const GMAIL_ICON_URL = chrome.runtime.getURL("icons/services/gmail.png");
const CALENDAR_ICON_URL = chrome.runtime.getURL("icons/services/calendar.png");
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
  oauthClientId: "",
  oauthClientSecret: "",
  enabled: true,
  gmailEnabled: true,
  calendarEnabled: true,
  pollIntervalMinutes: 5,
  gmailQuery: "in:inbox is:unread newer_than:7d",
  maxGmailResults: 10
};

const DEFAULT_STATE = {
  gmailInitialized: false,
  seenGmailIds: [],
  notifiedCalendarKeys: [],
  lastGmailPollAt: null,
  lastCalendarPollAt: null,
  lastError: null,
  lastPollAt: null,
  unreadEstimate: 0
};

const DEFAULT_AUTH = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  clientId: null,
  scopes: []
};

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
  const settings = await getSettings();
  const state = await getState();
  const auth = await getAuth();
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...settings },
    state: { ...DEFAULT_STATE, ...state },
    auth: { ...DEFAULT_AUTH, ...auth }
  });
  await ensureAlarm();
  await updateBadge();
}

async function handleMessage(message) {
  switch (message?.type) {
    case "getStatus":
      return getStatus();
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
  await chrome.storage.local.set({ settings });
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

async function pollGmail(token, settings, state) {
  const response = await googleFetch(token, "/gmail/v1/users/me/messages", {
    q: settings.gmailQuery,
    maxResults: String(settings.maxGmailResults),
    fields: "messages(id,threadId),resultSizeEstimate"
  });

  const messages = response.messages ?? [];
  const knownIds = new Set(state.seenGmailIds);
  const newIds = messages.map((message) => message.id).filter((id) => !knownIds.has(id));
  const notificationErrors = [];

  for (const id of newIds) {
    try {
      await notifyGmailMessage(token, id);
    } catch (error) {
      notificationErrors.push(`Gmail message ${id} could not be notified: ${normalizeError(error)}`);
    }
  }

  const nextSeen = unique([...messages.map((message) => message.id), ...state.seenGmailIds]).slice(0, 200);

  return {
    errors: notificationErrors,
    state: {
      ...state,
      gmailInitialized: true,
      seenGmailIds: nextSeen,
      lastGmailPollAt: new Date().toISOString(),
      unreadEstimate: response.resultSizeEstimate ?? messages.length
    }
  };
}

async function notifyGmailMessage(token, messageId) {
  const message = await googleFetch(token, `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`, {
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date"],
    fields: "id,threadId,internalDate,snippet,payload/headers"
  });

  const headers = getHeaders(message.payload?.headers ?? []);
  const from = simplifySender(headers.from ?? "Unknown sender");
  const subject = headers.subject || "(no subject)";
  const snippet = collapseWhitespace(message.snippet ?? "");

  await createNotification(`gmail:${message.id}`, {
    type: "basic",
    iconUrl: GMAIL_ICON_URL,
    title: `New mail: ${subject}`,
    message: truncate(`${from}${snippet ? ` - ${snippet}` : ""}`, 180),
    priority: 1
  }, buildGmailThreadUrl(message.threadId || message.id));
}

async function pollCalendar(token, settings, state) {
  const now = new Date();
  const pollIntervalMinutes = Number(settings.pollIntervalMinutes) || DEFAULT_SETTINGS.pollIntervalMinutes;
  const calendarDefaults = await getPrimaryCalendarDefaults(token);
  const defaultReminderMinutes = getEarliestPopupReminderMinutes(calendarDefaults);
  const lookAheadMinutes = Math.max((defaultReminderMinutes ?? 0) + pollIntervalMinutes, 24 * 60);
  const timeMax = new Date(now.getTime() + lookAheadMinutes * 60 * 1000);

  const response = await googleFetch(token, "/calendar/v3/calendars/primary/events", {
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    fields: "items(id,summary,location,start,end,htmlLink,status,reminders)"
  });

  const notifiedKeys = new Set(state.notifiedCalendarKeys);
  const upcomingEvents = (response.items ?? [])
    .filter((event) => event.status !== "cancelled")
    .map((event) => ({
      event,
      startsAt: getEventStart(event),
      reminderMinutes: getEventReminderMinutes(event, calendarDefaults)
    }))
    .filter(({ startsAt, reminderMinutes }) => {
      if (!startsAt || reminderMinutes === null || reminderMinutes < 0) {
        return false;
      }

      const effectiveReminderMs = (reminderMinutes + pollIntervalMinutes) * 60 * 1000;
      return startsAt >= now && startsAt.getTime() - now.getTime() <= effectiveReminderMs;
    });

  for (const { event, startsAt } of upcomingEvents) {
    const key = `${event.id}|${startsAt.toISOString()}`;
    if (!notifiedKeys.has(key)) {
      await notifyCalendarEvent(event, startsAt);
      notifiedKeys.add(key);
    }
  }

  const freshKeys = [...notifiedKeys].filter((key) => {
    const timestamp = key.slice(key.lastIndexOf("|") + 1);
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) && now.getTime() - date.getTime() < 24 * 60 * 60 * 1000;
  });

  return {
    state: {
      ...state,
      notifiedCalendarKeys: freshKeys.slice(-200),
      lastCalendarPollAt: new Date().toISOString()
    }
  };
}

async function notifyCalendarEvent(event, startsAt) {
  const title = event.summary || "Calendar event";
  const time = startsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const location = event.location ? ` - ${event.location}` : "";

  await createNotification(`calendar:${event.id}:${startsAt.toISOString()}`, {
    type: "basic",
    iconUrl: CALENDAR_ICON_URL,
    title: `Upcoming: ${title}`,
    message: `${time}${location}`,
    priority: 1
  }, event.htmlLink || null);
}

async function createTestGmailNotification() {
  await createNotification(`gmail:test:${Date.now()}`, {
    type: "basic",
    iconUrl: GMAIL_ICON_URL,
    title: "New mail: Test notification",
    message: "This is a sample Gmail notification from G Notify.",
    priority: 1
  }, "https://mail.google.com/mail/u/0/#inbox");
}

async function createTestCalendarNotification() {
  await createNotification(`calendar:test:${Date.now()}`, {
    type: "basic",
    iconUrl: CALENDAR_ICON_URL,
    title: "Upcoming: Test event",
    message: "This is a sample Calendar notification from G Notify.",
    priority: 1
  }, "https://calendar.google.com/calendar/u/0/r");
}

async function getPrimaryCalendarDefaults(token) {
  const response = await googleFetch(token, "/calendar/v3/users/me/calendarList/primary", {
    fields: "defaultReminders(method,minutes)"
  });
  return response.defaultReminders ?? [];
}

async function googleFetch(token, path, params = {}) {
  const url = new URL(`${API_ROOT}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, item));
    } else if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (response.status === 401) {
    await clearAccessToken();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google API ${response.status}: ${truncate(body, 300)}`);
  }

  return response.json();
}

async function getAuthToken({ interactive }) {
  const settings = await getSettings();
  const clientId = settings.oauthClientId;
  const clientSecret = settings.oauthClientSecret;
  if (!clientId) {
    throw new Error("Enter an OAuth client ID first.");
  }
  if (!clientSecret) {
    throw new Error("Enter a client secret first.");
  }

  const auth = await getAuth();
  if (auth.clientId && auth.clientId !== clientId) {
    await clearAuth();
  } else if (auth.accessToken && auth.expiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return auth.accessToken;
  } else if (auth.refreshToken) {
    return refreshAccessToken(clientId, clientSecret, auth.refreshToken);
  }

  if (!interactive) {
    throw new Error("Google authentication is required.");
  }

  return startInteractiveAuth(clientId, clientSecret);
}

async function startInteractiveAuth(clientId, clientSecret) {
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)));
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const redirectUri = chrome.identity.getRedirectURL("oauth2");
  const authUrl = new URL(AUTH_ENDPOINT);

  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", [GMAIL_SCOPE, CALENDAR_SCOPE].join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  authUrl.searchParams.set("state", state);

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });

  const resultUrl = new URL(responseUrl);
  validateOAuthRedirect(resultUrl, redirectUri);
  if (getOAuthResponseParam(resultUrl, "state") !== state) {
    throw new Error("Google authorization returned an invalid state value.");
  }

  const error = getOAuthResponseParam(resultUrl, "error");
  if (error) {
    throw new Error(`Google authorization failed: ${error}`);
  }

  const code = getOAuthResponseParam(resultUrl, "code");
  if (!code) {
    throw new Error("Google authorization did not return an auth code.");
  }

  const tokenResponse = await exchangeAuthCode({ clientId, clientSecret, code, codeVerifier, redirectUri });
  await storeTokenResponse(clientId, tokenResponse);
  return tokenResponse.access_token;
}

async function exchangeAuthCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  return tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
}

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const tokenResponse = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  await storeTokenResponse(clientId, { ...tokenResponse, refresh_token: refreshToken });
  return tokenResponse.access_token;
}

async function tokenRequest(params) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams(params)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const description = body.error_description || body.error || response.statusText;
    throw new Error(`Google token request failed: ${description}`);
  }

  return body;
}

async function storeTokenResponse(clientId, tokenResponse) {
  if (!tokenResponse.access_token) {
    throw new Error("Google token response did not include an access token.");
  }

  await chrome.storage.local.set({
    auth: {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      expiresAt: Date.now() + Number(tokenResponse.expires_in ?? 3600) * 1000,
      clientId,
      scopes: String(tokenResponse.scope || "").split(/\s+/).filter(Boolean)
    }
  });
}

async function canGetTokenSilently() {
  try {
    await getAuthToken({ interactive: false });
    return true;
  } catch {
    return false;
  }
}

async function signOut() {
  const auth = await getAuth();
  await revokeStoredToken(auth);
  await clearAuth();
  await chrome.storage.local.set({ [NOTIFICATION_TARGETS_STORAGE_KEY]: {} });

  await setState({
    ...DEFAULT_STATE,
    lastError: null
  });
  await updateBadge();
}

async function getAuth() {
  const { auth } = await chrome.storage.local.get("auth");
  return { ...DEFAULT_AUTH, ...(auth ?? {}) };
}

async function clearAuth() {
  await chrome.storage.local.set({ auth: { ...DEFAULT_AUTH } });
}

async function clearAccessToken() {
  const auth = await getAuth();
  await chrome.storage.local.set({
    auth: {
      ...auth,
      accessToken: null,
      expiresAt: 0
    }
  });
}

async function revokeStoredToken(auth) {
  const token = auth.refreshToken || auth.accessToken;
  if (!token) {
    return;
  }

  try {
    await revokeToken(token);
  } catch (error) {
    console.warn("Failed to revoke Google token", error);
  }
}

async function revokeToken(token) {
  const response = await fetch(TOKEN_REVOCATION_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({ token })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google token revocation failed: ${response.status} ${truncate(body, 300)}`);
  }
}

async function handleNotificationClick(notificationId) {
  try {
    const targetUrl = await getNotificationTarget(notificationId);
    if (!targetUrl) {
      return;
    }

    await chrome.notifications.clear(notificationId);
    await forgetNotificationTarget(notificationId);
    await chrome.tabs.create({ url: targetUrl });
  } catch (error) {
    console.warn("Failed to open notification target", error);
  }
}

async function createNotification(id, options, targetUrl = null) {
  try {
    if (targetUrl) {
      await rememberNotificationTarget(id, targetUrl);
    }
    await chrome.notifications.create(id, options);
  } catch (error) {
    console.warn("Failed to create notification", error);
  }
}

async function rememberNotificationTarget(notificationId, targetUrl) {
  if (!isAllowedNotificationTarget(targetUrl)) {
    return;
  }

  const targets = await getNotificationTargets();
  targets[notificationId] = {
    url: targetUrl,
    createdAt: Date.now()
  };

  await chrome.storage.local.set({
    [NOTIFICATION_TARGETS_STORAGE_KEY]: pruneNotificationTargets(targets)
  });
}

async function getNotificationTarget(notificationId) {
  const targets = await getNotificationTargets();
  const target = targets[notificationId];
  return target && isAllowedNotificationTarget(target.url) ? target.url : null;
}

async function forgetNotificationTarget(notificationId) {
  const targets = await getNotificationTargets();
  if (!targets[notificationId]) {
    return;
  }

  delete targets[notificationId];
  await chrome.storage.local.set({ [NOTIFICATION_TARGETS_STORAGE_KEY]: targets });
}

async function getNotificationTargets() {
  const result = await chrome.storage.local.get(NOTIFICATION_TARGETS_STORAGE_KEY);
  return result[NOTIFICATION_TARGETS_STORAGE_KEY] ?? {};
}

function pruneNotificationTargets(targets) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return Object.fromEntries(
    Object.entries(targets)
      .filter(([, target]) => target?.url && Number(target.createdAt) >= cutoff)
      .slice(-200)
  );
}

async function updateBadge() {
  const [settings, state] = await Promise.all([getSettings(), getState()]);
  const text = state.lastError ? "!" : settings.gmailEnabled && state.unreadEstimate ? String(Math.min(state.unreadEstimate, 99)) : "";
  await chrome.action.setBadgeBackgroundColor({ color: state.lastError ? "#d92d20" : "#1a73e8" });
  await chrome.action.setBadgeText({ text });
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
}

async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...DEFAULT_STATE, ...(state ?? {}) };
}

async function setState(state) {
  await chrome.storage.local.set({ state: { ...DEFAULT_STATE, ...state } });
}

function sanitizeSettings(settings) {
  return {
    oauthClientId: String(settings.oauthClientId || "").trim(),
    oauthClientSecret: String(settings.oauthClientSecret || "").trim(),
    enabled: Boolean(settings.enabled),
    gmailEnabled: settings.gmailEnabled !== false,
    calendarEnabled: settings.calendarEnabled !== false,
    pollIntervalMinutes: Math.max(0.5, Number(settings.pollIntervalMinutes) || DEFAULT_SETTINGS.pollIntervalMinutes),
    gmailQuery: String(settings.gmailQuery || DEFAULT_SETTINGS.gmailQuery).trim(),
    maxGmailResults: Math.max(1, Math.min(50, Number(settings.maxGmailResults) || DEFAULT_SETTINGS.maxGmailResults))
  };
}

function getPublicSettings(settings, hasToken) {
  return {
    ...settings,
    oauthClientSecret: hasToken ? "" : settings.oauthClientSecret
  };
}

function getPublicAuth(auth, hasToken) {
  return {
    hasToken,
    expiresAt: auth.expiresAt || 0,
    scopes: Array.isArray(auth.scopes) ? auth.scopes : []
  };
}

function validateOAuthRedirect(resultUrl, redirectUri) {
  const expectedUrl = new URL(redirectUri);
  if (resultUrl.origin !== expectedUrl.origin || resultUrl.pathname !== expectedUrl.pathname) {
    throw new Error("Google authorization returned an unexpected redirect URI.");
  }
}

function getOAuthResponseParam(url, name) {
  if (url.searchParams.has(name)) {
    return url.searchParams.get(name);
  }

  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  return hashParams.get(name);
}

function buildGmailThreadUrl(threadId) {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function isAllowedNotificationTarget(targetUrl) {
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "https:") {
      return false;
    }

    if (url.hostname === "mail.google.com" && url.pathname.startsWith("/mail/")) {
      return true;
    }

    if (url.hostname === "calendar.google.com" && url.pathname.startsWith("/calendar/")) {
      return true;
    }

    return url.hostname === "www.google.com" && url.pathname.startsWith("/calendar/");
  } catch {
    return false;
  }
}

function getHeaders(headers) {
  return headers.reduce((acc, header) => {
    acc[header.name.toLowerCase()] = header.value;
    return acc;
  }, {});
}

function getEventStart(event) {
  if (!event.start?.dateTime) {
    return null;
  }

  const date = new Date(event.start.dateTime);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getEventReminderMinutes(event, defaultReminders) {
  const reminders = event.reminders;
  if (reminders?.useDefault) {
    return getEarliestPopupReminderMinutes(defaultReminders);
  }

  if (Array.isArray(reminders?.overrides)) {
    return getEarliestPopupReminderMinutes(reminders.overrides);
  }

  return getEarliestPopupReminderMinutes(defaultReminders);
}

function getEarliestPopupReminderMinutes(reminders) {
  const popupMinutes = (reminders ?? [])
    .filter((reminder) => reminder?.method === "popup" && Number.isFinite(Number(reminder.minutes)))
    .map((reminder) => Number(reminder.minutes));

  if (popupMinutes.length === 0) {
    return null;
  }

  return Math.min(...popupMinutes);
}

function simplifySender(sender) {
  return sender.replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "") || sender;
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

async function sha256Base64Url(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
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
