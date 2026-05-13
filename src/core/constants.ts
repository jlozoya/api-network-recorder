export const EXTENSION_SOURCE = "API_NETWORK_RECORDER"

export const MAX_BODY_SIZE_BYTES = 2 * 1024 * 1024

export const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
  "x-stytch-session",
  "stytch-session",
])

export const SENSITIVE_BODY_KEYS = new Set([
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "id_token",
  "idToken",
  "token",
  "jwt",
  "password",
  "passcode",
  "otp",
  "mfa",
  "totp",
  "code",
  "secret",
  "client_secret",
  "clientSecret",
  "api_key",
  "apiKey",
  "authorization",
  "cookie",
  "set-cookie",
])

export const CAPTURABLE_TEXT_CONTENT_TYPES = [
  "application/json",
  "application/problem+json",
  "application/graphql",
  "text/",
  "application/x-www-form-urlencoded",
]