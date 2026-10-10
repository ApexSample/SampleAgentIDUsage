import { describe, expect, it, vi } from "vitest";
import { jwtVerify, SignJWT } from "jose";
import { buildCheckoutApp, buildIncidentApp, buildInventoryApp } from "./apps.js";

describe("sample company services", () => {
  it("seeds the unlinked finance invoice agent with invoice-only RBAC", async () => {
    const integration = buildIncidentApp({
      alertToken: "alert-secret",
      apiToken: "reader-secret",
      adminToken: "admin-secret",
    });

    const response = await integration.inject({
      method: "GET",
      url: "/v1/admin/agents",
      headers: { authorization: "Bearer admin-secret" },
    });

    expect(response.json()).toMatchObject({ items: [expect.objectContaining({
      name: "FinanceTeamInvoiceAgent",
      email: "scinvoiceagent@agentmail.to",
      scopes: ["invoice.list", "invoice.get", "invoice.extract", "invoice.validate"],
      services: ["invoice-mcp"],
    })] });
    expect(response.body).not.toContain("externalSubject");
    await integration.close();
  });

  it("accepts an order when inventory is available", async () => {
    const inventory = buildInventoryApp();
    const checkout = buildCheckoutApp({
      inventoryBaseUrl: "http://inventory",
      request: vi.fn<typeof fetch>(async (_url, init) => {
        const response = await inventory.inject({ method: "GET", url: "/v1/inventory/SKU-1" });
        return new Response(response.body, { status: response.statusCode, headers: init?.headers });
      }),
    });

    const response = await checkout.inject({ method: "POST", url: "/v1/orders/SKU-1" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: "accepted", sku: "SKU-1", available: 12 });
    await Promise.all([checkout.close(), inventory.close()]);
  });

  it("returns 503 and publishes a dependency failure metric when inventory is down", async () => {
    const checkout = buildCheckoutApp({
      inventoryBaseUrl: "http://inventory",
      request: vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused")),
    });

    const response = await checkout.inject({ method: "POST", url: "/v1/orders/SKU-1" });
    const metrics = await checkout.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "inventory_unavailable" });
    expect(metrics.body).toContain("sample_company_inventory_failures_total 1");
    expect(metrics.body).toContain("sample_company_inventory_up 0");
    await checkout.close();
  });

  it("accepts authenticated Alertmanager events and exposes incidents through a separate token", async () => {
    const incidents = buildIncidentApp({ alertToken: "alert-secret", apiToken: "reader-secret" });
    const alert = {
      alerts: [{
        status: "firing",
        fingerprint: "inventory-down",
        labels: { alertname: "InventoryUnavailable", service: "checkout-api", severity: "critical" },
        annotations: { summary: "Inventory is unavailable", description: "Checkout cannot reach inventory." },
        startsAt: "2026-10-04T00:00:00.000Z",
      }],
    };

    expect((await incidents.inject({ method: "POST", url: "/v1/alertmanager/events", payload: alert })).statusCode).toBe(401);
    expect((await incidents.inject({
      method: "POST",
      url: "/v1/alertmanager/events",
      headers: { authorization: "Bearer alert-secret" },
      payload: alert,
    })).statusCode).toBe(202);
    const listed = await incidents.inject({
      method: "GET",
      url: "/v1/incidents",
      headers: { authorization: "Bearer reader-secret" },
    });
    expect(listed.json()).toMatchObject({ items: [{ id: "inventory-down", status: "open", service: "checkout-api" }] });
    await incidents.close();
  });

  it("exposes bounded metrics and runbooks through the authenticated integration edge", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "success",
      data: { result: [{ value: [1_728_000_000, "0"] }] },
    }), { status: 200 }));
    const integration = buildIncidentApp({
      alertToken: "alert-secret",
      apiToken: "reader-secret",
      adminToken: "admin-secret",
      prometheusBaseUrl: "http://prometheus:9090",
      request: fetchMock,
    });
    const headers = { authorization: "Bearer reader-secret" };

    const metric = await integration.inject({ method: "GET", url: "/v1/metrics/inventory-health", headers });
    const runbook = await integration.inject({ method: "GET", url: "/v1/runbooks/checkout-api", headers });

    expect(metric.json()).toEqual({ service: "inventory-api", up: false, source: "prometheus" });
    expect(runbook.json()).toMatchObject({ service: "checkout-api", checks: expect.any(Array) });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://prometheus:9090/api/v1/query?query=sample_company_inventory_up",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await integration.close();
  });

  it("authorizes an agent principal with customer RBAC", async () => {
    const signingSecret = new TextEncoder().encode("sample-company-agent-signing-secret");
    const token = await new SignJWT({ actor_type: "agent", roles: ["incident_reader"] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://sample-company.test")
      .setAudience("sample-company-operations")
      .setSubject("agentid:sre-demo")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingSecret);
    const integration = buildIncidentApp({
      alertToken: "alert-secret",
      apiToken: "reader-secret",
      agentAccess: {
        issuer: "https://sample-company.test",
        audience: "sample-company-operations",
        signingSecret,
      },
    });
    const headers = { authorization: `Bearer ${token}` };

    expect((await integration.inject({ method: "GET", url: "/v1/incidents", headers })).statusCode).toBe(200);
    const denied = await integration.inject({ method: "GET", url: "/v1/runbooks/checkout-api", headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "agent_role_required", requiredRole: "sre_agent" });
    const audit = await integration.inject({
      method: "GET",
      url: "/v1/access-audit",
      headers: { authorization: "Bearer reader-secret" },
    });
    expect(audit.json()).toMatchObject({ items: [
      { principalType: "agent", subject: "agentid:sre-demo", operation: "runbooks.get", decision: "denied" },
      { principalType: "agent", subject: "agentid:sre-demo", operation: "incidents.list", decision: "allowed" },
    ] });
    await integration.close();
  });

  it("exchanges a verified AgentID token for a short-lived customer RBAC token", async () => {
    const signingSecret = new TextEncoder().encode("sample-company-agent-signing-secret");
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      actor_type: "agent",
      sub: "agent-subject",
      email: "sample-company-sre@agents.test",
      email_verified: true,
    })));
    const integration = buildIncidentApp({
      alertToken: "alert-secret",
      apiToken: "reader-secret",
      adminToken: "admin-secret",
      request,
      agentAccess: {
        issuer: "https://sample-company.test",
        audience: "sample-company-operations",
        signingSecret,
      },
      agentTokenExchange: {
        issuer: "https://sample-company.test",
        audience: "sample-company-operations",
        signingSecret,
        agentIdIssuer: "https://auth.agentid.test",
        userInfoUrl: "https://auth.agentid.test/v0/userinfo",
        allowedEmail: "sample-company-sre@agents.test",
        roles: ["incident_reader"],
      },
    });

    const exchanged = await integration.inject({
      method: "POST",
      url: "/v1/auth/agentid/exchange",
      headers: { authorization: "Bearer agentid-access-token" },
    });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.headers["cache-control"]).toBe("no-store");
    expect(request).toHaveBeenCalledWith(
      "https://auth.agentid.test/v0/userinfo",
      expect.objectContaining({ headers: { authorization: "Bearer agentid-access-token" } }),
    );
    const customerToken = exchanged.json().access_token as string;
    const verified = await jwtVerify(customerToken, signingSecret, {
      algorithms: ["HS256"],
      issuer: "https://sample-company.test",
      audience: "sample-company-operations",
    });
    expect(verified.payload).toMatchObject({
      sub: "agentid:agent-subject",
      external_sub: "agent-subject",
      roles: ["incident_reader"],
    });
    expect(exchanged.body).not.toContain("agentid-access-token");

    const customerHeaders = { authorization: `Bearer ${customerToken}` };
    expect((await integration.inject({
      method: "GET", url: "/v1/incidents", headers: customerHeaders,
    })).statusCode).toBe(200);
    const agents = await integration.inject({
      method: "GET",
      url: "/v1/admin/agents",
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(agents.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
      email: "sample-company-sre@agents.test",
      externalSubject: "agent-subject",
      status: "approved",
      scopes: ["incidents.list", "metrics.get"],
      services: ["checkout-api", "inventory-api"],
    })]) });
    const updated = await integration.inject({
      method: "PATCH",
      url: "/v1/admin/agents/sample-company-sre%40agents.test",
      headers: { authorization: "Bearer admin-secret" },
      payload: { scopes: ["runbooks.get"] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ scopes: ["runbooks.get"], status: "approved" });
    const deniedAfterScopeChange = await integration.inject({
      method: "GET", url: "/v1/incidents", headers: customerHeaders,
    });
    expect(deniedAfterScopeChange.statusCode).toBe(403);
    expect(deniedAfterScopeChange.json()).toEqual({
      error: "agent_scope_required", requiredScope: "incidents.list",
    });
    const adminAudit = await integration.inject({
      method: "GET",
      url: "/v1/admin/access-audit",
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(adminAudit.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      principalType: "agent",
      operation: "incidents.list",
      decision: "denied",
      reason: "agent_scope_required",
    })]));
    expect((await integration.inject({
      method: "GET", url: "/v1/runbooks/checkout-api", headers: customerHeaders,
    })).statusCode).toBe(200);

    request.mockResolvedValueOnce(new Response(JSON.stringify({
      actor_type: "agent",
      sub: "other-agent",
      email: "other@agents.test",
      email_verified: true,
    })));
    const denied = await integration.inject({
      method: "POST",
      url: "/v1/auth/agentid/exchange",
      headers: { authorization: "Bearer other-agentid-token" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "agentid_principal_not_registered" });
    const deniedAudit = await integration.inject({
      method: "GET",
      url: "/v1/admin/access-audit",
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(deniedAudit.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      operation: "agentid.exchange",
      decision: "denied",
      reason: "agentid_principal_not_registered",
    })]));
    await integration.close();
  });

  it("enforces AgentID action, resource, and parameter boundaries while legacy access remains broad", async () => {
    const signingSecret = new TextEncoder().encode("sample-company-agent-signing-secret");
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      actor_type: "agent",
      sub: "agent-subject",
      email: "sample-company-sre@agents.test",
      email_verified: true,
    })));
    const integration = buildIncidentApp({
      alertToken: "alert-secret",
      apiToken: "legacy-secret",
      adminToken: "admin-secret",
      request,
      agentAccess: {
        issuer: "https://sample-company.test",
        audience: "sample-company-operations",
        signingSecret,
      },
      agentTokenExchange: {
        issuer: "https://sample-company.test",
        audience: "sample-company-operations",
        signingSecret,
        agentIdIssuer: "https://auth.agentid.test",
        userInfoUrl: "https://auth.agentid.test/v0/userinfo",
        allowedEmail: "sample-company-sre@agents.test",
        roles: ["incident_reader", "sre_agent"],
      },
    });
    await integration.inject({
      method: "POST",
      url: "/v1/alertmanager/events",
      headers: { authorization: "Bearer alert-secret" },
      payload: { alerts: [{ labels: { alertname: "CheckoutDown", service: "checkout-api", severity: "critical" } }] },
    });
    await integration.inject({
      method: "POST",
      url: "/v1/alertmanager/events",
      headers: { authorization: "Bearer alert-secret" },
      payload: { alerts: [{ labels: { alertname: "InventoryDown", service: "inventory-api", severity: "critical" } }] },
    });
    const incidents = (await integration.inject({
      method: "GET", url: "/v1/incidents", headers: { authorization: "Bearer legacy-secret" },
    })).json().items as Array<{ id: string; service: string }>;
    const checkoutIncident = incidents.find((incident) => incident.service === "checkout-api")!;
    const inventoryIncident = incidents.find((incident) => incident.service === "inventory-api")!;

    const exchanged = await integration.inject({
      method: "POST",
      url: "/v1/auth/agentid/exchange",
      headers: { authorization: "Bearer agentid-access-token" },
    });
    const agentHeaders = { authorization: `Bearer ${exchanged.json().access_token as string}` };
    await integration.inject({
      method: "PATCH",
      url: "/v1/admin/agents/sample-company-sre%40agents.test",
      headers: { authorization: "Bearer admin-secret" },
      payload: {
        scopes: ["incidents.list", "incidents.acknowledge", "metrics.get"],
        services: ["checkout-api"],
        constraints: { maxNoteLength: 80, requireChangeTicket: true },
      },
    });

    expect((await integration.inject({
      method: "POST",
      url: `/v1/incidents/${checkoutIncident.id}/acknowledgements`,
      headers: agentHeaders,
      payload: { note: "Investigating checkout saturation", changeTicket: "CHG-1234" },
    })).statusCode).toBe(200);
    expect((await integration.inject({
      method: "POST",
      url: `/v1/incidents/${inventoryIncident.id}/acknowledgements`,
      headers: agentHeaders,
      payload: { note: "Investigating inventory", changeTicket: "CHG-1234" },
    })).json()).toEqual({ error: "agent_resource_required", requiredResource: "service:inventory-api" });
    expect((await integration.inject({
      method: "GET",
      url: "/v1/metrics/inventory-health",
      headers: agentHeaders,
    })).json()).toEqual({ error: "agent_resource_required", requiredResource: "service:inventory-api" });
    expect((await integration.inject({
      method: "POST",
      url: `/v1/incidents/${checkoutIncident.id}/acknowledgements`,
      headers: agentHeaders,
      payload: { note: "Missing a valid ticket", changeTicket: "INC-1234" },
    })).json()).toEqual({ error: "agent_parameter_constraint", constraint: "changeTicket must match CHG-1234" });
    expect((await integration.inject({
      method: "POST",
      url: `/v1/incidents/${checkoutIncident.id}/resolve`,
      headers: agentHeaders,
      payload: { resolution: "Recovered", changeTicket: "CHG-1234" },
    })).json()).toEqual({ error: "agent_scope_required", requiredScope: "incidents.resolve" });
    expect((await integration.inject({
      method: "POST",
      url: `/v1/incidents/${checkoutIncident.id}/resolve`,
      headers: { authorization: "Bearer legacy-secret" },
      payload: { resolution: "Recovered without an AgentID boundary", changeTicket: "INC-1" },
    })).statusCode).toBe(200);
    const audit = (await integration.inject({
      method: "GET",
      url: "/v1/admin/access-audit",
      headers: { authorization: "Bearer admin-secret" },
    })).json().items as Array<{ reason: string }>;
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "agent_resource_required" }),
      expect.objectContaining({ reason: "agent_parameter_constraint" }),
      expect.objectContaining({ reason: "agent_scope_required" }),
      expect.objectContaining({ reason: "legacy_shared_token" }),
    ]));
    await integration.close();
  });

  it("exposes the AgentID browser flow when configured", async () => {
    const agentOidc = {
      authorizationUrl: vi.fn().mockResolvedValue("https://auth.agentid.test/v0/authorize?state=demo"),
      complete: vi.fn().mockResolvedValue({
        accessToken: "customer-agent-token",
        subject: "agent-subject",
        email: "sample-company-sre@agents.test",
        roles: ["sre_agent"],
        expiresIn: 600,
      }),
    };
    const integration = buildIncidentApp({
      alertToken: "alert-secret",
      apiToken: "reader-secret",
      agentOidc,
    });

    const start = await integration.inject({ method: "GET", url: "/auth/agentid/start" });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toBe("https://auth.agentid.test/v0/authorize?state=demo");
    const callback = await integration.inject({
      method: "GET",
      url: "/auth/agentid/callback?code=code&state=state&iss=https%3A%2F%2Fauth.agentid.test",
    });
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.json()).toMatchObject({
      access_token: "customer-agent-token",
      token_type: "Bearer",
      agent: { subject: "agent-subject", roles: ["sre_agent"] },
    });
    await integration.close();
  });

  it("returns an AgentID token only to the configured portal origin", async () => {
    const integration = buildIncidentApp({
      alertToken: "alert-secret",
      apiToken: "reader-secret",
      portalOrigin: "http://localhost:5173",
      agentOidc: {
        authorizationUrl: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          accessToken: "customer-agent-token",
          subject: "agent-subject",
          email: "sample-company-sre@agents.test",
          roles: ["incident_reader"],
          expiresIn: 600,
        }),
      },
    });

    const callback = await integration.inject({
      method: "GET",
      url: "/auth/agentid/callback?code=code&state=state",
    });
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.headers["content-type"]).toContain("text/html");
    expect(callback.body).toContain('postMessage({"type":"sample-company-agentid"');
    expect(callback.body).toContain('"http://localhost:5173"');
    expect(callback.body).toContain('"accessToken":"customer-agent-token"');
    expect(callback.body).toContain("#sample-company-agentid=");
    expect(callback.headers["content-security-policy"]).toContain("script-src 'nonce-");
    await integration.close();
  });
});