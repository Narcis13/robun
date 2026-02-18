import { z } from "zod";
import type { Tool } from "./base";

export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly description = "Search the web using Brave Search API.";
  readonly parameters = z.object({
    query: z.string().describe("Search query"),
    count: z.number().min(1).max(10).optional().describe("Number of results"),
  });

  private apiKey: string;
  private maxResults: number;

  constructor(options: { apiKey?: string; maxResults?: number } = {}) {
    this.apiKey = options.apiKey ?? process.env.BRAVE_API_KEY ?? "";
    this.maxResults = options.maxResults ?? 5;
  }

  async execute(params: { query: string; count?: number }): Promise<string> {
    if (!this.apiKey) return "Error: No Brave Search API key configured.";

    const count = Math.min(Math.max(params.count ?? this.maxResults, 1), 10);
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", params.query);
    url.searchParams.set("count", String(count));

    try {
      const resp = await fetch(url, {
        headers: {
          "X-Subscription-Token": this.apiKey,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) return `Search failed: ${resp.status} ${resp.statusText}`;

      const data = await resp.json();
      const results = data.web?.results ?? [];

      if (results.length === 0) return `No results for: ${params.query}`;

      return results
        .slice(0, count)
        .map(
          (
            r: { title: string; url: string; description: string },
            i: number,
          ) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`,
        )
        .join("\n\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

function validateUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        valid: false,
        error: `Only http/https allowed, got '${parsed.protocol}'`,
      };
    }
    if (!parsed.hostname) {
      return { valid: false, error: "Missing domain" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL" };
  }
}

export class WebFetchTool implements Tool {
  readonly name = "web_fetch";
  readonly description = "Fetch and extract content from a URL.";
  readonly parameters = z.object({
    url: z.string().describe("URL to fetch"),
    extractMode: z
      .enum(["markdown", "text"])
      .default("markdown")
      .describe("Content extraction mode"),
    maxChars: z.number().min(100).optional().describe("Max characters to return"),
  });

  private maxChars: number;

  constructor(options: { maxChars?: number } = {}) {
    this.maxChars = options.maxChars ?? 50000;
  }

  async execute(params: {
    url: string;
    extractMode?: string;
    maxChars?: number;
  }): Promise<string> {
    const { valid, error } = validateUrl(params.url);
    if (!valid) {
      return JSON.stringify({ error: `URL validation failed: ${error}`, url: params.url });
    }

    try {
      const { Readability } = await import("@mozilla/readability");
      const { parseHTML } = await import("linkedom");

      const resp = await fetch(params.url, {
        redirect: "follow",
        headers: { "User-Agent": "robun/1.0" },
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        return JSON.stringify({
          error: `Fetch failed: ${resp.status} ${resp.statusText}`,
          url: params.url,
        });
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const body = await resp.text();
      const maxChars = params.maxChars ?? this.maxChars;

      let text: string;
      let extractor: string;

      if (contentType.includes("application/json")) {
        text = JSON.stringify(JSON.parse(body), null, 2);
        extractor = "json";
      } else if (
        contentType.includes("text/html") ||
        body.slice(0, 256).toLowerCase().startsWith("<!doctype") ||
        body.slice(0, 256).toLowerCase().startsWith("<html")
      ) {
        const { document } = parseHTML(body);
        const reader = new Readability(document);
        const article = reader.parse();
        text = article?.textContent ?? document.body?.textContent ?? "";
        extractor = "readability";
      } else {
        text = body;
        extractor = "raw";
      }

      const truncated = text.length > maxChars;

      return JSON.stringify({
        url: params.url,
        finalUrl: resp.url,
        status: resp.status,
        extractor,
        length: text.length,
        truncated,
        text: text.slice(0, maxChars),
      });
    } catch (err) {
      return JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
        url: params.url,
      });
    }
  }
}
