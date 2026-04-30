const NOTIFICATION_TARGETS_STORAGE_KEY = "notificationTargets";

export async function handleNotificationClick(notificationId) {
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

export async function createNotification(id, options, targetUrl = null) {
  try {
    if (targetUrl) {
      await rememberNotificationTarget(id, targetUrl);
    }
    await chrome.notifications.create(id, options);
  } catch (error) {
    console.warn("Failed to create notification", error);
  }
}

export async function forgetNotificationTarget(notificationId) {
  const targets = await getNotificationTargets();
  if (!targets[notificationId]) {
    return;
  }

  delete targets[notificationId];
  await chrome.storage.local.set({ [NOTIFICATION_TARGETS_STORAGE_KEY]: targets });
}

export async function clearNotificationTargets() {
  await chrome.storage.local.set({ [NOTIFICATION_TARGETS_STORAGE_KEY]: {} });
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
