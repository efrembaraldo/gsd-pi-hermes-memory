import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentRoot } from "../src/paths.js";

describe("agent root path resolution", () => {
  it("prefers GSD_CODING_AGENT_DIR over the legacy ~/.gsd/agent root", () => {
    const root = resolveAgentRoot({ GSD_CODING_AGENT_DIR: "/tmp/gsd-pi-agent-dir" });

    assert.strictEqual(root, path.resolve("/tmp/gsd-pi-agent-dir"));
  });

  it("falls back to ~/.gsd/agent when GSD_CODING_AGENT_DIR is unset or blank", () => {
    const expected = path.join(os.homedir(), ".gsd", "agent");

    assert.strictEqual(resolveAgentRoot({}), expected);
    assert.strictEqual(resolveAgentRoot({ GSD_CODING_AGENT_DIR: "  " }), expected);
  });

  it("expands home-relative GSD_CODING_AGENT_DIR values", () => {
    const root = resolveAgentRoot({ GSD_CODING_AGENT_DIR: "~/custom-gsd-pi-agent" });

    assert.strictEqual(root, path.join(os.homedir(), "custom-gsd-pi-agent"));
  });
});
