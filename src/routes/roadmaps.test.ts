import assert from "node:assert/strict";
import test from "node:test";
import { officialLinkData, type CreateRoadmapInput, type RoadmapTaskInput } from "../db/roadmaps.ts";
import { parseRoadmapInput } from "./roadmaps.ts";

function parseTaskLinks(links: unknown[], extra: Record<string, unknown> = {}): CreateRoadmapInput {
  const result = parseRoadmapInput({
    title: "Language test roadmap",
    shortDescription: "Get ready to book a test.",
    time: "1 week",
    category: "Education",
    steps: Array.from({ length: 3 }, (_, index) => ({
      title: `Step ${index + 1}`,
      checklist: [{ id: `task-${index + 1}`, title: "Book a test", links, assets: [] }],
    })),
    ...extra,
  });
  assert.notEqual(typeof result, "string");
  if (typeof result === "string") throw new Error(result);
  return result;
}

function firstTask(input: CreateRoadmapInput): RoadmapTaskInput {
  const task = input.steps[0]!.checklist[0]!;
  if (typeof task === "string") throw new Error("Expected a structured task");
  return task;
}

test("official links preserve legacy URLs and optional names in snapshots and resource rows", () => {
  const input = parseTaskLinks([
    " https://example.com/legacy ",
    { url: " https://example.com/ielts ", label: " Book IELTS " },
  ]);
  const snapshot = JSON.stringify(input);
  const restored: CreateRoadmapInput = JSON.parse(snapshot);
  assert.deepEqual(firstTask(restored).links, [
    "https://example.com/legacy",
    { url: "https://example.com/ielts", label: "Book IELTS" },
  ]);
  assert.deepEqual(firstTask(restored).links.map(officialLinkData), [
    { url: "https://example.com/legacy", label: "Official link" },
    { url: "https://example.com/ielts", label: "Book IELTS" },
  ]);
});

test("empty names remain optional and keep the legacy resource label", () => {
  const task = firstTask(parseTaskLinks([
    { url: "https://example.com", label: "   " },
    { url: "https://example.com/unnamed" },
  ]));
  assert.deepEqual(task.links, ["https://example.com", "https://example.com/unnamed"]);
  assert.equal(officialLinkData({ url: "https://example.com", label: "" }).label, "Official link");
});

test("names are capped at 160 characters and names cannot change URL validation", () => {
  const task = firstTask(parseTaskLinks([
    { url: "https://example.com", label: "A".repeat(200) },
    { url: "javascript:alert(1)", label: "Unsafe" },
    "data:text/html,unsafe",
    { url: "ftp://example.com", label: "Unsupported" },
    null,
    { label: "Missing URL" },
  ]));
  assert.deepEqual(task.links, [{ url: "https://example.com", label: "A".repeat(160) }]);
});

test("the existing twenty-link limit applies to mixed named and unnamed links", () => {
  const links = Array.from({ length: 25 }, (_, index) => index % 2
    ? { url: `https://example.com/${index}`, label: `Link ${index}` }
    : `https://example.com/${index}`);
  assert.equal(firstTask(parseTaskLinks(links)).links.length, 20);
});

test("verification evidence keeps safe image metadata and HTTP links", () => {
  const input = parseTaskLinks([], {
    requestVerification: true,
    verificationEvidence: [
      {
        kind: "image",
        name: " permit.png ",
        storagePath: "user-1/evidence.png",
        mimeType: "image/png",
        sizeBytes: 12_345,
      },
      { kind: "link", label: " Official result ", url: "https://example.com/result" },
      { kind: "link", label: "Unsafe", url: "javascript:alert(1)" },
    ],
  });

  assert.deepEqual(input.verificationEvidence, [
    {
      kind: "image",
      name: "permit.png",
      storagePath: "user-1/evidence.png",
      mimeType: "image/png",
      sizeBytes: 12_345,
    },
    { kind: "link", label: "Official result", url: "https://example.com/result" },
  ]);
});

test("verification evidence rejects oversized images and unsupported file types", () => {
  const input = parseTaskLinks([], {
    requestVerification: true,
    verificationEvidence: [
      { kind: "image", name: "large.png", storagePath: "user-1/large.png", mimeType: "image/png", sizeBytes: 4 * 1024 * 1024 },
      { kind: "image", name: "document.pdf", storagePath: "user-1/document.pdf", mimeType: "application/pdf", sizeBytes: 100 },
    ],
  });
  assert.deepEqual(input.verificationEvidence, []);
});

test("author-supplied xp is replaced by the platform reward for required and optional tasks", () => {
  const input = parseRoadmapInput({
    title: "XP clamp roadmap",
    shortDescription: "Rewards are platform-defined.",
    time: "1 week",
    category: "Education",
    steps: Array.from({ length: 3 }, (_, index) => ({
      title: `Step ${index + 1}`,
      checklist: [
        { title: "Required task", xp: 1000 },
        { title: "Optional task", required: false, xp: 900 },
      ],
    })),
  });
  if (typeof input === "string") throw new Error(input);
  const [required, optional] = input.steps[0]!.checklist as RoadmapTaskInput[];
  assert.equal(required!.xp, 10);
  assert.equal(optional!.xp, 5);
});
