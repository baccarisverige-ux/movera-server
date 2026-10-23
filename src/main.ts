import { buildApp } from "./app.js";
import { readEnv } from "./env.js";

const env = readEnv();
const app = await buildApp({ env });

const close = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
