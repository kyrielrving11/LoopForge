---
name: prompt-techniques
description: >
  Reference catalog of 7 prompt engineering techniques. This skill should be
  used when the AI needs to recall the purpose, method steps, and use cases
  of techniques like zero-shot, few-shot, chain-of-thought, step-back,
  least-to-most, or tree-of-thought. It is a pure reference skill — no
  workflow instructions, only technique documentation loaded on demand.
---

# Prompt Techniques Reference

This skill catalogs seven prompt engineering techniques. Use `references/` files
to load detailed technique documentation on demand. Each reference includes:
purpose, input requirements, recommended JSON input templates, method steps,
design rules, when-to-use guidance, and example use cases.

## Technique Overview

| Technique | Cognitive Load | Independence | When to Use |
|-----------|---------------|-------------|-------------|
| zero-shot | Low | Either | Simple code explanation, formatting, renaming. |
| few-shot | Medium | Continuous | Standard CRUD modules, unit tests with fixed patterns. |
| chain-of-thought | Medium-High | Either | Multi-step reasoning; use `zero-shot-cot` without examples, `few-shot-cot` with examples. |
| step-back | High | Independent | Vague errors, messy legacy refactoring — abstract principles first. |
| least-to-most | High | Continuous | Large multi-step modules — decompose into ordered sub-tasks. |
| tree-of-thought | High | Independent | Core algorithms, crypto/signature verification, Assembly ops — explore multiple candidate paths. |

## How to Use

1. Read `references/<technique>.md` for the selected technique. Each reference contains:
   - **Purpose** — what problem the technique solves.
   - **Input Requirements** — required and optional parameters.
   - **Recommended JSON Input** — a complete input template with example values.
   - **Method Steps** — step-by-step construction guide.
   - **Design Rules** — specific rules for high-quality prompt construction.
   - **Case Generation Rules** — how to generate examples, decompositions, branches, or abstractions (where applicable).
   - **Single-Pass vs Two-Stage** — when to use each execution mode (step-back, least-to-most).
   - **Search Strategy Selection** — beam/dfs/expert-panel guidance (tree-of-thought).
   - **Prompt Output Template** — a complete 8-section output skeleton with section-level format specifications. Defines the exact structure the generated prompt must follow. The technique-specific section (section 5) format varies per technique: Few-Shot uses input→output pairs, Few-Shot-CoT uses reasoning triples, Step-Back uses abstraction framework boxes, Least-to-Most uses ordered subproblems, Tree-of-Thought uses state tables + evaluation criteria. Zero-Shot omits section 5 entirely for a lightweight 7-section prompt.
   - **When to Use** — concrete scenarios and example use cases.
2. `references/chain-of-thought.md` covers both `zero-shot-cot` and `few-shot-cot`, including paper citations for Few-Shot-CoT.
3. Do not load all references at once — read only the one selected by the router in Step 1.

## Reference Files

- `references/zero-shot.md`
- `references/few-shot.md`
- `references/chain-of-thought.md` (covers zero-shot-cot and few-shot-cot)
- `references/step-back.md`
- `references/least-to-most.md`
- `references/tree-of-thought.md`
