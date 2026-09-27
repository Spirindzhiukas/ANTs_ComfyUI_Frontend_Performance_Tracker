#!/usr/bin/env node
// Renders the tracker node's pill (the switch + the gear) into a standalone HTML
// page, using the *real* glyph code and the *real* CSS out of web/tracker.js.
//
// Why: the pill's specification is geometric — "both round, same radius, both
// #AE7719, unchecked means no fill" — and nothing in the test suite can look at it.
// This page can, drawn by the same code that draws it in ComfyUI; the only
// difference is that here the pill sits on plain backgrounds instead of on the
// frontend's node header.
//
//   node tools/pill-preview.mjs > preview/pill.html
//
// It is generated, never hand-edited: if the extraction stops matching (the code
// moved, a function was renamed) it exits non-zero rather than printing a page that
// silently disagrees with the extension.

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../web/tracker.js", import.meta.url), "utf8");

function die(msg) {
  console.error(`pill-preview: ${msg}`);
  process.exit(1);
}

// A slice of tracker.js from `needle` to the close brace matching the first `{`
// after it. Braces inside strings are ignored, which is sound for the three
// builders this is used on (their strings hold no braces).
function sliceFunction(needle) {
  const at = src.indexOf(needle);
  if (at < 0) die(`could not find ${needle} in web/tracker.js`);
  let depth = 0;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  return die(`unbalanced braces reading ${needle}`);
}

function sliceConst(name) {
  const m = src.match(new RegExp(`^const ${name} = .*?;`, "m"));
  if (!m) die(`could not find const ${name} in web/tracker.js`);
  return m[0];
}

const constLines = ["ANTS_ACCENT", "ANTS_SWITCH_FILL", "ANTS_GLYPH_LINE", "ANTS_GLYPH_BOX", "ANTS_GLYPH_R"].map(sliceConst);
const value = (name) => {
  const m = constLines.find((l) => l.startsWith(`const ${name} = `)).match(/= (.*?);/);
  return JSON.parse(m[1]);
};

// The pill's CSS: everything from the first rule that makes it a pill through the
// last rule that talks about the two controls.
const cssStart = src.indexOf(".ants-node-pill {");
const cssEndAt = src.indexOf('.ants-node-btn-tick[aria-checked="true"]:hover');
if (cssStart < 0 || cssEndAt < 0) die("could not find the pill CSS in web/tracker.js");
const pillCss = src.slice(cssStart, src.indexOf("}", src.indexOf("{", cssEndAt)) + 1);

// A DOM just rich enough for the glyph builders: elements with attributes, one
// string of inner markup, and children that serialize.
function element(tag) {
  const attrs = [];
  const node = {
    tag,
    children: [],
    text: "",
    setAttribute(k, v) {
      attrs.push([k, String(v)]);
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    set innerHTML(v) {
      node.text = String(v);
    },
    get innerHTML() {
      return node.text;
    },
    get outerHTML() {
      const a = attrs.map(([k, v]) => ` ${k}="${v}"`).join("");
      return `<${tag}${a}>${node.text}${node.children.map((c) => c.outerHTML).join("")}</${tag}>`;
    },
  };
  return node;
}

const builders = new Function(
  "document",
  `${constLines.join("\n")}
${sliceFunction("function antsSvg")}
${sliceFunction("function antsGearSvg")}
${sliceFunction("function antsCheckSvg")}
return { gear: antsGearSvg(), check: antsCheckSvg() };`
)({ createElementNS: (_ns, tag) => element(tag) });

if (!builders.gear || !builders.check) die("the glyph builders returned nothing");
const { gear, check } = builders;

const switchFill = value("ANTS_SWITCH_FILL");
const accent = value("ANTS_ACCENT");
const line = value("ANTS_GLYPH_LINE");

// One pill, in the state asked for. The inline background is what the extension's
// own sync() writes while the tool is on; the CSS covers the checked state too.
const pill = (on) =>
  `<div class="ants-node-pill ants-own">
      <button class="ants-node-btn ants-node-btn-tick" type="button" role="checkbox" aria-checked="${on}"
              ${on ? `style="background: ${switchFill}" ` : ""}title="${on ? "on" : "off"}">${check.outerHTML}</button>
      <button class="ants-node-btn ants-node-btn-gear" type="button" title="gear">${gear.outerHTML}</button>
  </div>`;

process.stdout.write(`<!doctype html>
<meta charset="utf-8">
<title>ANTs Tracker — the node's pill</title>
<style>
  body { margin: 0; padding: 28px 32px 44px; background: #1e1e1e; color: #d8d8dd;
         font: 14px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p  { margin: 0 0 8px; color: #9a9aa4; max-width: 78ch; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #9a9aa4;
       margin: 34px 0 12px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
  .zoom4 { zoom: 4; } .zoom2 { zoom: 2; }
  .panel { background: #2b2b2b; border-radius: 8px; padding: 12px 14px; display: inline-block; }
  .dark  { background: #141414; border-radius: 8px; padding: 12px 14px; display: inline-block; }
  code { background: #2b2b2b; border-radius: 4px; padding: 1px 5px; font-size: 12px; }
  .facts { color: #9a9aa4; font-size: 13px; }
  .facts b { color: #d8d8dd; font-weight: 600; }
${pillCss}
</style>
<h1>The tracker node's pill</h1>
<p>Generated by <code>tools/pill-preview.mjs</code> from the real CSS and the real SVG builders in
<code>web/tracker.js</code> — the same code that draws it on the node. Left: the switch (off, then on).
Right: the gear. Hover either control.</p>
<p class="facts">One line weight for both: <b>${line}px</b>. Accent: <b>${accent}</b>, on the ring, the
checkmark and the gear's silhouette. Checked interior: <b>${switchFill}</b>; unchecked, nothing of ours is
painted inside the ring, so the theme shows through.</p>

<h2>4x — the geometry</h2>
<div class="row">
  <div class="zoom4">${pill(false)}</div>
  <div class="zoom4">${pill(true)}</div>
  <div class="zoom4"><div class="ants-node-pill ants-own">
      <button class="ants-node-btn ants-node-btn-tick" role="checkbox" aria-checked="false">${check.outerHTML}</button>
      <button class="ants-node-btn ants-node-btn-gear">${gear.outerHTML}</button>
  </div></div>
</div>

<h2>2x — on a node-header background and on a black one</h2>
<div class="row">
  <div class="zoom2"><div class="panel">${pill(false)}</div></div>
  <div class="zoom2"><div class="panel">${pill(true)}</div></div>
  <div class="zoom2"><div class="dark">${pill(false)}</div></div>
  <div class="zoom2"><div class="dark">${pill(true)}</div></div>
</div>

<h2>1x — the size it actually is</h2>
<div class="row">
  <div class="panel">${pill(false)}</div>
  <div class="panel">${pill(true)}</div>
  <div class="dark">${pill(false)}</div>
  <div class="dark">${pill(true)}</div>
  <div>${pill(true)}${pill(false)}</div>
</div>
`);

console.error(`pill-preview: wrote a page using ${pillCss.split("\n").length} lines of CSS from web/tracker.js`);
