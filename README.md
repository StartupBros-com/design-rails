# design-rails

**Guardrails that keep AI agents on YOUR design.**

Your AI agents ship UI every day. Left alone, they hardcode colors, invent font
sizes, and quietly erode whatever design system you had — one plausible-looking
PR at a time. Everything else in this space either writes a DESIGN.md for you or
lints the one you wrote. **design-rails runs the whole loop against your actual
codebase** — and keeps it true after you leave.

```
npx design-rails posture .
```

```
apps/web
  ✓ exists    design/DESIGN.md
  ✓ valid     frontmatter carries colour tokens
  ✗ wired     agent instructions never mention design/DESIGN.md — the file is inert
  · followed  raw colours 98, palette utilities 1370 — the trend migrations move
  ✓ enforced  CI runs the scanner with budgets
```

Five verbs, one loop:

| Verb | What it does |
| --- | --- |
| `posture` | Five pass/fail checks per app: does a real, agent-wired, CI-enforced design system exist at the right scope? Workspace-aware; a monorepo-root blend counts as missing. |
| `scan` | Measures drift — raw color literals, one-off Tailwind values, raw palette utilities, missing scales, near-duplicate colors, unresolved tokens — and reads what your theme files *declare* (content-detected theme files, `oklch()`, dark-mode systems, alias resolution). Per-detector CI budgets: `--fail-on=color=2354,palette=3116`. |
| `propose` | Authors a [Google-spec DESIGN.md](https://github.com/google-labs-code/design.md) + DTCG tokens **from your own code** — declared tokens win by name, residual literals fill gaps weighted by shipped use. Refuses to blend a multi-app workspace into one system nobody owns. |
| `decide` | Renders open taste decisions (is that purple your brand or a chart library's default?) as visual HTML pages — options side by side on your real canvas — and records your choice. |
| `tighten` | The one-way ratchet: lowers CI budgets to current actuals after each cleanup, and refuses to absorb an increase. |

## Why trust it

Every claim below is dated and was produced by running, not asserting:

- **4/4 public-repo validation** (2026-08-07): systems derived for shadcn-ui/taxonomy,
  calcom/cal.com, excalidraw/excalidraw and outline/outline each agreed with the
  repo's *own declared tokens*, verified per role at the declaring `file:line` —
  including bare-HSL shadcn themes, a 5,000-file monorepo with competing token
  sets, SCSS custom properties, and a styled-components theme reachable only
  through reference resolution.
- **Controlled adherence experiment** (2026-08-08, 3v3): agents building the same
  component with and without a wired DESIGN.md. The wired arm produced **zero**
  raw-value violations; two of three control runs copied a shipped hardcoded-color
  violation forward. Two wired agents cited the file's ban verbatim as their
  reason. Mechanism: the file stops *violation propagation* — agents copying
  shipped mistakes — and the CI budgets catch whatever slips.
- **A full production loop** on the monorepo that motivated the tool: per-app
  systems derived and committed, three owner decisions rendered → decided →
  recorded, first migration landed, budgets tightened, and a theme flip shipped to
  production behind the wiring.

See `docs/validation.md` for methods and `docs/upstream-limits.md` for the
dated list of `@google/design.md` v0.4.0 CLI behaviors this tool compensates for.

## Quick start

```bash
# 1. Where do you stand?
npx design-rails posture .

# 2. Author the system you already have (per app, never a monorepo blend):
npx design-rails propose apps/web --out=apps/web/design
#    dark-identity brand? --mode=dark

# 3. Settle the taste calls it flags:
npx design-rails decide apps/web            # renders design/decisions/*.html
npx design-rails decide apps/web --record charts-palette=violet-ramp --rationale="…"

# 4. Wire your agents (one section in the app's AGENTS.md / CLAUDE.md):
#    "design/DESIGN.md is the styling source of truth — read it before any UI work."

# 5. Enforce, and only ever tighten:
npx design-rails scan . --fail-on=color=2354,palette=3116,arbitrary=1201,orphan=24
npx design-rails tighten .github/workflows/design.yml
```

## Principles

- **Never edits your source.** Reports, authors under `design/`, and gates CI.
- **Never invents a value.** Every proposed token is a color your codebase already
  ships or declares, with its evidence attached.
- **Never decides taste.** Open calls go to a human, rendered visually, recorded
  with rationale.
- **The ratchet only turns one way.** Budgets go down when you clean up; a tighten
  that would absorb an increase refuses.

## License

MIT — see `LICENSE`. Method credits in `NOTICE` and `PROVENANCE.md`.
