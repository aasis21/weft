import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = resolve(root, "docs");
const html = readFileSync(resolve(docs, "index.html"), "utf8");
const document = new JSDOM(html).window.document;

test("documentation is readable static HTML with accessible landmarks and navigation", () => {
  assert.equal(document.documentElement.lang, "en");
  assert.equal(document.querySelectorAll("main").length, 1);
  assert.equal(document.querySelectorAll("h1").length, 1);
  assert.equal(document.querySelector(".skip-link").hash, "#main");
  assert.ok(document.querySelector('details[open] > summary'));
  assert.ok(document.querySelector('nav[aria-label="Documentation"]'));
  for (const section of document.querySelectorAll("main > section")) {
    const heading = document.getElementById(section.getAttribute("aria-labelledby"));
    assert.ok(heading && section.contains(heading), `Section ${section.id} needs its heading`);
    assert.ok(document.querySelector(`nav a[href="#${section.id}"]`), `Section ${section.id} needs navigation`);
  }
  for (const heading of document.querySelectorAll("h2, h3")) {
    assert.ok(heading.querySelector('a[href^="#"]'), `Heading needs permalink: ${heading.textContent}`);
  }
  for (const table of document.querySelectorAll("table")) {
    assert.ok(table.querySelector('thead th[scope="col"]'));
    assert.ok(table.closest('[role="region"][aria-label][tabindex="0"]'));
  }
  for (const codeBlock of document.querySelectorAll("pre")) {
    assert.ok(codeBlock.matches('[role="region"][aria-label][tabindex="0"]'), "Code scroll areas need keyboard access");
  }
});

test("all fragment targets, local assets, and repository reference links exist", () => {
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length, "Duplicate IDs break deep links");
  for (const element of document.querySelectorAll("[href], [src]")) {
    const target = element.getAttribute("href") ?? element.getAttribute("src");
    if (target.startsWith("#")) {
      assert.ok(ids.includes(target.slice(1)), `Missing anchor: ${target}`);
    } else if (!/^https:/.test(target)) {
      assert.ok(existsSync(resolve(docs, target)), `Missing local asset: ${target}`);
      assert.ok(!target.endsWith(".md"), `Site must not send readers to raw Markdown: ${target}`);
    } else if (target.startsWith("https://github.com/aasis21/weft/blob/main/")) {
      assert.ok(existsSync(resolve(root, target.split("/blob/main/")[1])), `Missing reference: ${target}`);
    }
  }
  for (const id of ["install", "advanced", "what", "action", "architecture", "commands"]) {
    assert.ok(ids.includes(id), `Preserve legacy anchor #${id}`);
  }
  for (const image of document.querySelectorAll("img")) assert.ok(image.alt.trim());
});

test("handbook includes operating-system setup, recovery, limitations, and all technical guides", () => {
  const content = document.querySelector("main").textContent;
  for (const required of [
    "Windows", "macOS", "Linux", "Node.js 20", "weft start --new-device",
    "weft update --check", "weft show-transport", "10 minutes", "previously trusted",
    "service-role key", "namespace", "private keys", "metadata", "does not currently publish",
  ]) assert.ok(content.includes(required), `Missing essential documentation: ${required}`);
  assert.ok(document.querySelector('a[href="https://useweft.netlify.app"]'));
  for (const guide of ["setup", "advanced", "pairing", "hosting", "security", "releases", "mode-switching", "event-envelope"]) {
    assert.ok(document.querySelector(`#guides a[href="https://github.com/aasis21/weft/blob/main/docs/${guide}.md"]`));
    assert.match(readFileSync(resolve(docs, `${guide}.md`), "utf8"), /https:\/\/aasis21\.github\.io\/weft\/#/);
  }
});

test("documentation runs locally without remote scripts, styles, fonts, or Markdown fetching", () => {
  assert.deepEqual([...document.querySelectorAll("script")].map((script) => script.getAttribute("src")), ["docs-theme.js", "docs.js"]);
  assert.equal(document.querySelector('link[rel="stylesheet"]').getAttribute("href"), "docs.css");
  const js = readFileSync(resolve(docs, "docs.js"), "utf8");
  const css = readFileSync(resolve(docs, "docs.css"), "utf8");
  assert.doesNotMatch(js, /\b(fetch|XMLHttpRequest|localStorage|sessionStorage|eval)\b/);
  assert.doesNotMatch(css, /@import|https?:/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media print/);
  assert.ok(document.querySelector('select[aria-label="Theme"]'));
});
