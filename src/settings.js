export const DEFAULT_SETTINGS = {
  oauthClientId: "",
  oauthClientSecret: "",
  enabled: true,
  gmailEnabled: true,
  calendarEnabled: true,
  calendarIds: ["primary"],
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
    calendarIds: sanitizeCalendarIds(settings.calendarIds),
    pollIntervalMinutes: Math.max(0.5, Number(settings.pollIntervalMinutes) || DEFAULT_SETTINGS.pollIntervalMinutes),
    gmailQuery: String(settings.gmailQuery || DEFAULT_SETTINGS.gmailQuery).trim(),
    maxGmailResults: Math.max(1, Math.min(50, Number(settings.maxGmailResults) || DEFAULT_SETTINGS.maxGmailResults))
  };
}

function sanitizeCalendarIds(calendarIds) {
  const ids = Array.isArray(calendarIds)
    ? calendarIds.map((id) => String(id || "").trim()).filter(Boolean)
    : DEFAULT_SETTINGS.calendarIds;

  return [...new Set(ids)].slice(0, 50);
}

export function getPublicSettings(settings, hasToken) {
  return {
    ...settings,
    oauthClientSecret: hasToken ? "" : settings.oauthClientSecret
  };
}
