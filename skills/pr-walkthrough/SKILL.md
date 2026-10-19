---
name: pr-walkthrough
description: Helps a human review a PR efficiently — it does not review in their place. Pins the true before-state, quarantines mechanical churn from real behavior change, slices the diff into vertical behaviors, and walks the reviewer through each one with the actual code and full control flow, restates the whole change in plain English to confirm they followed it, then drafts and posts the review they approve. Companion to pr-audit, not a replacement.
allowed-tools: Bash, Read, Glob, Grep, Agent, WebFetch, AskUserQuestion, mcp__codebase-guardian__search, mcp__codebase-guardian__callers, mcp__codebase-guardian__callees, mcp__codebase-guardian__impact, mcp__codebase-guardian__search_doc_sections, mcp__codebase-guardian__search_comments, mcp__codebase-guardian__list_domains, mcp__codebase-guardian__list_tags, mcp__codebase-guardian__index_status
---

# /pr-walkthrough — Human Review Companion

`/pr-audit` produces findings. **This produces understanding, and the findings fall out of it.**

The problem this solves: PRs have become large and are increasingly machine-authored, which makes them hard for a human to hold in their head. An audit hands you a verdict you must either trust or re-derive. That is not review. Review is a person understanding the change well enough to have a defensible opinion about it. This skill builds that understanding, in vertical slices, with the actual code in front of the reviewer.

**The human is the reviewer. You are their instrument.** You do the legwork — reading the base revision, tracing call chains, enumerating call sites, verifying claims. They make the calls. Every finding is a proposal until they accept it.

## Load the shared core first

Read `../_shared/pr-review-core.md` (relative to this skill's base directory) before doing anything else. It holds configuration loading, Phases 0–5, the blind-spot taxonomy, the machine-authored failure modes, and the review record — follow it in full. `/pr-tour` loads the same core; this file adds only how Phase 3 is **presented** here: in the terminal, as prose with quoted code.

## ⚠️ Execution model — this runs INLINE (the inverse of pr-audit)

`pr-audit` dispatches a fresh subagent because implementation memory invites corner-cutting. **This skill is the opposite: the walkthrough MUST run in the main session, because the dialogue with the human is the deliverable.** A subagent cannot have the conversation, cannot be interrupted, cannot be argued with, and cannot absorb the human's domain knowledge mid-stream.

Subagents are used for exactly one thing: **the Phase 1 classification fan-out**, which is read-only inventory work that would otherwise consume the context the dialogue needs.

**Every claim a subagent returns is a hypothesis, not a finding.** Verify it yourself against the code before putting it in front of the human. In practice a meaningful fraction of subagent claims are overstated — a real observation with a wrong severity, a reachability assumption never checked. Presenting those unverified burns the reviewer's trust faster than missing them would.

## Phase 3 presentation — walk each slice in the pane

**One slice per message. Never batch.** The reviewer needs to ask questions before the next slice lands.

Present each slice as the core's Phase 3 arc, in order, quoting real code from the ref in plain fenced blocks.

- **Number your paragraphs** so the reviewer can reply with "27 yes, 29 no."
- **Keep formatting simple.** Terminals mangle nested structures. Plain fenced code blocks, short tables, no deep nesting.
