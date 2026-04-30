# G Notify

Chrome extension prototype for polling Gmail and Google Calendar in the background. It uses Manifest V3, `chrome.alarms`, `chrome.identity.launchWebAuthFlow`, Google Gmail API, Google Calendar API, and Chrome desktop notifications.

## What it does

- Polls Gmail for unread inbox messages matching the configured Gmail search query.
- Shows a notification for unread messages found during sync, including the first successful sync.
- Polls primary Google Calendar events and shows upcoming reminders based on the calendar's own reminder time plus the poll interval.
- Works without Gmail or Calendar tabs being open, as long as Chrome can run extension service workers.

## Google Cloud setup

This version lets you paste the OAuth client ID in the extension popup. Users still sign in through Google's normal login and consent page.

1. Create a Google Cloud project.
2. Enable these APIs:
   - Gmail API
   - Google Calendar API
3. Configure the OAuth consent screen.
4. Create an OAuth client that supports an authorized redirect URI.
5. Load this folder as an unpacked extension in `chrome://extensions`.
6. Open the extension popup and copy the shown **Redirect URI**.
7. Add that exact Redirect URI to the OAuth client in Google Cloud.
8. Copy the OAuth client ID into the popup's **OAuth client ID** field.
9. Copy the OAuth client secret into the popup's **Client secret** field.
10. Settings save automatically. Click **Connect Google**.

Shortcut: the popup includes a link to [Google Cloud credentials](https://console.cloud.google.com/apis/credentials).

The redirect URI looks like `https://<extension-id>.chromiumapp.org/oauth2`. If you remove and reload the extension as a new unpacked extension, Chrome may assign a new extension ID, which means the redirect URI changes too.

## Local install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open the extension popup.
6. Paste your OAuth client ID and client secret. Settings save automatically, then click **Connect Google**.

## Notes

- Chrome 120+ is required because this scaffold allows `chrome.alarms` intervals as low as 30 seconds.
- Gmail polling defaults to `in:inbox is:unread newer_than:7d`.
- Existing unread mail found on the first successful sync will notify immediately.
- Calendar reminders currently use the primary calendar's popup reminders plus the poll interval, and timed events only. All-day events are ignored.
