import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderBrandedEmail } from "./email.ts";

process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.FRONTEND_URL ??= "https://miroadmap.co";
process.env.PUBLIC_SITE_URL ??= "https://miroadmap.co";
process.env.MAIL_POSTAL_ADDRESS ??= "123 Example Street, Toronto, ON, Canada";

test("email HTML escapes user-controlled content and contains a plain-text alternative", () => {
  const rendered = renderBrandedEmail({
    preheader: "A <safe> preview",
    badge: "Support",
    title: "Hello <script>",
    paragraphs: ["A user said: <img src=x onerror=alert(1)>"],
    facts: [["Ticket", "<123>"]],
    cta: { label: "View & respond", url: "https://miroadmap.co/support?a=1&b=2" },
  });

  assert.ok(!rendered.html.includes("<script>"));
  assert.ok(!rendered.html.includes("<img src=x"));
  assert.match(rendered.html, /Hello &lt;script&gt;/);
  assert.match(rendered.html, /View &amp; respond/);
  assert.match(rendered.html, /background-size:48px 48px/);
  assert.match(rendered.html, /https:\/\/www\.miroadmap\.co\/logo\.png/);
  assert.match(rendered.text, /Hello <script>/);
  assert.match(rendered.text, /Contact support:/);
});

test("marketing mail includes unsubscribe and sender-address fields", () => {
  const rendered = renderBrandedEmail({
    preheader: "Newsletter",
    badge: "Newsletter",
    title: "This month at MiRoadmap",
    paragraphs: ["Useful updates."],
    kind: "marketing",
    unsubscribeUrl: "https://miroadmap.co/newsletter/unsubscribe?token=test",
  });

  assert.match(rendered.html, /Unsubscribe/);
  assert.match(rendered.text, /Unsubscribe: https:\/\/miroadmap\.co/);
});

test("HTML escaping covers attribute-significant characters", () => {
  assert.equal(escapeHtml(`<&>\"'`), "&lt;&amp;&gt;&quot;&#39;");
});
