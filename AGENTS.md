# AGENTS.md

<!-- agent-skills:start -->
## Agent skills

Before starting work, read the skills below that apply to the task; each SKILL.md says when to use it. They are Sam's working playbooks and Lauren Tan's pstack (`pstack-*`), chosen for this repo. Obvious Autobuild loads them from `.obvious/skills/` on the default branch.

- [`anti-ui-slop`](.obvious/skills/anti-ui-slop/SKILL.md): Run the Uizze reference-guided design playbook or UI finish check when explicitly requested
- [`blast-radius`](.obvious/skills/blast-radius/SKILL.md): Assess what a change could break beyond its diff
- [`pstack-benchmark-checklist`](.obvious/skills/pstack-benchmark-checklist/SKILL.md): Vet a perf measurement (limiter, tuning, limits, errors, repeatability, relevance, and whether the work happened) before you report or act on it
- [`pstack-principle-boundary-discipline`](.obvious/skills/pstack-principle-boundary-discipline/SKILL.md): Apply when wiring validation, error handling, or framework adapters
- [`pstack-principle-explain-the-number`](.obvious/skills/pstack-principle-explain-the-number/SKILL.md): Apply before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result *(needed by `pstack/benchmark-checklist`)*
- [`pstack-principle-make-operations-idempotent`](.obvious/skills/pstack-principle-make-operations-idempotent/SKILL.md): Apply when designing commands, lifecycle steps, or processing loops that run amid crashes, restarts, and retries
- [`pstack-principle-prove-it-works`](.obvious/skills/pstack-principle-prove-it-works/SKILL.md): Apply after completing a task, before declaring done *(needed by `pstack/principle-explain-the-number`)*
- [`pstack-principle-separate-before-serializing-shared-state`](.obvious/skills/pstack-principle-separate-before-serializing-shared-state/SKILL.md): Apply when concurrent actors might write to the same file, branch, key, or state object
- [`pstack-principle-test-behavior-not-implementation`](.obvious/skills/pstack-principle-test-behavior-not-implementation/SKILL.md): Apply when you write, change, or keep a test
- [`pstack-typescript-best-practices`](.obvious/skills/pstack-typescript-best-practices/SKILL.md): TypeScript best practices
- [`pstack-unslop`](.obvious/skills/pstack-unslop/SKILL.md): Cut AI tells from any writing
<!-- agent-skills:end -->
