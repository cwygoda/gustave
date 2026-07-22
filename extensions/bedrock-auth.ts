// Bedrock Auth Refresh Extension
// Detects expired Amazon Bedrock (AWS) credentials and offers to refresh them
// by running a login command (default `aws login`), then optionally retries the
// last request. AWS profile/SSO credentials are re-read from the credential
// chain on the next request, so a successful login is enough to continue.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BEDROCK_PROVIDER = "amazon-bedrock";
const AUTH_FAILURE_STATUSES = new Set([401, 403]);
const LOGIN_TIMEOUT_MS = 5 * 60_000;

// Bedrock/SSO credential expiry frequently surfaces as a thrown error from the
// AWS credential provider chain *before* any HTTP request is made, so it never
// reaches `after_provider_response` as a 401/403. Match those error strings so
// we can still offer to reauthenticate. See @aws-sdk/credential-provider-login
// ("Your session has expired. Please reauthenticate.").
export const AUTH_FAILURE_PATTERN =
  /session has expired|please reauthenticate|re-?authenticate|aws login|expiredtokenexception|(?:token|credential(?:s)?|session|sso)[^.]*expired|expired[^.]*(?:token|credential|session)|the security token included in the request is (?:expired|invalid)|unable to refresh credentials/i;

export function isBedrockAuthError(text: string | undefined): boolean {
  if (!text) return false;
  return AUTH_FAILURE_PATTERN.test(text);
}

function loginCommand(): { command: string; args: string[]; display: string } {
  const raw = (process.env.GUSTAVE_BEDROCK_LOGIN_CMD ?? "aws login").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const [command, ...args] = parts.length > 0 ? parts : ["aws", "login"];
  return { command, args, display: [command, ...args].join(" ") };
}

export default function bedrockAuthExtension(pi: ExtensionAPI) {
  let pendingAuthFailure = false;
  let refreshing = false;
  let lastUserInput: string | undefined;

  // Remember the most recent user prompt so we can offer to retry it after a
  // successful credential refresh.
  pi.on("input", async (event) => {
    if (event.source !== "extension" && event.text.trim()) {
      lastUserInput = event.text;
    }
  });

  // Some Bedrock credential expiries surface as a 401/403 from the provider.
  pi.on("after_provider_response", async (event, ctx) => {
    if (ctx.model?.provider !== BEDROCK_PROVIDER) return;
    if (AUTH_FAILURE_STATUSES.has(event.status)) {
      pendingAuthFailure = true;
    }
  });

  // Most SSO expiries are thrown while resolving credentials (no HTTP status),
  // so they arrive as an assistant message with stopReason "error" and an
  // errorMessage. Detect those here.
  pi.on("message_end", async (event, ctx) => {
    if (ctx.model?.provider !== BEDROCK_PROVIDER) return;
    const message = event.message as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
    if (isBedrockAuthError(message.errorMessage)) {
      pendingAuthFailure = true;
    }
  });

  // Act once the run has fully settled so we don't interrupt streaming or retries.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingAuthFailure) return;
    pendingAuthFailure = false;
    await refreshCredentials(pi, ctx, {
      reason:
        "Amazon Bedrock credentials look expired (the provider rejected the request or your AWS session token expired).",
      offerRetry: true,
    });
  });

  // Manual escape hatch: refresh on demand regardless of detection.
  pi.registerCommand("bedrock-login", {
    description: "Refresh AWS/Bedrock credentials by running the login command",
    handler: async (_args, ctx) => {
      await refreshCredentials(pi, ctx, {
        reason: "Refresh AWS/Bedrock credentials.",
        offerRetry: false,
      });
    },
  });

  async function refreshCredentials(
    api: ExtensionAPI,
    ctx: ExtensionContext,
    options: { reason: string; offerRetry: boolean }
  ) {
    if (refreshing) return;
    if (!ctx.hasUI) return;

    const { command, args, display } = loginCommand();
    const proceed = await ctx.ui.confirm(
      "Refresh Bedrock credentials",
      `${options.reason}\n\nRun \`${display}\` to sign in again?`
    );
    if (!proceed) return;

    refreshing = true;
    ctx.ui.setStatus("gustave", "aws login…");
    ctx.ui.notify(`Running \`${display}\`…`, "info");
    try {
      const result = await api.exec(command, args, { timeout: LOGIN_TIMEOUT_MS });
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        ctx.ui.notify(`\`${display}\` failed (exit ${result.code}).${detail ? `\n${detail}` : ""}`, "error");
        return;
      }

      ctx.ui.notify("AWS credentials refreshed. Bedrock will re-read them on the next request.", "info");

      if (options.offerRetry && lastUserInput && ctx.isIdle()) {
        const retry = await ctx.ui.confirm("Retry request", "Resend your last message to continue?");
        if (retry) {
          api.sendUserMessage(lastUserInput);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not run \`${display}\`: ${message}`, "error");
    } finally {
      refreshing = false;
      if (ctx.mode === "tui") ctx.ui.setStatus("gustave", "ready");
    }
  }
}
