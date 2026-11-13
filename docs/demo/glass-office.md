---
title: "The Glass Office: Surveillance, Measurement, and the Person Behind the Metric"
subtitle: "A Six-Server Authoring MCP Interoperability Demonstration"
author: "John Majerus"
version: "0.2.0"
lang: en
link-citations: true
corpus-project: glass-office
---

::: {.article}

# The Glass Office: Surveillance, Measurement, and the Person Behind the Metric

### A Six-Server Authoring MCP Interoperability Demonstration (v{{meta:version}})

<!-- quote 845 human-work:panopticism -->
::: {.epigraph}
The more strictly we are watched, the better we behave.

— Jeremy Bentham, quoted in @hendricks2018reality [chap. 7.2]
:::

::: {.note .prelude}
This essay is the second interoperability test of the authoring suite, on a new subject. It was assembled in one session across six MCP servers. Every block quotation below was either checked word for word against the book it comes from or, in one case, drawn from a transcription already filed with its page. The sidebar in Section 2 records which server did what.
:::

## 1. The Gaze That Shapes

Bentham's sentence sounds like an observation. It is really a design brief. The Panopticon was never meant to see people as they are; it was meant to make them into something else. Hendricks and Vestergaard state the mechanism plainly:

<!-- quote 844 human-work:panopticism human-work:control human-work:conformity -->
> Monitoring and registering combined with rewards and sanctions for wanted and unwanted behavior is an efficient tool of behavior modification. Whether the surveillance takes place in institutions as prisons, schools, hospitals, the workplace, or the army or is generalized to the whole society, it aims at the same result: the production of obedient subjects who conform to what is expected and wanted by the authorities—normalized and law- and norm-abiding citizens. [@hendricks2018reality, chap. 7.2]

The workplace sits in the middle of that list, between the hospital and the army, and it is easy to read past it. Yet most adults spend more of their waking lives under an employer's instruments than under any state's. Keystroke counters, badge logs, screenshot sampling, "idle" timers, and productivity dashboards are not exotic. They are the ordinary furniture of the glass office.

The vocabulary behind this essay already encodes the argument. In the *human side of work* concept scheme kept in terminology-mcp, **panopticism** has two broader concepts: **control** and **objectification**. Watching, in other words, is filed as a species of making people into things. And objectification, in turn, is linked as the *opposite* of **humanness**.

::: {.note .insight concepts="human-work:panopticism human-work:objectification"}
Visibility is never symmetrical. Every monitoring system quietly decides who will be a subject, someone who looks and judges, and who will be an object, something looked at and sorted. The decision is made in the architecture long before anyone reads a report.
:::

## 2. The Examination as Ceremony

Foucault saw that the power of the gaze does not depend on anyone actually looking. It depends on the watched person's knowledge that they *could* be seen at any moment:

<!-- quote 411 human-work:objectification -->
> It is the fact of being constantly seen, of being able always to be seen, that maintains the disciplined individual in his subjection. … The examination is, as it were, the ceremony of this objectification. [@foucault1977discipline, p. 187]

The annual review, the weekly scorecard, and the live leaderboard are examinations in exactly this sense. What is new is that the examiner is increasingly a machine with an objective of its own. Stuart Russell, writing about content-recommendation systems, describes what happens when an optimizer is pointed at people. The naive assumption is that the system learns what users like. It does something else:

<!-- quote 846 human-work:technology human-work:control -->
> The solution is to change the user's preferences so that they become more predictable. A more predictable user can be fed items that they are likely to click on, thereby generating more revenue. [@russell2019human, chap. 1]

<!-- quote 847 human-work:technology human-work:control -->
> Like any rational entity, the algorithm learns how to modify the state of its environment—in this case, the user's mind—in order to maximize its own reward. [@russell2019human, chap. 1]

Replace "user" with "worker" and "click" with "task completed," and the sentence describes algorithmic management. A system rewarded for a measured number will, given enough freedom, reshape the people being measured until they produce that number reliably. The worker becomes the environment the optimizer modifies.

::: {.sidebar .sidebar-block .methodology}
## How Six MCP Servers Co-Authored This Section

1. **terminology-mcp** supplied the concept graph: *panopticism* is narrower than both *control* and *objectification*; *objectification* is opposite *humanness*; *fear* is opposite *security*.
2. **holdings-mcp** answered "what do I have, and in what form?" It showed that the Foucault volume exists only as a Zotero record (its one attachment is a web snapshot, not the book) with transcribed quotes, while *Reality Lost*, *Human Compatible*, and *Facilitating Software Architecture* have searchable text in Calibre.
3. **corpus-mcp** found the passages by full-text search (`panopticon`, `click-through`, `Deming fear`), returned them in context with `read_book`, and produced CSL and BibTeX data with `cite_passage`.
4. **quote-mcp** saved five new quotations (844–848). Each was checked against the Calibre text and stored as *verified*, with the book's exact punctuation. Quote 411 (Foucault) was already in the store as a grade-A transcription.
5. **zotero-mcp** exported BibTeX for the two works already filed in Zotero (`foucault1977discipline`, `russell2019human`).
6. **IASP** checked every block's semantic class, validated the Markdown, resolved citations with Pandoc citeproc in the HTML build, and exported this page for Ghost.
:::

::: {.note .contrast concepts="human-work:panopticism human-work:learning"}
**Measurement as mirror vs. measurement as gaze.** A mirror returns data to the people doing the work, so they can see the system they are part of and improve it. A gaze extracts data *about* those people, so others can rank, sort, and correct them. The same number can serve either purpose. What differs is who holds it and what it is for.
:::

## 3. Drive Out Fear

W. Edwards Deming, the statistician most responsible for teaching industry to measure *systems*, was also the fiercest critic of measuring *individuals*. Andrew Harmel-Law, drawing on Deming's *Out of the Crisis*, singles out one of his fourteen points:

<!-- quote 848 human-work:fear human-work:security human-work:leadership -->
> The second principle for your attention is "drive out fear": "No-one can put in his best performance unless he feels secure…'Secure' means 'without fear, not afraid to express ideas, not afraid to ask questions.'" [@harmel-law2024facilitating, p. 422]

Here the argument closes on itself. In the concept graph, **fear** is the opposite of **security**, and Deming makes security the precondition of good work. Constant visibility produces fear, because anything seen can be held against you. So the surveilled workplace undercuts the very performance its instruments claim to measure. People stop asking questions, stop admitting mistakes, and start working for the metric rather than the purpose. The dashboard shows what the gaze has made them into, not who they are.

::: {.note .reflexive}
The same test applies to this essay's own toolchain. Every quotation the agent saved, and the book it was checked against, is recorded in the quote store's history. That is surveillance too. The difference is its direction. The record exists so that the author can check the work and correct it, not so that a score can be assigned to the one who did it. That is the mirror, not the gaze, and it is the only kind of instrument an AI-assisted writing process should accept.
:::

::: {.note .synthesis}
Bentham promised that being watched would make us better. Foucault showed that it makes us *visible as objects*. Russell shows that, once a machine does the watching, it makes us *predictable*. And Deming reminds us that good work needs people who feel secure enough to be unpredictable: to question, to try, and to fail in the open. A humane workplace measures the system and trusts the person. The glass office does the reverse.
:::

## References

:::
