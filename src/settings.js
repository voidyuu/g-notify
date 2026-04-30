export const DEFAULT_SETTINGS = {
  oauthClientId: "",
  oauthClientSecret: "",
  enabled: true,
  gmailEnabled: true,
  calendarEnabled: true,
  pollIntervalMinutes: 5,
  gmailQuery: "in:inbox is:unread newer_than:7d",
  maxGmailResults: 10
};

export function sanitizeSettings(settings) {
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

export function getPublicSettings(settings, hasToken) {
  return {
    ...settings,
    oauthClientSecret: hasToken ? "" : settings.oauthClientSecret
  };
}
