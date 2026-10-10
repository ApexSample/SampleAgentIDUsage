import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const invoiceFilePattern = /^invoice_(.+)_(\d+)\.pdf$/i;
const currencyPattern = /^\$([\d,]+\.\d{2})$/;
const datePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4}$/;
const orderIdPattern = /^Order ID\s*:\s*(.+)$/i;
const classificationPattern = /^(.+),\s*(.+),\s*([A-Z]{3}-[A-Z]{2}-\d+)$/;
const shipModes = new Set(["First Class", "Second Class", "Same Day", "Standard Class"]);

export interface InvoiceSummary {
  invoiceId: string;
  customerName: string;
  fileName: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface ExtractedInvoice {
  invoiceId: string;
  customerName: string;
  billTo: string;
  shipTo: string;
  orderDate: string;
  shipMode: string;
  balanceDue: number;
  item: {
    productName: string;
    productId: string;
    category: string;
    subCategory: string;
    quantity: number;
    unitCost: number;
    amount: number;
  };
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  orderId: string;
  extraction: {
    method: "pdf_text";
    pageCount: number;
    confidence: number;
    sourceFile: string;
    sha256: string;
  };
}

export interface InvoiceValidation {
  invoiceId: string;
  status: "valid" | "review_required";
  checks: Array<{
    code: string;
    status: "passed" | "failed";
    message: string;
  }>;
}

export class InvoiceNotFoundError extends Error {}
export class InvoiceExtractionError extends Error {}

export class InvoiceStore {
  constructor(
    private readonly directory: string,
    private readonly maxPdfBytes = 10 * 1024 * 1024,
    private readonly maxPages = 5,
  ) {}

  async list(options: { offset?: number; limit?: number; customer?: string } = {}) {
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
    const customer = options.customer?.trim().toLowerCase();
    const catalog = await this.catalog();
    const filtered = customer
      ? catalog.filter((invoice) => invoice.customerName.toLowerCase().includes(customer))
      : catalog;
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      nextOffset: offset + limit < filtered.length ? offset + limit : undefined,
    };
  }

  async get(invoiceId: string): Promise<InvoiceSummary> {
    const normalized = normalizeInvoiceId(invoiceId);
    const invoice = (await this.catalog()).find((candidate) => candidate.invoiceId === normalized);
    if (!invoice) throw new InvoiceNotFoundError("Invoice was not found");
    return invoice;
  }

  async extract(invoiceId: string): Promise<ExtractedInvoice> {
    const invoice = await this.get(invoiceId);
    const path = join(this.directory, invoice.fileName);
    const data = await readFile(path);
    if (data.byteLength > this.maxPdfBytes) throw new InvoiceExtractionError("Invoice PDF exceeds the extraction limit");
    const document = await getDocument({ data: new Uint8Array(data) }).promise;
    if (document.numPages < 1 || document.numPages > this.maxPages) {
      throw new InvoiceExtractionError("Invoice PDF page count is outside the extraction limit");
    }
    const tokens: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      tokens.push(...content.items.flatMap((item) => "str" in item && item.str.trim() ? [item.str.trim()] : []));
    }
    return parseInvoice(tokens, invoice, document.numPages, createHash("sha256").update(data).digest("hex"));
  }

  async validate(invoiceId: string): Promise<InvoiceValidation> {
    let invoice: ExtractedInvoice;
    try {
      invoice = await this.extract(invoiceId);
    } catch (error) {
      if (!(error instanceof InvoiceExtractionError)) throw error;
      return {
        invoiceId: normalizeInvoiceId(invoiceId),
        status: "review_required",
        checks: [check("supported_layout", false,
          "Invoice fields could not be extracted from the supported document layout.")],
      };
    }
    const checks: InvoiceValidation["checks"] = [
      check("required_fields", Boolean(invoice.orderId && invoice.billTo && invoice.item.productId),
        "Required invoice identity and product fields are present."),
      check("positive_amounts", invoice.item.quantity > 0 && invoice.item.unitCost > 0 && invoice.total > 0,
        "Quantity, unit cost, and total must be positive."),
      check("subtotal_matches", close(invoice.subtotal, invoice.item.amount),
        "Subtotal matches the line-item amount."),
      check("total_matches", close(invoice.total, invoice.subtotal - invoice.discount + invoice.shipping),
        "Total equals subtotal minus discount plus shipping."),
      check("balance_matches", close(invoice.balanceDue, invoice.total),
        "Balance due matches the invoice total."),
    ];
    return {
      invoiceId: invoice.invoiceId,
      status: checks.every((candidate) => candidate.status === "passed") ? "valid" : "review_required",
      checks,
    };
  }

  private async catalog(): Promise<InvoiceSummary[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const invoices = await Promise.all(entries.flatMap((entry) => {
      const match = entry.isFile() ? invoiceFilePattern.exec(entry.name) : undefined;
      if (!match) return [];
      return [stat(join(this.directory, entry.name)).then((metadata) => ({
        invoiceId: match[2]!,
        customerName: match[1]!.replaceAll("_", " ").trim(),
        fileName: basename(entry.name),
        sizeBytes: metadata.size,
        updatedAt: metadata.mtime.toISOString(),
      }))];
    }));
    return invoices.sort((left, right) => Number(left.invoiceId) - Number(right.invoiceId));
  }
}

function parseInvoice(
  tokens: string[],
  summary: InvoiceSummary,
  pageCount: number,
  sha256: string,
): ExtractedInvoice {
  const invoiceId = tokens.find((token) => /^#\s*\d+$/.test(token))?.replace(/^#\s*/, "");
  const orderDate = tokens.find((token) => datePattern.test(token));
  const shipMode = tokens.find((token) => shipModes.has(token));
  const orderId = tokens.map((token) => orderIdPattern.exec(token)?.[1]).find(Boolean);
  const classification = tokens.map((token) => classificationPattern.exec(token)).find(Boolean);
  const amounts = tokens.flatMap((token) => {
    const match = currencyPattern.exec(token);
    return match ? [Number(match[1]!.replaceAll(",", ""))] : [];
  });
  const billToIndex = tokens.indexOf("Bill To:");
  const shipToIndex = tokens.indexOf("Ship To:");
  const itemHeaderIndex = tokens.indexOf("Amount");
  const classificationIndex = tokens.findIndex((token) => classificationPattern.test(token));
  const quantityIndex = tokens.findIndex((token, index) =>
    index > itemHeaderIndex && index < classificationIndex && /^\d+$/.test(token));
  const productName = tokens.slice(itemHeaderIndex + 1, quantityIndex).join(" ");
  const quantity = Number(tokens[quantityIndex]);
  const addressEnd = tokens.findIndex((token, index) => index > shipToIndex && datePattern.test(token));
  const hasDiscount = tokens.some((token) => /^Discount(?:\s|:|\()/.test(token));
  const expectedAmountCount = hasDiscount ? 7 : 6;
  if (!invoiceId || invoiceId !== summary.invoiceId || !orderDate || !shipMode || !orderId ||
    !classification || amounts.length < expectedAmountCount || billToIndex < 0 || shipToIndex < 0 || itemHeaderIndex < 0 ||
    classificationIndex < 0 || quantityIndex <= itemHeaderIndex ||
    !productName || !Number.isInteger(quantity) || quantity < 1 || addressEnd < 0) {
    throw new InvoiceExtractionError("Invoice text does not match the supported SuperStore layout");
  }
  return {
    invoiceId,
    customerName: summary.customerName,
    billTo: tokens[billToIndex + 1] ?? summary.customerName,
    shipTo: tokens.slice(shipToIndex + 1, addressEnd).join(" "),
    orderDate,
    shipMode,
    balanceDue: amounts[0]!,
    item: {
      productName,
      quantity,
      unitCost: amounts[1]!,
      amount: amounts[2]!,
      subCategory: classification[1]!,
      category: classification[2]!,
      productId: classification[3]!,
    },
    subtotal: amounts[3]!,
    discount: hasDiscount ? amounts[4]! : 0,
    shipping: hasDiscount ? amounts[5]! : amounts[4]!,
    total: hasDiscount ? amounts[6]! : amounts[5]!,
    orderId,
    extraction: {
      method: "pdf_text",
      pageCount,
      confidence: 0.98,
      sourceFile: summary.fileName,
      sha256,
    },
  };
}

function normalizeInvoiceId(value: string): string {
  const normalized = value.trim().replace(/^#\s*/, "");
  if (!/^\d{1,12}$/.test(normalized)) throw new InvoiceNotFoundError("Invoice was not found");
  return normalized;
}

function check(code: string, passed: boolean, message: string): InvoiceValidation["checks"][number] {
  return { code, status: passed ? "passed" : "failed", message };
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.02;
}