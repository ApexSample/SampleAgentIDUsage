import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { jwtVerify, SignJWT } from "jose";
import type { AgentOidcService } from "./agent-oidc.js";
import { CheckoutMetrics } from "./metrics.js";
import { sampleCompanyAgentAdminHtml } from "./agent-admin-portal.js";

export interface AlertmanagerWebhook {
  alerts: Array<{
    status: "firing" | "resolved";
    labels: Record<string, string>;
    annotations?: Record<string, string>;
    startsAt?: string;
    endsAt?: string;
    fingerprint?: string;
  }>;
}

export interface CustomerIncident {
  id: string;
  status: "open" | "resolved";
  title: string;
  service: string;
  severity: string;
  summary: string;
  openedAt: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  acknowledgementNote?: string;
  changeTicket?: string;
}

export interface AgentAccessOptions {
  issuer: string;
  audience: string;
  signingSecret: Uint8Array;
}

export interface AgentTokenExchangeOptions extends AgentAccessOptions {
  agentIdIssuer: string;
  userInfoUrl: string;
  allowedEmail: string;
  roles: string[];
}

export interface CustomerAccessAuditEvent {
  timestamp: string;
  principalType: "agent" | "shared_integration" | "unknown";
  subject?: string;
  externalSubject?: string;
  roles: string[];
  operation: string;
  decision: "allowed" | "denied";
  reason: string;
}

const customerAgentScopes = [
  "incidents.list",
  "incidents.acknowledge",
  "incidents.resolve",
  "metrics.get",
  "runbooks.get",
  "invoice.list",
  "invoice.get",
  "invoice.extract",
  "invoice.validate",
] as const;
type CustomerAgentScope = typeof customerAgentScopes[number];
const customerAgentServices = ["checkout-api", "inventory-api", "invoice-mcp"] as const;
const incidentAgentServices: CustomerAgentService[] = ["checkout-api", "inventory-api"];
type CustomerAgentService = typeof customerAgentServices[number];

interface CustomerAgentPolicy {
  name: string;
  email: string;
  externalSubject?: string;
  status: "approved";
  scopes: CustomerAgentScope[];
  services: CustomerAgentService[];
  constraints: {
    maxNoteLength: number;
    requireChangeTicket: boolean;
  };
}

export function buildInventoryApp() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok", service: "inventory-api" }));
  app.get<{ Params: { sku: string } }>("/v1/inventory/:sku", async (request) => ({
    sku: request.params.sku,
    available: 12,
  }));
  return app;
}

export function buildCheckoutApp(options: {
  inventoryBaseUrl: string;
  request?: typeof fetch;
  dependencyTimeoutMs?: number;
}) {
  const app = Fastify({ logger: false });
  const metrics = new CheckoutMetrics();
  const request = options.request ?? globalThis.fetch;
  const dependencyTimeoutMs = options.dependencyTimeoutMs ?? 2_000;

  app.get("/health", async () => ({ status: "ok", service: "checkout-api" }));
  app.get("/metrics", async (_request, reply) => {
    reply.type("text/plain; version=0.0.4");
    return metrics.render();
  });
  app.post<{ Params: { sku: string } }>("/v1/orders/:sku", async (incoming, reply) => {
    metrics.recordRequest();
    try {
      const response = await request(`${options.inventoryBaseUrl}/v1/inventory/${encodeURIComponent(incoming.params.sku)}`, {
        signal: AbortSignal.timeout(dependencyTimeoutMs),
      });
      if (!response.ok) throw new Error(`inventory_http_${response.status}`);
      const inventory = await response.json() as { available?: number };
      metrics.recordDependencyResult(true);
      return reply.code(201).send({ status: "accepted", sku: incoming.params.sku, available: inventory.available });
    } catch {
      metrics.recordDependencyResult(false);
      return reply.code(503).send({
        error: "inventory_unavailable",
        message: "Checkout cannot confirm inventory availability",
      });
    }
  });
  return app;
}

export function buildIncidentApp(options: {
  alertToken: string;
  apiToken: string;
  adminToken?: string;
  agentAccess?: AgentAccessOptions;
  agentTokenExchange?: AgentTokenExchangeOptions;
  agentOidc?: Pick<AgentOidcService, "authorizationUrl" | "complete">;
  portalOrigin?: string;
  prometheusBaseUrl?: string;
  request?: typeof fetch;
}) {
  const app = Fastify({ logger: false });
  const incidents = new Map<string, CustomerIncident>();
  const accessAudit: CustomerAccessAuditEvent[] = [];
  const agentPolicies = new Map<string, CustomerAgentPolicy>();
  const request = options.request ?? globalThis.fetch;

  const invoiceAgentEmail = "scinvoiceagent@agentmail.to";
  agentPolicies.set(invoiceAgentEmail, {
    name: "FinanceTeamInvoiceAgent",
    email: invoiceAgentEmail,
    status: "approved",
    scopes: ["invoice.list", "invoice.get", "invoice.extract", "invoice.validate"],
    services: ["invoice-mcp"],
    constraints: { maxNoteLength: 160, requireChangeTicket: false },
  });

  if (options.agentTokenExchange) {
    const email = options.agentTokenExchange.allowedEmail.trim().toLowerCase();
    agentPolicies.set(email, {
      name: "Sample Company SRE",
      email,
      status: "approved",
      scopes: scopesForRoles(options.agentTokenExchange.roles),
      services: incidentAgentServices,
      constraints: { maxNoteLength: 160, requireChangeTicket: true },
    });
  }

  app.get("/health", async () => ({ status: "ok", service: "incident-api" }));
  app.get("/admin/agents", async (_incoming, reply) => {
    reply.header("content-security-policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    reply.type("text/html; charset=utf-8");
    return sampleCompanyAgentAdminHtml;
  });
  app.get("/v1/admin/agents", async (incoming, reply) => {
    if (!authorizeAdmin(incoming.headers.authorization, options.adminToken, reply)) return;
    return { items: [...agentPolicies.values()] };
  });
  app.get("/v1/admin/access-audit", async (incoming, reply) => {
    if (!authorizeAdmin(incoming.headers.authorization, options.adminToken, reply)) return;
    return { items: [...accessAudit].reverse() };
  });
  app.patch<{ Params: { email: string }; Body: {
    scopes?: unknown;
    services?: unknown;
    constraints?: { maxNoteLength?: unknown; requireChangeTicket?: unknown };
  } }>(
    "/v1/admin/agents/:email",
    async (incoming, reply) => {
      if (!authorizeAdmin(incoming.headers.authorization, options.adminToken, reply)) return;
      const email = incoming.params.email.trim().toLowerCase();
      const policy = agentPolicies.get(email);
      if (!policy) return reply.code(404).send({ error: "agent_not_found" });
      if (!Array.isArray(incoming.body?.scopes) || incoming.body.scopes.length === 0 ||
        incoming.body.scopes.some((scope) => typeof scope !== "string" ||
          !customerAgentScopes.includes(scope as CustomerAgentScope))) {
        return reply.code(400).send({ error: "invalid_agent_scopes" });
      }
      if (incoming.body.services !== undefined &&
        (!Array.isArray(incoming.body.services) || incoming.body.services.length === 0 ||
          incoming.body.services.some((service) => typeof service !== "string" ||
            !customerAgentServices.includes(service as CustomerAgentService)))) {
        return reply.code(400).send({ error: "invalid_agent_services" });
      }
      const maxNoteLength = incoming.body.constraints?.maxNoteLength ?? policy.constraints.maxNoteLength;
      const requireChangeTicket = incoming.body.constraints?.requireChangeTicket ??
        policy.constraints.requireChangeTicket;
      if ((incoming.body.constraints !== undefined &&
        (incoming.body.constraints.maxNoteLength === undefined ||
          incoming.body.constraints.requireChangeTicket === undefined)) ||
        !Number.isInteger(maxNoteLength) || Number(maxNoteLength) < 40 || Number(maxNoteLength) > 500 ||
        typeof requireChangeTicket !== "boolean") {
        return reply.code(400).send({ error: "invalid_agent_constraints" });
      }
      const updated = {
        ...policy,
        scopes: [...new Set(incoming.body.scopes)] as CustomerAgentScope[],
        services: incoming.body.services
          ? [...new Set(incoming.body.services)] as CustomerAgentService[]
          : policy.services,
        constraints: { maxNoteLength: Number(maxNoteLength), requireChangeTicket },
      };
      agentPolicies.set(email, updated);
      return updated;
    },
  );
  app.post("/v1/auth/agentid/exchange", async (incoming, reply) => {
    const token = incoming.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token || !options.agentTokenExchange) {
      recordAccess(accessAudit, {
        principalType: "unknown", roles: [], operation: "agentid.exchange",
        decision: "denied", reason: "agentid_token_required",
      });
      return reply.code(401).send({ error: "agentid_token_required" });
    }
    const userInfoResponse = await request(options.agentTokenExchange.userInfoUrl, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!userInfoResponse.ok) {
      recordAccess(accessAudit, {
        principalType: "unknown", roles: [], operation: "agentid.exchange",
        decision: "denied", reason: "agentid_token_invalid",
      });
      return reply.code(401).send({ error: "agentid_token_invalid" });
    }
    const userInfo = await userInfoResponse.json() as Record<string, unknown>;
    const email = typeof userInfo.email === "string" ? userInfo.email.trim().toLowerCase() : "";
    if (userInfo.actor_type !== "agent" || typeof userInfo.sub !== "string" ||
      userInfo.email_verified !== true || email !== options.agentTokenExchange.allowedEmail.toLowerCase()) {
      recordAccess(accessAudit, {
        principalType: "unknown", roles: [], operation: "agentid.exchange",
        decision: "denied", reason: "agentid_principal_not_registered",
      });
      return reply.code(403).send({ error: "agentid_principal_not_registered" });
    }
    const policy = agentPolicies.get(email);
    if (!policy) return reply.code(403).send({ error: "agentid_principal_not_registered" });
    agentPolicies.set(email, { ...policy, externalSubject: userInfo.sub });
    const expiresIn = 600;
    const customerToken = await new SignJWT({
      actor_type: "agent",
      roles: options.agentTokenExchange.roles,
      email,
      external_issuer: options.agentTokenExchange.agentIdIssuer,
      external_sub: userInfo.sub,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(options.agentTokenExchange.issuer)
      .setAudience(options.agentTokenExchange.audience)
      .setSubject(`agentid:${userInfo.sub}`)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(options.agentTokenExchange.signingSecret);
    reply.header("cache-control", "no-store");
    return { access_token: customerToken, token_type: "Bearer", expires_in: expiresIn };
  });
  app.get("/auth/agentid/start", async (_request, reply) => {
    if (!options.agentOidc) return reply.code(503).send({ error: "agentid_not_configured" });
    return reply.redirect(await options.agentOidc.authorizationUrl());
  });
  app.get<{ Querystring: { code?: string; state?: string; iss?: string; error?: string } }>(
    "/auth/agentid/callback",
    async (incoming, reply) => {
      if (!options.agentOidc) return reply.code(503).send({ error: "agentid_not_configured" });
      if (incoming.query.error || !incoming.query.code || !incoming.query.state) {
        return reply.code(400).send({ error: incoming.query.error ?? "oidc_callback_invalid" });
      }
      try {
        const result = await options.agentOidc.complete(
          incoming.query.code,
          incoming.query.state,
          incoming.query.iss,
        );
        reply.header("cache-control", "no-store");
        if (options.portalOrigin) {
          const nonce = randomBytes(18).toString("base64");
          const payload = JSON.stringify({
            type: "sample-company-agentid",
            accessToken: result.accessToken,
            expiresIn: result.expiresIn,
            agent: {
              issuer: result.issuer,
              subject: result.subject,
              email: result.email,
              roles: result.roles,
            },
          }).replaceAll("<", "\\u003c");
          const origin = JSON.stringify(options.portalOrigin);
          const fallback = JSON.stringify(
            `${options.portalOrigin}/#sample-company-agentid=${encodeURIComponent(payload)}`,
          );
          reply.header(
            "content-security-policy",
            `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
          );
          reply.type("text/html; charset=utf-8");
          return `<!doctype html><html><head><meta charset="utf-8"><title>AgentID connected</title></head><body><p>Completing AgentID connection...</p><script nonce="${nonce}">window.opener?.postMessage(${payload},${origin});setTimeout(()=>location.replace(${fallback}),300);</script></body></html>`;
        }
        return {
          access_token: result.accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          agent: { subject: result.subject, email: result.email, roles: result.roles },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "oidc_callback_failed";
        return reply.code(401).send({ error: reason });
      }
    },
  );
  app.get("/v1/incidents", async (request, reply) => {
    if (!await authorizeIntegrationRequest(
      request.headers.authorization, options, "incident_reader", "incidents.list", agentPolicies, accessAudit, reply,
    )) return;
    return { items: [...incidents.values()] };
  });
  app.post<{ Params: { incidentId: string }; Body: { note?: unknown; changeTicket?: unknown } }>(
    "/v1/incidents/:incidentId/acknowledgements",
    async (incoming, reply) => {
      const incident = incidents.get(incoming.params.incidentId);
      if (!incident) return reply.code(404).send({ error: "incident_not_found" });
      const note = typeof incoming.body?.note === "string" ? incoming.body.note.trim() : "";
      const changeTicket = typeof incoming.body?.changeTicket === "string"
        ? incoming.body.changeTicket.trim().toUpperCase()
        : "";
      if (!await authorizeIntegrationRequest(
        incoming.headers.authorization, options, "sre_agent", "incidents.acknowledge",
        agentPolicies, accessAudit, reply, { service: incident.service, note, changeTicket },
      )) return;
      const acknowledgedAt = new Date().toISOString();
      const updated = {
        ...incident,
        acknowledgedAt,
        acknowledgedBy: "agent",
        acknowledgementNote: note,
        ...(changeTicket ? { changeTicket } : {}),
      };
      incidents.set(incident.id, updated);
      return { incidentId: incident.id, status: "acknowledged", acknowledgedAt, changeTicket };
    },
  );
  app.post<{ Params: { incidentId: string }; Body: { resolution?: unknown; changeTicket?: unknown } }>(
    "/v1/incidents/:incidentId/resolve",
    async (incoming, reply) => {
      const incident = incidents.get(incoming.params.incidentId);
      if (!incident) return reply.code(404).send({ error: "incident_not_found" });
      const resolution = typeof incoming.body?.resolution === "string" ? incoming.body.resolution.trim() : "";
      const changeTicket = typeof incoming.body?.changeTicket === "string"
        ? incoming.body.changeTicket.trim().toUpperCase()
        : "";
      if (!await authorizeIntegrationRequest(
        incoming.headers.authorization, options, "sre_agent", "incidents.resolve",
        agentPolicies, accessAudit, reply, { service: incident.service, note: resolution, changeTicket },
      )) return;
      const resolvedAt = new Date().toISOString();
      incidents.set(incident.id, { ...incident, status: "resolved", resolvedAt, changeTicket });
      return { incidentId: incident.id, status: "resolved", resolvedAt, changeTicket };
    },
  );
  app.get("/v1/metrics/inventory-health", async (incoming, reply) => {
    if (!await authorizeIntegrationRequest(
      incoming.headers.authorization, options, "incident_reader", "metrics.get", agentPolicies, accessAudit, reply,
      { service: "inventory-api" },
    )) return;
    if (!options.prometheusBaseUrl) return reply.code(503).send({ error: "metrics_unavailable" });
    try {
      const response = await request(
        `${options.prometheusBaseUrl.replace(/\/$/, "")}/api/v1/query?query=sample_company_inventory_up`,
        { signal: AbortSignal.timeout(2_000) },
      );
      if (!response.ok) throw new Error(`prometheus_http_${response.status}`);
      const body = await response.json() as {
        data?: { result?: Array<{ value?: [number, string] }> };
      };
      const value = body.data?.result?.[0]?.value?.[1];
      if (value !== "0" && value !== "1") throw new Error("invalid_metric");
      return { service: "inventory-api", up: value === "1", source: "prometheus" };
    } catch {
      return reply.code(503).send({ error: "metrics_unavailable" });
    }
  });
  app.get<{ Params: { service: string } }>("/v1/runbooks/:service", async (incoming, reply) => {
    if (!await authorizeIntegrationRequest(
      incoming.headers.authorization, options, "sre_agent", "runbooks.get", agentPolicies, accessAudit, reply,
      { service: incoming.params.service },
    )) return;
    if (incoming.params.service !== "checkout-api") {
      return reply.code(404).send({ error: "runbook_not_found" });
    }
    return {
      service: "checkout-api",
      title: "Checkout inventory dependency failure",
      checks: [
        "Confirm sample_company_inventory_up is zero.",
        "Verify Inventory API health before restarting Checkout API.",
        "After Inventory recovers, submit a test order and confirm the alert resolves.",
      ],
    };
  });
  app.get("/v1/access-audit", async (incoming, reply) => {
    if (incoming.headers.authorization !== `Bearer ${options.apiToken}`) {
      return reply.code(401).send({ error: "integration_api_authentication_required" });
    }
    return { items: [...accessAudit].reverse() };
  });
  app.post("/v1/alertmanager/events", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${options.alertToken}`) {
      return reply.code(401).send({ error: "alert_webhook_authentication_required" });
    }
    const payload = request.body as AlertmanagerWebhook;
    if (!Array.isArray(payload?.alerts)) {
      return reply.code(400).send({ error: "invalid_alertmanager_payload" });
    }
    for (const alert of payload.alerts) {
      const id = alert.fingerprint || `${alert.labels.alertname ?? "alert"}:${alert.labels.instance ?? "unknown"}`;
      const existing = incidents.get(id);
      const status = alert.status === "resolved" ? "resolved" : "open";
      incidents.set(id, {
        id,
        status,
        title: alert.annotations?.summary ?? alert.labels.alertname ?? "Monitoring alert",
        service: alert.labels.service ?? "unknown",
        severity: alert.labels.severity ?? "unknown",
        summary: alert.annotations?.description ?? "No description supplied",
        openedAt: existing?.openedAt ?? alert.startsAt ?? new Date().toISOString(),
        ...(status === "resolved" ? { resolvedAt: alert.endsAt ?? new Date().toISOString() } : {}),
      });
    }
    return reply.code(202).send({ accepted: payload.alerts.length });
  });
  return app;
}

async function authorizeIntegrationRequest(
  authorization: string | undefined,
  options: { apiToken: string; agentAccess?: AgentAccessOptions },
  requiredRole: "incident_reader" | "sre_agent",
  operation: CustomerAgentScope,
  agentPolicies: Map<string, CustomerAgentPolicy>,
  accessAudit: CustomerAccessAuditEvent[],
  reply: { code(statusCode: number): { send(payload: Record<string, unknown>): unknown } },
  context?: { service?: string; note?: string; changeTicket?: string },
): Promise<boolean> {
  if (authorization === `Bearer ${options.apiToken}`) {
    recordAccess(accessAudit, {
      principalType: "shared_integration", roles: ["legacy_full_access"], operation,
      decision: "allowed", reason: "legacy_shared_token",
    });
    return true;
  }
  const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token || !options.agentAccess) {
    recordAccess(accessAudit, {
      principalType: "unknown", roles: [], operation, decision: "denied", reason: "authentication_required",
    });
    reply.code(401).send({ error: "integration_api_authentication_required" });
    return false;
  }
  try {
    const { payload } = await jwtVerify(token, options.agentAccess.signingSecret, {
      algorithms: ["HS256"],
      issuer: options.agentAccess.issuer,
      audience: options.agentAccess.audience,
    });
    if (payload.actor_type !== "agent" || !payload.sub) throw new Error("invalid_agent_principal");
    const tokenRoles = Array.isArray(payload.roles) ? payload.roles.filter((role): role is string => typeof role === "string") : [];
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const policy = agentPolicies.get(email);
    const roles = policy ? rolesForScopes(policy.scopes) : tokenRoles;
    const scopeAllowed = policy ? policy.scopes.includes(operation) : tokenRoles.includes(requiredRole);
    if (!scopeAllowed) {
      recordAccess(accessAudit, {
        principalType: "agent", subject: payload.sub,
        externalSubject: typeof payload.external_sub === "string" ? payload.external_sub : undefined,
        roles, operation, decision: "denied", reason: policy ? "agent_scope_required" : "agent_role_required",
      });
      reply.code(403).send(policy
        ? { error: "agent_scope_required", requiredScope: operation }
        : { error: "agent_role_required", requiredRole });
      return false;
    }
    if (policy && context?.service &&
      !policy.services.includes(context.service as CustomerAgentService)) {
      recordAccess(accessAudit, {
        principalType: "agent", subject: payload.sub,
        externalSubject: typeof payload.external_sub === "string" ? payload.external_sub : undefined,
        roles, operation, decision: "denied", reason: "agent_resource_required",
      });
      reply.code(403).send({ error: "agent_resource_required", requiredResource: `service:${context.service}` });
      return false;
    }
    if (policy && context?.note !== undefined &&
      (!context.note || context.note.length > policy.constraints.maxNoteLength)) {
      recordAccess(accessAudit, {
        principalType: "agent", subject: payload.sub,
        externalSubject: typeof payload.external_sub === "string" ? payload.external_sub : undefined,
        roles, operation, decision: "denied", reason: "agent_parameter_constraint",
      });
      reply.code(403).send({
        error: "agent_parameter_constraint",
        constraint: `note length must be 1-${policy.constraints.maxNoteLength}`,
      });
      return false;
    }
    if (policy && context?.changeTicket !== undefined && policy.constraints.requireChangeTicket &&
      !/^CHG-\d{4,10}$/.test(context.changeTicket)) {
      recordAccess(accessAudit, {
        principalType: "agent", subject: payload.sub,
        externalSubject: typeof payload.external_sub === "string" ? payload.external_sub : undefined,
        roles, operation, decision: "denied", reason: "agent_parameter_constraint",
      });
      reply.code(403).send({ error: "agent_parameter_constraint", constraint: "changeTicket must match CHG-1234" });
      return false;
    }
    recordAccess(accessAudit, {
      principalType: "agent", subject: payload.sub,
      externalSubject: typeof payload.external_sub === "string" ? payload.external_sub : undefined,
      roles, operation, decision: "allowed", reason: policy ? "customer_policy_allowed" : "role_granted",
    });
    return true;
  } catch {
    recordAccess(accessAudit, {
      principalType: "unknown", roles: [], operation, decision: "denied", reason: "token_invalid",
    });
    reply.code(401).send({ error: "integration_api_authentication_required" });
    return false;
  }
}

function authorizeAdmin(
  authorization: string | undefined,
  adminToken: string | undefined,
  reply: { code(statusCode: number): { send(payload: Record<string, unknown>): unknown } },
): boolean {
  if (adminToken && authorization === `Bearer ${adminToken}`) return true;
  reply.code(401).send({ error: "admin_authentication_required" });
  return false;
}

function scopesForRoles(roles: string[]): CustomerAgentScope[] {
  return customerAgentScopes.filter((scope) =>
    (!scope.startsWith("invoice.") && (scope === "runbooks.get" || scope === "incidents.acknowledge"
      ? roles.includes("sre_agent")
      : scope !== "incidents.resolve" && roles.includes("incident_reader"))));
}

function rolesForScopes(scopes: CustomerAgentScope[]): string[] {
  return [
    ...(scopes.some((scope) => scope === "incidents.list" || scope === "metrics.get") ? ["incident_reader"] : []),
    ...(scopes.some((scope) => scope === "runbooks.get" || scope === "incidents.acknowledge" ||
      scope === "incidents.resolve")
      ? ["sre_agent"] : []),
  ];
}

function recordAccess(
  accessAudit: CustomerAccessAuditEvent[],
  event: Omit<CustomerAccessAuditEvent, "timestamp">,
): void {
  accessAudit.push({ timestamp: new Date().toISOString(), ...event });
  if (accessAudit.length > 200) accessAudit.shift();
}