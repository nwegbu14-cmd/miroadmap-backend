import assert from "node:assert/strict";
import test from "node:test";

import { parseRoadmapAiOutput } from "./roadmap-ai.ts";

test("parses a structured roadmap change response", () => {
  const output = parseRoadmapAiOutput({
    assistantMessage: "I found one useful adjustment.",
    scenarioSummary: "Moving to Alberta.",
    requiresClarification: false,
    safetyStatus: "SAFE",
    suggestions: [{
      operation: "UPDATE",
      stepPosition: 2,
      taskPosition: 1,
      title: "Check the Alberta-specific requirements",
      required: true,
      xp: 10,
      rationale: "The original task targets Ontario.",
    }],
  });

  assert.equal(output.suggestions[0]?.operation, "UPDATE");
  assert.equal(output.suggestions[0]?.stepPosition, 2);
});

test("rejects an add suggestion that points at an existing task", () => {
  assert.throws(() => parseRoadmapAiOutput({
    assistantMessage: "Add this task.",
    scenarioSummary: "",
    requiresClarification: false,
    safetyStatus: "SAFE",
    suggestions: [{
      operation: "ADD",
      stepPosition: 1,
      taskPosition: 2,
      title: "New task",
      required: true,
      xp: 10,
      rationale: "Useful.",
    }],
  }), /task position/);
});

test("rejects a response without an explicit safety decision", () => {
  assert.throws(() => parseRoadmapAiOutput({
    assistantMessage: "I found one useful adjustment.",
    scenarioSummary: "",
    requiresClarification: false,
    suggestions: [],
  }), /safety status/);
});
