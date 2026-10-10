import { buildCheckoutApp } from "./apps.js";

const port = Number(process.env.PORT ?? "4100");
const app = buildCheckoutApp({
  inventoryBaseUrl: process.env.INVENTORY_BASE_URL ?? "http://inventory-api:4101",
  dependencyTimeoutMs: Number(process.env.DEPENDENCY_TIMEOUT_MS ?? "2000"),
});

await app.listen({ host: "0.0.0.0", port });