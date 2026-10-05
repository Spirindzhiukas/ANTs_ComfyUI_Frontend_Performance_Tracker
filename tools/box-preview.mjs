#!/usr/bin/env node
// Renders what a flat box looks like at each box-detail level, by drawing the
// *real* paint code (web/tracker.js `lodPaintNode`, reached through the same
// `drawNode` wrapper ComfyUI uses) into a recording canvas and turning the
// recorded operations into SVG.
//
//   node tools/box-preview.mjs        > preview/boxes.html
//   node tools/box-preview.mjs --svg  > preview/boxes.svg
//
// Why: the whole point of the box-detail ladder is what it looks like. This page
// records the tracker's real paint operations — rectangles and canvas paths — in
// graph units, with the fill, alpha, stroke and width they were issued with. The
// path recorder includes the live fallback box's amber triangle, dark border and bolt.
// What is *not* real is the surrounding graph: LiteGraph's own node rendering
// (title text, sockets, widgets) is not reproduced, so the preview shows the
// tracker's stand-in drawing rather than the full node.
//
// The picture is drawn in graph units and magnified so it can be read at all:
// at 10% zoom — the zoom this mode exists for — a 200x100 node is 20x10 pixels on
// screen. The captions say the magnification rather than pretending to be 1:1.

import { readFileSync } from "node:fs";
import { createHarness, FRAME_MS } from "../tests/harness.mjs";

const SRC = readFileSync(new URL("../web/tracker.js", import.meta.url), "utf8");

function die(msg) {
  console.error(`box-preview: ${msg}`);
  process.exit(1);
}

// A const out of web/tracker.js, by name. Used for the snapshot capture geometry:
// a picture of the code's own numbers cannot drift from the code.
function srcConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = ([-0-9.]+);`, "m"));
  if (!m) die(`could not find const ${name} in web/tracker.js`);
  return Number(m[1]);
}

const h = createHarness();
for (const ext of h.app.extensions) if (ext.setup) await ext.setup();
await h.flush();

const ZOOM = 0.1; // the zoom this mode exists for: 200x100 graph units -> 20x10 css px
h.canvas.ds.scale = ZOOM;
h.canvas.ds.offset[0] = 0;
h.canvas.ds.offset[1] = 0;
h.canvas.links = [];
h.tracker.lowZoom.set({ flatBelow: 0.2, idleCapMs: 0, boxDetail: "plain" });

// One node per thing a box can now say. `color` is the node's own title-bar
// colour (LiteGraph's `renderingColor`), which is what the `title` level uses.
const NODES = [
  { label: "healthy", fields: {} },
  { label: "has_errors: true", fields: { has_errors: true } },
  { label: "progress: 0.4", fields: { progress: 0.4 } },
  { label: "mode: 2 (muted)", fields: { mode: 2 } },
  { label: "mode: 4 (bypassed)", fields: { mode: 4 } },
  { label: "ghost + selected", fields: { flags: { ghost: true }, selected: true } },
];
const COLORS = ["#4a6f8f", "#8f4a4a", "#4a8f6f", "#6f6f6f", "#6f6f3f", "#8f4a8f"];
const SIZE = [200, 100]; // graph units — 20x10 css px at 10% zoom
const GAP_X = 40;
const GAP_Y = 70; // room for the title bar, which is drawn above the body

function buildNodes() {
  h.canvas.nodes = NODES.map((n, i) => {
    const node = {
      type: "KSampler",
      pos: [i * (SIZE[0] + GAP_X), 0],
      size: SIZE.slice(),
      selected: false,
      color: COLORS[i],
      bgcolor: "#2b2b2b",
    };
    Object.assign(node, n.fields);
    return node;
  });
  h.app.graph._nodes = h.canvas.nodes;
  return h.canvas.nodes;
}

// Record what the real paint issued, with the context state it issued it in.
// The canvas the tracker paints on is the harness's stub context, so this wraps
// the same object the wrapper calls.
function recordNode(canvas, node) {
  const ctx = canvas.ctx;
  const ops = [];
  const names = ["fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "closePath", "stroke", "fill", "bezierCurveTo", "arc", "drawImage"];
  const real = {};
  for (const name of names) {
    real[name] = ctx[name];
    ctx[name] = function (...args) {
      ops.push({
        name,
        args,
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineJoin: this.lineJoin,
        globalAlpha: this.globalAlpha,
      });
      return real[name].apply(this, args);
    };
  }
  canvas.drawNode(node, ctx);
  for (const name of names) ctx[name] = real[name];
  return ops;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v) => Math.round(Number(v) * 1000) / 1000;
const alphaAttr = (a) => (Number(a) >= 1 ? "" : ` opacity="${num(a)}"`);

// One node's ops -> SVG, translated to where the node sits (the flat path draws
// in node-local coordinates, exactly as LiteGraph's own drawNode does). Rectangles
// stay rectangles; path operations preserve the warning badge's actual triangle,
// dark outline and lightning bolt.
function opsToSvg(ops, x, y, scale, notes) {
  const parts = [`<g transform="translate(${num(x * scale)} ${num(y * scale)})">`];
  let path = [];
  const emitPath = (mode, op) => {
    if (!path.length) return;
    const d = path.join(" ");
    const fill = mode === "fill" ? esc(op.fillStyle || "none") : "none";
    const stroke = mode === "stroke" ? esc(op.strokeStyle || "none") : "none";
    const strokeWidth = mode === "stroke" ? num(op.lineWidth * scale) : 0;
    const join = mode === "stroke" && op.lineJoin ? ` stroke-linejoin="${esc(op.lineJoin)}"` : "";
    parts.push(
      `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${join}${alphaAttr(op.globalAlpha)}/>`
    );
    notes.push(`${mode} path (${mode === "fill" ? op.fillStyle : op.strokeStyle})`);
  };
  for (const op of ops) {
    const a = op.args.map(Number);
    if (op.name === "beginPath") {
      path = [];
    } else if (op.name === "moveTo" || op.name === "lineTo") {
      const cmd = op.name === "moveTo" ? "M" : "L";
      path.push(`${cmd} ${num(a[0] * scale)} ${num(a[1] * scale)}`);
    } else if (op.name === "closePath") {
      path.push("Z");
    } else if (op.name === "fill" || op.name === "stroke") {
      emitPath(op.name, op);
    } else if (op.name === "fillRect") {
      parts.push(
        `<rect x="${num(a[0] * scale)}" y="${num(a[1] * scale)}" width="${num(a[2] * scale)}" height="${num(a[3] * scale)}" ` +
          `fill="${esc(op.fillStyle)}"${alphaAttr(op.globalAlpha)}/>`
      );
      notes.push(`fillRect ${num(a[2])}x${num(a[3])} at y=${num(a[1])} ${op.fillStyle}`);
    } else if (op.name === "strokeRect") {
      parts.push(
        `<rect x="${num(a[0] * scale)}" y="${num(a[1] * scale)}" width="${num(a[2] * scale)}" height="${num(a[3] * scale)}" ` +
          `fill="none" stroke="${esc(op.strokeStyle)}" stroke-width="${num(op.lineWidth * scale)}"${alphaAttr(op.globalAlpha)}/>`
      );
      notes.push(`strokeRect ${op.strokeStyle} ${num(op.lineWidth)}u wide at (${num(a[0])}, ${num(a[1])})`);
    }
  }
  parts.push("</g>");
  return { svg: parts.join(""), notes };
}

const LEVELS = ["plain", "title", "state"];
const panels = [];
for (const level of LEVELS) {
  h.tracker.lowZoom.set({ boxDetail: level });
  const nodes = buildNodes();
  h.canvas.ctx.ops.length = 0;
  h.advance(FRAME_MS);
  h.canvas.setDirty(true, true);
  const before = { ...h.tracker.lowZoom.flat };
  h.canvas.draw(); // the real frame the panel's counters read
  const after = { ...h.tracker.lowZoom.flat };
  // The counters are cumulative across the run (as they are in the panel), so a
  // level's own marks are the difference this frame made.
  const counters = {
    boxTitles: after.boxTitles - before.boxTitles,
    boxErrors: after.boxErrors - before.boxErrors,
    boxBars: after.boxBars - before.boxBars,
    boxMuted: after.boxMuted - before.boxMuted,
  };
  const pieces = [];
  for (const node of nodes) {
    const notes = [];
    const ops = recordNode(h.canvas, node);
    const drawn = opsToSvg(ops, node.pos[0], -70, 1, notes);
    pieces.push(drawn.svg);
    if (level === "plain") {
      const fills = ops.filter((o) => o.name === "fillRect").length;
      if (fills !== 1) die(`a plain box must be one rectangle, saw ${fills} for ${node.type}`);
    }
  }
  const marks =
    counters.boxTitles + counters.boxErrors + counters.boxBars + counters.boxMuted;
  if (level === "plain" && marks !== 0) die(`plain drew ${marks} mark(s) — it must draw none`);
  if (level === "title" && counters.boxTitles === 0) die("title drew no title bars");
  if (level === "state" && (counters.boxErrors === 0 || counters.boxBars === 0 || counters.boxMuted === 0)) {
    die("state did not draw every kind of mark this scenario asks for");
  }
  panels.push({ level, pieces, counts: counters, notes: marks });
}

// The SVG: one row per level, drawn in graph units and magnified so the marks can
// be seen at all. The captions name what each row adds; the fonts are the ones
// that exist on the machine that renders this (a headless renderer with no
// "system-ui" would print nothing at all).
const MAG = Number(process.env.MAG || 1.6);
const MARGIN = 16;
const CAPTION_H = 46; // two lines of caption per row
const HEADROOM = 44; // graph units above the body: 30 for the title bar, 12 for the error ring
const LABEL_H = 24;
const UNITS_W = NODES.length * (SIZE[0] + GAP_X) - GAP_X;
const ROW_H = CAPTION_H + (HEADROOM + SIZE[1] + LABEL_H / MAG) * MAG + MARGIN;
const W = MARGIN * 2 + UNITS_W * MAG;
const SCHEMATIC_H = 210; // the capture-geometry row below the three real ones
const H = MARGIN + LEVELS.length * ROW_H + SCHEMATIC_H;
const SANS = "DejaVu Sans, Verdana, Geneva, ui-sans-serif, system-ui, sans-serif";
const MONO = "DejaVu Sans Mono, Menlo, Consolas, ui-monospace, monospace";

const legend = {
  plain: "plain — one fill rectangle per node, plus the selection ring and live-fallback warning badge",
  title: "title — + the node's own title-bar colour, above the body, at LiteGraph's 30-unit title height",
  state:
    "state — + the frontend's own marks: error stroke (#E00, 10 units wide, 12 units out), the green progress bar, " +
    "and its own dimming for a muted (0.4), bypassed (0.2) or ghosted (0.3) node",
};

const svgParts = [];
svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${num(W)}" height="${num(H)}" viewBox="0 0 ${num(W)} ${num(H)}">`);
svgParts.push(`<rect width="100%" height="100%" fill="#141416"/>`);
LEVELS.forEach((level, row) => {
  const panel = panels.find((p) => p.level === level);
  const y0 = MARGIN + row * ROW_H;
  const bodyY = y0 + CAPTION_H + HEADROOM * MAG;
  svgParts.push(
    `<text x="${MARGIN}" y="${num(y0 + 16)}" fill="#e8e8ea" font-family="${SANS}" font-size="14">${esc(legend[level])}</text>`
  );
  svgParts.push(
    `<text x="${MARGIN}" y="${num(y0 + 34)}" fill="#9a9aa2" font-family="${SANS}" font-size="11">` +
      `marks this frame of ${NODES.length} boxes: ${panel.counts.boxTitles} title, ${panel.counts.boxErrors} error ring, ` +
      `${panel.counts.boxBars} progress, ${panel.counts.boxMuted} dimmed · drawn ${MAG}x, and each box is ` +
      `${num(SIZE[0] * ZOOM)}x${num(SIZE[1] * ZOOM)} css px at this ${Math.round(ZOOM * 100)}% zoom</text>`
  );
  svgParts.push(`<g transform="translate(${MARGIN} ${num(bodyY)})">`);
  svgParts.push(panel.pieces.join(""));
  svgParts.push(`</g>`);
  NODES.forEach((n, i) => {
    const cx = MARGIN + (i * (SIZE[0] + GAP_X) + SIZE[0] / 2) * MAG;
    svgParts.push(
      `<text x="${num(cx)}" y="${num(bodyY + SIZE[1] * MAG + 16)}" text-anchor="middle" fill="#9a9aa2" ` +
        `font-family="${MONO}" font-size="10">${esc(n.label)}</text>`
    );
  });
});
// ---------------------------------------------------------- the schematic ---
// One more picture, and the only one that is not a recording: the *extent* of a
// node snapshot. It has to be drawn by hand because the harness's canvas has no
// pixels — a capture there is a list of operations, not an image — and the
// rectangle a bitmap covers is worth seeing: it is what decides whether a node's
// title bar, its error stroke and a hook that draws outside the body survive.
{
  const PAD = srcConst("LOD_SNAP_PAD");
  const TITLE = srcConst("LOD_SNAP_TITLE_H");
  const sample = { w: 200, h: 100 };
  const y0 = MARGIN + LEVELS.length * ROW_H;
  const bodyY = y0 + CAPTION_H + (TITLE + PAD) * MAG;
  const bx = MARGIN + PAD * MAG;
  const w = sample.w * MAG;
  const h = sample.h * MAG;
  const t = TITLE * MAG;
  const p = PAD * MAG;
  svgParts.push(
    `<text x="${MARGIN}" y="${num(y0 + 16)}" fill="#e8e8ea" font-family="${SANS}" font-size="14">` +
      `what a snapshot covers — the dashed rect is the bitmap: the body, LiteGraph's ${TITLE}-unit title bar above it, and ${PAD} units of ` +
      `padding on every side</text>`
  );
  svgParts.push(
    `<text x="${MARGIN}" y="${num(y0 + 34)}" fill="#9a9aa2" font-family="${SANS}" font-size="11">` +
      `drawn to scale, in graph units. The padding is what keeps the frontend's own error stroke (12 units outside the node, 10 wide) inside ` +
      `the picture; a capture that covered only the body would clip it</text>`
  );
  // the capture rect
  svgParts.push(
    `<rect x="${num(bx - p)}" y="${num(bodyY - t - p)}" width="${num(w + 2 * p)}" height="${num(h + t + 2 * p)}" fill="none" ` +
      `stroke="#AE7719" stroke-width="1.5" stroke-dasharray="6 5"/>`
  );
  // the body and the title bar the node itself paints
  svgParts.push(`<rect x="${num(bx)}" y="${num(bodyY)}" width="${num(w)}" height="${num(h)}" fill="#3a3a40"/>`);
  svgParts.push(`<rect x="${num(bx)}" y="${num(bodyY - t)}" width="${num(w)}" height="${num(t)}" fill="#4a6f8f"/>`);
  // the frontend's error stroke, where it lands relative to the capture rect
  svgParts.push(
    `<rect x="${num(bx - 12 * MAG)}" y="${num(bodyY - 12 * MAG)}" width="${num(w + 24 * MAG)}" height="${num(h + 24 * MAG)}" fill="none" ` +
      `stroke="#E00" stroke-width="${num(10 * MAG)}"/>`
  );
  const cap = (x, y, text, anchor) =>
    `<text x="${num(x)}" y="${num(y)}" text-anchor="${anchor || "start"}" fill="#9a9aa2" font-family="${MONO}" font-size="10">${esc(text)}</text>`;
  svgParts.push(cap(bx + w / 2, bodyY + h / 2 + 4, "the node's own drawing", "middle"));
  svgParts.push(cap(bx + w + p + 6, bodyY - t - p + 12, `padding ${PAD}`));
  svgParts.push(cap(bx + w + p + 6, bodyY - t / 2 + 4, `title bar (${TITLE})`));
  svgParts.push(cap(bx - 12 * MAG - 6, bodyY + h + 12 * MAG + 16, "error stroke: 10 wide, 12 out — inside the picture", "end"));
}

svgParts.push(`</svg>`);
const svg = svgParts.join("\n");

if (process.argv.includes("--svg")) {
  process.stdout.write(svg + "\n");
} else {
  process.stdout.write(`<!doctype html>
<meta charset="utf-8">
<title>ANTs tracker — flat boxes, by box-detail level</title>
<style>
  body { margin: 0; background: #141416; color: #e8e8ea; font: 14px ui-sans-serif, system-ui; }
  p.note { max-width: 980px; margin: 16px; color: #9a9aa2; }
  code { color: #d8d8dc; }
</style>
<h2 style="margin:16px">Flat boxes, by box-detail level</h2>
<p class="note">The setting is <code>box detail</code> in the Tweaks tab, or
<code>window.__antsTracker.lowZoom.set({ boxDetail: "title" })</code>. Every rectangle and canvas path below is an
operation the real paint path (<code>lodPaintNode</code>) issued, recorded from the harness canvas and
replayed as SVG, in graph units, at the same numbers the code uses. That includes each live fallback box's
warning badge (amber triangle, dark outline and bolt); the badge is not part of stored pictures. LiteGraph's
own node drawing (title text, sockets, widgets) is not reproduced — that is the drawing the flat path replaces. At
${Math.round(ZOOM * 100)}% zoom each box is ${num(SIZE[0] * ZOOM)}&times;${num(SIZE[1] * ZOOM)} css pixels on screen, so the picture is magnified ${MAG}&times;.</p>
${svg}
`);
}

const summary = panels
  .map((p) => `${p.level}: ${p.counts.boxTitles} title / ${p.counts.boxErrors} ring / ${p.counts.boxBars} bar / ${p.counts.boxMuted} dimmed`)
  .join(" · ");
console.error(`box-preview: ${NODES.length} boxes per level at zoom ${ZOOM}, magnified ${MAG}x — ${summary}`);
