// Bedrock Auth Refresh Extension
// Keeps Amazon Bedrock usable with AWS CLI `aws login` profiles. The AWS SDK
// and CLI use the cached login refresh token when possible; Gustave only opens
// the browser login flow when cached renewal fails.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BEDROCK_PROVIDERS = new Set(["amazon-bedrock", "bedrock"]);
const AUTH_FAILURE_STATUSES = new Set([401, 403]);
const DEFAULT_BEDROCK_PROFILE = "dev";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CACHED_REFRESH_TIMEOUT_MS = 30_000;
const CACHED_REFRESH_SUCCESS_TTL_MS = 8 * 60_000;
const CACHED_REFRESH_FAILURE_BACKOFF_MS = 60_000;

// Bedrock/AWS login credential expiry frequently surfaces as a thrown error from
// the AWS credential provider chain *before* any HTTP request is made, so it
// never reaches `after_provider_response` as a 401/403. Match those error
// strings so we can still offer to reauthenticate. See
// @aws-sdk/credential-provider-login and the AWS CLI `aws login` cache flow.
export const AUTH_FAILURE_PATTERN =
  /session has expired|please reauthenticate|re-?authenticate|aws login|failed to load a token for session|token validation failed|createoauth2token|dpop|expiredtokenexception|(?:token|credential(?:s)?|session|sso)[^.]*expired|expired[^.]*(?:token|credential|session)|the security token included in the request is (?:expired|invalid)|unable to refresh credentials/i;

export function isBedrockAuthError(text: string | undefined): boolean {
  if (!text) return false;
  return AUTH_FAILURE_PATTERN.test(text);
}

export function isBedrockProvider(provider: string | undefined): boolean {
  return provider !== undefined && BEDROCK_PROVIDERS.has(provider);
}

export function bedrockProfile(env: Record<string, string | undefined> = process.env): string {
  const raw = env.GUSTAVE_BEDROCK_AWS_PROFILE ?? env.GUSTAVE_BEDROCK_PROFILE;
  const profile = raw?.trim();
  return profile || DEFAULT_BEDROCK_PROFILE;
}

export function splitCommandLine(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  if (current) parts.push(current);
  return parts;
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

export function loginCommand(env: Record<string, string | undefined> = process.env): {
  command: string;
  args: string[];
  display: string;
} {
  const raw = env.GUSTAVE_BEDROCK_LOGIN_CMD?.trim();
  const parts = raw ? splitCommandLine(raw) : ["aws", "login", `--profile=${bedrockProfile(env)}`];
  const [command = "aws", ...args] = parts.length > 0 ? parts : ["aws", "login", `--profile=${bedrockProfile(env)}`];
  return { command, args, display: formatCommand(command, args) };
}

export function cachedRefreshCommand(env: Record<string, string | undefined> = process.env): {
  command: string;
  args: string[];
  display: string;
} {
  const raw = env.GUSTAVE_BEDROCK_REFRESH_CMD?.trim();
  const parts = raw
    ? splitCommandLine(raw)
    : ["aws", "sts", "get-caller-identity", `--profile=${bedrockProfile(env)}`, "--output", "json", "--no-cli-pager"];
  const [command = "aws", ...args] =
    parts.length > 0
      ? parts
      : ["aws", "sts", "get-caller-identity", `--profile=${bedrockProfile(env)}`, "--output", "json", "--no-cli-pager"];
  return { command, args, display: formatCommand(command, args) };
}

export function shouldAutoRefresh(env: Record<string, string | undefined> = process.env): boolean {
  return env.GUSTAVE_BEDROCK_AUTO_REFRESH !== "0";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function configureDefaultProfile() {
  if (process.env.GUSTAVE_BEDROCK_SET_AWS_PROFILE === "0") return;
  process.env.AWS_PROFILE = bedrockProfile();
}

function redactCredentialLikeText(text: string): string {
  return text
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/((?:aws_)?secret_access_key\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:aws_)?session_token\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:aws_)?access_key_id\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]");
}

function summarizeCommandFailure(stdout: string, stderr: string): string {
  const detail = redactCredentialLikeText((stderr || stdout || "").trim());
  if (!detail) return "";
  return detail.split(/\r?\n/).slice(0, 4).join("\n").slice(0, 800);
}

export default function bedrockAuthExtension(pi: ExtensionAPI) {
  configureDefaultProfile();

  let pendingAuthFailure = false;
  let refreshing = false;
  let lastUserInput: string | undefined;
  let nextCachedRefreshCheckAt = 0;
  let lastCachedRefreshSucceeded = false;

  // Remember the most recent user prompt so we can offer to retry it after a
  // successful credential refresh.
  pi.on("input", async (event) => {
    if (event.source !== "extension" && event.text.trim()) {
      lastUserInput = event.text;
    }
  });

  // Proactively let the AWS CLI renew the short-lived login session from the
  // cached refresh token before Bedrock sends a request. This command does not
  // open a browser; it simply exercises the profile credential chain. If the
  // refresh token is absent/invalid we stay quiet and let the normal auth-error
  // path prompt for `aws login --profile=dev` after the failed turn settles.
  pi.on("before_provider_request", async (_event, ctx) => {
    if (!isBedrockProvider(ctx.model?.provider)) return;
    if (!shouldAutoRefresh()) return;
    await refreshFromCachedToken(pi, { force: false, notify: false });
  });

  // Some Bedrock credential expiries surface as a 401/403 from the provider.
  pi.on("after_provider_response", async (event, ctx) => {
    if (!isBedrockProvider(ctx.model?.provider)) return;
    if (AUTH_FAILURE_STATUSES.has(event.status)) {
      pendingAuthFailure = true;
    }
  });

  // Most login-token expiries are thrown while resolving credentials (no HTTP
  // status), so they arrive as an assistant message with stopReason "error" and
  // an errorMessage. Detect those here.
  pi.on("message_end", async (event, ctx) => {
    if (!isBedrockProvider(ctx.model?.provider)) return;
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
        "Amazon Bedrock credentials look expired (the provider rejected the request or your AWS login session expired).",
      offerRetry: true,
    });
  });

  // Manual escape hatch: first try cached refresh-token renewal, then fall back
  // to browser login. Pass `login` or `--login` to skip the cached refresh try.
  pi.registerCommand("bedrock-login", {
    description: "Renew AWS/Bedrock credentials with aws login profile refresh, falling back to browser login",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const forceLogin = trimmed === "login" || trimmed === "--login" || trimmed === "--force";
      await refreshCredentials(pi, ctx, {
        reason: "Refresh AWS/Bedrock credentials.",
        offerRetry: false,
        forceLogin,
      });
    },
  });

  async function refreshCredentials(
    api: ExtensionAPI,
    ctx: ExtensionContext,
    options: { reason: string; offerRetry: boolean; forceLogin?: boolean }
  ) {
    if (refreshing) return;
    if (!ctx.hasUI) return;

    refreshing = true;
    try {
      if (!options.forceLogin) {
        ctx.ui.setStatus("gustave", "aws refresh…");
        const refreshed = await refreshFromCachedToken(api, { force: true, notify: true, ctx });
        if (refreshed) {
          await offerRetryIfNeeded(api, ctx, options.offerRetry);
          return;
        }
      }

      await runBrowserLogin(api, ctx, options.reason, options.offerRetry);
    } finally {
      refreshing = false;
      if (ctx.mode === "tui") ctx.ui.setStatus("gustave", "ready");
    }
  }

  async function refreshFromCachedToken(
    api: ExtensionAPI,
    options: { force: boolean; notify: boolean; ctx?: ExtensionContext }
  ): Promise<boolean> {
    if (!options.force && Date.now() < nextCachedRefreshCheckAt) return lastCachedRefreshSucceeded;

    const { command, args, display } = cachedRefreshCommand();
    let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
    try {
      result = await api.exec(command, args, { timeout: CACHED_REFRESH_TIMEOUT_MS });
    } catch (error) {
      lastCachedRefreshSucceeded = false;
      nextCachedRefreshCheckAt = Date.now() + CACHED_REFRESH_FAILURE_BACKOFF_MS;
      if (options.notify && options.ctx) {
        const message = error instanceof Error ? error.message : String(error);
        options.ctx.ui.notify(
          `Cached AWS login refresh could not run \`${display}\`. Browser login is needed.\n${redactCredentialLikeText(
            message
          )}`,
          "warning"
        );
      }
      return false;
    }

    if (result.code === 0) {
      lastCachedRefreshSucceeded = true;
      nextCachedRefreshCheckAt = Date.now() + CACHED_REFRESH_SUCCESS_TTL_MS;
      if (options.notify && options.ctx) {
        options.ctx.ui.notify(
          `AWS Bedrock session renewed from the cached \`${bedrockProfile()}\` refresh token.`,
          "info"
        );
      }
      return true;
    }

    lastCachedRefreshSucceeded = false;
    nextCachedRefreshCheckAt = Date.now() + CACHED_REFRESH_FAILURE_BACKOFF_MS;
    if (options.notify && options.ctx) {
      const detail = summarizeCommandFailure(result.stdout, result.stderr);
      options.ctx.ui.notify(
        `Cached AWS login refresh failed via \`${display}\`. Browser login is needed.${detail ? `\n${detail}` : ""}`,
        "warning"
      );
    }
    return false;
  }

  async function runBrowserLogin(api: ExtensionAPI, ctx: ExtensionContext, reason: string, offerRetry: boolean) {
    const { command, args, display } = loginCommand();
    const proceed = await ctx.ui.confirm(
      "Refresh Bedrock credentials",
      `${reason}\n\nRun \`${display}\` to sign in again?`
    );
    if (!proceed) return;

    ctx.ui.setStatus("gustave", "aws login…");
    ctx.ui.notify(`Running \`${display}\`…`, "info");
    try {
      const result = await api.exec(command, args, { timeout: LOGIN_TIMEOUT_MS });
      if (result.code !== 0) {
        const detail = summarizeCommandFailure(result.stdout, result.stderr);
        ctx.ui.notify(`\`${display}\` failed (exit ${result.code}).${detail ? `\n${detail}` : ""}`, "error");
        return;
      }

      lastCachedRefreshSucceeded = true;
      nextCachedRefreshCheckAt = Date.now() + CACHED_REFRESH_SUCCESS_TTL_MS;
      ctx.ui.notify(
        `AWS credentials refreshed for profile \`${bedrockProfile()}\`. Bedrock will re-read them on the next request.`,
        "info"
      );
      await offerRetryIfNeeded(api, ctx, offerRetry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not run \`${display}\`: ${redactCredentialLikeText(message)}`, "error");
    }
  }

  async function offerRetryIfNeeded(api: ExtensionAPI, ctx: ExtensionContext, offerRetry: boolean) {
    if (offerRetry && lastUserInput && ctx.isIdle()) {
      const retry = await ctx.ui.confirm("Retry request", "Resend your last message to continue?");
      if (retry) {
        api.sendUserMessage(lastUserInput);
      }
    }
  }
}
