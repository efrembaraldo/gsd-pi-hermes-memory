import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPreviewContextCommand } from "../../src/handlers/preview-context.js";

describe("registerPreviewContextCommand", () => {
  function setup(opts: {
    memoryBlock?: string;
    projectBlock?: string;
    skillIndex?: string;
    projectName?: string;
    withProjectStore?: boolean;
  }) {
    const commands: { name: string; handler: Function }[] = [];
    const notifyCalls: { message: string; severity: string }[] = [];

    const mockPi = {
      registerCommand: (name: string, conf: any) => {
        commands.push({ name, handler: conf.handler });
      },
    } as any;

    const store = {
      formatForSystemPrompt: () => opts.memoryBlock ?? "",
    } as any;

    const projectStore = opts.withProjectStore
      ? ({ formatProjectBlock: () => opts.projectBlock ?? "" } as any)
      : null;

    const skillStore = {
      formatIndexForSystemPrompt: async () => opts.skillIndex ?? "",
    } as any;

    registerPreviewContextCommand(
      mockPi,
      store,
      projectStore,
      skillStore,
      opts.projectName ?? "demo-project",
    );

    return {
      handler: commands[0].handler,
      notifyCalls,
      ctx: {
        ui: {
          notify: (message: string, severity: string) => {
            notifyCalls.push({ message, severity });
          },
        },
      },
    };
  }

  it("registers /memory-preview-context", () => {
    const { handler } = setup({});
    assert.ok(typeof handler === "function");
  });

  it("shows all available blocks", async () => {
    const { handler, ctx, notifyCalls } = setup({
      memoryBlock: "<memory-context>MEM</memory-context>",
      projectBlock: "<memory-context>PROJECT</memory-context>",
      skillIndex: "<memory-context>SKILLS</memory-context>",
      withProjectStore: true,
      projectName: "pi-hermes-memory",
    });

    await handler({}, ctx);
    assert.strictEqual(notifyCalls.length, 1);
    const out = notifyCalls[0].message;
    assert.match(out, /Injected Context Preview/);
    assert.match(out, /MEMORY \+ USER \+ RECENT FAILURES/);
    assert.match(out, /PROJECT MEMORY \(pi-hermes-memory\)/);
    assert.match(out, /SKILL INDEX/);
    assert.match(out, /Blocks shown: 3/);
  });

  it("shows empty-state guidance when no blocks exist", async () => {
    const { handler, ctx, notifyCalls } = setup({
      memoryBlock: "",
      projectBlock: "",
      skillIndex: "",
      withProjectStore: false,
    });

    await handler({}, ctx);
    const out = notifyCalls[0].message;
    assert.match(out, /No memory context blocks are currently injected/);
    assert.match(out, /Blocks shown: 0/);
  });
});
