import { afterEach, describe, expect, it, vi } from "vitest";

type SdkInstance = {
  start: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

const sdkInstances: SdkInstance[] = [];
const exporterOptions: unknown[] = [];

vi.mock("@opentelemetry/api", () => ({
  DiagLogLevel: { WARN: 2 },
  diag: { setLogger: vi.fn() },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    constructor(opts: unknown) {
      exporterOptions.push(opts);
    }
  },
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: (attrs: unknown) => attrs,
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    readonly start = vi.fn();
    readonly shutdown = vi.fn(async () => {});

    constructor() {
      sdkInstances.push(this);
    }
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
  ATTR_SERVICE_VERSION: "service.version",
}));

describe("tracing bootstrap", () => {
  afterEach(async () => {
    const tracing = await import("./tracing");
    await tracing.shutdownTracing();
    delete process.env["ORDIN_TRACING_ENABLED"];
    delete process.env["ORDIN_TRACING_DISABLED"];
    delete process.env["HTTP_PROXY"];
    delete process.env["HTTPS_PROXY"];
    sdkInstances.length = 0;
    exporterOptions.length = 0;
    vi.restoreAllMocks();
  });

  it("does not start unless explicitly enabled", async () => {
    const { startTracing } = await import("./tracing");

    expect(startTracing()).toBe(false);
    expect(sdkInstances).toHaveLength(0);
  });

  it("uses the parent broker proxy URL when supplied", async () => {
    const { startTracing } = await import("./tracing");

    expect(startTracing({ enabled: true, proxyUrl: "http://ordin:secret@127.0.0.1:1234" })).toBe(
      true,
    );

    expect(sdkInstances).toHaveLength(1);
    expect(sdkInstances[0]?.start).toHaveBeenCalledOnce();
    expect(exporterOptions[0]).toMatchObject({
      url: "http://otel/api/public/otel/v1/traces",
      httpAgentOptions: expect.any(Function),
    });
  });

  it("can restart and flush tracing across sequential runs", async () => {
    const { shutdownTracing, startTracing } = await import("./tracing");

    expect(startTracing({ enabled: true, proxyUrl: "http://ordin:secret@127.0.0.1:1234" })).toBe(
      true,
    );
    await shutdownTracing();
    expect(startTracing({ enabled: true, proxyUrl: "http://ordin:secret@127.0.0.1:5678" })).toBe(
      true,
    );
    await shutdownTracing();

    expect(sdkInstances).toHaveLength(2);
    expect(sdkInstances[0]?.shutdown).toHaveBeenCalledOnce();
    expect(sdkInstances[1]?.shutdown).toHaveBeenCalledOnce();
  });
});
