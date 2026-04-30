import { googleFetch } from "./auth.js";
import { createNotification } from "./notifications.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const CALENDAR_ICON_URL = chrome.runtime.getURL("icons/services/calendar.png");

export async function listCalendars(token) {
  const response = await googleFetch(token, "/calendar/v3/users/me/calendarList", {
    minAccessRole: "reader",
    maxResults: "250",
    fields: "items(id,summary,primary,selected,accessRole,backgroundColor)"
  });

  return (response.items ?? []).map((calendar) => ({
    id: calendar.primary ? "primary" : calendar.id,
    summary: calendar.summary || calendar.id,
    primary: Boolean(calendar.primary),
    selected: calendar.selected !== false,
    accessRole: calendar.accessRole || "",
    backgroundColor: calendar.backgroundColor || ""
  }));
}

export async function pollCalendar(token, settings, state) {
  const now = new Date();
  const pollIntervalMinutes = Number(settings.pollIntervalMinutes) || DEFAULT_SETTINGS.pollIntervalMinutes;
  const calendarIds = getSelectedCalendarIds(settings);
  if (calendarIds.length === 0) {
    return {
      state: {
        ...state,
        lastCalendarPollAt: new Date().toISOString()
      }
    };
  }

  const calendarDefaultsById = new Map();
  for (const calendarId of calendarIds) {
    calendarDefaultsById.set(calendarId, await getCalendarDefaults(token, calendarId));
  }

  const defaultReminderMinutes = getEarliestDefaultReminderMinutes([...calendarDefaultsById.values()]);
  const lookAheadMinutes = Math.max((defaultReminderMinutes ?? 0) + pollIntervalMinutes, 24 * 60);
  const timeMax = new Date(now.getTime() + lookAheadMinutes * 60 * 1000);
  const eventResponses = await Promise.all(calendarIds.map(async (calendarId) => {
    const response = await googleFetch(token, `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
      fields: "items(id,summary,location,start,end,htmlLink,status,reminders)"
    });

    return {
      calendarId,
      items: response.items ?? []
    };
  }));

  const notifiedKeys = new Set(state.notifiedCalendarKeys);
  const upcomingEvents = eventResponses
    .flatMap(({ calendarId, items }) => items.map((event) => ({
      calendarId,
      event
    })))
    .filter(({ event }) => event.status !== "cancelled")
    .map(({ calendarId, event }) => ({
      calendarId,
      event,
      startsAt: getEventStart(event),
      reminderMinutes: getEventReminderMinutes(event, calendarDefaultsById.get(calendarId) ?? [])
    }))
    .filter(({ startsAt, reminderMinutes }) => {
      if (!startsAt || reminderMinutes === null || reminderMinutes < 0) {
        return false;
      }

      const effectiveReminderMs = (reminderMinutes + pollIntervalMinutes) * 60 * 1000;
      return startsAt >= now && startsAt.getTime() - now.getTime() <= effectiveReminderMs;
    });

  for (const { calendarId, event, startsAt } of upcomingEvents) {
    const key = `${calendarId}|${event.id}|${startsAt.toISOString()}`;
    if (!notifiedKeys.has(key)) {
      await notifyCalendarEvent(calendarId, event, startsAt);
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

export async function createTestCalendarNotification() {
  await createNotification(`calendar:test:${Date.now()}`, {
    type: "basic",
    iconUrl: CALENDAR_ICON_URL,
    title: "Upcoming: Test event",
    message: "This is a sample Calendar notification from G Notify.",
    priority: 1
  }, "https://calendar.google.com/calendar/u/0/r");
}

async function notifyCalendarEvent(calendarId, event, startsAt) {
  const title = event.summary || "Calendar event";
  const time = startsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const location = event.location ? ` - ${event.location}` : "";

  await createNotification(`calendar:${calendarId}:${event.id}:${startsAt.toISOString()}`, {
    type: "basic",
    iconUrl: CALENDAR_ICON_URL,
    title: `Upcoming: ${title}`,
    message: `${time}${location}`,
    priority: 1
  }, event.htmlLink || null);
}

async function getCalendarDefaults(token, calendarId) {
  const response = await googleFetch(token, `/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`, {
    fields: "defaultReminders(method,minutes)"
  });
  return response.defaultReminders ?? [];
}

function getSelectedCalendarIds(settings) {
  return Array.isArray(settings.calendarIds) ? settings.calendarIds.filter(Boolean) : DEFAULT_SETTINGS.calendarIds;
}

function getEarliestDefaultReminderMinutes(defaultsList) {
  const reminderMinutes = defaultsList
    .map((reminders) => getEarliestPopupReminderMinutes(reminders))
    .filter((minutes) => minutes !== null);

  if (reminderMinutes.length === 0) {
    return null;
  }

  return Math.min(...reminderMinutes);
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
