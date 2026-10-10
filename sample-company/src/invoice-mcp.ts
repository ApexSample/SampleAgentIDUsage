import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { InvoiceExtractionError, InvoiceNotFoundError, type InvoiceStore } from "./invoice-store.js";

export function buildInvoiceMcpApp(options: { store: InvoiceStore; apiToken: string }) {
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: ["127.0.0.1", "localhost", "host.k3d.internal"],
  });
  app.get("/health", (_request, response) => response.json({ status: "ok", service: "sample-company-invoices" }));
  app.use("/mcp", (request, response, next) => {
    const candidate = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!sameToken(candidate, options.apiToken)) {
      response.status(401).json({ error: "authentication_required" });
      return;
    }
    next();
  });
  app.post("/mcp", async (request, response) => {
    const server = createInvoiceServer(options.store);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) response.status(500).json({
        jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null,
      });
    } finally {
      await transport.close();
      await server.close();
    }
  });
  app.get("/mcp", (_request, response) => response.status(405).send("Method Not Allowed"));
  app.delete("/mcp", (_request, response) => response.status(405).send("Method Not Allowed"));
  return app;
}

function createInvoiceServer(store: InvoiceStore): McpServer {
  const server = new McpServer({ name: "sample-company-invoices", version: "0.1.0" });
  server.registerTool("invoice.list", {
    description: "List Sample Company invoice documents using bounded pagination and an optional customer-name filter",
    inputSchema: {
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      customer: z.string().min(1).max(200).optional(),
    },
    annotations: readOnlyAnnotations,
  }, async (arguments_) => toolResult(await store.list(arguments_)));
  server.registerTool("invoice.get", {
    description: "Get metadata for one Sample Company invoice without returning the source PDF",
    inputSchema: { invoiceId: z.string().regex(/^#?\s*\d{1,12}$/) },
    annotations: readOnlyAnnotations,
  }, async ({ invoiceId }) => invoiceTool(() => store.get(invoiceId)));
  server.registerTool("invoice.extract", {
    description: "Extract normalized fields and source integrity evidence from one Sample Company invoice PDF",
    inputSchema: { invoiceId: z.string().regex(/^#?\s*\d{1,12}$/) },
    annotations: readOnlyAnnotations,
  }, async ({ invoiceId }) => invoiceTool(() => store.extract(invoiceId)));
  server.registerTool("invoice.validate", {
    description: "Validate required fields and invoice arithmetic, returning review findings without creating an AP record",
    inputSchema: { invoiceId: z.string().regex(/^#?\s*\d{1,12}$/) },
    annotations: readOnlyAnnotations,
  }, async ({ invoiceId }) => invoiceTool(() => store.validate(invoiceId)));
  return server;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

async function invoiceTool(operation: () => Promise<unknown>) {
  try {
    return toolResult(await operation());
  } catch (error) {
    if (error instanceof InvoiceNotFoundError || error instanceof InvoiceExtractionError) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: error.message }],
      };
    }
    throw error;
  }
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isRecord(value) ? { structuredContent: value } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameToken(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash) && candidate.length === expected.length;
}