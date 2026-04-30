import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.js";

export const DEFAULT_STATE = {
  gmailInitialized: false,
  seenGmailIds: [],
  notifiedCalendarKeys: [],
  lastGmailPollAt: null,
  lastCalendarPollAt: null,
  lastError: null,
  lastPollAt: null,
  unreadEstimate: 0
};

export const DEFAULT_AUTH = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  clientId: null,
  scopes: []
};

export async function initializeStorage() {
  const settings = await getSettings();
  const state = await getState();
  const auth = await getAuth();

  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...settings },
    state: { ...DEFAULT_STATE, ...state },
    auth: { ...DEFAULT_AUTH, ...auth }
  });
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ settings: sanitizeSettings(settings) });
}

export async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...DEFAULT_STATE, ...(state ?? {}) };
}

export async function setState(state) {
  await chrome.storage.local.set({ state: { ...DEFAULT_STATE, ...state } });
}

export async function getAuth() {
  const { auth } = await chrome.storage.local.get("auth");
  return { ...DEFAULT_AUTH, ...(auth ?? {}) };
}

export async function setAuth(auth) {
  await chrome.storage.local.set({ auth: { ...DEFAULT_AUTH, ...auth } });
}

export async function clearAuth() {
  await chrome.storage.local.set({ auth: { ...DEFAULT_AUTH } });
}

export async function clearAccessToken() {
  const auth = await getAuth();
  await setAuth({
    ...auth,
    accessToken: null,
    expiresAt: 0
  });
}
