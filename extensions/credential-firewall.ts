// Credential Firewall Extension
// Keeps gh/aws usable while blocking credential extraction and redacting accidental leaks.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

type TextPart = { type: "text"; text: string; [key: string]: unknown };

const credentialPathPatterns = [
	/(^|\/)\.aws\/(credentials|config|sso\/cache|cli\/cache)(\/|$)/i,
	/(^|\/)\.config\/gh\/(hosts\.yml|config\.yml)(\/|$)/i,
	/(^|\/)\.git-credentials$/i,
	/(^|\/)\.ssh\/(?!config$)[^\s;|&]*/i,
	/(^|\/)\.docker\/config\.json$/i,
	/(^|\/)\.kube\/config$/i,
];

const blockedCommandPatterns = [
	// Direct token export commands.
	/\bgh\s+auth\s+token\b/i,
	/\baws\s+configure\s+export-credentials\b/i,
	/\baws\s+configure\s+get\s+(aws_access_key_id|aws_secret_access_key|aws_session_token)\b/i,

	// macOS Keychain password extraction, common source for gh/git tokens.
	/\bsecurity\s+find-(generic|internet)-password\b[^\n;|&]*\s-w\b/i,

	// Direct reads/searches of known credential storage.
	/\b(cat|bat|less|more|head|tail|grep|rg|awk|sed|jq|yq|python\d?|node|perl|ruby)\b[^\n;|&]*(\.aws\/(credentials|config|sso\/cache|cli\/cache)|\.config\/gh\/hosts\.yml|\.git-credentials|\.ssh\/|\.docker\/config\.json|\.kube\/config)/i,
];

const secretRedactions: Array<[RegExp, string]> = [
	[/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
	[/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
	[/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY_ID]"],
	[/\b(?:xox[baprs]-)[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]"],
	[/\b(sk-(?:live|test)-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{32,})\b/g, "[REDACTED_API_KEY]"],

	// key=value / YAML / JSON-ish credential fields.
	[/((?:AWS_)?SECRET_ACCESS_KEY\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"],
	[/((?:AWS_)?SESSION_TOKEN\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"],
	[/((?:AWS_)?ACCESS_KEY_ID\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"],
	[/((?:aws_)?secret_access_key\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"],
	[/((?:aws_)?session_token\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"],
	[/((?:aws_)?access_key_id\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"],
	[/((?:SecretAccessKey|SessionToken|AccessKeyId)\s*["']?\s*:\s*["'])[^"']+/g, "$1[REDACTED]"],
	[/((?:token|access_token|refresh_token|id_token|password|passwd|secret|api[_-]?key)\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"],
	[/((?:authorization)\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
];

function redact(text: string): string {
	let redacted = text;
	for (const [pattern, replacement] of secretRedactions) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

function pathLooksCredentialBearing(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	return credentialPathPatterns.some((pattern) => pattern.test(normalized));
}

function commandLooksCredentialBearing(command: string): string | undefined {
	if (blockedCommandPatterns.some((pattern) => pattern.test(command))) {
		return "command may expose CLI credentials";
	}

	// Standalone environment dumps commonly expose tokens. Allow `env FOO=bar cmd`.
	const segments = command.split(/(?:^|[;&|]{1,2}|\n)\s*/).map((segment) => segment.trim());
	if (segments.some((segment) => /^(printenv|set|export\s+-p)\b/.test(segment) || segment === "env")) {
		return "environment dump may expose credentials";
	}

	return undefined;
}

function redactContent(content: unknown): unknown {
	if (!Array.isArray(content)) return content;

	return content.map((part) => {
		const maybeText = part as Partial<TextPart>;
		if (maybeText?.type === "text" && typeof maybeText.text === "string") {
			return { ...maybeText, text: redact(maybeText.text) };
		}
		return part;
	});
}

export default function credentialFirewall(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("credential-firewall", "creds: firewall on");
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			const reason = commandLooksCredentialBearing(command);
			if (reason) return { block: true, reason: `Credential Firewall blocked: ${reason}` };
		}

		if (["read", "write", "edit"].includes(event.toolName)) {
			const path = String((event.input as { path?: unknown }).path ?? "");
			if (pathLooksCredentialBearing(path)) {
				return { block: true, reason: "Credential Firewall blocked: credential file access" };
			}
		}

		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (!["bash", "read"].includes(event.toolName)) return undefined;
		return { content: redactContent(event.content) as typeof event.content };
	});

	// user_bash exists at runtime in recent pi versions, but older type definitions may not include it.
	(pi.on as unknown as (name: "user_bash", handler: (event: { command: string }) => unknown) => void)("user_bash", (event) => {
		const reason = commandLooksCredentialBearing(event.command);
		if (reason) {
			return {
				result: {
					output: `Credential Firewall blocked: ${reason}`,
					exitCode: 126,
					cancelled: false,
					truncated: false,
				},
			};
		}

		const local = createLocalBashOperations();
		return {
			operations: {
				async exec(
					command: Parameters<typeof local.exec>[0],
					cwd: Parameters<typeof local.exec>[1],
					options: Parameters<typeof local.exec>[2],
				) {
					const result = (await local.exec(command, cwd, options)) as { output?: string; [key: string]: unknown };
					return typeof result.output === "string" ? { ...result, output: redact(result.output) } : result;
				},
			},
		};
	});

	pi.registerCommand("credential-firewall", {
		description: "Show Credential Firewall status",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Credential Firewall is active: gh/aws can run, known token extraction is blocked, bash/read output is redacted.", "info");
		},
	});
}
