# Technique Routing Matrix

When determining which prompt engineering technique to use, evaluate the current
task along two dimensions:

## Dimension 1: Independence

- **Continuous (连续)**: The task modifies, extends, or repairs code/context from the
  current conversation. Prior context is directly relevant.
- **Independent (独立)**: The task demands a completely new, self-contained feature,
  algorithm, or module that does not depend on the preceding conversation.

## Dimension 2: Cognitive Load

- **Low (低)**: Simple changes — renaming, formatting, adding comments, basic CRUD,
  config files, hello-world pages.
- **Medium (中)**: Standard modules with fixed patterns — typical CRUD endpoints,
  common unit tests, boilerplate data models.
- **High (高)**: Involves cryptography, concurrency, security auditing, EVM/Assembly
  operations, complex algorithms, multi-step state machines, or deeply nested logic.

## Routing Table

| Independence | Cognitive Load | Recommended Technique | Rationale |
|:---|:---|:---|:---|
| Continuous | Low | `zero-shot` | Lightweight fixes; don't disturb context. |
| Continuous | Medium | `few-shot` | Reuse established patterns from the session. |
| Continuous | High | `few-shot-cot` or `least-to-most` | **few-shot-cot**: user has provided reasoning examples (input→reasoning→output triples) from prior context — carry forward prior insights as a reasoning relay. **least-to-most**: the task itself decomposes naturally into 4-6 ordered subproblems with clear dependencies, but the user has NOT provided reasoning examples. If both conditions are true, prefer `few-shot-cot`. |
| Independent | Low | `zero-shot` | Fresh start, simple task. |
| Independent | Medium | `few-shot` or `zero-shot-cot` | Pattern-based or light reasoning as appropriate. |
| Independent | High | `tree-of-thought` | Explore multiple candidate paths; prune weak ones. Use `step-back` instead if the task requires abstracting principles first before branching. |

## Edge Cases

- **If independence is ambiguous**: Treat as Continuous to avoid unnecessary context
  flush. Erring on the side of keeping context is safer.
- **If cognitive load is borderline (medium/high)**: Round up to High for tasks
  involving any of: security, money, concurrency, user data, or irreversibility.
- **Continuous + High — choosing between `few-shot-cot` and `least-to-most`**:
  - Does the user's prior context contain complete reasoning examples (input→reasoning→output triples)? → `few-shot-cot`
  - Can the task be cleanly decomposed into 4-6 ordered subproblems (e.g. compiler stages, data pipeline, multi-step module)? → `least-to-most`
  - If both conditions hold, prefer `few-shot-cot` (leverage existing examples first).
  - If neither holds (no examples, no natural decomposition), fall back to `zero-shot-cot` and note the downgrade reason.
- **If the user explicitly requests a technique**: Use it directly — skip the matrix.
- **If no vault exists**: Skip Step 0, proceed directly to routing.

## Context Flush Rule

When the router determines **Independent + High cognitive load**, instruct the AI to
ignore prior conversation content unrelated to the current task. Retain only:
- Hard constraints from the vault (if any).
- The current file context.
- Technical stack information.
