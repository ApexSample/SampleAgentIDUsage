import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildInvoiceMcpApp } from "./invoice-mcp.js";
import { InvoiceStore } from "./invoice-store.js";

const invoiceDirectory = resolve(process.cwd(), "../../../external_data/PDF_Invoice_Folder");

describe("Sample Company invoice MCP", () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(close.splice(0).map((operation) => operation())));

  it("lists, extracts, and validates real customer invoice PDFs", async () => {
    const app = buildInvoiceMcpApp({ store: new InvoiceStore(invoiceDirectory), apiToken: "invoice-reader" });
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolveListening) => listener.once("listening", resolveListening));
    close.push(async () => new Promise<void>((resolveClose, reject) =>
      listener.close((error?: Error) => error ? reject(error) : resolveClose())));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Invoice MCP listener is unavailable");
    const client = new Client({ name: "invoice-mcp-test", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { authorization: "Bearer invoice-reader" } } },
    ));
    close.push(async () => client.close());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "invoice.list", "invoice.get", "invoice.extract", "invoice.validate",
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);

    const listed = await client.callTool({ name: "invoice.list", arguments: { customer: "Sample Company A", limit: 10 } });
    expect(listed.structuredContent).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ invoiceId: "29496" })]),
    });
    const extracted = await client.callTool({ name: "invoice.extract", arguments: { invoiceId: "29496" } });
    expect(extracted.structuredContent).toMatchObject({
      invoiceId: "29496",
      billTo: "Sample Company A",
      orderDate: "Dec 06 2012",
      shipMode: "Standard Class",
      total: 13239.94,
      orderId: "IN-2012-SC200507-41249",
      item: { productId: "TEC-PH-5356", quantity: 5 },
      extraction: { method: "pdf_text", pageCount: 1, confidence: 0.98 },
    });
    const validated = await client.callTool({ name: "invoice.validate", arguments: { invoiceId: "29496" } });
    expect(validated.structuredContent).toMatchObject({ invoiceId: "29496", status: "valid" });

    const zeroDiscount = await client.callTool({ name: "invoice.extract", arguments: { invoiceId: "58" } });
    expect(zeroDiscount.structuredContent).toMatchObject({
      invoiceId: "58",
      subtotal: 10622.5,
      discount: 0,
      shipping: 447.66,
      total: 11070.16,
    });
    const zeroDiscountValidation = await client.callTool({
      name: "invoice.validate",
      arguments: { invoiceId: "58" },
    });
    expect(zeroDiscountValidation.structuredContent).toMatchObject({ invoiceId: "58", status: "valid" });

    const wrappedProduct = await client.callTool({ name: "invoice.extract", arguments: { invoiceId: "31900" } });
    expect(wrappedProduct.structuredContent).toMatchObject({
      invoiceId: "31900",
      item: {
        productName: "Eldon Expressions Desk Accessory, Wood Photo Frame, Mahogany",
        quantity: 3,
      },
    });

    const incomplete = await client.callTool({ name: "invoice.validate", arguments: { invoiceId: "41032" } });
    expect(incomplete.structuredContent).toMatchObject({
      invoiceId: "41032",
      status: "review_required",
      checks: [expect.objectContaining({ code: "supported_layout", status: "failed" })],
    });
  });

  it("requires the customer-owned invoice credential", async () => {
    const app = buildInvoiceMcpApp({ store: new InvoiceStore(invoiceDirectory), apiToken: "invoice-reader" });
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolveListening) => listener.once("listening", resolveListening));
    close.push(async () => new Promise<void>((resolveClose, reject) =>
      listener.close((error?: Error) => error ? reject(error) : resolveClose())));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Invoice MCP listener is unavailable");

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: "POST" });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "authentication_required" });
  });
});