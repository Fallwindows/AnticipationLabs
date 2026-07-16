# Anticipy

An **anticipatory personal agent**, built from the [technical build brief](docs/anticipy-build-brief.md):
it observes the streams of someone's life and acts toward the **outcome the person actually
wants** — never the surface phrasing of what they said. "We'll have to stop at London Drugs"
does not open a shopping page; it becomes *Elias needs a toothbrush without a special trip*,
a check of the hotel's amenities, and one disclosed, approved call to the front desk.

The product is defined by **how it decides to act**: every consequential side effect passes
through a scoped, single-use, signature-bound approval and an Actor → Verifier split, and an
Outcome only closes on ground truth.

## Repository layout

```
packages/core    the agent core — long-running local service (Node + TypeScript)
                 outcome state machine, memory + vault, entity resolver, episode
                 interpreter, preparation, execution actors, read-only verifier,
                 watch scheduler, channel policy, append-only audit, LLM provider
                 abstraction, integration ports + fixture adapters, SQLite
                 persistence, local HTTP/WS API
packages/shell   the desktop shell — Electron + React chat surface with approval
                 cards and live inspector panels (Memory / Outcomes / Watches / Audit)
DECISIONS.md     the architecture decision log (§13 of the brief)
```

## The invariants are mechanisms, not prompts

| Invariant | Mechanism |
|---|---|
| I1 outcome, not trigger | `EpisodeInterpreter` emits goals (structured output); preparers act on goals |
| I2 whole-episode supersession | episodes re-interpreted as a whole; `supersede()` from pre-execution states; `MemoryStore.correct()` chains |
| I3 discussion ≠ authorization | classification gates: discussion/emotion park as `Dormant`; only humans issue approvals |
| I4 action ≠ outcome | `Closed` requires a `ClosureRecord`: watch ground truth or verified action-was-outcome |
| I5 scoped single-use approval | `ApprovalToken` bound to SHA-256 of the canonical `ActionSignature`; any edit invalidates; consumed at the execution gate |
| I6 actor/verifier split | `Verifier` is constructed with **read ports only** — self-confirmation is a type error |
| I7 idempotency | deterministic idempotency keys; post-timeout recovery **re-reads** (`Verifying → Executing` re-read edge), never re-submits |
| I8 durable watches | SQLite-persisted `WatchScheduler`: poll policies, max one follow-up per window, timeouts notify but never close |
| I9 entity ask-threshold | scored evidence resolution; below 0.80 → `DisambiguationRequest`; a person is never resolved on name similarity alone |
| I10 authority & scope | constraints (`exclusion`/`authority-limit`/`scope`) persist on the Outcome and gate preparation/drafting |
| I11 disclosure & audit | disclosures are part of the signed signature; hash-chained, trigger-enforced append-only audit log |
| I12 memory provenance/TTL/vault | facts carry source/confidence/sensitivity/TTL; prompt assembly uses the redaction view; AES-256-GCM vault with adapter-boundary secret substitution |
| I13 channel matches urgency | `ChannelPolicy.deriveUrgency` → quiet-card / chat / priority-push / call |
| I14 provider-swappable brain | `LLMProvider` interface; default `LocalProvider` (OpenAI-compatible local runtime); `FixtureProvider` in CI |

## The Outcome state machine

`Discovered → Interpreting → (Dormant ⇄) Prepared → AwaitingApproval → Approved →
Executing → Executed → Verifying → Verified → (Watching →) Closed`, with `Superseded`
(pre-execution only) and `Cancelled` (kill switch; not mid-execution — ground truth first).
The legal-edge table lives in `packages/core/src/domain/types.ts`; illegal edges throw and
are tested.

## Running

Prereqs: Node ≥ 20, pnpm ≥ 9. For the real brain: any local OpenAI-compatible runtime
(Ollama, LM Studio, llama.cpp, vLLM).

```bash
pnpm install

# tests: 100% deterministic fixtures — no network, no credentials (brief §12)
pnpm test                 # everything
pnpm test:scenarios       # the ten §10 acceptance scenarios

# console demo: scenario 1 end-to-end with printed state transitions
pnpm --filter @anticipy/core demo

# the agent core service (http://127.0.0.1:4271, SQLite in var/)
ANTICIPY_LLM_BASE_URL=http://127.0.0.1:11434/v1 \
ANTICIPY_LLM_MODEL=qwen2.5:14b-instruct \
pnpm dev:core

# the desktop shell (Vite dev server; Electron once a binary is installed)
pnpm dev:shell
```

Configuration (env): `ANTICIPY_DB`, `ANTICIPY_PORT`, `ANTICIPY_LLM_BASE_URL`,
`ANTICIPY_LLM_MODEL`, `ANTICIPY_ENABLE_TELEPHONY=1` (compliance-gated tier, off by
default — DECISIONS D-005).

## Testing strategy (brief §12)

- **Fixtures are the contract.** Every scenario = seeded memory + an episode transcript +
  stubbed integration state + assertions on exact state transitions, the exact
  `ActionSignature`, approval binding, verifier reads, and watch behavior.
- The `FixtureWorld` records **every write attempt** with its idempotency key, and can make
  any write land-then-timeout — the exact trap I7 exists for.
- A separate fixture **recipient mailbox** proves delivery independently of the sender.
- `TestClock` + injected ID sources make every run byte-deterministic.
- CI (`.github/workflows/ci.yml`) runs typecheck + unit/invariant tests + the ten scenarios
  on every push. Real adapters are exercised only in manual, interactive runs.

## Integration tiers (brief §6)

Every domain implements a port with three interchangeable adapters: `ApiAdapter`
(sanctioned APIs — Gmail/Calendar/Jira first), `BrowserAdapter` (Playwright with
user-takeover for login/2FA/payment), and `FixtureAdapter` (CI). The telephony tier ships
disabled behind an explicit compliance gate with mandatory disclosure. See DECISIONS
D-004/D-005 for what's lit up in this build.
