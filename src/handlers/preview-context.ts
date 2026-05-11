/**
 * Preview context command — /memory-preview-context shows the policy-only prompt
 * or legacy memory/skill blocks appended to the system prompt.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { SkillStore } from "../store/skill-store.js";
import { MEMORY_POLICY_PROMPT } from "../constants.js";
import type { MemoryConfig } from "../types.js";

export function registerPreviewContextCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  skillStore: SkillStore,
  projectName: string,
  memoryMode: MemoryConfig["memoryMode"] = "policy-only",
): void {
  pi.registerCommand("memory-preview-context", {
    description: "Preview the memory policy or legacy memory/skill context blocks",
    handler: async (_args, ctx) => {
      if (memoryMode === "policy-only") {
        const lines: string[] = [];
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║        Injected Context Preview             ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  Mode: policy-only");
        lines.push("  This is the memory policy appended to the system prompt.");
        lines.push("  Full Markdown memories are NOT injected in this mode.");
        lines.push("");
        lines.push(MEMORY_POLICY_PROMPT);
        lines.push("");
        lines.push("  Blocks shown: 1");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const memoryBlock = store.formatForSystemPrompt();
      const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";
      const skillIndex = await skillStore.formatIndexForSystemPrompt();

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║        👀 Injected Context Preview          ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");
      lines.push("  This is the memory/skill context appended to the system prompt.");
      lines.push("  (Core hidden system instructions are NOT shown.)");
      lines.push("");

      let blockCount = 0;

      if (memoryBlock) {
        blockCount++;
        lines.push("  ── MEMORY + USER + RECENT FAILURES ─────────────────────────");
        lines.push(memoryBlock);
        lines.push("");
      }

      if (projectBlock) {
        blockCount++;
        lines.push(`  ── PROJECT MEMORY (${projectName}) ─────────────────────────`);
        lines.push(projectBlock);
        lines.push("");
      }

      if (skillIndex) {
        blockCount++;
        lines.push("  ── SKILL INDEX ─────────────────────────────────────────────");
        lines.push(skillIndex);
        lines.push("");
      }

      if (blockCount === 0) {
        lines.push("  No memory context blocks are currently injected.");
        lines.push("  Add memory entries or skills, then run this command again.");
        lines.push("");
      }

      lines.push(`  Blocks shown: ${blockCount}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
