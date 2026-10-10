import { buildInventoryApp } from "./apps.js";

const port = Number(process.env.PORT ?? "4101");
await buildInventoryApp().listen({ host: "0.0.0.0", port });