# Validation evidence

Every claim here was produced by running the tool and checking its output against
an independent ground truth, on the date shown. Claims decay; re-run before
re-asserting.

## Multi-repo derivation validation (2026-08-07)

Method: shallow-clone four public repos spanning styling paradigms; run
`propose`; compare every derived role against the repo's OWN declared tokens at
the declaring `file:line`.

| Repo | Paradigm | Result |
| --- | --- | --- |
| shadcn-ui/taxonomy | shadcn bare-HSL custom properties | 7/7 assigned roles agree (hand-converted HSL→hex); correct abstentions where the repo declares no token |
| calcom/cal.com | 5,000-file monorepo, hsla() custom properties, two competing package-scoped token sets | 8/8 byte-exact; the dominant main-app brand correctly preferred over package-scoped `--primary`s |
| excalidraw/excalidraw | SCSS custom properties, dark-mode overrides | All declared-role matches exact; dark-mode values correctly not flattened into the light system |
| outline/outline | styled-components JS theme, semantic layer of references | Full agreement after one-hop reference resolution — including the brand reachable only through `link: colors.accent` |

Earlier iterations of the engine FAILED parts of this suite (a canvas swatch as
one repo's brand; a 45-file side app's palette as a 10-app monorepo's identity).
Those failures drove: content-based theme-file detection, oklch support,
dark-mode systems, workspace blend-refusal, declared-beats-residual, and the
variant/component-word guards. The suite is the reason to trust the defaults.

## Controlled adherence experiment (2026-08-08)

3v3: six fresh agents, identical component brief, no mention of design or an
experiment. Arm A worked in an app snapshot WITH a wired DESIGN.md; arm B on the
parent commit without it. Mechanical scoring (regex over outputs).

Result: arm A — 0/0/0 raw-value violations. Arm B — 0/3/2: both violating runs
copied the SAME shipped hardcoded-colour precedent forward. Two arm-A agents
cited the DESIGN.md ban verbatim as their reason for substituting token-based
equivalents. Mechanism identified: the wired file stops **violation
propagation** (agents copying shipped mistakes); CI budgets catch what slips.

Instrument note: an initial LLM-judge scoring layer was discarded — perfectly
tokenized components show no literal colours, so file-reading judges scored the
most adherent outputs as "brand-neutral". Mechanical counts are the valid
instrument for this experiment shape.

## Production loop (2026-08-05..08, private monorepo)

Per-app systems derived and committed for three differently-branded apps
(violet / matrix-green dark / red); three owner decisions rendered as pages,
decided, and recorded; first migration moved 29 chart call sites onto tokens
and tightened the colour budget; a dark-only theme decision shipped to
production behind the wiring. The CI ratchet's budgets moved only downward
throughout — including once when the tool's own false positive was fixed rather
than budgeted around.
