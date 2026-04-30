import { googleFetch } from "./auth.js";
import { createNotification } from "./notifications.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const CALENDAR_ICON_URL = globalThis.chrome?.runtime?.getURL
  ? globalThis.chrome.runtime.getURL("icons/services/calendar.png")
  : "icons/services/calendar.png";
const DAY_MINUTES = 24 * 60;

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

export async function pollCalendar(token, settings, state, deps = {}) {
  const googleFetchFn = deps.googleFetch ?? googleFetch;
  const createNotificationFn = deps.createNotification ?? createNotification;
  const now = typeof deps.now === "function" ? deps.now() : new Date();
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
    calendarDefaultsById.set(calendarId, await getCalendarDefaults(token, calendarId, googleFetchFn));
  }

  const defaultReminderMinutes = getLargestDefaultReminderMinutes([...calendarDefaultsById.values()]);
  const lookAheadMinutes = Math.max((defaultReminderMinutes ?? 0) + pollIntervalMinutes, DAY_MINUTES);
  const timeMax = new Date(now.getTime() + lookAheadMinutes * 60 * 1000);
  const eventResponses = await Promise.all(calendarIds.map(async (calendarId) => {
    const response = await googleFetchFn(token, `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
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
      timing: getEventTiming(event),
      reminderMinutes: getEventReminderMinutes(event, calendarDefaultsById.get(calendarId) ?? [])
    }))
    .map(({ calendarId, event, timing, reminderMinutes }) => ({
      calendarId,
      event,
      timing,
      reminderAt: getReminderTime(timing, reminderMinutes),
      endsAt: getEventEndTime(event, timing)
    }))
    .filter(({ reminderAt, timing, endsAt }) => {
      if (!timing || !reminderAt || now < reminderAt) {
        return false;
      }

      const pollWindowEnd = new Date(reminderAt.getTime() + pollIntervalMinutes * 60 * 1000);
      if (now <= pollWindowEnd) {
        return true;
      }

      const compensationEnd = endsAt ?? timing.startsAt;
      return now < compensationEnd;
    });

  for (const { calendarId, event, timing } of upcomingEvents) {
    const key = `${calendarId}|${event.id}|${timing.startsAt.toISOString()}`;
    if (!notifiedKeys.has(key)) {
      await notifyCalendarEvent(calendarId, event, timing, createNotificationFn);
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

async function notifyCalendarEvent(calendarId, event, timing, createNotificationFn = createNotification) {
  const title = event.summary || "Calendar event";
  const time = timing.isAllDay ? "All day" : timing.startsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const location = event.location ? ` - ${event.location}` : "";

  await createNotificationFn(`calendar:${calendarId}:${event.id}:${timing.startsAt.toISOString()}`, {
    type: "basic",
    iconUrl: CALENDAR_ICON_URL,
    title: `Upcoming: ${title}`,
    message: `${time}${location}`,
    priority: 1
  }, event.htmlLink || null);
}

async function getCalendarDefaults(token, calendarId, googleFetchFn = googleFetch) {
  const response = await googleFetchFn(token, `/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`, {
    fields: "defaultReminders(method,minutes)"
  });
  return response.defaultReminders ?? [];
}

function getSelectedCalendarIds(settings) {
  return Array.isArray(settings.calendarIds) ? settings.calendarIds.filter(Boolean) : DEFAULT_SETTINGS.calendarIds;
}

function getLargestDefaultReminderMinutes(defaultsList) {
  const reminderMinutes = defaultsList
    .flatMap((reminders) => getPopupReminderMinutes(reminders))
    .filter((minutes) => minutes !== null);

  if (reminderMinutes.length === 0) {
    return null;
  }

  return Math.max(...reminderMinutes);
}

function getEventTiming(event) {
  if (event.start?.dateTime) {
    const startsAt = new Date(event.start.dateTime);
    return Number.isFinite(startsAt.getTime()) ? { startsAt, isAllDay: false } : null;
  }

  if (event.start?.date) {
    const startsAt = parseLocalDate(event.start.date);
    return startsAt ? { startsAt, isAllDay: true } : null;
  }

  return null;
}

function getEventEndTime(event, timing) {
  if (!timing) {
    return null;
  }

  if (event.end?.dateTime) {
    const endsAt = new Date(event.end.dateTime);
    return Number.isFinite(endsAt.getTime()) ? endsAt : null;
  }

  if (event.end?.date) {
    const endsAt = parseLocalDate(event.end.date);
    return endsAt ?? null;
  }

  return null;
}

function getReminderTime(timing, reminderMinutes) {
  if (!timing || reminderMinutes === null || reminderMinutes < 0) {
    return null;
  }

  const reminderAt = new Date(timing.startsAt.getTime() - reminderMinutes * 60 * 1000);
  return Number.isFinite(reminderAt.getTime()) ? reminderAt : null;
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
  const popupMinutes = getPopupReminderMinutes(reminders);

  if (popupMinutes.length === 0) {
    return null;
  }

  return Math.min(...popupMinutes);
}

function getPopupReminderMinutes(reminders) {
  return (reminders ?? [])
    .filter((reminder) => reminder?.method === "popup" && Number.isFinite(Number(reminder.minutes)))
    .map((reminder) => Number(reminder.minutes));
}

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return null;
  }

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(date.getTime()) ? date : null;
}
