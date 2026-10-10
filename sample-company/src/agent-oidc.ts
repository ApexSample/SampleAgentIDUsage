import { createHash, randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface PendingAuthorization {
  codeVerifier: string;
  nonce: string;
  expiresAt: number;
}

export interface AgentOidcOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  discoveryUrl: string;
  allowedEmail: string;
  customerIssuer: string;
  customerAudience: string;
  customerSigningSecret: Uint8Array;
  roles: string[];
  fetch?: typeof fetch;
  verifyIdentityToken?: (token: string, discovery: OidcDiscovery, nonce: string) => Promise<JWTPayload>;
}

export interface AgentAuthorizationResult {
  accessToken: string;
  issuer: string;
  subject: string;
  email: string;
  roles: string[];
  expiresIn: number;
}

export class AgentOidcService {
  private readonly pending = new Map<string, PendingAuthorization>();
  private discovery?: OidcDiscovery;

  constructor(private readonly options: AgentOidcOptions) {}

  async authorizationUrl(): Promise<string> {
    const discovery = await this.getDiscovery();
    const state = randomValue();
    const nonce = randomValue();
    const codeVerifier = randomValue();
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.pending.set(state, { codeVerifier, nonce, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async complete(code: string, state: string, responseIssuer?: string): Promise<AgentAuthorizationResult> {
    const transaction = this.pending.get(state);
    this.pending.delete(state);
    if (!transaction || transaction.expiresAt <= Date.now()) throw new Error("oidc_state_invalid");
    const discovery = await this.getDiscovery();
    if (responseIssuer && responseIssuer !== discovery.issuer) throw new Error("oidc_issuer_mismatch");
    const response = await (this.options.fetch ?? globalThis.fetch)(discovery.token_endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.options.redirectUri,
        code_verifier: transaction.codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`oidc_token_exchange_${response.status}`);
    const tokens = await response.json() as { id_token?: string };
    if (!tokens.id_token) throw new Error("oidc_id_token_missing");
    const payload = this.options.verifyIdentityToken
      ? await this.options.verifyIdentityToken(tokens.id_token, discovery, transaction.nonce)
      : await verifyAgentIdToken(tokens.id_token, discovery, this.options.clientId, transaction.nonce);
    if (payload.actor_type !== "agent" || !payload.sub) throw new Error("oidc_agent_identity_invalid");
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (payload.email_verified !== true || email !== this.options.allowedEmail.toLowerCase()) {
      throw new Error("oidc_agent_not_registered");
    }
    const expiresIn = 600;
    const accessToken = await new SignJWT({
      actor_type: "agent",
      roles: this.options.roles,
      email,
      external_issuer: discovery.issuer,
      external_sub: payload.sub,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.options.customerIssuer)
      .setAudience(this.options.customerAudience)
      .setSubject(`agentid:${payload.sub}`)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(this.options.customerSigningSecret);
    return {
      accessToken,
      issuer: discovery.issuer,
      subject: payload.sub,
      email,
      roles: [...this.options.roles],
      expiresIn,
    };
  }

  private async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const response = await (this.options.fetch ?? globalThis.fetch)(this.options.discoveryUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`oidc_discovery_${response.status}`);
    const value = await response.json() as Partial<OidcDiscovery>;
    if (!value.issuer || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) {
      throw new Error("oidc_discovery_invalid");
    }
    this.discovery = value as OidcDiscovery;
    return this.discovery;
  }
}

async function verifyAgentIdToken(
  token: string,
  discovery: OidcDiscovery,
  clientId: string,
  nonce: string,
): Promise<JWTPayload> {
  if (decodeProtectedHeader(token).alg !== "ES256") throw new Error("oidc_algorithm_invalid");
  const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
    algorithms: ["ES256"],
    issuer: discovery.issuer,
    audience: clientId,
  });
  if (payload.nonce !== nonce) throw new Error("oidc_nonce_invalid");
  return payload;
}

function randomValue(): string {
  return randomBytes(32).toString("base64url");
}