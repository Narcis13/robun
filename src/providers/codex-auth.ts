import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import pino from "pino";

const logger = pino({ name: "codex-auth" });

export interface CodexToken {
  accountId: string;
  access: string;
}

const TOKEN_FILE = join(homedir(), ".robun", "codex-token.json");

// ChatGPT OAuth endpoints (OpenAI Codex uses ChatGPT's auth)
const AUTH_URL = "https://auth0.openai.com/authorize";
const TOKEN_URL = "https://auth0.openai.com/oauth/token";
const CLIENT_ID = "DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD"; // ChatGPT public client
const REDIRECT_URI = "http://localhost:18791/callback";
const AUDIENCE = "https://api.openai.com/v1";

function readStoredToken(): CodexToken | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
    if (raw.accountId && raw.access) {
      return { accountId: raw.accountId, access: raw.access };
    }
  } catch {
    // Corrupt file, ignore
  }
  return null;
}

function storeToken(token: CodexToken): void {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

/**
 * Get a stored Codex OAuth token. Throws if no token is available.
 * This is the TypeScript equivalent of Python's `oauth_cli_kit.get_token()`.
 */
export async function getCodexToken(): Promise<CodexToken> {
  const token = readStoredToken();
  if (token) {
    return token;
  }
  throw new Error(
    "No Codex OAuth token found. Run 'robun provider login openai-codex' to authenticate.",
  );
}

/**
 * Interactive OAuth login for OpenAI Codex.
 * Starts a local HTTP server to receive the OAuth callback, opens the browser,
 * and exchanges the authorization code for a token.
 *
 * Falls back to manual token entry if the browser flow fails.
 *
 * This is the TypeScript equivalent of Python's `oauth_cli_kit.login_oauth_interactive()`.
 */
export async function loginCodexInteractive(
  printFn: (msg: string) => void,
  promptFn: (msg: string) => Promise<string>,
): Promise<CodexToken> {
  // First check if we already have a valid token
  const existing = readStoredToken();
  if (existing) {
    printFn("Found existing token. Validating...");
    // Simple validation: try a lightweight request
    try {
      const resp = await fetch("https://chatgpt.com/backend-api/me", {
        headers: { Authorization: `Bearer ${existing.access}` },
      });
      if (resp.ok) {
        printFn("Existing token is valid.");
        return existing;
      }
    } catch {
      // Token invalid, proceed with login
    }
    printFn("Existing token expired. Starting new login...\n");
  }

  // Try OAuth authorization code flow with local server
  try {
    const token = await oauthBrowserFlow(printFn);
    if (token) {
      storeToken(token);
      return token;
    }
  } catch (e) {
    logger.debug({ err: e }, "Browser OAuth flow failed, falling back to manual");
    printFn("Browser-based login failed. Falling back to manual token entry.\n");
  }

  // Fallback: manual token entry
  return manualTokenEntry(printFn, promptFn);
}

async function oauthBrowserFlow(
  printFn: (msg: string) => void,
): Promise<CodexToken | null> {
  const state = crypto.randomUUID();

  return new Promise<CodexToken | null>((resolve, reject) => {
    let server: Server;
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error("OAuth timeout: no callback received within 120 seconds"));
    }, 120_000);

    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Authentication failed</h1><p>You can close this window.</p>");
          clearTimeout(timeout);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Invalid callback</h1><p>State mismatch or missing code.</p>");
          return;
        }

        // Exchange code for token
        const tokenResp = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            redirect_uri: REDIRECT_URI,
          }),
        });

        if (!tokenResp.ok) {
          const text = await tokenResp.text();
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Token exchange failed</h1><p>You can close this window.</p>");
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Token exchange failed: ${text}`));
          return;
        }

        const tokenData = (await tokenResp.json()) as Record<string, unknown>;
        const accessToken = tokenData.access_token as string;

        // Get account ID from /me endpoint
        let accountId = "unknown";
        try {
          const meResp = await fetch("https://chatgpt.com/backend-api/me", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (meResp.ok) {
            const meData = (await meResp.json()) as Record<string, unknown>;
            const accounts = meData.accounts as Record<string, Record<string, unknown>> | undefined;
            if (accounts) {
              accountId = Object.keys(accounts)[0] ?? "unknown";
            }
          }
        } catch {
          // Non-fatal: use default account ID
        }

        const token: CodexToken = { accountId, access: accessToken };

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authentication successful!</h1><p>You can close this window and return to the terminal.</p>");
        clearTimeout(timeout);
        server.close();
        resolve(token);
      } catch (e) {
        clearTimeout(timeout);
        server.close();
        reject(e);
      }
    });

    server.listen(18791, "127.0.0.1", () => {
      const authUrl = new URL(AUTH_URL);
      authUrl.searchParams.set("client_id", CLIENT_ID);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("audience", AUDIENCE);
      authUrl.searchParams.set("scope", "openid profile email");
      authUrl.searchParams.set("state", state);

      printFn("Opening browser for authentication...");
      printFn(`If the browser doesn't open, visit:\n  ${authUrl.toString()}\n`);

      // Open browser
      const openCmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";

      import("node:child_process").then(({ exec }) => {
        exec(`${openCmd} "${authUrl.toString()}"`, (err) => {
          if (err) {
            printFn("Could not open browser automatically.");
          }
        });
      });
    });

    server.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

async function manualTokenEntry(
  printFn: (msg: string) => void,
  promptFn: (msg: string) => Promise<string>,
): Promise<CodexToken> {
  printFn("Manual token entry:");
  printFn("  1. Go to https://chatgpt.com and log in");
  printFn("  2. Open browser DevTools (F12) > Application > Cookies");
  printFn('  3. Find the "__Secure-next-auth.session-token" cookie value');
  printFn("  4. Or use the Network tab to capture a Bearer token from any API request\n");

  const access = await promptFn("Paste your access token: ");
  const accountId = await promptFn("Paste your account ID (or press Enter for 'default'): ");

  const token: CodexToken = {
    accountId: accountId.trim() || "default",
    access: access.trim(),
  };

  if (!token.access) {
    throw new Error("No token provided");
  }

  storeToken(token);
  return token;
}
