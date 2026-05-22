# Shadow — Reactive Dog Training Coach

Shadow is an AI-powered reactive dog training coach built on force-free, evidence-based methods. It provides personalised guidance grounded in a curated knowledge base of 26 training topics, 20 breed-specific reactivity profiles, and a three-type reactivity framework (fear / frustration / excitement).

Shadow was created for [Calming Paws](https://github.com/codeWithRewaskar/calming-paws), a reactive dog training app, and is now available as a standalone skill for any LLM.

## Who is this for?

- **Dog owners** living with a reactive dog who want evidence-based, force-free guidance
- **Dog trainers** looking for a structured AI assistant to complement their practice
- **Developers** building pet-care or training apps who want a reactive-dog knowledge layer
- **AI enthusiasts** who want a well-structured domain-specific skill to study or extend

## What Shadow knows

| Area | Coverage |
|------|----------|
| Training techniques | DS/CC, LAT, Engage-Disengage, BAT 2.0, pattern games, stationing, muzzle conditioning, emergency protocols |
| Reactivity framework | Fear-based, frustration/barrier, excitement/over-arousal — identification and treatment |
| Breed profiles | 20 breeds with reactivity types, training nuances, threshold notes, and management tips |
| Safety | Risk-level escalation, aversive method guardrails, medical redirect, certified trainer referrals |
| Resources | 7 recommended books, 4 trainer credential types, finding a qualified trainer |

## Install

Shadow is a single Markdown file ([`SKILL.md`](SKILL.md)). Pick your LLM below and paste it in.

### Claude (claude.ai)

**Create a Project → paste contents into Custom Instructions.**

1. Copy the full contents of [`SKILL.md`](SKILL.md)
2. Go to [claude.ai](https://claude.ai) → **Projects** → **Create project**
3. Name it "Shadow" (or whatever you'd like)
4. Open **Project knowledge / Custom Instructions** and paste the contents
5. Start a new chat inside the Project — Shadow is now your reactive-dog coach

### ChatGPT (chat.openai.com)

**Create a Custom GPT → paste into Instructions.**

1. Copy the full contents of [`SKILL.md`](SKILL.md)
2. Go to [chat.openai.com](https://chat.openai.com) → **Explore GPTs** → **Create**
3. Switch to the **Configure** tab
4. Name it "Shadow", paste the contents into the **Instructions** field
5. Save (Only me / Anyone with link / Public — your call) and start chatting

### Cursor / Continue (IDE)

**Add to `.cursorrules` (Cursor) or `.continuerules` / config (Continue).**

1. Clone or download this repo
2. Copy [`SKILL.md`](SKILL.md) into your project root as `.cursorrules` (Cursor) or append it to your Continue config's `systemMessage`
   ```bash
   # Cursor
   cp shadow-reactivity-coach/SKILL.md /path/to/your/project/.cursorrules

   # Continue — add to ~/.continue/config.json under "systemMessage"
   ```
3. Restart the IDE so the new rules load
4. Shadow's guidance now travels with that workspace

### Claude Code (Skills directory)

```bash
git clone https://github.com/codeWithRewaskar/shadow-reactivity-coach.git
mkdir -p .claude/skills
cp shadow-reactivity-coach/SKILL.md .claude/skills/shadow-reactive-coach.md
```

## Examples

The [`examples/`](examples/) directory contains 10 real conversations showing Shadow in action:

| # | Scenario | Key concepts |
|---|----------|-------------|
| 1 | [What is reactivity?](examples/01-what-is-reactivity.md) | Three types, not aggression, threshold zones |
| 2 | [My dog lunges at other dogs](examples/02-dog-lunges-at-other-dogs.md) | Frustration vs fear diagnosis, Engage-Disengage |
| 3 | [Border Collie threshold work](examples/03-border-collie-threshold.md) | Breed-specific advice, arousal management |
| 4 | [Emergency reaction on a walk](examples/04-emergency-reaction.md) | U-turn, scatter feeding, cortisol recovery |
| 5 | [Is it fear or frustration?](examples/05-fear-vs-frustration.md) | Diagnostic framework, body language |
| 6 | [Training has stalled](examples/06-training-stalled.md) | Cortisol vacation, plateau management |
| 7 | [Just adopted a rescue](examples/07-rescue-dog-first-weeks.md) | 3-3-3 rule, decompression, trigger identification |
| 8 | [Starting muzzle training](examples/08-muzzle-training.md) | Conditioning steps, basket muzzle, timeline |
| 9 | [Small dog fear reactivity](examples/09-small-dog-fear.md) | Chihuahua-specific, choice-based greetings |
| 10 | [Setback after progress](examples/10-setback-after-progress.md) | Non-linear progress, trigger stacking, recovery |

## Project structure

```
shadow-reactivity-coach/
├── SKILL.md          # The complete skill — paste into any LLM
├── README.md         # You are here
├── LICENSE           # CC-BY-4.0
├── CHANGELOG.md      # Version history (currently v2.1)
└── examples/         # 10 conversation examples
```

## Principles

- **Force-free only.** Shadow never recommends aversive tools or punishment-based methods. Hard guardrails block these at the prompt level.
- **Evidence-based.** All knowledge is sourced from vetted force-free training resources and certified bodies (IAABC, CCPDT, KPA).
- **Breed-aware.** 20 breed profiles ensure advice is tailored, not generic.
- **Safe escalation.** High-risk situations always include a certified trainer referral.
- **Type-aware.** The three-type reactivity framework (fear / frustration / excitement) runs through every recommendation.

## Contributing

Contributions welcome! If you'd like to:

- **Add a breed profile** — follow the schema in SKILL.md and include: reactivity type, common triggers, training nuances, management tips, and threshold notes.
- **Add a training topic** — source must be from a certified force-free body or evidence-based reference. No aversive methods, no dominance framing.
- **Fix an error** — open an issue or PR with the correction and your source.

## License

[CC-BY-4.0](LICENSE) — free to use, share, and adapt with attribution.

Built by [Saurabh Rewaskar](https://github.com/codeWithRewaskar) as part of [Calming Paws](https://github.com/codeWithRewaskar/calming-paws).

---

### 🐾 Powered by [Calming Paws](https://calming-paws.com/)

Shadow is the open-source coaching brain behind **[Calming Paws](https://calming-paws.com/)** — the full reactive-dog companion app with **live dog profiles, walk logs, trigger tracking, and progress analytics** built right in. If you'd like the complete experience (not just the LLM prompt), head to **[calming-paws.com](https://calming-paws.com/)**.
