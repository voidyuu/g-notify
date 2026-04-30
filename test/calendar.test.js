import test from "node:test";
import assert from "node:assert/strict";

import { pollCalendar } from "../src/calendar.js";

const SETTINGS = {
  pollIntervalMinutes: 5,
  calendarIds: ["primary"]
};

test("notifies timed events when reminder falls in current poll window", async () => {
  const notifications = [];
  const state = { notifiedCalendarKeys: [] };
  const now = new Date("2026-04-30T10:00:00.000Z");

  const googleFetch = async (_token, path) => {
    if (path.includes("/calendarList/")) {
      return {
        defaultReminders: [{ method: "popup", minutes: 10 }]
      };
    }

    if (path.endsWith("/events")) {
      return {
        items: [{
          id: "evt-1",
          summary: "Team Sync",
          location: "Meeting Room",
          start: { dateTime: "2026-04-30T10:10:00.000Z" },
          status: "confirmed",
          htmlLink: "https://calendar.google.com/calendar/event?eid=123",
          reminders: { useDefault: true }
        }]
      };
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  const result = await pollCalendar("token", SETTINGS, state, {
    now: () => now,
    googleFetch,
    createNotification: async (id, options) => {
      notifications.push({ id, options });
    }
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.title, "Upcoming: Team Sync");
  assert.notEqual(notifications[0].options.message.startsWith("All day"), true);
  assert.equal(result.state.notifiedCalendarKeys.length, 1);
});

test("notifies all-day events and message starts with All day", async () => {
  const notifications = [];
  const state = { notifiedCalendarKeys: [] };
  const now = new Date(2026, 3, 30, 0, 2, 0);

  const googleFetch = async (_token, path) => {
    if (path.includes("/calendarList/")) {
      return {
        defaultReminders: [{ method: "popup", minutes: 0 }]
      };
    }

    if (path.endsWith("/events")) {
      return {
        items: [{
          id: "evt-2",
          summary: "Holiday",
          start: { date: "2026-04-30" },
          location: "Company",
          status: "confirmed",
          reminders: { useDefault: true }
        }]
      };
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  await pollCalendar("token", SETTINGS, state, {
    now: () => now,
    googleFetch,
    createNotification: async (_id, options) => {
      notifications.push(options);
    }
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Upcoming: Holiday");
  assert.equal(notifications[0].message.startsWith("All day"), true);
});

test("does not duplicate notification for the same event key", async () => {
  const notifications = [];
  const now = new Date("2026-04-30T10:00:00.000Z");
  const state = { notifiedCalendarKeys: [] };

  const googleFetch = async (_token, path) => {
    if (path.includes("/calendarList/")) {
      return {
        defaultReminders: [{ method: "popup", minutes: 10 }]
      };
    }

    if (path.endsWith("/events")) {
      return {
        items: [{
          id: "evt-3",
          summary: "Planning",
          start: { dateTime: "2026-04-30T10:10:00.000Z" },
          status: "confirmed",
          reminders: { useDefault: true }
        }]
      };
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  const first = await pollCalendar("token", SETTINGS, state, {
    now: () => now,
    googleFetch,
    createNotification: async () => {
      notifications.push("sent");
    }
  });

  await pollCalendar("token", SETTINGS, first.state, {
    now: () => now,
    googleFetch,
    createNotification: async () => {
      notifications.push("sent");
    }
  });

  assert.equal(notifications.length, 1);
});

test("does not notify cancelled events", async () => {
  const notifications = [];
  const state = { notifiedCalendarKeys: [] };
  const now = new Date("2026-04-30T10:00:00.000Z");

  const googleFetch = async (_token, path) => {
    if (path.includes("/calendarList/")) {
      return {
        defaultReminders: [{ method: "popup", minutes: 10 }]
      };
    }

    if (path.endsWith("/events")) {
      return {
        items: [{
          id: "evt-4",
          summary: "Cancelled Meeting",
          start: { dateTime: "2026-04-30T10:10:00.000Z" },
          status: "cancelled",
          reminders: { useDefault: true }
        }]
      };
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  await pollCalendar("token", SETTINGS, state, {
    now: () => now,
    googleFetch,
    createNotification: async () => {
      notifications.push("sent");
    }
  });

  assert.equal(notifications.length, 0);
});

test("does not notify when no popup reminder exists", async () => {
  const notifications = [];
  const state = { notifiedCalendarKeys: [] };
  const now = new Date("2026-04-30T10:00:00.000Z");

  const googleFetch = async (_token, path) => {
    if (path.includes("/calendarList/")) {
      return {
        defaultReminders: [{ method: "email", minutes: 10 }]
      };
    }

    if (path.endsWith("/events")) {
      return {
        items: [{
          id: "evt-5",
          summary: "Email-only reminder",
          start: { dateTime: "2026-04-30T10:10:00.000Z" },
          status: "confirmed",
          reminders: { useDefault: true }
        }]
      };
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  await pollCalendar("token", SETTINGS, state, {
    now: () => now,
    googleFetch,
    createNotification: async () => {
      notifications.push("sent");
    }
  });

  assert.equal(notifications.length, 0);
});

test("compensates a missed reminder once before an event ends", async () => {
  const notifications = [];
  const state = { notifiedCalendarKeys: [] };
  const now = new Date("2026-04-30T10:30:00.000Z");

  const googleFetch = async (_token, path) => {
    if (path.includes("/calendarList/")) {
      return {
        defaultReminders: [{ method: "popup", minutes: 60 }]
      };
    }

    if (path.endsWith("/events")) {
      return {
        items: [{
          id: "evt-6",
          summary: "Long Meeting",
          start: { dateTime: "2026-04-30T10:00:00.000Z" },
          end: { dateTime: "2026-04-30T11:00:00.000Z" },
          status: "confirmed",
          reminders: { useDefault: true }
        }]
      };
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  const first = await pollCalendar("token", SETTINGS, state, {
    now: () => now,
    googleFetch,
    createNotification: async () => {
      notifications.push("sent");
    }
  });

  await pollCalendar("token", SETTINGS, first.state, {
    now: () => now,
    googleFetch,
    createNotification: async () => {
      notifications.push("sent");
    }
  });

  assert.equal(notifications.length, 1);
});

test("does not compensate reminders after event end", async () => {
  const notifications = [];
  const state = { notifiedCalendarKeys: [] };
  const now = new Date("2026-04-30T11:30:00.000Z");

  const googleFetch = async (_token, path) => {
    if (path.includes("/calendarList/")) {
      return {
        defaultReminders: [{ method: "popup", minutes: 60 }]
      };
    }

    if (path.endsWith("/events")) {
      return {
        items: [{
          id: "evt-7",
          summary: "Ended Meeting",
          start: { dateTime: "2026-04-30T10:00:00.000Z" },
          end: { dateTime: "2026-04-30T11:00:00.000Z" },
          status: "confirmed",
          reminders: { useDefault: true }
        }]
      };
    }

    throw new Error(`Unexpected path: ${path}`);
  };

  await pollCalendar("token", SETTINGS, state, {
    now: () => now,
    googleFetch,
    createNotification: async () => {
      notifications.push("sent");
    }
  });

  assert.equal(notifications.length, 0);
});
