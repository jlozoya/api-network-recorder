export const EXTENSION_SOURCE = "API_NETWORK_RECORDER"

export const MAX_BODY_SIZE_BYTES = 2 * 1024 * 1024

export const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
])

export const CAPTURABLE_TEXT_CONTENT_TYPES = [
  "application/json",
  "application/problem+json",
  "application/graphql",
  "text/",
  "application/x-www-form-urlencoded",
]