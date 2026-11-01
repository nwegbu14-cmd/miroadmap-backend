import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const GRID_PATTERN =
  "background-image:linear-gradient(rgba(255,255,255,.10) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.10) 1px,transparent 1px);background-size:48px 48px";
const LOGO_URL = "https://www.miroadmap.co/logo.png";

async function htmlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return htmlFiles(path);
      return entry.isFile() && entry.name.endsWith(".html") ? [path] : [];
    }),
  );
  return files.flat();
}

test("every static email template uses the canonical MiRoadmap grid and logo", async () => {
  const files = (
    await Promise.all([
      htmlFiles(join(process.cwd(), "supabase/templates")),
      htmlFiles(join(process.cwd(), "email-templates")),
    ])
  ).flat();

  assert.ok(files.length > 0, "expected email templates to audit");
  for (const file of files) {
    const html = await readFile(file, "utf8");
    assert.ok(html.includes(GRID_PATTERN), `${file} must use the canonical email grid`);
    assert.ok(html.includes(LOGO_URL), `${file} must use the canonical MiRoadmap logo`);
  }
});
