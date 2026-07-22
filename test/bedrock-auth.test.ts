import assert from "node:assert/strict";
import { test } from "node:test";

import { isBedrockAuthError } from "../extensions/bedrock-auth.ts";

// Real strings thrown by @aws-sdk/credential-provider-login and the Bedrock
// runtime when AWS/SSO credentials expire mid-session. These arrive as an
// assistant message errorMessage rather than a 401/403 HTTP status, so the
// extension relies on matching the text.
const EXPIRED_MESSAGES = [
  "Your session has expired. Please reauthenticate.",
  "Unable to refresh credentials because of a change in your password. Please reauthenticate with your new password.",
  "Failed to refresh token: ... Please re-authenticate using `aws login`",
  "The security token included in the request is expired",
  "The security token included in the request is invalid",
  "ExpiredTokenException: The provided token has expired.",
  "Token has expired and refresh failed",
  "Unable to refresh credentials due to insufficient permissions.",
  "credentials have expired",
];

const UNRELATED_MESSAGES = [
  "",
  undefined,
  "Rate limit exceeded, please try again later.",
  "The model returned a 500 internal server error.",
  "Tool execution failed: file not found.",
  "Connection reset by peer.",
  "ValidationException: input is too long.",
];

test("isBedrockAuthError matches AWS credential expiry messages", () => {
  for (const message of EXPIRED_MESSAGES) {
    assert.equal(isBedrockAuthError(message), true, `expected auth error: ${message}`);
  }
});

test("isBedrockAuthError ignores unrelated errors and empty input", () => {
  for (const message of UNRELATED_MESSAGES) {
    assert.equal(isBedrockAuthError(message), false, `expected non-auth error: ${String(message)}`);
  }
});

test("isBedrockAuthError is case-insensitive", () => {
  assert.equal(isBedrockAuthError("YOUR SESSION HAS EXPIRED"), true);
  assert.equal(isBedrockAuthError("expiredtokenexception"), true);
});
