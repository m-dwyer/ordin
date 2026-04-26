import { afterAll } from "vitest";
import { shutdownTracing, startTracing } from "../src/observability/tracing";

startTracing();

afterAll(async () => {
  await shutdownTracing();
});
