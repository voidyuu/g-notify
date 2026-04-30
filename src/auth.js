import {
  clearAccessToken,
  clearAuth,
  getAuth,
  getSettings,
  setAuth
} from "./storage.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const API_ROOT = "https://www.googleapis.com";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

export async function googleFetch(token, path, params = {}) {
  const url = new URL(`${API_ROOT}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, item));
    } else if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (response.status === 401) {
    await clearAccessToken();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google API ${response.status}: ${truncate(body, 300)}`);
  }

  return response.json();
}

export async function getAuthToken({ interactive }) {
  const settings = await getSettings();
  const clientId = settings.oauthClientId;
  const clientSecret = settings.oauthClientSecret;
  if (!clientId) {
    throw new Error("Enter an OAuth client ID first.");
  }
  if (!clientSecret) {
    throw new Error("Enter a client secret first.");
  }

  const auth = await getAuth();
  if (auth.clientId && auth.clientId !== clientId) {
    await clearAuth();
  } else if (auth.accessToken && auth.expiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return auth.accessToken;
  } else if (auth.refreshToken) {
    return refreshAccessToken(clientId, clientSecret, auth.refreshToken);
  }

  if (!interactive) {
    throw new Error("Google authentication is required.");
  }

  return startInteractiveAuth(clientId, clientSecret);
}

export function getPublicAuth(auth, hasToken) {
  return {
    hasToken,
    expiresAt: auth.expiresAt || 0,
    scopes: Array.isArray(auth.scopes) ? auth.scopes : []
  };
}

export async function revokeStoredToken(auth) {
  const token = auth.refreshToken || auth.accessToken;
  if (!token) {
    return;
  }

  try {
    await revokeToken(token);
  } catch (error) {
    console.warn("Failed to revoke Google token", error);
  }
}

async function startInteractiveAuth(clientId, clientSecret) {
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)));
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const redirectUri = chrome.identity.getRedirectURL("oauth2");
  const authUrl = new URL(AUTH_ENDPOINT);

  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", [GMAIL_SCOPE, CALENDAR_SCOPE].join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  authUrl.searchParams.set("state", state);

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });

  const resultUrl = new URL(responseUrl);
  validateOAuthRedirect(resultUrl, redirectUri);
  if (getOAuthResponseParam(resultUrl, "state") !== state) {
    throw new Error("Google authorization returned an invalid state value.");
  }

  const error = getOAuthResponseParam(resultUrl, "error");
  if (error) {
    throw new Error(`Google authorization failed: ${error}`);
  }

  const code = getOAuthResponseParam(resultUrl, "code");
  if (!code) {
    throw new Error("Google authorization did not return an auth code.");
  }

  const tokenResponse = await exchangeAuthCode({ clientId, clientSecret, code, codeVerifier, redirectUri });
  await storeTokenResponse(clientId, tokenResponse);
  return tokenResponse.access_token;
}

async function exchangeAuthCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  return tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
}

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const tokenResponse = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  await storeTokenResponse(clientId, { ...tokenResponse, refresh_token: refreshToken });
  return tokenResponse.access_token;
}

async function tokenRequest(params) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams(params)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const description = body.error_description || body.error || response.statusText;
    throw new Error(`Google token request failed: ${description}`);
  }

  return body;
}

async function storeTokenResponse(clientId, tokenResponse) {
  if (!tokenResponse.access_token) {
    throw new Error("Google token response did not include an access token.");
  }

  await setAuth({
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    expiresAt: Date.now() + Number(tokenResponse.expires_in ?? 3600) * 1000,
    clientId,
    scopes: String(tokenResponse.scope || "").split(/\s+/).filter(Boolean)
  });
}

async function revokeToken(token) {
  const response = await fetch(TOKEN_REVOCATION_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({ token })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google token revocation failed: ${response.status} ${truncate(body, 300)}`);
  }
}

function validateOAuthRedirect(resultUrl, redirectUri) {
  const expectedUrl = new URL(redirectUri);
  if (resultUrl.origin !== expectedUrl.origin || resultUrl.pathname !== expectedUrl.pathname) {
    throw new Error("Google authorization returned an unexpected redirect URI.");
  }
}

function getOAuthResponseParam(url, name) {
  if (url.searchParams.has(name)) {
    return url.searchParams.get(name);
  }

  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  return hashParams.get(name);
}

async function sha256Base64Url(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}
