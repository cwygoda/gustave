import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_FETCH_CHARS = 20000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function braveSearch(query: string, count: number) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return null;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });
  if (!res.ok) throw new Error(`Brave Search failed: HTTP ${res.status}`);
  const json = (await res.json()) as any;
  return (json.web?.results ?? []).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: stripHtml(r.description ?? ""),
  }));
}

async function duckDuckGoInstantAnswer(query: string) {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`DuckDuckGo failed: HTTP ${res.status}`);
  const json = (await res.json()) as any;
  const results = [] as Array<{ title: string; url: string; snippet: string }>;
  if (json.AbstractText) {
    results.push({ title: json.Heading || query, url: json.AbstractURL || "", snippet: json.AbstractText });
  }
  for (const topic of json.RelatedTopics ?? []) {
    if (topic.Text) results.push({ title: topic.Text.split(" - ")[0], url: topic.FirstURL ?? "", snippet: topic.Text });
  }
  return results;
}

export default function researchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web. Uses BRAVE_API_KEY when available, otherwise DuckDuckGo Instant Answer fallback.",
    parameters: Type.Object({
      query: Type.String(),
      count: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const count = Number(params.count ?? 5);
      const query = String(params.query ?? "");
      const results = (await braveSearch(query, count)) ?? (await duckDuckGoInstantAnswer(query));
      const trimmed = results.slice(0, count);
      const text = trimmed.length
        ? trimmed
            .map(
              (r: { title: string; url: string; snippet: string }, i: number) =>
                `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
            )
            .join("\n\n")
        : "No search results found. If you need general web search, configure BRAVE_API_KEY.";
      return { content: [{ type: "text", text }], details: { query, results: trimmed } };
    },
  });

  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch a URL and return readable text extracted from HTML or raw text responses.",
    parameters: Type.Object({
      url: Type.String(),
      maxChars: Type.Optional(Type.Number({ default: MAX_FETCH_CHARS, minimum: 1000, maximum: 100000 })),
    }),
    async execute(_toolCallId, params) {
      const url = String(params.url ?? "");
      const maxChars = Math.min(Number(params.maxChars ?? MAX_FETCH_CHARS), 100000);
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Gustave research tool (+https://pi.dev)",
          Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
        },
      });
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const text = contentType.includes("html") ? stripHtml(body) : body;
      return {
        content: [{ type: "text", text: text.slice(0, maxChars) }],
        details: { url, status: res.status, contentType, truncated: text.length > maxChars },
      };
    },
  });
}
