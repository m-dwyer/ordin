import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface HarnessRootOptions {
  /** Override the workflow body. Defaults to a 3-phase plan/build/review with `human` gates. */
  readonly workflow?: string;
}

export async function makeHarnessRoot(opts: HarnessRootOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ordin-fixture-"));
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "skills"), { recursive: true });
  await mkdir(join(root, "workflows"), { recursive: true });

  await write(
    join(root, "ordin.config.yaml"),
    `run_store:
  base_dir: ${join(root, "runs")}
default_runtime: ai-sdk
default_model: m
allowed_tools: []
runtimes:
  ai-sdk:
    base_url: http://localhost:4000
tiers:
  S: {}
  M: {}
  L: {}
`,
  );
  await write(join(root, "workflows", "software-delivery.yaml"), opts.workflow ?? defaultWorkflow);
  await write(join(root, "projects.yaml"), "projects: {}\n");
  await write(
    join(root, "agents", "planner.md"),
    "---\nname: planner\nruntime: ai-sdk\n---\n\nPlanner prompt.\n",
  );
  await write(
    join(root, "agents", "build-local.md"),
    "---\nname: build-local\nruntime: ai-sdk\n---\n\nBuild prompt.\n",
  );
  await write(
    join(root, "agents", "reviewer.md"),
    "---\nname: reviewer\nruntime: ai-sdk\n---\n\nReview prompt.\n",
  );
  return root;
}

const defaultWorkflow = `name: software-delivery
version: 1
runtime: ai-sdk
model: m
phases:
  - id: plan
    agent: planner
    gate: human
    allowed_tools: []
    outputs:
      - { label: RFC, path: "docs/rfcs/{slug}-rfc.md", description: "Reviewable RFC for this problem" }
  - id: build
    agent: build-local
    gate: human
    allowed_tools: []
    inputs:
      - { label: "Approved RFC", path: "docs/rfcs/{slug}-rfc.md", description: "Plan-phase output; source of truth for Build and Review" }
    outputs:
      - { label: "Build notes", path: "docs/rfcs/{slug}-build-notes.md" }
  - id: review
    agent: reviewer
    gate: human
    allowed_tools: []
    inputs:
      - { label: "Approved RFC", path: "docs/rfcs/{slug}-rfc.md" }
      - { label: "Build notes", path: "docs/rfcs/{slug}-build-notes.md", description: "Build-phase summary" }
    outputs:
      - { label: Review, path: "reviews/{slug}-review.md" }
`;

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
