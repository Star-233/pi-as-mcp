import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { sameSecret, type OAuthProvider } from "./oauth.ts";

/**
 * `/authorize` and `/token`, written here rather than taken from the SDK router.
 *
 * The SDK's versions implement the MCP specification exactly, and that is the
 * problem for the case this file exists for: a client added by pasting a client id
 * and secret into a hosted product (Gemini's "custom connected app"). Two
 * differences matter, and both are deliberate:
 *
 * - **PKCE is required from a public client, optional for a confidential one.**
 *   The SDK requires `code_challenge` (S256) from everybody, and requires a
 *   `code_verifier` at the token endpoint. A confidential client is protected by
 *   its secret and an exactly-matched redirect URI, which is what RFC 6749 §4.1
 *   described before PKCE existed; the MCP specification mandates PKCE, a
 *   pre-registered client may not implement it, and a client that sends no
 *   `code_verifier` cannot satisfy `z.string()` no matter what the provider says.
 * - **The client secret is accepted in the body *or* as HTTP Basic.** The SDK
 *   reads only `client_secret_post`. Which of the two a hosted client uses is not
 *   something this bridge gets to decide.
 *
 * Everything else - discovery, dynamic client registration, revocation - stays
 * with `mcpAuthRouter`, which mounts the same two paths afterwards and is
 * therefore shadowed for them. That shadowing is on purpose and is the reason
 * this file must never call `next()`.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * RFC 8252 §7.3: a loopback redirect URI may use any port, because a native client
 * asks the OS for an ephemeral one and cannot know it in advance. Everything else
 * is an exact match, including the scheme, host, path and query.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(req.hostname) || !LOOPBACK_HOSTS.has(reg.hostname)) return false;
  return (
    req.protocol === reg.protocol &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search
  );
}

/** PKCE, per RFC 7636: base64url(SHA-256(verifier)) must equal the challenge. */
function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
  return sameSecret(computed, challenge);
}

function errorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.href;
}

function sendError(res: Response, status: number, error: string, description: string): void {
  res.setHeader("cache-control", "no-store");
  res.status(status).json({ error, error_description: description });
}

/** An SDK error already carries the OAuth error code; anything else is a server fault. */
function fail(res: Response, err: unknown, status = 400): void {
  const known = err instanceof OAuthError;
  sendError(
    res,
    known ? status : 500,
    known ? err.errorCode : "server_error",
    err instanceof Error ? err.message : String(err),
  );
}

/** `Authorization: Basic base64(id:secret)`, as RFC 6749 §2.3.1 spells it. */
function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  // Both halves are urlencoded by RFC 6749; clients that skip that still work,
  // because decoding a string with no escaped character is the identity.
  return { id: decodeURIComponent(decoded.slice(0, sep)), secret: decodeURIComponent(decoded.slice(sep + 1)) };
}

type Params = Record<string, unknown>;
const text = (from: Params, key: string): string | undefined =>
  typeof from[key] === "string" ? (from[key] as string) : undefined;

export function mountOAuthEndpoints(app: express.Express, provider: OAuthProvider): void {
  /** The same budgets the SDK router used, so replacing these endpoints changes nothing here. */
  const limit = (max: number, error: string) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "temporarily_unavailable", error_description: error },
    });

  const authorize = async (req: Request, res: Response): Promise<void> => {
    const p: Params = req.method === "POST" ? (req.body ?? {}) : req.query;
    res.setHeader("cache-control", "no-store");

    const clientId = text(p, "client_id");
    if (!clientId) return sendError(res, 400, "invalid_request", "client_id is required");
    const client = await provider.clientsStore.getClient(clientId);
    if (!client) return sendError(res, 400, "invalid_client", `Unknown client_id: ${clientId}`);

    // Past this point the errors belong to the client's redirect URI, so the client
    // can see them. Before it, reporting there would be an open redirect.
    const requestedRedirect = text(p, "redirect_uri");
    let redirectUri: string;
    if (requestedRedirect === undefined) {
      if (client.redirect_uris.length !== 1) {
        return sendError(
          res,
          400,
          "invalid_request",
          "redirect_uri is required when the client has more than one registered",
        );
      }
      redirectUri = client.redirect_uris[0];
    } else {
      if (!client.redirect_uris.some((registered) => redirectUriMatches(requestedRedirect, registered))) {
        return sendError(res, 400, "invalid_request", "redirect_uri is not registered for this client");
      }
      redirectUri = requestedRedirect;
    }

    const state = text(p, "state");
    const failAtClient = (error: string, description: string): void => {
      res.redirect(302, errorRedirect(redirectUri, error, description, state));
    };

    if (text(p, "response_type") !== "code") {
      return failAtClient("unsupported_response_type", "This bridge only issues authorization codes.");
    }

    const challenge = text(p, "code_challenge") ?? "";
    if (challenge) {
      if (text(p, "code_challenge_method") !== "S256") {
        return failAtClient("invalid_request", "code_challenge_method must be S256.");
      }
    } else if (!client.client_secret) {
      return failAtClient(
        "invalid_request",
        "A client without a client secret must use PKCE: send code_challenge with code_challenge_method=S256.",
      );
    }

    const resource = text(p, "resource");
    try {
      await provider.authorize(
        client,
        {
          state,
          scopes: (text(p, "scope") ?? "").split(" ").filter(Boolean),
          redirectUri,
          codeChallenge: challenge,
          resource: resource ? new URL(resource) : undefined,
        },
        res,
      );
    } catch (err) {
      failAtClient(err instanceof OAuthError ? err.errorCode : "server_error", err instanceof Error ? err.message : String(err));
    }
  };

  const token = async (req: Request, res: Response): Promise<void> => {
    res.setHeader("cache-control", "no-store");
    const body: Params = req.body ?? {};
    const basic = basicCredentials(req.headers.authorization);
    const clientId = text(body, "client_id") ?? basic?.id;
    const secret = text(body, "client_secret") ?? basic?.secret;

    if (!clientId) return sendError(res, 401, "invalid_client", "client_id is required");
    const client = await provider.clientsStore.getClient(clientId);
    if (!client) return sendError(res, 401, "invalid_client", `Unknown client_id: ${clientId}`);
    // A client with a secret must prove it; one without is public, and its
    // protection is PKCE plus the registered redirect URI.
    if (client.client_secret) {
      if (!secret) return sendError(res, 401, "invalid_client", "This client must present its client_secret");
      if (!sameSecret(secret, client.client_secret)) {
        return sendError(res, 401, "invalid_client", "Invalid client_secret");
      }
    }

    const resource = text(body, "resource");
    const asResource = resource ? new URL(resource) : undefined;

    try {
      switch (text(body, "grant_type")) {
        case "authorization_code": {
          const code = text(body, "code");
          if (!code) return sendError(res, 400, "invalid_request", "code is required");
          const verifier = text(body, "code_verifier");
          const challenge = await provider.challengeForAuthorizationCode(client, code);
          if (challenge) {
            if (!verifier) {
              return sendError(res, 400, "invalid_request", "code_verifier is required: this code was issued with PKCE");
            }
            if (!pkceMatches(verifier, challenge)) {
              return sendError(res, 400, "invalid_grant", "code_verifier does not match the challenge");
            }
          } else if (!client.client_secret) {
            // Unreachable through /authorize, which refuses to issue such a code;
            // kept because this is the invariant that matters if that ever changes.
            return sendError(res, 400, "invalid_grant", "This code was issued without PKCE and its client has no secret.");
          }
          const tokens = await provider.exchangeAuthorizationCode(
            client,
            code,
            verifier,
            text(body, "redirect_uri"),
            asResource,
          );
          res.json(tokens);
          return;
        }
        case "refresh_token": {
          const refreshToken = text(body, "refresh_token");
          if (!refreshToken) return sendError(res, 400, "invalid_request", "refresh_token is required");
          const scope = text(body, "scope");
          const tokens = await provider.exchangeRefreshToken(
            client,
            refreshToken,
            scope ? scope.split(" ").filter(Boolean) : undefined,
            asResource,
          );
          res.json(tokens);
          return;
        }
        default:
          return sendError(
            res,
            400,
            "unsupported_grant_type",
            "This bridge supports authorization_code and refresh_token.",
          );
      }
    } catch (err) {
      fail(res, err);
    }
  };

  const urlencoded = express.urlencoded({ extended: false });
  app.use("/authorize", limit(100, "You have exceeded the rate limit for authorization requests"), urlencoded, (req, res) => {
    void authorize(req, res);
  });
  app.use("/token", limit(50, "You have exceeded the rate limit for token requests"), urlencoded, express.json(), (req, res) => {
    void token(req, res);
  });
}
