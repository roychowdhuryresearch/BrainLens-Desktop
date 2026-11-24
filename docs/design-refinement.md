# Design refinement plan

The app works but feels **不精致 (unrefined)**. A designer's-eye audit (audit-only, on the
rendered `?visualFixture` workspace) found it is **not AI-slop** — no purple gradients, no
3-column feature grid, no centered-everything. The opposite: it's **under-systematized**. Each
surface was built to function without a shared system on top.

## Findings (measured on the rendered UI)

| Axis | Finding | Impact |
|---|---|---|
| Type scale | **20 distinct font sizes** from ~25 ad-hoc rem values (.62 .7 .72 .74 .76 .78 .8 .82 .84 .86 .88 .9 .92 .94 .95 .98 1 1.02 1.05 1.5rem). 141 `font-size` declarations. | HIGH — the dominant cause of "crude". |
| Hierarchy | Section/panel headers render at **weight 400**, ~1px above body. Headings do not anchor. | HIGH |
| Color | **89 distinct colors**. A `--lab-*` token set exists but is bypassed by scattered literals; 5 near-identical light grays. | MED-HIGH |
| Spacing | Packed rails, ~18px inputs, no consistent rhythm. | MED |
| Buttons | filled-blue vs outline vs ghost, inconsistent. | MED |
| Fonts | 1 sans + **2 different mono stacks**. | LOW |

Design score ~C+. AI-slop **A** (the good news).

## Target system

`--lab-*` (color), `--lab-radius`, `--lab-card-shadow` are already tokens. Extend the SAME root
(`src/styles/workspace/shared-clinical-theme.css :root`) with the missing axes:

- **Type scale** (one ramp): `--fs-2xs .6875rem / --fs-xs .75 / --fs-sm .8125 / --fs-base .875 /
  --fs-md 1 / --fs-lg 1.25 / --fs-xl 1.5`. Map the ~25 ad-hoc rem sizes to the nearest step.
- **Spacing**: evaluated and intentionally NOT tokenized — the rail/panel compact density is
  deliberate for a clinical quick-control tool, and the type-scale normalization already improved
  vertical rhythm. No speculative spacing tokens shipped.
- **Hierarchy**: section/eyebrow headers → weight 600 + `--fs-2xs`/`--fs-xs` with letter-spacing;
  card titles → weight 600 + `--fs-sm`/`--fs-base`.
- **Color**: collapse the 5 near-identical light grays to `--lab-canvas`/`--lab-panel-2`; route
  primary actions through one accent (`--lab-cobalt`).
- **Buttons**: a primary / secondary / tertiary recipe applied consistently.
- **Mono**: unify to the one `--ui-mono` stack.

## Application order (surfaces)

1. Tokens defined in `shared-clinical-theme.css :root`.
2. Type-scale sweep across `src/styles/workspace/*.css` (`font-size:<rem>` → `var(--fs-*)`).
3. Hierarchy on section headers (review rail `PIPELINE/DETECTION/...`, agent panel
   `AGENT/INTENT PREVIEW/...`, prepare/QC headings).
4. Color consolidation (grays → tokens; primary accent).
5. Spacing/density on the review rail + prepare/detect/classify panels.
6. Button hierarchy.

## Guardrails

- UI text stays **English**.
- `desktop/tests/source-contract.test.js` pins exact CSS owner strings — update pins if a pinned
  rule changes; keep `npm test` (142) green.
- `qa:geometry` must show no NEW overlap errors.
- Verify visually before/after with `desktop/artifacts/design-capture.mjs` (vite :5191 +
  `?visualFixture`); re-extract font/color counts each step.
