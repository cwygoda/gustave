import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bedrockProfile,
  cachedRefreshCommand,
  formatCommand,
  applyAwsCredentialsToEnv,
  isBedrockAuthError,
  isBedrockProvider,
  loginCommand,
  parseAwsProcessCredentials,
  shouldAutoRefresh,
  splitCommandLine,
} from "../extensions/bedrock-auth.ts";

// Real strings thrown by @aws-sdk/credential-provider-login and the Bedrock
// runtime when AWS/SSO credentials expire mid-session. These arrive as an
// assistant message errorMessage rather than a 401/403 HTTP status, so the
// extension relies on matching the text.
const EXPIRED_MESSAGES = [
  "Your session has expired. Please reauthenticate.",
  "Unable to refresh credentials because of a change in your password. Please reauthenticate with your new password.",
  "Failed to refresh token: ... Please re-authenticate using `aws login`",
  "Failed to load a token for session dev, please re-authenticate using aws login",
  "Token validation failed, missing fields: refreshToken",
  "CreateOAuth2Token AccessDeniedException: TOKEN_EXPIRED",
  "Failed to generate Dpop proof: invalid key",
  "The security token included in the request is expired",
  "The security token included in the request is invalid",
  "ExpiredTokenException: The provided token has expired.",
  "Token has expired and refresh failed",
  "Unable to refresh credentials due to insufficient permissions.",
  "credentials have expired",
  "Error: Could not load credentials from any providers",
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

test("isBedrockProvider accepts built-in and legacy Bedrock provider ids", () => {
  assert.equal(isBedrockProvider("amazon-bedrock"), true);
  assert.equal(isBedrockProvider("bedrock"), true);
  assert.equal(isBedrockProvider("anthropic"), false);
  assert.equal(isBedrockProvider(undefined), false);
});

test("bedrockProfile defaults to dev and ignores ambient AWS_PROFILE", () => {
  assert.equal(bedrockProfile({}), "dev");
  assert.equal(bedrockProfile({ AWS_PROFILE: "work" }), "dev");
  assert.equal(bedrockProfile({ AWS_PROFILE: "work", GUSTAVE_BEDROCK_AWS_PROFILE: "sandbox" }), "sandbox");
  assert.equal(bedrockProfile({ GUSTAVE_BEDROCK_PROFILE: "sandbox" }), "sandbox");
});

test("loginCommand defaults to aws login with the dev profile", () => {
  assert.deepEqual(loginCommand({}), {
    command: "aws",
    args: ["login", "--profile=dev"],
    display: "aws login --profile=dev",
  });
});

test("cachedRefreshCommand defaults to exporting fresh profile credentials", () => {
  assert.deepEqual(cachedRefreshCommand({ AWS_PROFILE: "dev" }), {
    command: "env",
    args: [
      "-u",
      "AWS_ACCESS_KEY_ID",
      "-u",
      "AWS_SECRET_ACCESS_KEY",
      "-u",
      "AWS_SESSION_TOKEN",
      "-u",
      "AWS_CREDENTIAL_EXPIRATION",
      "aws",
      "configure",
      "export-credentials",
      "--profile=dev",
      "--format",
      "process",
    ],
    display:
      "env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_CREDENTIAL_EXPIRATION aws configure export-credentials --profile=dev --format process",
  });
});

test("command overrides are shell-word parsed and display-quoted", () => {
  assert.deepEqual(splitCommandLine("aws login --profile 'dev profile'"), ["aws", "login", "--profile", "dev profile"]);
  assert.deepEqual(loginCommand({ GUSTAVE_BEDROCK_LOGIN_CMD: "aws login --profile dev" }), {
    command: "aws",
    args: ["login", "--profile", "dev"],
    display: "aws login --profile dev",
  });
  assert.equal(formatCommand("aws", ["login", "--profile", "dev profile"]), "aws login --profile 'dev profile'");
});

test("shouldAutoRefresh can be disabled", () => {
  assert.equal(shouldAutoRefresh({}), true);
  assert.equal(shouldAutoRefresh({ GUSTAVE_BEDROCK_AUTO_REFRESH: "0" }), false);
});

test("parseAwsProcessCredentials reads AWS CLI process JSON without logging secrets", () => {
  assert.deepEqual(
    parseAwsProcessCredentials(
      JSON.stringify({
        Version: 1,
        AccessKeyId: "ASIATESTKEY123456789",
        SecretAccessKey: "secret",
        SessionToken: "session",
        Expiration: "2026-01-01T00:00:00Z",
      })
    ),
    {
      AccessKeyId: "ASIATESTKEY123456789",
      SecretAccessKey: "secret",
      SessionToken: "session",
      Expiration: "2026-01-01T00:00:00Z",
    }
  );
});

test("parseAwsProcessCredentials accepts env-style command overrides", () => {
  assert.deepEqual(
    parseAwsProcessCredentials("AWS_ACCESS_KEY_ID='key'\nAWS_SECRET_ACCESS_KEY=secret\nAWS_SESSION_TOKEN=session"),
    {
      AccessKeyId: "key",
      SecretAccessKey: "secret",
      SessionToken: "session",
      Expiration: undefined,
    }
  );
});

test("applyAwsCredentialsToEnv updates the running process for the Bedrock SDK", () => {
  const previous = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    AWS_CREDENTIAL_EXPIRATION: process.env.AWS_CREDENTIAL_EXPIRATION,
  };

  try {
    assert.equal(
      applyAwsCredentialsToEnv({
        AccessKeyId: "key",
        SecretAccessKey: "secret",
        SessionToken: "session",
        Expiration: "2026-01-01T00:00:00Z",
      }),
      true
    );
    assert.equal(process.env.AWS_ACCESS_KEY_ID, "key");
    assert.equal(process.env.AWS_SECRET_ACCESS_KEY, "secret");
    assert.equal(process.env.AWS_SESSION_TOKEN, "session");
    assert.equal(process.env.AWS_CREDENTIAL_EXPIRATION, "2026-01-01T00:00:00Z");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
