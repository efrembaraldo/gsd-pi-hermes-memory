import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptContext } from "../../src/prompt-context.js";
import { MEMORY_POLICY_PROMPT } from "../../src/constants.js";

describe("buildPromptContext", () => {
  const store = {
    formatForSystemPrompt: () => "<memory-context>MEMORY</memory-context>",
  } as any;

  const projectStore = {
    formatProjectBlock: (projectName: string) => `<memory-context>PROJECT ${projectName}</memory-context>`,
  } as any;

  const skillStore = {
    formatIndexForSystemPrompt: async () => "<memory-context>SKILLS</memory-context>",
  } as any;

  it("returns policy only in policy-only mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "policy-only" },
      store,
      projectStore,
      skillStore,
      "demo",
    );

    assert.strictEqual(result, MEMORY_POLICY_PROMPT);
    assert.match(result, /memory_search/);
    assert.match(result, /Accepted memory categories/);
    assert.match(result, /category filters categorized failure\/lesson memories only/);
    assert.match(result, /Use category only for categorized failure\/lesson searches/);
    assert.match(result, /session_search: search indexed past conversation messages/);
    assert.match(result, /skill: list, view, create, patch, edit, and delete procedural skills/);
    assert.doesNotMatch(result, /category="preference"/);
    assert.doesNotMatch(result, /inspect, and update procedural skills/);
    assert.doesNotMatch(result, /memory_search: search relevant user, project, session, failure, and skill memories/);
    assert.doesNotMatch(result, /MEMORY<\/memory-context>/);
    assert.doesNotMatch(result, /PROJECT demo/);
    assert.doesNotMatch(result, /SKILLS/);
  });

  it("returns legacy memory blocks in legacy-inject mode", async () => {
    const result = await buildPromptContext(
      { memoryMode: "legacy-inject" },
      store,
      projectStore,
      skillStore,
      "demo",
    );

    assert.match(result, /MEMORY/);
    assert.match(result, /PROJECT demo/);
    assert.match(result, /SKILLS/);
    assert.doesNotMatch(result, /<memory-policy>/);
  });
});
