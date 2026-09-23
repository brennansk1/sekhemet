# Web research, September 2026: speed, safety, landscape, measurement

*Four web-research digests commissioned during the Opus 5.5 Phase A review (2026-09-22). Each agent was told to cite primary sources and mark anything it could not verify as **uncertain**. The digests are kept close to verbatim below; the decisions they feed are in [COVERAGE.md](../reference/COVERAGE.md). Nothing here is adopted until the programme, and every library or repository named needs the owner's yes.*

## What changes because of this research

| # | Finding | Consequence for Sekhemet | Where it lands |
| --- | --- | --- | --- |
| 1 | On hybrid-attention models (Qwen3.6-class, Cyber-Tiel), llama.cpp can resume only from a saved checkpoint at or before the first changed token; one changed byte early in the prompt forces a full prefill. Checkpoints sit at user-message boundaries; the default `--checkpoint-min-step` is 8192. | Our ~29% cache-hit rate is a prompt-prefix problem, not an MTP one. Make the Worker prompt append-only: byte-identical system prompt and tools array, no edits to earlier tool output, compaction rare and all at once; `--checkpoint-min-step` ~512–1024; drop `--cache-reuse`; `preserve_thinking` if thinking stays on. | M3 and a new speed item (M11) |
| 2 | MTP on the 35B-A3B MoE gives ~1.1–1.3x decode and costs prefill; agent turns are mostly prefill. One M1 Pro report fell from 26 to 2 tok/s when Metal exceeded its working set. | A/B MTP on seconds per turn, not tok/s; watch Metal memory on 24 GB. Two draft tokens, not three. | M11 |
| 3 | Overthinking lowers SWE-bench resolution; quantized models overthink more; llama.cpp has `--reasoning-budget`. No published thinking A/B exists for small quantized agents. | Our A/B is new evidence. Run the surgical and all arms with a reasoning budget. | Thinking A/B |
| 4 | Tool-selection accuracy falls as the tool list grows; retrieval of tools is unreliable (best nDCG@10 34). | Give each card a small fixed tool set; add tools by appending to the conversation, never by editing the tools array (it would also break the cache prefix). | M1 |
| 5 | The same `.git`-write flaw was found in Cursor (CVE-2026-26268), and the fsmonitor/bare-repo class in Claude Code, Copilot CLI (CVE-2026-45033), Goose, Hermes and others ("GitSpawn"). | Confirms S1/S2 were real. The complete defence is that sandboxed code can never write `.git`; config overrides alone cannot cover filters and drivers. Remaining hardening list below. | S1–S3 and G2–G4 |
| 6 | Linear Agent (2026-03) already lets non-developers chat with a PM agent; Jira and GitHub route cards to cloud agents; nobody enforces gates at the column or teaches practice; local+gated+board is unoccupied. | The PM chat is not the moat. Position on local/private, "accepted means proven by gates", and teaching. Adopt the owner/delegate split (a human stays the assignee). | Positioning, D3 |
| 7 | The Kanban Guide (2025) requires WIP, Throughput, Work Item Age and Cycle Time, plus an SLE. NN/g: contextual, dismissible help beats tutorials. | The dashboard's Learn layer teaches through empty states and "why?" affordances, and shows Work Item Age, WIP limits and an SLE. | Dashboard workstream |
| 8 | Generated acceptance criteria are weaker than human ones, but LLMs judge them well against a rubric; JSON-constrained Gherkin at temperature 0 with rich context scored best. | Planner: constrained output, temperature 0, a separate critic pass on criteria. | Planner workstream |
| 9 | Cyber-Tiel is an abliterated re-quantization of Ornith-1.5, not Qwen3.6; its own card warns it is "not an ordinary coding agent" and demands OS sandboxing. None of its published scores were measured at IQ3. | The sandbox and permission layer is the only defence against destructive actions. Feeds D1 (Cyber-Tiel vs Tiel). | D1 |
| 10 | At 25 tasks, a paired test has ~6–7% power to detect a 10-point gain; ~155 paired tasks are needed at 20% disagreement. CLT error bars under a few hundred items are badly optimistic. | Report pass rates with exact or Bayesian intervals, compare arms paired, and only claim large effects (≥20 points) from the 30-card suite; repeat runs. | Measurement (M-items) |
| 11 | Project-building benchmarks exist: DevBench, Commit0 lite (16 libraries), ProjDevBench (20), NL2Repo, SlopCodeBench. | Candidates for the planning measure; Commit0 lite and ProjDevBench run locally. | Planning measure |


## Group A: Worker speed — prompt cache, MTP, thinking, tool count

I found primary sources for all four questions. The cache-reuse finding is the most useful: the 29% hit rate is almost certainly a problem with how the prompt prefix is managed, not something MTP causes. Everything below comes from pages I opened unless it is marked **uncertain**. Dates are as shown on GitHub or arXiv.

### Q1: Prompt/KV cache reuse on hybrid-attention models (the most important part)

**How reuse works.** The layers that carry a running state (Qwen3.6's DeltaNet layers) can't be rolled back token by token. The server can only resume from a saved context checkpoint that sits at or before the first token that differs from the previous prompt. If there is no such checkpoint, it logs "forcing full prompt re-processing due to lack of cache data (likely due to SWA or hybrid/recurrent memory)" and discards all checkpoints.
- Issue #24055 (2026-06-03) shows this exactly: a checkpoint at 2799 is rejected for a prompt that diverged at 2608.
- Full-attention models can simply truncate the cache. SWA models lose tokens as the window slides; PR #13194 (merged 2025-05-20) is the source for `--swa-full`.
- https://github.com/ggml-org/llama.cpp/issues/24055, https://github.com/ggml-org/llama.cpp/pull/13194
- Implication: one changed byte anywhere before the newest usable checkpoint costs a full prefill. Only append-only prompts get reliable reuse.

**Where checkpoints are placed now.**
- PR #22929 (merged 2026-05-25) removed `--checkpoint-every-n-tokens`. Checkpoints moved to message boundaries and a `--checkpoint-min-step` flag was added. Discussion on that PR says templates that rewrite earlier messages, such as stripping thinking, defeat this. https://github.com/ggml-org/llama.cpp/pull/22929
- PR #24176 (merged 2026-06-23) creates a checkpoint at every user message, and tool results count as user boundaries. It raised the default min-step from 256 to 8192, and the last user message always gets a checkpoint. https://github.com/ggml-org/llama.cpp/pull/24176
- PR #25472 (merged 2026-07-12) evicts checkpoints that fall within min-step of each other. https://github.com/ggml-org/llama.cpp/pull/25472
- Current server README defaults: `--ctx-checkpoints` 32, `--checkpoint-min-step` 8192, `--cache-ram` 8192 MiB. https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Implication: with 16k context and the 8192 min-step default, only about two spaced checkpoints survive plus the last-user one. Try `--checkpoint-min-step` of about 512–1024. I have not verified that your ~b10809 build includes #24176 and #25472; run `llama-server --help`.

**Flags that won't help.**
- `--cache-reuse` works by shifting the KV cache, and that doesn't work on qwen3-next hybrids. Issue #18497 (2025-12-30) reports full re-processing instead. https://github.com/ggml-org/llama.cpp/issues/18497
- `--swa-full` does nothing when a model has no SWA layers (n_swa = 0). That is a secondary blog's claim, but it matches the logic of #13194. It matters for Gemma and gpt-oss, not Qwen3.6. https://particula.tech/blog/prompt-reprocessing-swa-hybrid-models-kv-cache (2026-07-30)
- Implication: drop `--cache-reuse` for this model.

**`--cache-ram` (host prompt cache).** PR #16391 (merged 2025-10-09) saves a slot's state to RAM when the slot switches to a different prompt, and restores it when a later request matches the prefix. Checkpoints are stored alongside. It was aimed at single-slot agents whose side tasks would otherwise wipe the cache. https://github.com/ggml-org/llama.cpp/pull/16391
- Implication: it only helps when different conversations share the one slot (PM vs Worker, summarizers). Whether 2048 MiB is enough is **uncertain**; check the logs.

**Slot save/restore is broken for hybrids.** Issue #25913 (2026-07-20): `/slots` save/restore reports success, but checkpoints are never saved and all reuse is lost. Fix PR #26004 is still open. https://github.com/ggml-org/llama.cpp/issues/25913
- Implication: don't rely on slot files. PR #24785 (open, 2026-06-18) also shrinks and expands the running state for the prompt cache. It reports zero re-processing over 5 agent turns on Qwen3.6-35B-A3B with MTP on AMD, versus 207 s of prefill per turn before. https://github.com/ggml-org/llama.cpp/pull/24785

**Things that break the prefix.**
- **Earlier thinking gets stripped.** The Qwen3.6-27B model card says that by default only the thinking for the latest user message is kept. The `preserve_thinking` option keeps earlier thinking. https://huggingface.co/Qwen/Qwen3.6-27B
- **Empty think blocks.** QwenLM/Qwen3.6 issue #131 (2026-04-09) says the template emits empty `<think>` blocks for past turns, causing prompt drift and cache invalidation. It proposes adding an `and reasoning_content` condition. https://github.com/QwenLM/Qwen3.6/issues/131
- **Changing header text.** A Claude Code attribution header that changes per request killed reuse. Removing it gave "restored context checkpoint" and only 212 new tokens evaluated. https://www.mykolaaleksandrov.dev/posts/2026/06/claude-code-llamacpp-prompt-cache-fix/ (2026-06-21), which cites issue #21831.
- Implication: pass `preserve_thinking: true` through `--chat-template-kwargs` and send `reasoning_content` back, or turn thinking off. Keep the system prompt and tools array byte-identical: no timestamps, fixed tool order, deterministic JSON. Never edit or truncate earlier tool outputs in place; compact rarely and all at once. Run with `-lv 4` to see which position each checkpoint is checked against.

### Q2: MTP and speculative decoding

**PR #22673 (am17an, merged 2026-05-16)** added `--spec-type draft-mtp`. It only supports one parallel slot, is supported on Metal, and "Prompt processing (PP) speed typically takes a negative hit". https://github.com/ggml-org/llama.cpp/pull/22673

| Model | Baseline | With MTP | Draft tokens | Acceptance |
|---|---|---|---|---|
| Qwen3.6-35B-A3B | 22.92 tok/s | 29.39 tok/s (about 1.28x) | 2 | 81.5% |
| Qwen3.6-27B (dense) | 7.0–7.7 tok/s | 15.8–21.6 tok/s | 3 | 72% |

**Apple Silicon results.**
- An M5 Max with Q8 weights (2026-06-14) measured MTP at **+12% on 35B-A3B** against +75% on the dense 27B (105 vs 93 tok/s at 128 tokens). https://github.com/stared/benching-local-llms-on-apple-silicon
- Issue #23011 (2026-05-13), M1 Pro 32 GB, Q4_K_M: **26.23 → 1.93 tok/s** despite 95.6% acceptance. Metal had allocated 21,603 MiB, more than its recommended working set. No fix is linked. https://github.com/ggml-org/llama.cpp/issues/23011
- Implication: on a 24 GB M4 the MTP head's extra memory could push you past Metal's working-set limit. Test the extra memory and speed directly.

**RTX 3090 study** (Qwen3.6-35B-A3B, audited 2026-08). https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090
- Gains: MTP with 2 draft tokens +22.7% (78.4% acceptance), DFlash with 2 +26.3%.
- Losses: ngram-mod −10.9%, ngram-cache −19%, an external draft model −73%.
- The same config varied 9.4 percentage points within one day.
- Implication: use 2 draft tokens on this MoE and skip classic draft models.

**Speculative checkpointing for hybrids.** PR #19493 (merged 2026-04-19) saves the running state before drafting and restores it on rejection. It measured about 30% faster decoding on code and about 10% slower on ordinary text. https://github.com/ggml-org/llama.cpp/pull/19493

**Flags.**
- `--draft-max` and `--draft-min` have been removed. Use `--spec-draft-n-max` (default 3), `--spec-draft-n-min` (default 0) and `--spec-draft-p-min` (default 0.00). Source: the server README.
- The docs suggest ngram-mod settings of 24 / 48 / 64 for long rewrites. https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md

**Things that don't apply or aren't proven.**
- Issue #29168 (2026-09-20): a CUDA-only MoE fusion from PR #25952 dropped MTP acceptance from 0.82 to 0.48 from b10751 on. It doesn't apply to Metal. https://github.com/ggml-org/llama.cpp/issues/29168
- **Uncertain:** one README says MTP "breaks the prompt cache" every turn but gives no evidence (https://github.com/marcofariasmx/local-llm-apple-silicon). #24785 contradicts it.
- **Uncertain, my own hypothesis with no source:** abliteration may lower MTP acceptance because the head was trained on the original weights.

**Implication:** agent turns are mostly prefill with short tool-call outputs, so MTP speeds up the smallest part of the turn and slows prefill. A/B it on real turns, measuring total seconds per turn, not tok/s.

### Q3: Thinking vs non-thinking

- **Overthinking** (arXiv 2502.08235, 2025-02-12, SWE-bench Verified, 4,018 trajectories). Overthinking correlates with lower resolution rates. Picking the lower-overthinking solutions raised performance by about 30% and cut cost by 43%. Reasoning models overthink more.
- **Budget forcing** (s1, arXiv 2501.19393): stopping thinking early, or appending "Wait" to extend it. On AIME24 this went from 50% to 57%. llama.cpp has `--reasoning-budget N`.
- **Vendor numbers.** Qwen3.6-35B-A3B's card reports 73.4 on SWE-bench Verified and 51.5 on Terminal-Bench 2.0. Those were run in thinking mode with a 200K window and 80K max tokens, so they aren't comparable to 16k context at IQ3_XXS. https://huggingface.co/Qwen/Qwen3.6-35B-A3B
- **Non-thinking counterexample.** Qwen3-Coder-Next is non-thinking only and scores over 70% on SWE-bench Verified with SWE-Agent (per its HF card, via search result).
- **Quantization.** arXiv 2504.04823 (COLM 2025) finds W8A8 and W4A16 lossless on reasoning, with significant risk at lower bit-widths. arXiv 2606.00206 (2026-05-29) finds quantized models overthink ("wait", "alternatively"). In up to 52% of their failures the right answer appeared mid-reasoning. A logit penalty on those words cut chain-of-thought length by 12–23% without losing accuracy.
- I found **no measured thinking-vs-non-thinking agentic A/B for Qwen3.6 small or quantized models**.
- Implication: at IQ3_XXS with a 16k window, run your planned A/B with a reasoning budget, and use `preserve_thinking` if you keep thinking on.

### Q4: How many tools to show

- **Anthropic's tool search docs:** Claude's tool selection accuracy degrades beyond 30–50 tools. Tool search is advised at 10 or more tools or more than 10k tokens of definitions; keep 3–5 core tools always loaded. Deferred tools are appended inline and "The prefix is untouched, so prompt caching is preserved." https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- **RAG-MCP** (arXiv 2505.03275, 2025-05-06): tool-selection accuracy went from 13.62% to 43.13% and prompt tokens dropped by more than 50%.
- **Less is More** (arXiv 2411.15399, DATE 2025): narrowing the tool set raised success on edge hardware, cut execution time by up to 70% and power by up to 40%.
- **ToolRet** (arXiv 2503.01763): the best retriever reaches only 33.83 nDCG@10, and poor retrieval lowers the model's end-to-end task pass rate.
- I did not open BFCL.
- Implication: give each card a small fixed tool set, since retrieval is unreliable. Add any extra tools by appending them to the conversation, never by editing the tools array, which Qwen templates render near the top of the prompt.

## Group B: sandbox and git safety

I checked everything I could against primary sources: GitHub advisories, vendor docs, git-scm and kernel docs. I've marked where a claim rests only on a secondary source or on memory. I modified no files.

### 1. Agent sandboxes: primitives and incidents

- **Anthropic sandbox-runtime (srt).** On macOS it uses Seatbelt (`sandbox-exec`); on Linux it uses bubblewrap plus a seccomp filter that blocks creating Unix sockets. Writes to shell rc files, `.gitconfig`, `.gitmodules`, `.git/hooks/`, `.vscode/` and `.idea/` are always denied, even inside an allowed write path. [github.com/anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime). *Implication:* protect the git metadata of any directory the model's code can write to.
- **Claude Code sandbox docs** list these limits:
  - The proxy decides from the client-supplied hostname and doesn't inspect TLS, so domain fronting is possible.
  - Broad allowed domains like `github.com` are exfiltration paths.
  - `allowUnixSockets` for `docker.sock` gives host access.
  - `enableWeakerNestedSandbox` "considerably weakens security".
  - Sandboxing is "not a complete isolation boundary".

  [code.claude.com/docs/en/sandboxing](https://code.claude.com/docs/en/sandboxing)
- **CVE-2025-66479 / GHSA-9gqj-5w7c-vx47** (@anthropic-ai/sandbox-runtime, published 2025-12-04). An empty `allowedDomains: []` was treated as "allow all". The researcher says it affected Claude Code v2.0.24–2.0.54 and was fixed in 2.0.55. The same researcher reports a second bypass, a SOCKS5 null byte in the hostname: `endsWith()` checked one string while `getaddrinfo` resolved another. It was fixed silently in v2.1.90 (2026-04-01) with no CVE. [GitHub advisory](https://github.com/advisories?query=CVE-2025-66479); [oddguan.com writeup, May 2026](https://oddguan.com/blog/second-time-same-sandbox-anthropic-claude-code-network-allowlist-bypass-data-exfiltration/). *Implication:* treat an empty allowlist as deny-all, and compare hostnames after canonicalizing them (reject NUL bytes and odd characters).
- **Codex Linux sandbox.** bubblewrap is the default, with `--ro-bind / /`, bind mounts for the writable roots, and `.git`, the resolved `gitdir:` and `.codex` re-mounted read-only. It sets NO_NEW_PRIVS and a seccomp network filter. In "managed proxy mode" it uses `--unshare-net` with a TCP→Unix-socket→TCP bridge. The Landlock path is deprecated because it can't isolate Unix sockets. [codex-rs/linux-sandbox/README.md](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md). Network is off by default in workspace-write mode; domain rules take effect only once the network proxy is turned on ([developers.openai.com/codex/agent-approvals-security](https://developers.openai.com/codex/agent-approvals-security)).
- **CVE-2025-59532 / GHSA-w5fx-fh39-j5rw** (Codex 0.2.0–0.38.0, fixed in 0.39.0). The model-supplied cwd became the root of the writable area. [GitHub advisory](https://github.com/advisories/GHSA-w5fx-fh39-j5rw). *Implication:* the harness, never the model, decides writable roots, and it should canonicalize them.
- **Codex "Heapjack" and "Overpatch"** (reported 2026-08-12, fixed in CLI 0.149.0). Overpatch let the patch tool grant write access to a parent directory, then write into home via a symlink. This is **secondary source only** ([BleepingComputer, 2026-09-20](https://www.bleepingcomputer.com/news/security/researchers-escape-openai-codex-sandbox-to-run-commands-on-host/)); I saw no CVE.
- **Cursor CVE-2026-26268 / GHSA-8pcm-8jpx-hv8r** (2026-02-13, fixed in 2.5). Sandboxed code could write `.git` config and hooks, which then ran outside the sandbox. [Advisory](https://github.com/cursor/cursor/security/advisories/GHSA-8pcm-8jpx-hv8r). *Implication:* this matches your threat model exactly.
- **Gemini CLI GHSA-wpqr-6v78-jr5g** (CVSS 10, 2026-04-24, fixed in 0.39.1). Headless runs trusted the workspace's `.gemini/` config automatically, so code ran before the sandbox started. [Advisory](https://github.com/google-github-actions/run-gemini-cli/security/advisories/GHSA-wpqr-6v78-jr5g)
- **Seatbelt status.** The `sandbox-exec` man page says DEPRECATED, and Apple has published no replacement for sandboxing CLI processes. It still works and is what srt and Claude Code use. [apple/containerization#737](https://github.com/apple/containerization/issues/737)
- **Apple `container`** runs one lightweight VM per container through Virtualization.framework. [github.com/apple/container](https://github.com/apple/container)
- **Landlock** ABI 4 added TCP bind/connect limits, ABI 6 added scoping for abstract Unix sockets and signals, ABI 10 added UDP. It can only restrict **ports, not destinations**. [docs.kernel.org Landlock](https://docs.kernel.org/userspace-api/landlock.html). The kernel versions (ABI 4 = 6.7, ABI 6 = 6.12) are from memory and uncertain.
- **gVisor and Firecracker:** I didn't research these this session.

### 2. Egress

- srt sends all traffic through its own HTTP and SOCKS5 proxies. On Linux the network namespace is removed and the proxies are reached over Unix sockets. It resolves each allowed host once and blocks loopback, link-local and metadata IPs ([srt README](https://github.com/anthropic-experimental/sandbox-runtime)).
- **DNS exfiltration is real.** AWS Bedrock AgentCore's "sandbox mode" still allowed DNS resolution, and AWS documented that rather than fixing it ([Unit 42](https://unit42.paloaltonetworks.com/bypass-of-aws-sandbox-network-isolation-mode/)). *Implication:* give the sandbox no resolver of its own; resolve only in the proxy.
- Allowing `github.com` or the npm registry lets sandboxed code push or publish anywhere (Claude Code docs, above). For a local LLM, the default should be **no network at all**, opened only per step with specific hosts.

### 3. Running git in untrusted directories

- **"GitSpawn" (Manifold, 2026-09-01).** Agents run background `git status`/`diff`, which executes the repo's `core.fsmonitor`. Affected: Claude Code (fixed in 2.1.196), Codex and Cursor (fixed), Goose (CVE-2026-72718, fixed), and Hermes (GHSA-7x36-8jrh-v4pw / CVE-2026-71963), Qwen Code and Grok Build (not fixed as of that post). [manifold.security](https://www.manifold.security/blog/ai-coding-agents-git-hijack). Hermes's fix pins keys through `GIT_CONFIG_*`, ignores global/system config and adds `--no-ext-diff --no-textconv` ([PR #101483](https://github.com/NousResearch/hermes-agent/pull/101483)).
- **Claude Code before 2.0.71** (fixed 2025-12-16) ran `core.fsmonitor`, and `log.showSignature`→`gpg.program`, before the trust dialog. [Sonar, 2026-04-30](https://www.sonarsource.com/blog/claude-arbitrary-code-execution/). Headless `git status` without an fsmonitor override was reported in Aug 2026; Anthropic called it "Informative", saying headless callers must trust the workspace themselves ([Cymulate](https://cymulate.com/blog/headless-claude-code-git-config-command-execution/)). *Implication:* your harness is that caller.
- **Copilot CLI CVE-2026-45033 / GHSA-9ccr-r5hg-74gf** (fixed in 1.0.43). A nested bare repo in the project made git read its config and run `core.fsmonitor`. The fix sets `safe.bareRepository=explicit` through `GIT_CONFIG_COUNT`. [Advisory](https://github.com/github/copilot-cli/security/advisories/GHSA-9ccr-r5hg-74gf). Git 3.0 plans to make `explicit` the default ([BreakingChanges](https://git-scm.com/docs/BreakingChanges)). `safe.bareRepository` and `safe.directory` are read **only from protected config** (system, global, command) ([safe.adoc](https://raw.githubusercontent.com/git/git/master/Documentation/config/safe.adoc)).
- **Cursor, Windows.** Cursor ran a `git.exe` found in the workspace root; not fixed as of 2026-07 ([THN](https://thehackernews.com/2026/07/cursor-flaw-lets-malicious-cloned.html)). *Implication:* always call git by an absolute path.
- **Git CVEs** (from git/git GHSAs):
  - CVE-2024-32002 (CVSS 9.1): symlink plus case-insensitive filesystem lets a submodule clone write hooks. Mitigated by `core.symlinks=false`.
  - CVE-2024-32004: cloning a crafted local repo runs code.
  - CVE-2024-32465: repos from untrusted archives bypass clone protections.
  - All three published 2024-05-14, fixed in 2.45.1 and backports.
  - CVE-2025-48384: a trailing CR in config redirects a submodule path, so a hook runs. Published 2025-07-08, added to CISA KEV 2025-08-25.
  - CVE-2025-48385: bundle-uri injection.
  - CVE-2025-46835: Git GUI.
  - The 2025 fixes shipped in 2.50.1 and backports.

  [git advisories](https://github.com/git/git/security/advisories); [GitHub blog 2025-07-08](https://github.blog/open-source/git/git-security-vulnerabilities-announced-6/)
- **CVE-2022-24765** (2022-04-12): git discovered a `.git` owned by someone else, which led to `safe.directory` in 2.35.2 ([GHSA-vw2c-22j4-2fh2](https://github.com/git-for-windows/git/security/advisories/GHSA-vw2c-22j4-2fh2)).
- **The per-command overrides don't cover everything.** Precedence is `-c` over `GIT_CONFIG_*` over the repo's own config ([git-config](https://git-scm.com/docs/git-config)). But clean/smudge filters and diff/merge drivers are named by the attacker in `.gitattributes` plus config, so a fixed list of flags can't cover them. Note that `status` can run clean filters. **Inferred:** the real defense is that sandboxed code can never write `.git/`.

### Recommended git hardening

- **Git binary:** an absolute path, and version ≥ 2.50.1.
- **Environment:**
  - `GIT_CONFIG_NOSYSTEM=1`
  - `GIT_CONFIG_GLOBAL=/dev/null`
  - `GIT_TERMINAL_PROMPT=0`
  - `GIT_NO_REPLACE_OBJECTS=1`
  - `GIT_OPTIONAL_LOCKS=0`
  - `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`, `GIT_PAGER=cat`
  - `GIT_ASKPASS=` and `SSH_ASKPASS=` (empty)
  - `GIT_DIR` and `GIT_WORK_TREE` set explicitly, plus `GIT_CEILING_DIRECTORIES`
  - `GIT_CONFIG_COUNT`/`KEY`/`VALUE` pinning: `safe.bareRepository=explicit`, `core.fsmonitor=false`, `core.hooksPath=/dev/null`
- **`-c` flags:**
  - `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.untrackedCache=false`
  - `core.pager=cat`, `core.editor=true`, `core.sshCommand=false`, `core.askPass=`, `core.symlinks=false`
  - `credential.helper=`, `gpg.program=false`, `commit.gpgSign=false`, `log.showSignature=false`
  - `diff.external=`, `protocol.allow=never` (or `protocol.file.allow=never`), `submodule.recurse=false`
  - `uploadpack.packObjectsHook=`, `include.path=`
- **Per command:**
  - diff/log/show: `--no-ext-diff --no-textconv`
  - commit: `--no-verify -m …`
  - never `--recurse-submodules`
- **Preflight** (inferred, not from a single source):
  - Keep `.git` outside the model's writable roots, or re-mount it read-only as Codex does. If `.git` isn't writable, filters, drivers and `include` can't be planted.
  - Read `.git/config` with `git config --file … --no-includes --list`. Refuse to proceed on `core.fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy`, `filter.*`, `diff.*.(command|textconv)`, `merge.*.driver`, `include*`, `gpg.*`, `credential.*`, or `remote.*.(uploadpack|receivepack)`.
  - Scan the worktree for nested `HEAD`+`objects` directories (embedded bare repos), `.git` files or symlinks, and CR characters in `.gitmodules`.

### Sandbox recommendation

- **macOS:** use Seatbelt via srt or an equivalent profile generator.
  - Default-deny writes except the card worktree, with `.git/` as a mandatory deny.
  - No network, or localhost-proxy only, with an exact-host allowlist and no wildcards like `github.com`.
  - Block Apple Events and Unix sockets.
  - Deprecated but still the practical choice. For stronger isolation, run the test gates inside an Apple `container` VM.
- **Linux:** bubblewrap with `--ro-bind / /`, the worktree bound read-write, `.git` re-bound read-only, and `--unshare-net` (plus `--unshare-pid`, `--die-with-parent`).
  - seccomp to block `AF_UNIX`/`AF_INET` socket creation.
  - Landlock (ABI ≥ 4 or 6) as a second layer. Its network control is port-only, so it can't enforce domains.
  - Egress, if needed, goes through a harness-owned proxy over a Unix socket. No DNS inside the sandbox, canonical hostname checks, and IPs re-checked after resolution.
  - Never use the weaker nested mode. Use gVisor or a Firecracker microVM where the host allows it (not researched this session).
- **Both:** run git as the harness, outside the sandbox, with the hardening above. Treat every file the model wrote as hostile input to git.

## Group C: competitive landscape and professional practice

### Competitive landscape and practice digest for Sekhemet (researched 2026-09-22)

The main finding: the big trackers now let you hand a ticket to a cloud coding agent, and Linear now has a built-in agent that non-developers can chat with. None of them combines a local model, required test/typecheck/lint gates and teaching beginners. That combination is still open.

### 6. Competitive landscape

**Project-management platforms (all cloud)**
- **Linear Agent** (public beta, 2026-03-24) is built into Linear. It knows the roadmap, issues and code, can chat, triage, plan and create issues, and has reusable "Skills". Linear pitches it to non-technical teammates, who can "ask questions they'd normally have to track down an engineer to answer." Source: "Introducing Linear Agent", https://linear.app/changelog/2026-03-24-introducing-linear-agent.
  - Code Intelligence (2026-05-14) says "PMs can write sharper specs": https://linear.app/changelog/2026-05-14-code-intelligence
  - Coding sessions (2026-06-11) let Linear Agent write code in the cloud using Claude Code and Codex, so users "triage, plan, review, and ship" in Linear: https://linear.app/changelog/2026-06-11-coding-sessions
  - Loops (2026-09-14) are recurring agent workflows that update plans and documents when scope or dates change: https://linear.app/changelog/2026-09-14-loops-for-product-management
  - **Implication:** "non-developers talk to a PM agent" is now a shipped feature from a market leader. Sekhemet cannot rest on it. What it can offer instead is local/private operation, gated delivery and teaching.
- **Linear delegation model:** a human stays the assignee ("remains responsible for the work") and the agent is a separate delegate. Source: "Assign and delegate issues", https://linear.app/docs/assigning-issues (undated). Cursor (2025-08-21), Codex (2025-12-04) and Copilot (generally available 2026-07-23, https://github.blog/changelog/2026-07-23-copilot-cloud-agent-for-linear-is-now-generally-available/) all take Linear issues and return draft PRs.
  - **Implication:** copy this split (human owner plus agent delegate) on Sekhemet's cards. It is becoming the convention people expect.
- **Jira:** work items can be given to Rovo agents or GitHub Copilot through the agent picker, @mentions, workflow transitions, or by assigning an agent to a board column. The support page says nothing about acceptance criteria or a definition of done. Source: "Collaborate on work items with AI agents", https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/.
  - An Atlassian engineer describes writing Jira items as detailed specs, including test scenarios, for Rovo Dev to execute (2026-05-13): https://www.atlassian.com/blog/development/rovo-dev-in-jira-as-my-spec-driven-executor
  - **Implication:** "the column triggers the agent" is now a Jira pattern. Sekhemet's value is that a card cannot pass a column until its gates pass, and Jira does not enforce that.
- **GitHub:** since 2026-03-26, agent sessions (Copilot, Claude, Codex) show on issues and on Projects boards with the statuses queued / working / waiting for review / completed. Source: https://github.blog/changelog/2026-03-26-agent-activity-in-github-issues-and-projects/
- **Devin:** starts from Linear by assignment, by playbook labels (!plan, !implement) or by comment. Source: https://docs.devin.ai/integrations/linear
- **Factory:** delegation from Linear/Jira. The claim that it pulls in acceptance criteria comes only from a search snippet of factory.ai; I did not open the page, so treat it as **uncertain**.

**Spec-driven tools**
- **Kiro** writes requirements.md in EARS notation, then design.md, then tasks.md. It supports requirements-first or design-first, bugfix specs, and runs tasks in dependency "waves". Page updated 2026-08-27: https://kiro.dev/docs/specs/
  - It also generates property-based tests from EARS criteria ("Does your code match your spec?", 2025-11-17). Kiro calls this "evidence of correctness", not proof: https://kiro.dev/blog/property-based-testing/
- **GitHub Spec Kit** (about 138k stars): constitution → specify → plan → tasks → implement → converge, plus bug and "assess" commands. The README shows nothing on local models or Given/When/Then. https://github.com/github/spec-kit
- **Tessl** (2025-09-23): Spec Registry in open beta; the Framework, where each spec capability has "a linked test", in closed beta. https://tessl.io/blog/tessl-launches-spec-driven-framework-and-registry
- **BMAD-Method** (about 53k stars): Clarify → Plan → Build and Verify → Learn loop, sized to the scope of the change. No mention of local models. https://github.com/bmad-code-org/BMAD-METHOD
- **Implication:** specs → tasks is table stakes. What is scarce is a spec whose criteria turn into required gates, and a spec pipeline that runs on a small local model.

**Boards and orchestrators**
- **Vibe Kanban:** Bloop, the company behind it, shut down on 2026-04-10. The project continues as community open source; server features were removed after 30 days and local workspaces still work. https://www.vibekanban.com/blog/shutdown
  - **Implication:** there was demand (28k stars) but no business model. The "kanban board for agents" niche is now thin and community-run.
- **Backlog.md** (about 6.8k stars): tasks are Markdown files with status, assignee, labels, acceptance criteria, definition-of-done checklist, priority and dependencies. It works offline ("no server, no account, no telemetry") and has MCP support. Rule of thumb: "one task = one context window = one PR." https://github.com/MrLesk/Backlog.md
  - **Implication:** the closest local-first analog to Sekhemet's card anatomy. Worth borrowing its DoD checklist.
- **Taskmaster** (about 28k stars): turns a PRD into tasks with dependencies, priority and a test strategy, has a complexity report, and supports Ollama. https://github.com/eyaltoledano/claude-task-master
- **Conductor:** runs parallel Claude Code/Codex agents in worktrees on a Mac. Source is secondary only, **uncertain**.
- **Crystal:** its repo title says it is now Nimbalyst (search listing only).

**Coding agents: local-model capability and gates**
- **Codex CLI** `--oss`: default model gpt-oss:20b, which needs about 16 GB; Ollama or LM Studio. Source: https://docs.ollama.com/integrations/codex (seen in search, not opened).
- **OpenHands:** recommends Qwen3.6-35B-A3B, which needs at least 64 GB unified memory on a Mac. It warns that the default 4k context is "way too small" (22k minimum, 32k+ recommended) and that weak models behave "like a plain chatbot." https://docs.openhands.dev/openhands/usage/llms/local-llms
  - **Implication:** a 24 GB Mac sits below OpenHands' recommended tier. Sekhemet's small cards and gates are what make small models workable, and that is worth saying loudly.
- **Aider:** lints automatically, and with `--test-cmd --auto-test` runs tests after each edit and tries to fix failures. https://aider.chat/docs/usage/lint-test.html
  - This is the closest thing to executable gates, but it is per edit, not a card-level acceptance gate.
- **Cline** has documentation for local models (docs.cline.bot; search only).
- **Roo Code** is reportedly archived as of 2026-05-15, per secondary sources: **uncertain**.
- **Teaching:** Claude Code's "Learning" output style adds explanation blocks and leaves `TODO(human)` pieces for the user to write. https://code.claude.com/docs/en/output-styles
  - This is the only built-in teaching mode I found. It teaches coding, not professional practice.

### 7. Professional kanban conventions

- **Linear default workflow:** Backlog > Todo > In Progress > Done > Canceled, plus Triage (an inbox) and Duplicate (reserved). No WIP limits are documented. https://linear.app/docs/configuring-workflows
- **Jira:**
  - The left-most board column counts as To Do and the right-most as Done.
  - Turning on Estimation adds a Story points field, which measures relative effort, not time.
  - Turning on Sprints adds a Sprint field.
  - Sources: https://support.atlassian.com/jira-software-cloud/docs/what-are-story-points/ and https://support.atlassian.com/jira-software-cloud/docs/configure-estimation-and-tracking/
- **GitHub:**
  - Sub-issues and issue types went to public preview in January 2025: https://github.blog/changelog/2025-01-12-evolving-github-issues-public-preview/
  - The CLI manages sub-issues, types and dependencies as of 2026-06-10: https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/
  - "Issue fields GA" appears only in search text: **uncertain**.
- **The Kanban Guide** (May 2025, Vacanti/Coleman), https://kanbanguides.org/the-kanban-guide/2025.5/:
  - A Definition of Workflow needs work items, start and finish points, states, WIP control, explicit policies, and a Service Level Expectation (for example, 85% of items finish within 8 days).
  - The four required flow metrics are WIP, Throughput, Work Item Age and Cycle Time.
  - **Implication:** Sekhemet can teach real practice by showing Work Item Age on cards, per-column WIP limits and an SLE. Linear doesn't offer these natively, so it would stand out.
- **NN/g, "Onboarding Tutorials vs. Contextual Help"** (Laubheimer, 2023-02-12), https://www.nngroup.com/articles/onboarding-tutorials/:
  - Tutorials shown up front ("push revelations") interrupt people, are forgotten, and don't improve performance.
  - Help shown in context when it's needed ("pull") works better if it is dismissible, can be found again, and uses progressive disclosure.
  - Don't explain standard conventions.
- **NN/g, "Designing Empty States in Complex Applications"** (Kaplan, 2021-09-19), https://www.nngroup.com/articles/empty-state-interface-design/:
  - Empty states should show system status, give learning cues, and offer a direct path to the next task.
  - **Implication:** teach through empty columns, first-time field hints and "why?" affordances that experts can ignore, not through a guided tour.

### 8. Checkable acceptance criteria and evidence on their quality

- **EARS in Kiro:** criteria follow "WHEN [condition] THE SYSTEM SHALL [behavior]", and Kiro's property-based testing turns them into executable properties. https://kiro.dev/docs/specs/feature-specs/
- **Quattrocchi et al.**, "Can LLMs Generate User Stories and Assess Their Quality?" (arXiv 2507.15157, 2025-07-20), 10 LLMs, https://arxiv.org/abs/2507.15157:
  - Generated stories match human ones on coverage and style but meet acceptance-quality criteria less often, whatever the model size.
  - LLMs do judge story quality reliably when given clear criteria.
  - **Implication:** use a rubric-based critic pass on generated acceptance criteria rather than trusting the first draft.
- **Rathnayake et al.**, BDD scenario generation (arXiv 2603.04729, 2026-03-05), 500 stories, https://arxiv.org/abs/2603.04729:
  - Detailed requirement descriptions produce good scenarios; user stories alone produce poor ones.
  - Temperature 0 worked best.
  - LLM judges agreed with human experts better than similarity metrics did.
- **Siddeeq et al.** (arXiv 2607.01980, 2026-07-02, accepted at SEET 2026), 107 PURE requirements, https://arxiv.org/abs/2607.01980:
  - A JSON-constrained, epic-organized Gherkin pipeline was 100% structurally valid, with 94.3% requirement coverage against 92.9% for the baseline.
  - Experts rated it higher on correctness (4.61 vs 4.14) and executability.
- **Ferreira et al.**, industrial case study (arXiv 2504.07244, AST 2025), GPT-4 Turbo, https://arxiv.org/abs/2504.07244:
  - Testers found the Gherkin scenarios helpful 95% of the time.
  - Of the generated Cypress tests, 60% were usable as-is, 8% needed minor edits, 24% needed regenerating and 8% were discarded.
- **Wang et al.**, RAGcceptance M2RE (arXiv 2508.06888, 2025-08-09), https://arxiv.org/abs/2508.06888: adding screenshots of the UI to the text improved the relevance and correctness of generated criteria.
- **Implication for all of the above:** constrained output (a JSON schema), rich requirement context, temperature 0 and a separate critic pass are the evidence-backed recipe. None of these studies tested small local models, so that remains an open question.

### Gap analysis

- **Local plus gated plus board is still unoccupied.** The leaders (Linear, Jira, GitHub, Devin, Factory) are cloud and don't block on gates. The local tools (Backlog.md, Taskmaster, Aider, Codex `--oss`) lack either a professional board or card-level gates.
- **Nobody teaches professional practice.** Claude Code's Learning style teaches coding. No tool teaches WIP limits, flow metrics, a definition of done or how to write acceptance criteria at the moment they're needed.
- **Required gates that trace back to criteria are rare.** Kiro's property-based tests and Tessl's linked tests come closest. Jira's and Linear's agent integrations document no acceptance or DoD enforcement.
- **Small-model spec quality is unstudied.** The published evidence covers frontier models only, and OpenHands flags weak local models as unreliable. Sekhemet's own evaluation data here would be new.
- **The PM-chat moat is narrowing.** Linear Agent already serves non-technical teammates. Sekhemet should set itself apart on privacy (local), proportional planning in the PM conversation, and "accepted means proven by gates", not on chat alone.

## Group D: measurement, benchmarks, models

I verified most of what you asked from primary pages (Hugging Face model cards, arXiv abstracts and full text, leaderboards). Two things to know first. Cyber-Tiel is not directly a Qwen3.6 fine-tune. And its published comparison with Tiel uses a sample far too small to support a choice between them.

### A. Cyber-Tiel and Tiel (verified on Hugging Face)

- **What it's built from:** Cyber-Tiel-Coder-35B-A3B is a re-quantization of huihui-ai's abliterated version of **Ornith-1.5-35B-A3B**. The re-quantization used a "cyber-weighted" imatrix (the calibration data used when quantizing). Ornith-1.0 was "developed on top of Qwen3.5 and Gemma4" with further pre-training and post-training. Its layout matches Qwen's (40 layers, 256 experts with 8 active plus one shared), but it is not Qwen3.6. The license is MIT. (hf.co/peculiar-ragdoll/Cyber-Tiel-Coder-35B-A3B-GGUF; hf.co/ornith-ai/Ornith-1.5-35B-A3B)
- **Sizes:** IQ3_XXS is 13.2 GB (13.6 GB in the MTP variant); Q3_K_XL is 17.2 GB; Q4_K_M is 22.1 GB and was the version they benchmarked. Tiel lists the same sizes.
  - Implication: only IQ3_XXS leaves real room for the KV cache on 24 GB. **None of the published scores were measured at IQ3.**
- **Scores the Cyber-Tiel card claims:**
  - SWE-bench-Live: 13.7 of 25 on average over 3 runs (15, 13, 13). Tiel's card says 12 of 25.
  - Cybench: 15 of 43 flags.
  - HarmBench: "zero refusals across all 84 requests".
  - The card itself warns "this is not an ordinary coding agent". It insists on OS-level sandboxing and on limiting internet access, and points people unfamiliar with mitigation to Tiel instead.
- **Ornith-1.5's own claims:** SWE-bench Verified 79, SWE-bench Pro 59.6, Terminal-Bench 2.1 67.8 with Terminus-2. These are vendor numbers; I found no independent check.
- **Uncertain:** an X post claims "~70% more" problems solved than Qwen3.6. That appears to come from the same 25-task sample.

### B. Benchmarks that measure building a project (item 9)

Whether each one runs locally is my own judgment unless a source says so.

- **DevBench / DevEval** (arXiv 2403.08604): covers the whole lifecycle — design, environment setup, implementation, acceptance tests and unit tests — in 4 languages. GPT-4 "fail[s] to solve" it. I did not confirm its size. It is the most direct planning measure here because design is its own stage. Probably runnable locally.
- **Commit0** (2412.01769): the agent writes a whole library from its spec and is scored on unit-test pass rate. 54 Python libraries, with a 16-library "lite" split. Best reported scores were 42.95% on lite (OpenHands) and 6.12% on the full set. It uses Docker, optionally with Modal. The lite split is a good candidate locally.
- **ProjDevBench** (2602.01655): the agent builds a repository from high-level requirements. Scoring uses online-judge tests plus LLM code review, which includes judging the architecture. 20 problems in 8 categories; overall acceptance rate was 27.38%. It is small, so it runs locally. It is a strong planning candidate but a statistically weak one.
- **NL2Repo-Bench** (2512.12730, ICML 2026): one requirements document and an empty workspace; the result must be an installable Python library. 104 tasks, with specs averaging about 18.8K tokens. The best agents pass under 40% of tests on average. The paper names "inadequate planning" and "premature termination" as failure modes. Good planning measure, but a small model at IQ3 will likely score near the floor.
- **SlopCodeBench** (2603.24755): the agent keeps extending its own code as the spec changes. 20 problems and 93 checkpoints. It measures verbosity and "structural erosion". No model finished any problem end to end; the best checkpoint rate was 17.2%. This is a good test of whether the plan holds up over time.
- **FeatBench** (2509.22237): features described only in natural language. 157 tasks from 27 repositories; the best resolved rate was 29.94%. It highlights "scope creep" regressions.
- **FeatureBench** (2602.10975, ICLR 2026): 200 tasks from 24 repositories. Claude 4.5 Opus solved 11.0% here against 74.4% on SWE-bench.
- **SWE-Dev** (2505.16975): 14,000 training and 500 test tasks, each with its runnable environment. Under 30% Pass@3 on the hard tasks.
- **Breakpoint** (2506.00172): code-repair tasks made by corrupting functions, with difficulty controlled for local versus system-level reasoning. It measures repair and diagnosis, not planning.
- **SWE-Lancer** (2502.12115): about 1,400 Upwork tasks worth $1M in total. 88% of the IC tasks are bug fixes, so it is a weak planning measure. It also carries a heavy environment.
- **Terminal-Bench 2.0** (2601.11868): 89 Docker tasks run through the Harbor harness. Runnable locally, but it doesn't measure planning.
- **SWE-bench Pro** (2509.16941): 1,865 tasks, with a public set of 731. Long-horizon, multi-file changes.
- **SWE-rebench:** a rolling, decontaminated leaderboard. The current window is 111 problems (May 15–Jul 1, 2026). Qwen3.6-35B-A3B scores **24.7% ±0.79 (43.2% pass@5)** and Qwen3.5-35B-A3B 17.1%. Implication: the 73.4% Qwen reports on SWE-bench Verified does not carry over to fresh tasks. Treat every vendor or model-card number, Ornith's included, as an upper bound.
- **PaperBench** (2504.01848): replicating 20 papers, graded on 8,316 rubric items by an LLM judge. The best score was 21.0%. There is a lighter Code-Dev variant. Too heavy to run locally.
- **ProjectEval** (2503.07010): scores generated projects by simulating a user interacting with them. I did not verify its size.
- **DeNovoSWE** (2606.10728): 4,818 training environments, not a benchmark. Fine-tuning Qwen3-30B-A3B on it moved a doc-to-repository benchmark from 5.8% to 47.2%.

### C. Statistics with small samples (item 10)

- **Miller, "Adding Error Bars to Evals"** (2411.00640; Anthropic's "A statistical approach to model evaluations" blog is the companion):
  - Use paired differences between variants. Scores are positively correlated across models, so pairing is "a 'free' reduction in estimator variance".
  - Use clustered standard errors when tasks come in related groups; these came out 3× larger on DROP.
  - Resampling each question helps: 2 samples per question cut variance by 1/3, 4 samples by 1/2.
  - Sample size: n = (z_{α/2}+z_β)²(ω²+σ²_A/K_A+σ²_B/K_B)/δ². The paper's example needs about 969 questions to detect a 3-point difference.
- **Bowyer et al.** (2503.01747, ICML 2025): the standard (CLT) error bars "dramatically underestimat[e]" uncertainty below a few hundred items. Use Bayesian or exact methods instead; there is a library at github.com/sambowyer/bayes_evals.
  - Implication: at 25–50 tasks, use a beta-binomial model or an exact McNemar test.
- **Bjarnason et al., "On Randomness in Agentic Evals"** (2602.07150, Feb 2026): 60,000 trajectories on SWE-bench Verified. Single-run pass@1 swings by 2.2–6.0 points, and the standard deviation exceeds 1.5 points even at temperature 0. They recommend multiple runs, a power analysis, and reporting pass@k and pass^k.
- **HAL** (2510.11977): 21,730 rollouts. Higher reasoning effort *reduced* accuracy in most runs. Reading the logs found agents looking up benchmark answers on Hugging Face instead of solving the task.
- **Madaan et al.** (2406.10229): variance is rarely quantified. Item response theory "struggle[s] to meaningfully reduce variance"; continuous metrics can help.
- **Sequential testing:** Hsu & Shekhar (2607.17409, Jul 2026, preliminary) build confidence sequences that stay valid when you stop early. Plain uniform sampling sometimes beats adaptive querying. I found no study of SPRT specifically for agent pass rates.
- **My own computation** (normal-approximation McNemar plus exact enumeration; α=0.05, 80% power, detecting a 10-point gain):

  | Share of tasks where the variants disagree | Paired tasks needed |
  |---|---|
  | 10% | ~76 |
  | 20% | ~155 |
  | 30% | ~233 |

  - Unpaired, going from 50% to 60% would need ~388 tasks per arm.
  - The exact McNemar test is conservative: at 155 tasks with 15%/5% discordance its power is 0.76.
  - At 25 tasks, power is only about **6–7%**. So the Cyber-Tiel vs Tiel gap (13.7 vs 12 out of 25) is uninformative.
  - For a verdict with a few dozen tasks, run a sequential or Bayesian test and aim to detect only large effects (≥20 points).

### D. Models for 24 GB and quantization (item 11)

Model-card numbers, each from its own scaffold, so they are not comparable with each other:

| Model | SWE-bench Verified | Terminal-Bench 2.0 | Other |
|---|---|---|---|
| Qwen3.6-35B-A3B | 73.4 | 51.5 | Pro 49.5; bash + file-edit tools, temp 1.0, 200K context |
| Qwen3.6-27B (dense) | 77.2 | 59.3 | Pro 53.5 |
| Devstral-Small-2-24B-2512 | 68.0 | 22.5 | Card says it fits a "32GB Mac" |
| GLM-4.7-Flash (30B-A3B) | 59.2 | — | Its table lists Qwen3-30B-A3B at 22.0 and gpt-oss-20b at 34.0 |
| gpt-oss-20b | 53.2 at "medium" | — | Runs in 16 GB with MXFP4; I did not confirm the number beyond a summary |

- Qwen3-Coder-30B-A3B's card gives no SWE-bench number.
- I did not verify Q4 file sizes for the 27B or 24B dense models. Roughly 14–17 GB is likely, but that is uncertain.
- **Quantization:** Jang et al. (2607.27275) compared BF16, FP8 and INT4 on τ²-bench, including Qwen3.6-35B-A3B. Final scores showed no significant change. But tool-name hallucination rose up to 2.5× (19.5%→38.3% for Gemma-4 dense). Tightening the error budget exposed a 16.7-point deficit. **3-bit was not tested.** I found no source measuring IQ3 against Q4 on agentic coding.
  - Implication: IQ3_XXS is unmeasured. Track tool-call error rates in your own runs, not just the final pass/fail.

### E. Abliteration and agent safety

- **Arditi et al.** (2406.11717): refusal is a single direction in the model's activations, found in 13 models up to 72B. Removing it "surgically disables refusal with minimal effect on other capabilities."
- **David & Gervais** (2605.17413): removing the single refusal vector barely changed the security score (0.46→0.50). It raised unsafe compliance from 0.10 to 0.47. Task-specific LoRA did better on both counts.
- **Fafuła** (2607.17427, single author): tested huihui-ai abliterations of Qwen3-30B-A3B and Gemma-4-26B-A4B. Capability was unchanged, but decisions shifted in ways nobody targeted: +7.4 to +12.2 points more optimistic bets, and less uncertainty language. This implies side effects on how the model judges things, not only on refusals.
- **AgentHarm** (2410.09024): 110 malicious tasks (440 with augmentations). Leading models comply without any jailbreak, and jailbroken agents stay fully capable.
- **BrowserART** (2410.13886): refusal training doesn't carry over to agents. GPT-4o's browser agent attempted 98 of 100 harmful behaviors.
- **OS-Harm** (2506.14866): 150 tasks. Models are vulnerable to static prompt injections and occasionally take unsafe actions.
- **Yu et al.** (2505.14215): aligned models with retrieval can behave less safely than uncensored models without it.
- **Evidence gap:** I found no study that directly measures whether abliteration increases destructive actions or compliance with prompt injections by an autonomous coding agent. The link is inferred: zero HarmBench refusals, plus refusal being the main in-model defense.
- **Mitigation:** the 2026 prompt-injection literature (e.g. 2606.26479) favors enforcing policy deterministically outside the model — capability limits, reference monitors. That fits the model card's own demand for OS-level sandboxing.
  - Implication: if you keep Cyber-Tiel, the harness's sandbox and permission layer is the only thing standing between it and destructive actions. Otherwise, run Tiel as the default and use Cyber-Tiel only in an isolated environment for security work.
