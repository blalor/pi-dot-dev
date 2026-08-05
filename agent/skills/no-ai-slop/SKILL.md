---
name: no-ai-slop
description: "Self-contained rules and examples for writing clear, direct prose without common AI-generated patterns. Consult before writing or editing prose."
ref: https://github.com/realrossmanngroup/no_ai_slop_writing_rules/blob/35e32ae45878148a6bd898572a9d15c96711affe/CLAUDE.md
---

# No AI Slop

Use this skill to write clear, direct, specific prose. Accuracy comes first; never invent a detail to make a sentence sound more concrete.

These rules apply to the prose being drafted. They do not override required terminology, exact quotations, code, configuration, product names, or factual work logs. The bundled [`references/ai-writing-detection.md`](references/ai-writing-detection.md) contains longer word lists and pattern checks, but this file contains the complete working rules.

## Rules

1. **Do not use em dashes.** Use a period, comma, colon, semicolon, parentheses, or rewrite the sentence.

2. **Use only attributable numbers.** Every statistic, date, amount, and measured quantity must come from a real source. If it cannot be supported, remove it.

3. **Do not put clarifications in headings.** Name the section directly. Put qualifications in the body when needed.

4. **Cut intensifiers.** Words such as `extremely`, `dramatically`, `exceptionally`, `significantly`, `incredibly`, `remarkably`, `truly`, `absolutely`, and `literally` usually stand in for evidence. Replace them with a fact or remove them.

5. **Cut hollow claims.** A claim should name a concrete fact, behavior, result, mechanism, or source. Delete statements that assert importance without explaining what happened.

6. **Do not repeat a point.** Say it once. Combine overlapping sections or paragraphs.

7. **Vary structure when the material calls for it.** Repeated paragraph lengths, sentence shapes, and section layouts make prose mechanical. Do not force unlike material into identical templates.

8. **Connect ideas without narrating the document.** Avoid `as discussed above`, `as noted earlier`, and `as we will see`. State the relationship directly.

9. **Do not manufacture urgency.** A call to act must name the real deadline, penalty, failure mode, or consequence.

10. **Do not use scare quotes around ordinary words.** Use quotation marks for exact quotations, titles, or terms that genuinely require them.

11. **Cut filler openings.** Do not use phrases such as `In today's world`, `It's important to note`, `When it comes to`, `At the end of the day`, `In the realm of`, `It goes without saying`, `This is where X comes in`, or `Look no further`. Start with the fact.

12. **Do not start with `Whether you're`.** Address the subject directly.

13. **Write like a researcher, not a copywriter.** Use specific, checkable statements. If a sentence could appear unchanged on an unrelated marketing page, rewrite or remove it.

14. **Do not add synthetic enthusiasm.** Avoid cheerleading, decorative exclamation marks, and unsupported praise. Let the evidence carry the point.

15. **Remove empty hedging.** Phrases such as `helps ensure`, `may be able to`, and `can potentially` obscure the claim. State what happens. Keep uncertainty only when the facts are uncertain, and explain why.

16. **Use descriptive headings.** Do not use dramatic, narrative, clickbait, or vague headings such as `The Hidden Cost`, `Broader Implications`, or `The X Trap`. Name the subject and the concrete issue covered by the section.

17. **Do not fabricate cases or scenarios.** Label hypotheticals as hypothetical. Present an event as real only when it is documented.

18. **Do not fabricate history.** Verify launches, dates, milestones, and sequences before stating them.

19. **Do not fabricate attributions.** Attribute a statement or position only when a real document, transcript, recording, or public statement supports it. Do not infer a person's position from their role, affiliation, or reputation.

20. **Replace stock transitions.** Avoid `Furthermore`, `Moreover`, `Notwithstanding`, `That being said`, `At its core`, `In essence`, `It is worth noting that`, `In the landscape of`, and `To put it simply`. Use a plain connector when one is needed.

21. **Replace inflated verbs.** Avoid `delve`, `leverage`, `utilize`, `facilitate`, `foster`, `bolster`, `underscore`, `unveil`, metaphorical `navigate`, `streamline`, `endeavour`, `ascertain`, and `elucidate`. Prefer direct verbs such as `examine`, `use`, `help`, `support`, `show`, `manage`, `simplify`, `try`, `find`, and `explain`.

22. **Replace academic filler.** Avoid `shed light on`, `pave the way for`, `a myriad of`, `a plethora of`, `paramount`, `pertaining to`, `prior to`, `subsequent to`, `in light of`, `with respect to`, `in terms of`, and `the fact that`. Use the shorter direct equivalent.

23. **Quote sources exactly.** Do not silently correct or clean up quoted text. Mark necessary changes with square brackets, or paraphrase without quotation marks. Name the speaker and medium. Use a block quote for a long quotation so the source's words remain distinct from yours.

24. **Do not narrate unsuccessful research inside the finished prose.** Report supported facts and omit unsupported claims. Do not pad the document with lists of searches that found nothing. This does not apply when the requested artifact is a research log, validation report, or limitations section where the method and missing evidence are themselves relevant.

## Concrete comparison rule

When contrasting two things, name the difference that explains the contrast. Identify the part, version, date, mechanism, configuration, or supply-chain change. If that detail is unknown, do not imply that one case is exempt, newer, better, or unaffected.

Bad:

> New clients are unaffected because they use the new API.

Better:

> Clients using the `v2` endpoint send a cursor token. The changed offset calculation runs only on requests to the `v1` endpoint.

## Worked examples

The examples below show sentence patterns, not facts to copy. Replace placeholders and technical details with evidence from the work being described.

### Replace an intensifier with evidence

Bad:

> The new query is significantly faster.

Better:

> Under `<benchmark workload>`, median query time fell from `<before>` to `<after>`.

Use measured values only when the benchmark output is available.

### Replace a hollow statement with a fact

Bad:

> This change has an important effect on reliability.

Better:

> The change retries failed uploads three times before returning an error.

### Define the mechanism

Bad:

> Caching may potentially improve performance.

Better:

> `getUser` checks the in-memory cache before sending an HTTP request, so a cache hit makes no network call.

### Use a descriptive heading

Bad:

> The Hidden Cost of Caching

Better:

> Cache invalidation after user updates

### Attribute only documented positions

Bad:

> The maintainer has argued that compatibility is essential.

Better:

> In `<issue link>`, `<maintainer>` wrote: “<exact quotation>.”

Use the better pattern only when the linked source contains that quotation.

## Self-check

Before returning prose:

1. Search for the em dash character and remove it.
2. Check every number, date, quotation, and attribution against a source.
3. Remove intensifiers, filler openings, stock transitions, inflated verbs, and academic filler.
4. Replace hollow claims with concrete facts or delete them.
5. Remove repeated points and repeated structural patterns.
6. Check that each heading describes its section without drama or parenthetical clarification.
7. Check each comparison for the concrete difference that makes it true.
8. Keep uncertainty only where the evidence is uncertain, and name the reason.
9. Search for unprocessed citation artifacts such as `oaicite`, `contentReference`, `turn0search0`, and `grok_card`.
10. Read the prose aloud. Rewrite anything that would sound unnatural in a conversation with a colleague.
11. Consult [`references/ai-writing-detection.md`](references/ai-writing-detection.md) for the expanded lint pass when the prose is intended for publication or external review.
