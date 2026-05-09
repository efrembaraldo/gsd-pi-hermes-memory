/**
 * Preview context command — /memory-preview-context shows the memory/skill blocks
 * that are injected into the system prompt.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { SkillStore } from "../store/skill-store.js";

export function registerPreviewContextCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  skillStore: SkillStore,
  projectName: string,
): void {
  pi.registerCommand("memory-preview-context", {
    description: "Preview the memory/skill context blocks injected into the system prompt",
    handler: async (_args, ctx) => {
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
