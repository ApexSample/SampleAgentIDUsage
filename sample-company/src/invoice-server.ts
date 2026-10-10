import { resolve } from "node:path";
import { buildInvoiceMcpApp } from "./invoice-mcp.js";
import { InvoiceStore } from "./invoice-store.js";

const apiToken = process.env.INVOICE_MCP_TOKEN;
if (!apiToken) throw new Error("INVOICE_MCP_TOKEN is required");

const directory = resolve(process.env.INVOICE_PDF_DIRECTORY ?? "/data/invoices");
const port = Number(process.env.PORT ?? "4103");
buildInvoiceMcpApp({ store: new InvoiceStore(directory), apiToken }).listen(port, "0.0.0.0");