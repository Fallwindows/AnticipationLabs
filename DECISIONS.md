# DECISIONS.md — Anticipy architecture decision log

Append-only. Each entry records a decision from §13 of the build brief (or one that came up
during the build), with rationale. Never rewrite an entry; supersede it with a new one.

---

## D-001 — Stack: single TypeScript monorepo (brief §8, §13.1)

**Date:** 2026-07-16
**Decision:** Primary recommendation from the brief — one TypeScript codebase.

- **Agent core** (`packages/core`): long-running Node 20+ service. Owns the Outcome state
  machine, memory, watches, audit, SQLite persistence, and the local-model client. Exposes a
  local HTTP + WebSocket API for the shell.
- **Desktop shell** (`packages/shell`): Electron + React + Vite. Chat surface + approval
  cards + the four inspector panels (Memory / Outcomes / Watches / Audit), live-updating
  over the core's WebSocket event stream.
- **Package manager:** pnpm workspaces. **Tests:** Vitest. **Browser automation (Phase 4):**
  Playwright.

**Rationale:** One language across UI and core eliminates shared-type drift (the domain
types in `@anticipy/core` are imported by the shell directly), Electron ships a Windows
installer, and Playwright integrates cleanly from Node. The native WinUI alternative buys
Windows idiom at the cost of rebuilding the inspector UI stack; the Python-core split buys
ML ergonomics at the cost of a serialization boundary. Neither outweighs a single-language
codebase for this build.

## D-002 — Local model runtime (brief §5.12, §13.2)

**Date:** 2026-07-16
**Decision:** The `LLMProvider` interface (`complete`, `structuredComplete(schema)`,
`embed`) is the only surface the rest of the system sees. Default implementation is
`LocalProvider`, which speaks the **OpenAI-compatible HTTP protocol** to any local runtime
(Ollama, LM Studio, llama.cpp server, vLLM) at a configurable base URL
(`ANTICIPY_LLM_BASE_URL`, default `http://127.0.0.1:11434/v1`). Model name is config
(`ANTICIPY_LLM_MODEL`), not code. Recommended starting point on a typical Windows dev box
(≥16 GB RAM, consumer GPU optional): Ollama running `qwen2.5:14b-instruct` (or `:7b` on
smaller hardware) — strong structured-output behavior at local-friendly sizes; swap freely.

**Rationale:** The OpenAI-compatible surface is the de-facto lingua franca of local
runtimes, so the model and the runtime are both swappable without touching callers (I14). A
hosted provider can later be added as another `LLMProvider` implementation. All automated
tests use `FixtureLLMProvider` (deterministic canned structured outputs) — CI never talks to
a model.

## D-003 — Persistence & vault encryption (brief §5.11, §13.3)

**Date:** 2026-07-16
**Decision:** **SQLite via better-sqlite3** (embedded, synchronous, restart-survivable) for
Outcomes, Episodes, MemoryFacts, Watches, ApprovalTokens, and the append-only Audit log.
Tests run on `:memory:` databases. The **vault** is a separate table whose values are
encrypted at rest with **AES-256-GCM**; the data-encryption key comes from a `KeyProvider`
interface with two implementations: `OsSecretStoreKeyProvider` (Windows DPAPI/Credential
Manager via keytar — the production path) and `FileKeyProvider` (0600-permission key file —
dev/CI path). Vault values never enter MemoryFacts, model prompts, or logs; memory may hold
only a `vault-ref` pointer. Every vault access is written to the audit log.

**Rationale:** SQLite is the brief's recommendation and the right shape for a local core
service that must survive UI restarts. GCM gives authenticated encryption; the KeyProvider
seam keeps the OS-secret-store dependency out of CI while making the production path
first-class.

## D-004 — Integrations lit up in this build (brief §6, §13.4)

**Date:** 2026-07-16
**Decision:** This build ships **all ten scenario domains on `FixtureAdapter`s** (email +
recipient mailbox, calendar, commerce/returns, airline, hotel/telephony, Jira, ledger,
subscription billing), and the adapter **ports** for the real tiers. Real adapters land in
this order (per brief Phases 3–4): Gmail/Calendar/Jira `ApiAdapter`s first (sanctioned
APIs), then Playwright `BrowserAdapter` with user-takeover for commerce/airline, then the
telephony tier. Adapter selection is per-environment config; CI is pinned to fixtures.

**Rationale:** Fixtures are the contract (§12) and the definition of done for behavior. The
sanctioned-API tier is the only one without ToS/legal constraints, so it goes first.

## D-005 — Telephony provider & compliance gate (brief §6, §9, §13.5)

**Date:** 2026-07-16
**Decision:** Port is `TelephonyPort`; the intended real backend is **Twilio
(ConversationRelay)** as referenced by the spec. The tier ships **disabled by default**
behind `ANTICIPY_ENABLE_TELEPHONY=1` *and* a region allowlist config
(`telephony.allowedRegions`); every call must carry `disclosures` (identify as the user's
assistant) in its ActionSignature, is rate-limited to the approved scope (one approval = one
call to one counterparty), and writes an AuditEntry with who was spoken to and the promised
ETA (I11). No recording by default; recording requires a region-consent check.

**Rationale:** Outbound automated calls are regulated (consent/recording law varies by
region; robocall rules). Opt-in + region gate + disclosure-in-signature makes compliance a
mechanism, not a habit.

## D-006 — Confidence thresholds (brief §5.3, §13.6)

**Date:** 2026-07-16
**Decision:** Entity resolution: **resolve at ≥ 0.80** confidence; **ask (Disambiguation
Request) below 0.80**. Contacting a human being additionally requires at least one piece of
**non-name evidence** (relationship, meeting context, thread membership, domain vocabulary)
regardless of score — name similarity alone can never select a person (I9). Auto-prepare
(read-only research) is allowed at interpretation confidence ≥ 0.60; below that the outcome
stays `Dormant` until new evidence. Thresholds live in config, not code.

**Rationale:** Preparation is read-only and cheap to be wrong about; contacting a human is
not. The asymmetry belongs in the thresholds.

## D-007 — Watch defaults (brief §5.9, §13.7)

**Date:** 2026-07-16
**Decision:** Per-kind defaults (all config-overridable), enforced by the scheduler:

| kind    | poll interval | follow-up window (max 1 per) | timeout |
|---------|---------------|------------------------------|---------|
| ledger  | 6 h           | 1 business day               | 14 d    |
| mailbox / reply | 15 min | 1 business day              | 7 d     |
| refund  | 12 h          | 3 d                          | 30 d    |
| flight  | 5 min         | 30 min                       | until departure + 24 h |
| delivery/front-desk promise | 5 min | 20 min (scenario 1)  | 2 h     |
| billing (final period) | 1 d | —                          | full billing period + 3 d |

A watch closes its Outcome **only** via its `closeCondition` (ground truth) or explicit
cancel; timeouts surface a notification, they never fabricate closure (I4/I8).

**Rationale:** Matches the cadences the scenarios assert (20-minute toothbrush follow-up,
"stay silent until Monday" ledger move, final-billing-period Adobe watch).

## D-008 — IDs, clock, and determinism

**Date:** 2026-07-16
**Decision:** All time reads go through an injectable `Clock`; all ID generation through an
injectable `IdSource`. Production uses the system clock + `crypto.randomUUID`; tests use
`TestClock` (manually advanced) and a seeded counter. No `Date.now()` outside the Clock
implementations.

**Rationale:** §12 requires controllable-clock watch tests and deterministic fixtures; this
is the mechanism that makes every scenario reproducible byte-for-byte.

## D-009 — ActionSignature hashing

**Date:** 2026-07-16
**Decision:** `ActionSignature` is canonicalized (recursively key-sorted JSON, no
whitespace) and hashed with **SHA-256**. `ApprovalToken`s bind to that hash; the
authorization layer recomputes the hash at execution time and refuses on any mismatch
(single-use enforced by a consumed-at column; expiry enforced by Clock).

**Rationale:** "Any edit invalidates the token" (I5) must be a byte-level property, not a
UI convention. Canonical JSON keeps the hash stable across serialization order.

## D-010 — PII scrubbing for prompt-bound free text (brief §9, I12)

**Date:** 2026-07-16
**Decision:** The vault remains the *primary* mechanism for identity documents (never in
memory, never in prompts, substitution at the adapter boundary). Because users also type
secrets into chat, every prompt-assembly site (episode interpreter transcript + evidence,
chat-reply, email drafting source notes) additionally passes free text through
`redactSensitiveText()`: conservative patterns for payment-card digit runs, SSN shapes, and
passport-shaped identifiers. Internal actions (`chat.deliver-brief`) refuse vault
placeholders outright — their "adapter" is the persisted, broadcast chat log.
**Limits (recorded deliberately):** pattern-based scrubbing is best-effort; novel secret
formats can pass. The mitigation hierarchy is vault first, scrub second, local-only model
third (D-002 — even a leak stays on the user's machine by default).

## D-011 — Localhost server threat model (brief §9)

**Date:** 2026-07-16
**Decision:** Binding to 127.0.0.1 does not protect against the user's own browser as a
confused deputy, so the browser attack surface is closed structurally rather than with an
auth token: the built shell is served **same-origin from the core** (no CORS headers exist
in production, so foreign pages cannot read responses); mutating routes require
`Content-Type: application/json` (forces a CORS preflight that fails without ACAO);
the `Host` header must be loopback (DNS-rebinding defense); WebSocket upgrades enforce an
Origin allowlist; `POST /api/outcomes/:id/edit` zod-validates the signature. Dev mode
(`vite dev`) opts into CORS for exactly one origin via `ANTICIPY_DEV_ORIGIN`.
High-sensitivity memory values are redacted in every server snapshot (stored ≠ exposed).

## D-012 — Known debts (accepted, not forgotten)

**Date:** 2026-07-16
- The actionType taxonomy appears in three switches (actor dispatch, verifier check, chat
  pipeline watch policy). Mitigations in place: the actor pre-checks routability *before*
  consuming the approval token; an unknown type can no longer close by fallthrough; and no
  wedge states remain (every failure path reaches a cancellable state). The right end state
  is a per-actionType module registry mirroring the preparer/poller registries — planned
  alongside the Phase 3 real adapters, which will force the taxonomy open anyway.
- The shell keeps a hand-maintained mirror of the protocol types (`src/lib/types.ts`)
  because its typecheck must not depend on `core/dist` build order; the mirror is the
  documented price. Revisit with project references if drift ever bites.
- The shell refetches the full snapshot per event burst (40 ms coalesced). Fine at
  operator-console scale; a delta protocol is the upgrade path if audit/chat history grows.
