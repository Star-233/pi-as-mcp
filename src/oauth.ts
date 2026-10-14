import crypto from "node:crypto";
import type { Response } from "express";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * An in-memory OAuth 2.1 authorization server for the HTTP transport.
 *
 * Two facts about this project decide the whole design. There is exactly one
 * human, and nothing survives the process. So a token is a Map entry, there is
 * no database, "logging in" is not a username and a password - it is the human
 * clicking Allow on a card in the local bridge UI - and every grant dies with
 * the process. A client that outlives a restart simply authorizes again.
 *
 * Discovery, dynamic registration and revocation come from the MCP SDK's
 * `mcpAuthRouter`. `/authorize` and `/token` are served by `src/oauth-http.ts`
 * instead, because the SDK's versions enforce two things that a *hosted* client
 * does not do: it requires PKCE from every client, and it reads the client secret
 * only from the POST body. Neither is wrong for a client that implements the MCP
 * specification itself; both lock out a client configured by hand (see
 * `staticClient` below). This module supplies the storage and the one decision
 * neither version can make: whether the human said yes.
 */

/** The only thing this bridge can hand out access to. */
export const SCOPE = "mcp";

/** A client that was configured by hand instead of registering itself. */
export type StaticClient = {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
};

/** Length-safe: timingSafeEqual throws on different lengths, which would itself leak. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** One-shot and short-lived, per RFC 6749 §4.1.2. */
const CODE_TTL_MS = 60 * 1000;
/**
 * How long a request waits for the human. Long enough to notice it and go read
 * it, short enough that a tab forgotten overnight is not still a live path to a
 * shell on this machine.
 */
const CONSENT_TTL_MS = 10 * 60 * 1000;
/**
 * `/authorize` is reachable from the internet, so requests can pile up without a
 * human ever looking. This is the point at which new ones are refused rather than
 * queued, because a queue nobody reads is just a slow leak.
 */
const MAX_PENDING = 8;
/**
 * How much longer an answered request stays resident so the browser polling for
 * the outcome can still collect it.
 */
const RESULT_GRACE_MS = 60 * 1000;

export type Consent = "allowed" | "denied";

/** What the human UI is shown when a client asks for access. */
export type PendingAuthorization = {
  id: string;
  clientId: string;
  /** From the client's own registration, so untrusted: render as text, never as HTML. */
  clientName: string;
  redirectUri: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
};

export type ConsentStatus = {
  state: "unknown" | "pending" | "expired" | "allowed" | "denied";
  /** The URL to finish at. Present only once the human has decided. */
  redirect?: string;
};

export type OAuthEvent = { type: "authorizations"; pending: PendingAuthorization[] };

type ConsentRequest = PendingAuthorization & {
  state?: string;
  /** Empty when the client sent no PKCE challenge, which only a confidential client may do. */
  codeChallenge: string;
  /** What the client asked for, kept only to say so when it is not what it gets. */
  requestedScopes: string[];
  resource?: URL;
  decision: Consent | null;
  /** Minted on approval, then handed to the browser that is waiting on the poll. */
  code: string | null;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
};

type StoredToken = {
  clientId: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
};

/** 256 bits of opaque string. Every id, code and token here is one of these. */
const randomToken = () => crypto.randomBytes(32).toString("base64url");

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

export class OAuthProvider implements OAuthServerProvider {
  readonly scopes: string[] = [SCOPE];

  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly consents = new Map<string, ConsentRequest>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly access = new Map<string, StoredToken>();
  private readonly refresh = new Map<string, StoredToken>();
  private readonly listeners = new Set<(e: OAuthEvent) => void>();
  /** Where the human approves, named on the consent page. */
  private readonly uiUrl: string;

  constructor(opts: { uiUrl: string; staticClient?: StaticClient | null }) {
    this.uiUrl = opts.uiUrl;
    if (opts.staticClient) {
      // Registered up front, which is the whole point: the human pasted this
      // client's credentials into the client, so the client will never call
      // /register. Everything else about it is an ordinary registration.
      this.clients.set(opts.staticClient.clientId, {
        client_id: opts.staticClient.clientId,
        client_secret: opts.staticClient.clientSecret,
        client_name: clientNameFor(opts.staticClient.redirectUris),
        redirect_uris: opts.staticClient.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      });
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients.get(clientId),
      // The SDK's registration handler generates the client_id itself and then
      // calls this with it. Its signature omits the field, so accepting the full
      // type here is a deliberate widening at that boundary - the value really is
      // there, and the whole registration is echoed back to the client as RFC 7591
      // requires, which is also why this stores the object rather than a few fields.
      registerClient: (client: OAuthClientInformationFull) => {
        this.clients.set(client.client_id, client);
        return client;
      },
    };
  }

  /** The human UI subscribes here to be told when it has something to approve. */
  subscribe(fn: (e: OAuthEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const pending = this.pending();
    for (const fn of this.listeners) {
      try {
        fn({ type: "authorizations", pending });
      } catch {
        /* a broken UI must never break an authorization request */
      }
    }
  }

  /** Requests still waiting for an answer, oldest first. Expired ones are dropped. */
  pending(): PendingAuthorization[] {
    const alive: PendingAuthorization[] = [];
    for (const [id, c] of this.consents) {
      if (c.expiresAt <= Date.now()) {
        this.consents.delete(id);
        continue;
      }
      // Answered ones stay resident until they expire: the browser that is polling
      // for the outcome still has to be able to collect it.
      if (c.decision) continue;
      alive.push({
        id,
        clientId: c.clientId,
        clientName: c.clientName,
        redirectUri: c.redirectUri,
        scopes: c.scopes,
        createdAt: c.createdAt,
        expiresAt: c.expiresAt,
      });
    }
    return alive;
  }

  /**
   * Answer a request. Returns false when it is already answered, expired or
   * unknown - the human UI turns that into "this one is gone, ignore the card".
   */
  decide(id: string, allow: boolean): boolean {
    const req = this.consents.get(id);
    if (!req || req.decision || req.expiresAt <= Date.now()) return false;
    req.decision = allow ? "allowed" : "denied";
    // A request answered in its last seconds would otherwise be swept away before
    // the waiting browser could come back for the result.
    req.expiresAt = Math.max(req.expiresAt, Date.now() + RESULT_GRACE_MS);
    if (allow) {
      req.code = randomToken();
      this.codes.set(req.code, {
        clientId: req.clientId,
        redirectUri: req.redirectUri,
        codeChallenge: req.codeChallenge,
        scopes: req.scopes,
        resource: req.resource,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
    }
    this.emit();
    return true;
  }

  /**
   * What the browser sitting on the consent page asks for. Safe to serve to
   * anyone holding `id`: it is 256 bits generated here, handed only to the
   * browser that arrived from that client's own `/authorize` navigation.
   */
  status(id: string): ConsentStatus {
    const req = this.consents.get(id);
    if (!req) return { state: "unknown" };
    if (req.decision) return { state: req.decision, redirect: this.redirectFor(req) };
    if (req.expiresAt <= Date.now()) return { state: "expired" };
    return { state: "pending" };
  }

  stats(): { clients: number; pending: number; accessTokens: number; refreshTokens: number } {
    return {
      clients: this.clients.size,
      pending: this.pending().length,
      accessTokens: this.access.size,
      refreshTokens: this.refresh.size,
    };
  }

  private redirectFor(req: ConsentRequest): string {
    const url = new URL(req.redirectUri);
    if (req.code) {
      url.searchParams.set("code", req.code);
    } else {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "The human who owns this bridge denied the request.");
    }
    if (req.state !== undefined) url.searchParams.set("state", req.state);
    return url.href;
  }

  /**
   * Start an authorization. This does not answer with a redirect, because the
   * answer is not this server's to give: it renders a page and waits for the
   * human.
   *
   * A scope this bridge does not have is *narrowed*, not refused, which RFC 6749
   * §3.3 allows and which is the only thing that lets a hosted client through:
   * such a client asks for whatever its own platform taught it to ask for
   * (`openid`, say) without having been told what this bridge offers. Narrowing
   * can only ever grant less than was requested, and the consent page says when
   * that happened.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requested = params.scopes ?? [];
    if (this.pending().length >= MAX_PENDING) {
      throw new TemporarilyUnavailableError(
        "Too many authorization requests are already waiting for the human who owns this bridge.",
      );
    }

    const now = Date.now();
    const req: ConsentRequest = {
      id: randomToken(),
      clientId: client.client_id,
      clientName: client.client_name?.trim() || client.client_id,
      redirectUri: params.redirectUri,
      scopes: this.scopes,
      requestedScopes: requested.filter((s) => !this.scopes.includes(s)),
      createdAt: now,
      expiresAt: now + CONSENT_TTL_MS,
      state: params.state,
      codeChallenge: params.codeChallenge,
      resource: params.resource,
      decision: null,
      code: null,
    };
    this.consents.set(req.id, req);
    this.emit();

    res.status(200).type("html").send(consentPage(req, this.uiUrl));
  }

  /**
   * The challenge stored with a code, or an empty string when the client sent
   * none. `src/oauth-http.ts` turns that into the PKCE decision: required from a
   * public client, optional for one that authenticates with a secret.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Unknown or expired authorization code");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Unknown or expired authorization code");
    }
    // Consume it whatever happens next: a code that failed one check must not be
    // replayable against the next one.
    this.codes.delete(authorizationCode);
    if (entry.clientId !== client.client_id) {
      throw new InvalidGrantError("This authorization code was issued to a different client");
    }
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    // PKCE was already checked by the caller, which is where the decision belongs:
    // it needs the client, to know whether a challenge was even required.
    return this.issue(client.client_id, entry.scopes, entry.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.refresh.get(refreshToken);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Unknown or expired refresh token");
    }
    if (entry.clientId !== client.client_id) {
      throw new InvalidGrantError("This refresh token was issued to a different client");
    }
    const widened = (scopes ?? []).filter((s) => !entry.scopes.includes(s));
    if (widened.length) {
      throw new InvalidScopeError("A refresh may not ask for more than it was granted");
    }
    // Rotated, not reused: a stolen refresh token is worth one attempt, not a lifetime.
    this.refresh.delete(refreshToken);
    return this.issue(client.client_id, scopes?.length ? scopes : entry.scopes, entry.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.access.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.access.delete(token);
      throw new InvalidTokenError("Unknown or expired access token");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: Math.floor(entry.expiresAt / 1000),
      resource: entry.resource,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Both maps: the caller does not have to say which kind of token this is, and
    // a revoked token must not keep working through the other one.
    const access = this.access.get(request.token);
    if (access && access.clientId === client.client_id) this.access.delete(request.token);
    const refresh = this.refresh.get(request.token);
    if (refresh && refresh.clientId === client.client_id) this.refresh.delete(request.token);
  }

  private issue(clientId: string, scopes: string[], resource?: URL): OAuthTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.access.set(accessToken, { clientId, scopes, resource, expiresAt: Date.now() + ACCESS_TTL_MS });
    this.refresh.set(refreshToken, { clientId, scopes, resource, expiresAt: Date.now() + REFRESH_TTL_MS });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

/**
 * A pre-registered client has no name of its own to offer - it never goes through
 * registration - so it is named after where it sends the human back. That is the
 * part the human typed in when configuring it, so it is the part they recognise.
 */
function clientNameFor(redirectUris: string[]): string {
  for (const uri of redirectUris) {
    try {
      return new URL(uri).host;
    } catch {
      /* not a URL: fall through to the next one */
    }
  }
  return "a client configured by hand";
}

/**
 * The page the client's browser lands on.
 *
 * It deliberately has no Allow button. This page is served from whatever address
 * the client reached - over a quick tunnel, that is the open internet - so a
 * button here would be an authorization any stranger who found the URL could
 * click. The decision belongs on the local UI, which only the human running the
 * bridge can reach; this page just reports and waits.
 */
function consentPage(req: ConsentRequest, uiUrl: string): string {
  const poll = `/oauth/pending?id=${encodeURIComponent(req.id)}`;
  // Only shown when it differs, so the common case stays quiet.
  const narrowed = req.requestedScopes.length
    ? `<p class="state">It also asked for <code>${esc(req.requestedScopes.join(" "))}</code>, which
       this bridge does not have and will not grant.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Authorize ${esc(req.clientName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2.5rem 1.25rem; font: 16px/1.55 system-ui, -apple-system, Segoe UI, sans-serif;
         background: #f6f7f9; color: #16181d; }
  main { max-width: 34rem; margin: 0 auto; background: #fff; border: 1px solid #e2e5ea;
         border-radius: 12px; padding: 1.75rem; box-shadow: 0 1px 3px rgba(16,24,40,.06); }
  .kicker { margin: 0 0 .35rem; font-size: .75rem; letter-spacing: .09em; text-transform: uppercase; color: #6b7280; }
  h1 { margin: 0 0 .75rem; font-size: 1.3rem; line-height: 1.3; }
  p { margin: 0 0 1rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; margin: 1.25rem 0; }
  dt { color: #6b7280; font-size: .85rem; }
  dd { margin: 0; overflow-wrap: anywhere; font-size: .9rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .where { background: #f2f6ff; border: 1px solid #d6e2ff; border-radius: 8px; padding: .75rem .9rem; }
  .where a { overflow-wrap: anywhere; }
  .state { margin: 1.25rem 0 0; padding-top: 1rem; border-top: 1px solid #eceef2;
           color: #6b7280; font-variant-numeric: tabular-nums; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e8eaed; }
    main { background: #1e2126; border-color: #2f343b; }
    dt, .state { color: #9aa0a8; }
    .where { background: #1b2432; border-color: #2b3a55; }
    .state { border-top-color: #2f343b; }
  }
</style>
</head>
<body>
<main>
  <p class="kicker">pi-as-mcp</p>
  <h1>Authorize ${esc(req.clientName)}</h1>
  <p>It is asking for the <code>${esc(req.scopes.join(" "))}</code> scope, which on this bridge means a
     shell and a filesystem on the computer running it. Approve it only if you started it.</p>
  <dl>
    <dt>Client</dt><dd>${esc(req.clientName)}</dd>
    <dt>Redirects to</dt><dd>${esc(req.redirectUri)}</dd>
    <dt>Scope</dt><dd>${esc(req.scopes.join(" "))}</dd>
  </dl>
  <p class="where">Approve or deny it on your own machine, at
     <a href="${esc(uiUrl)}">${esc(uiUrl)}</a>. This page cannot approve anything itself, and no one
     else can reach that one.</p>
${narrowed}
  <p class="state" id="state">Waiting for your decision&hellip;</p>
</main>
<script>
  const url = ${JSON.stringify(poll)};
  const state = document.getElementById("state");
  let tries = 0;
  async function tick() {
    try {
      const res = await fetch(url, { cache: "no-store" });
      const body = await res.json();
      if (body.redirect) { location.replace(body.redirect); return; }
      if (body.state === "expired" || body.state === "unknown") {
        state.textContent = "This request is no longer waiting. Nothing was authorized - start again from your client.";
        return;
      }
    } catch {
      /* a flaky network is not a decision; keep asking */
    }
    tries += 1;
    setTimeout(tick, tries < 15 ? 2000 : 5000);
  }
  tick();
</script>
</body>
</html>`;
}
