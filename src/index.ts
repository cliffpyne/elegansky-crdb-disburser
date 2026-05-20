import { buildServer } from "./server.js";
import { config } from "./config.js";

const app = buildServer();

app
  .listen({ port: config.PORT, host: config.HOST })
  .then((addr) => app.log.info(`disburser webhook listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.log.info(`${sig} received, shutting down`);
    app.close().then(() => process.exit(0));
  });
}
