import { googleFetch } from "./auth.js";
import { createNotification } from "./notifications.js";

const GMAIL_ICON_URL = chrome.runtime.getURL("icons/services/gmail.png");

export async function pollGmail(token, settings, state) {
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

export async function createTestGmailNotification() {
  await createNotification(`gmail:test:${Date.now()}`, {
    type: "basic",
    iconUrl: GMAIL_ICON_URL,
    title: "New mail: Test notification",
    message: "This is a sample Gmail notification from G Notify.",
    priority: 1
  }, "https://mail.google.com/mail/u/0/#inbox");
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

function buildGmailThreadUrl(threadId) {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function getHeaders(headers) {
  return headers.reduce((acc, header) => {
    acc[header.name.toLowerCase()] = header.value;
    return acc;
  }, {});
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

function normalizeError(error) {
  if (!error) {
    return "Unknown error.";
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || "Unknown error.";
}
