import { decodeJwt, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { AgentOidcService } from "./agent-oidc.js";

const discovery = {
  issuer: "https://auth.agentid.test",
  authorization_endpoint: "https://auth.agentid.test/v0/authorize",
  token_endpoint: "https://auth.agentid.test/v0/token",
  jwks_uri: "https://auth.agentid.test/v0/jwks.json",
};

describe("AgentOidcService", () => {
  it("uses discovery and starts authorization code flow with PKCE", async () => {
    const service = buildService();

    const url = new URL(await service.authorizationUrl());

    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(url.searchParams.get("client_id")).toBe("agentid-client");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
  });

  it("maps the verified AgentID inbox to a short-lived customer agent token", async () => {
    const signingSecret = new TextEncoder().encode("customer-signing-secret");
    const service = buildService(signingSecret);
    const authorization = new URL(await service.authorizationUrl());

    const result = await service.complete("authorization-code", authorization.searchParams.get("state")!, discovery.issuer);
    const verified = await jwtVerify(result.accessToken, signingSecret, {
      issuer: "http://sample-company.test",
      audience: "sample-company-operations",
    });

    expect(result).toMatchObject({
      subject: "agent-subject",
      email: "sample-company-sre@agents.test",
      roles: ["incident_reader", "sre_agent"],
      expiresIn: 600,
    });
    expect(verified.payload).toMatchObject({
      sub: "agentid:agent-subject",
      actor_type: "agent",
      external_issuer: discovery.issuer,
      external_sub: "agent-subject",
      roles: ["incident_reader", "sre_agent"],
    });
    expect(decodeJwt(result.accessToken).exp! - decodeJwt(result.accessToken).iat!).toBe(600);
  });
});

function buildService(signingSecret = new TextEncoder().encode("customer-signing-secret")) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json(discovery);
    }
    if (url === discovery.token_endpoint) {
      return Response.json({ id_token: "test-id-token" });
    }
    return new Response(null, { status: 404 });
  });
  return new AgentOidcService({
    clientId: "agentid-client",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:4102/auth/agentid/callback",
    discoveryUrl: "https://auth.agentid.test/.well-known/openid-configuration",
    allowedEmail: "sample-company-sre@agents.test",
    customerIssuer: "http://sample-company.test",
    customerAudience: "sample-company-operations",
    customerSigningSecret: signingSecret,
    roles: ["incident_reader", "sre_agent"],
    fetch: fetcher,
    verifyIdentityToken: async (_token, _metadata, nonce) => ({
      iss: discovery.issuer,
      aud: "agentid-client",
      sub: "agent-subject",
      actor_type: "agent",
      email: "sample-company-sre@agents.test",
      email_verified: true,
      nonce,
    }),
  });
}