import { googleFetch } from "./auth.js";
import { createNotification } from "./notifications.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const CALENDAR_ICON_URL = chrome.runtime.getURL("icons/services/calendar.png");

export async function pollCalendar(token, settings, state) {
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

export async function createTestCalendarNotification() {
  await createNotification(`calendar:test:${Date.now()}`, {
    type: "basic",
    iconUrl: CALENDAR_ICON_URL,
    title: "Upcoming: Test event",
    message: "This is a sample Calendar notification from G Notify.",
    priority: 1
  }, "https://calendar.google.com/calendar/u/0/r");
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

async function getPrimaryCalendarDefaults(token) {
  const response = await googleFetch(token, "/calendar/v3/users/me/calendarList/primary", {
    fields: "defaultReminders(method,minutes)"
  });
  return response.defaultReminders ?? [];
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
