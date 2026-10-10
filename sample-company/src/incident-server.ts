import { buildIncidentApp } from "./apps.js";
import { AgentOidcService } from "./agent-oidc.js";

const alertToken = process.env.ALERT_WEBHOOK_TOKEN;
const apiToken = process.env.INCIDENT_API_TOKEN;
if (!alertToken || !apiToken) throw new Error("ALERT_WEBHOOK_TOKEN and INCIDENT_API_TOKEN are required");

const port = Number(process.env.PORT ?? "4102");
const customerIssuer = process.env.AGENT_ACCESS_TOKEN_ISSUER ?? "http://localhost:4102";
const customerAudience = process.env.AGENT_ACCESS_TOKEN_AUDIENCE ?? "sample-company-operations";
const signingSecret = process.env.AGENT_ACCESS_TOKEN_SIGNING_SECRET;
const encodedSigningSecret = signingSecret ? new TextEncoder().encode(signingSecret) : undefined;
const roles = (process.env.AGENTID_AGENT_ROLES ?? "incident_reader")
	.split(",")
	.map((role) => role.trim())
	.filter(Boolean);
const agentOidc = process.env.AGENTID_CLIENT_ID && process.env.AGENTID_CLIENT_SECRET &&
	process.env.AGENTID_ALLOWED_EMAIL && encodedSigningSecret
	? new AgentOidcService({
		clientId: process.env.AGENTID_CLIENT_ID,
		clientSecret: process.env.AGENTID_CLIENT_SECRET,
		redirectUri: process.env.AGENTID_REDIRECT_URI ?? "http://localhost:4102/auth/agentid/callback",
		discoveryUrl: process.env.AGENTID_DISCOVERY_URL ?? "https://auth.agentid.com/.well-known/openid-configuration",
		allowedEmail: process.env.AGENTID_ALLOWED_EMAIL,
		customerIssuer,
		customerAudience,
		customerSigningSecret: encodedSigningSecret,
		roles,
	})
	: undefined;
await buildIncidentApp({
	alertToken,
	apiToken,
	adminToken: process.env.SAMPLE_COMPANY_ADMIN_TOKEN ?? "sample-company-admin",
	...(encodedSigningSecret ? {
		agentAccess: { issuer: customerIssuer, audience: customerAudience, signingSecret: encodedSigningSecret },
	} : {}),
	...(encodedSigningSecret && process.env.AGENTID_ALLOWED_EMAIL ? {
		agentTokenExchange: {
			issuer: customerIssuer,
			audience: customerAudience,
			signingSecret: encodedSigningSecret,
			agentIdIssuer: process.env.AGENTID_ISSUER ?? "https://auth.agentid.com",
			userInfoUrl: process.env.AGENTID_USERINFO_URL ?? "https://auth.agentid.com/v0/userinfo",
			allowedEmail: process.env.AGENTID_ALLOWED_EMAIL,
			roles,
		},
	} : {}),
	...(agentOidc ? { agentOidc } : {}),
	portalOrigin: process.env.AGENTID_PORTAL_ORIGIN ?? "http://localhost:5173",
	prometheusBaseUrl: process.env.PROMETHEUS_BASE_URL ?? "http://prometheus:9090",
}).listen({ host: "0.0.0.0", port });