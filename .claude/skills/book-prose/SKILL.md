---
name: book-prose
description: PROVISIONAL. Shawn Gagné's rules for long-form book prose (book #2, the carbon risk book), drawn from his own edits to Chapter 1. Use together with writing-style and humanizer when editing or drafting chapter text. Where this file and writing-style disagree on book prose, this file wins; where it is silent, writing-style applies.
---

# Book prose: provisional rules

**Status: PROVISIONAL.** Built from one sample: Shawn's tracked edits to the first
5 paragraphs of Chapter 1 (about 450 words, 16 edits, 1 comment, 24 September 2026),
plus the rewrites he chose while reading Chapter 1 v2 the same day.
Every rule below is tentative until it is confirmed against more marked-up pages.
Do not treat any rule here as settled, and do not apply one silently: when a rule
drives an edit, the edit goes in as a tracked change so Shawn can reject it.

Confidence tags follow writing-style: **[high]** 4+ instances, **[mod]** 2-3,
**[low]** 1. Rules tagged **[decision]** are conventions Shawn has to confirm, not
patterns observed in his edits.

Order of operations for an editing pass: humanizer first (remove AI tells), then
the rules here, then the writing-style check for register inflation.

---

## 1. Name the thing. Don't point at it. [mod, strongest pattern]

Repeat the full noun instead of a pronoun or a shortened form when a paragraph
opens, or when another noun has come in since the last mention.

Evidence (4 instances in 5 paragraphs):
- "They call it" → "Insurers call it"
- "The gap is not abstract" → "The protection gap is not abstract"
- "The policies" → "The insurance policies"
- "to handle it" → "to handle them" (the intent was an explicit referent; "them" still
  had none, so v2 uses "those losses")

Check: for each "it", "they", "them", "this" and "that" used as a pronoun, can the
reader name the antecedent without looking back more than one sentence? If not,
repeat the noun.

Limit: name the noun, don't add a clause after it. "The insurance policies" is the
fix. "The insurance policies developed to cover losses" is inflation (see rule 5).

## 2. No trade jargon a general reader has to decode. [mod]

When an insurance or finance term of art appears, replace it with the plain thing
it refers to. Keep a term of art only when the chapter defines it and uses it again.

Evidence (2 instances):
- "that peril" → Shawn replaced it with a placeholder, "<disaster category>". Resolved
  in v2 as "European windstorms".
- "Swiss Re's estimate of what carried a policy" → Shawn's comment: "?? needed??".
  Resolved in v2 as "Swiss Re's estimate of insured losses".

Watch list, to extend as more chapters are marked: peril, carried a policy, cedant,
attachment point, retrocession, penetration (as in insurance penetration), cat
(for catastrophe), tranche, spread (unless defined).

## 3. One idea per paragraph. [low]

Split a paragraph that carries more than one event, example or claim.

Evidence (1 instance): the paragraph holding Hurricane Ian, European windstorms and
the heatwave was split so the heatwave, and then the protection gap definition,
each got a paragraph of its own.

## 4. Spell out the logical turn. [low]

Where a sentence reverses or qualifies the one before it, the connective may be
written in rather than left implicit.

Evidence (1 instance): "The losses themselves are growing faster" → "The losses
themselves, however, are growing faster".

Limit: one connective per turn. Do not chain them ("however, in fact, ultimately").

## 5. Guard against word inflation. [mod, from writing-style §7 plus this sample]

writing-style §7 records that Shawn's revision loop raises register and adds words
without adding information. His Chapter 1 edits showed the same effect, so every
editing pass checks for it:

- Repeated words within a clause: "the most honest measure we have to measure";
  "policies developed to cover losses were never written to cover". Fix by keeping
  the intent and removing the echo ("the most honest way we have to measure").
- Clauses that restate the noun they modify ("developed to cover losses" after
  "insurance policies").
- Register swaps with no change in meaning ("bigger" → "larger", "struggles" →
  "is struggling"). These are left alone when Shawn makes them, but they are not
  introduced by an editor.

## 6. Numbers. [decision: confirm]

writing-style says "numerals always", but that rule comes from email. Book
convention, pending Shawn's decision:

- Spell out a number that starts a sentence ("Ninety-nine percent of..."), or
  rewrite the sentence so it doesn't start with a number. Shawn did this himself.
- Numerals everywhere else for data: "$112.9 billion", "84 percent", "25 years".
- Don't write a spelled-out number followed by the numeral in brackets ("Ninety-nine
  percent (99%)"). That is contract style, not book style.
- Open question: whole numbers under 10 in running prose ("eight insurers",
  "seven hazard types"). The chapter currently spells them out, which is standard
  book style. Keep that until Shawn decides otherwise.

## 7. Units and terms that must not drift. [decision: confirm; accuracy]

- **tonne**, not ton. Carbon credits are issued per metric tonne of CO2e (1,000 kg).
  A US ton is 907 kg, so "ton" understates every volume by about 9% and a market
  reader will notice. If American spelling is wanted, write "metric ton" and use it
  everywhere in the manuscript. Never mix the two.
- **damage** (physical loss), not "damages" (legal award), when describing
  what a disaster destroyed.
- Keep the source's scope exactly: if a figure covers "Europe's 2025 heatwaves",
  the prose can't narrow it to "that single heatwave". Check each scope-changing
  edit against the chapter's Sources entry.

## 8. Mechanical checks Shawn's edits needed

- A sentence starting with a lowercase word after a full stop ("insurers call it").
- A placeholder left in angle brackets ("<disaster category>"). Search for "<" and
  ">" before any reading copy goes out.

## 9. Shawn's spoken voice belongs in the book. [mod]

When offered a neutral version and a first-person version, Shawn chose his own
spoken register both times:
- The concession move from writing-style §5: "I'm not claiming this growth proves
  catastrophe bonds are good for the world... What it proves is narrower". Chosen over
  a neutral claim-first rewrite ("MUCH better").
- The self-implicating aside: "Finance has been trying for more than 30 years
  (I've spent 25 of them inside the attempt)".

So in book prose: offer the first-person, parenthetical version when a passage is
making an argument. Humanizer's "I'm not saying / I'm not claiming" tell does not
apply to Shawn's own concessions; his call transcript is the writing sample that
overrides it. Use the aside where it is the only place a point gets made, not where
the next paragraph makes it anyway (Shawn chose the plain version in that case).

## 10. Don't state an avoided loss as a result. [mod, accuracy]

The book argues that a prevented loss can't be measured, so the prose must not
claim to have measured one. For any prevented outcome, write what was expected,
estimated or bet on, not what "was", unless a cited source measured it.

Evidence (2 instances):
- "Restoring the catchment was cheaper than paying the claims" → "The company's
  arithmetic said restoring the catchment would cost less than paying the claims.
  The insurer was betting it could..."
- A modelled study "found that a dollar... saved $13" → "estimated that a dollar...
  saves $13".

## 11. Claims must survive the chapter's own evidence. [mod, accuracy]

Before a sweeping line stays in, check it against the examples in the same chapter.
Evidence:
- "financial systems are very good at pricing things that happen and very bad at
  pricing things that don't" contradicted the cat bond section (a 1% event that
  mostly doesn't happen). Now "reasonably good at pricing things that might happen
  and very bad at pricing things that were prevented from happening".
- "finance is only now beginning to try" contradicted the author's own 25 years.
- "Finance finds that move almost impossible" sat right after Santam doing it.
  Now "the move finance finds hardest to value".
- Scope words: "ahead of almost everyone" → "ahead of almost every other insurer";
  a 130-person survey can't carry "Companies" flatly.

## 12. Plain, candid tone; no hyperbole. [mod]

Cut idioms that are dramatic and don't describe the thing literally. Evidence:
"murder to value" (cut by Shawn: wrong tone, and it doesn't apply to value). Same
test applied to "at ruinous cost" and "armies of consultants". Still open, Shawn to
decide: "belle of the ball", "where the bodies are buried".

## 13. Repetition checks specific to this book.

- "this book": no more than once per paragraph; use "the book", "here" or "I".
- "For now" and "what matters is": once per chapter each.
- "value" as a verb and noun: watch for 3+ in a paragraph.
- Relative time ("a decade ago", "now") ages badly; use the year.
- One spelling system for the whole manuscript: British "travelled, modelled" vs
  American. Decision pending, alongside tonne.

---

## What would move this out of provisional

- Marked-up pages from at least 2 more chapters, or the rest of Chapter 1.
- A rule reaches **[high]** at 4+ instances across 2+ chapters.
- A rule gets dropped if Shawn rejects the edits it drives twice.
- Shawn confirms or overrides the two **[decision]** sections (6 and 7).

## Change log

- 2026-09-24 (later): rules 9-13 added from Shawn's live read of Chapter 1 v2
  (7 accepted rewrites in the protection gap, cat bond and Santam sections).
- 2026-09-24: first draft, from Shawn's edits to Chapter 1, paragraphs 1-5
  (Chapter_01_Reading_Copy_humanized.docx, tracked changes by Shawn Gagne).
