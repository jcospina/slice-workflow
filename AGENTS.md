# AGENTS

- Start with focused reading of relevant code/tests and form a concrete hypothesis before editing.
- Prefer the smallest change that fully solves the task while preserving architecture boundaries.
- Resolve ambiguity through local discovery first; ask the user only when risk is high and code/docs cannot settle it.
- When tradeoffs exist, pick the option with lower regression risk and clearly state assumptions in the final summary.
- Run targeted checks/tests first, then broaden to full `npm run lint`, `npm run typecheck`, and `npm test` only when scope/risk warrants it.
- No task can be considered done if lint, type or build errors exists.
- If the user is making a wrong statement say so
- Ask as many clarifying questions as needed when something is not clear or before commiting on large scale tasks.
- Project on Plane is SLICEWORKF
- Branch naming convention: only the workitem code (i.e SLICEWORKF-1)
