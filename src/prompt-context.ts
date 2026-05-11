import { MEMORY_POLICY_PROMPT } from "./constants.js";
import type { MemoryConfig } from "./types.js";
import type { MemoryStore } from "./store/memory-store.js";
import type { SkillStore } from "./store/skill-store.js";

export async function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  skillStore: SkillStore,
  projectName: string,
): Promise<string> {
  if (config.memoryMode === "policy-only") {
    return MEMORY_POLICY_PROMPT;
  }

  const memoryBlock = store.formatForSystemPrompt();
  const skillIndex = await skillStore.formatIndexForSystemPrompt();
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (projectBlock) parts.push(projectBlock);
  if (skillIndex) parts.push(skillIndex);

  return parts.join("\n\n");
}
