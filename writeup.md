---
title: "My RAG evaluation was lying to me, twice"
published: true
description: "I built a small RAG CLI, then spent a week measuring it. Three of my four findings were negative, and the most useful one was that my own metric was wrong."
tags: rag, typescript, ai, embeddings
---

I built the usual thing: a CLI that ingests documents, embeds them, and answers questions with citations. Bun, TypeScript, SQLite with `sqlite-vec` for the vector index, Voyage for embeddings, Claude for generation. About 700 lines. Nothing in that stack is interesting — it's a weekend's work and there are fifty tutorials for it.

What turned out to be interesting was the week after, when I tried to find out whether it was any good. I ran four experiments. Three came back negative, and the most valuable one told me my own measurement was broken.

## The setup

3,200 Wikipedia passages, chunked at 500 words with 50 words of overlap, embedded with `voyage-3.5` into 1024 dimensions, stored in a `vec0` virtual table. A query embeds the question, pulls the top *k* by L2 distance, and hands those chunks to Claude with instructions to cite or decline.

A session looks like this — the answer streams, then the sources print, with `*` marking the ones the answer actually cited:

```
$ bun run index.ts query "What is the capital of Uruguay, and how many people live there?" -k 3

Montevideo is Uruguay's capital [1][3]. Its metropolitan area is home to
1.7 million of the country's 3.3 million people [1].

sources:
* [1] data/rag-mini-wikipedia.jsonl#0  — distance 0.846
  [2] data/rag-mini-wikipedia.jsonl#15 — distance 0.916
* [3] data/rag-mini-wikipedia.jsonl#36 — distance 0.922
```

Two of the three retrieved chunks were used; the third was retrieved and ignored. Printing the unused ones turned out to matter more than I expected — the gap between what retrieval surfaces and what the answer leans on is the first place you see retrieval quality without running an eval at all.

The dataset ships 918 question/answer pairs alongside the corpus, which is what made any of this measurable. It does **not** say which passage answers each question, so there's no gold label to compare against. My proxy: a retrieval counts as a hit if the answer string shows up in one of the retrieved chunks.

That proxy is where the trouble started.

## Finding 1: the metric was wrong, and it reversed a conclusion

My first version checked whether the normalized answer appeared as a substring. Simple, obvious, and wrong in a way that took a while to see.

Here's a question it scored as a miss:

> **Q:** What countries border Liechtenstein?
> **Expected:** "Switzerland and Austria."
> **Retrieved, rank 1:** "...a tiny, doubly landlocked alpine country in Western Europe, bordered by Switzerland to its west and by Austria to its east."

Retrieval was perfect. The scorer said no, because the exact phrase "Switzerland and Austria" never appears contiguously.

I switched to token overlap — strip stopwords, and count it a hit if 80% of the answer's content words appear in a single chunk. The measured hit-rate moved from 65% to 78% at k=3. My system had been 13 points better than I thought, the entire time.

There was a second bug of the same kind. The corpus writes "around 60,000" and the answer key writes "60000". Stripping punctuation turned the first into two tokens that could never match the second. Joining digit groups before normalizing recovered another point.

**The part that actually stung:** under the broken metric, hit-rate looked flat from k=3 onward — 65%, 66%, 67% at k=3, 5, 10. I concluded that retrieving more than 3 chunks was wasted context and considered lowering the default. Under the fixed metric the curve keeps climbing: 79%, 82%, 83%. The broken metric didn't just report a wrong number, it pointed me at the wrong decision.

## Finding 2: 20 questions can't measure anything

My first runs used 20 questions, because that's what felt like a reasonable eval set for a side project.

At n=20 I measured 50% at k=3. At n=100, same seed, same code: 65%. (Both under the original substring metric, before the fix above — the point here is the gap, not the level.)

That 15-point gap is pure sampling noise. With 20 questions the 95% interval is roughly ±22 points — wide enough to swallow any change you'd realistically be testing. Two different seeds at n=100 disagree by 1–5 points, which is a usable resolution.

If your eval set is small enough to hand-write in an afternoon, it is small enough to tell you whatever you want to hear.

## Finding 3: hybrid search, bounded before it was built

Hybrid retrieval — merging BM25 keyword ranking with vector ranking — is the standard next move, and I had a motivating example from my own notes. Asking *"what do I need to know about the refinance?"* correctly surfaced a document that contains the words "refinance" and "refi" exactly zero times. Keyword search would have ranked it nowhere.

So I added an FTS5 index over the same chunks and fused the two rankings with reciprocal rank fusion. Result, n=100:

| | k=1 | k=3 | k=5 | k=10 |
|---|---|---|---|---|
| vector | 69% | 79% | 82% | **83%** |
| keyword | 60% | 71% | 78% | 82% |
| hybrid | 67% | 78% | 82% | 83% |

Hybrid tied vector at best and lost at low k. Before touching the fusion weights, I measured *why* — how often each retriever finds something the other misses, at k=10:

```
both retrievers found it   80
vector only                 3
keyword only                2   <- everything fusion could rescue
neither                    15

vector alone 83%      perfect fusion ceiling 85%
```

**Two points of headroom, total.** No fusion scheme — RRF, weighted, learned — can do better than 85% here, and RRF spent its two points demoting good vector hits. That's not a tuning problem, and an afternoon of tuning would have found nothing.

Why so much agreement? These are natural-language questions against encyclopedic prose, where the answering passage shares both meaning *and* vocabulary with the question. Hybrid earns its keep when queries carry exact tokens that embeddings smear — surnames, error codes, part numbers, function names. This corpus has almost none.

The complementarity test took ten minutes and would have saved a day. I'd run it before building any fusion, on any corpus.

## Finding 4: more context around fewer chunks loses to more chunks

The eval surfaced a specific failure that bugged me:

> **Q:** Who graduated in ecclesiastical law at the early age of 20?
> **Retrieved, rank 1:** "He graduated in ecclesiastical law at the early age of 20 and began to practice."

Retrieval was perfect again. The chunk just doesn't contain its own subject — "Amedeo Avogadro" is two chunks upstream, and "He" carries no identity.

The textbook fix is contextual retrieval: prepend document-level context to each chunk before embedding. I couldn't apply it. Every passage in this dataset was ingested as its own single-chunk document, so there is no parent document to inherit context from — the sentence arrived already severed. Worth checking before you budget for thousands of LLM calls to generate context that doesn't exist.

What I could test cheaply: expand each retrieved hit to include the chunks on either side of it. Zero extra embeddings. It fixes the target case exactly — at radius 0 the answer isn't found; at radius 1 the window reads *"Amedeo Avogadro was born in Turin... He graduated in ecclesiastical law..."*

And measured by k, it looks like a clear win: +3 points at k=1, +2 at k=10.

But comparing at equal k is cheating, because each hit now carries up to 3× the text. Matched by context actually consumed:

| context | plain | expanded |
|---|---|---|
| 3 chunks | k=3 → **79%** | radius 1, k=1 → 72% |
| 5 chunks | k=5 → **82%** | radius 2, k=1 → 75% |
| ~10 chunks | k=10 → **83%** | radius 1, k=3 → 81% |

Plain retrieval wins at every budget. Ten independent guesses cover more of the corpus than three guesses padded with their neighbors.

Any technique that adds text per hit has to be compared at matched context, not matched k. Otherwise you're measuring "does more context help" — which it does, trivially, and tells you nothing about the technique.

## Then I read the misses

15 questions were found by neither retriever. I read all 15, which took twenty minutes and should have been the first thing I did.

Eight of them are not answerable by any system: *"What is the first number on the page?"*, *"What is the last word on the page?"*, *"When did he die?"* (no referent), *"What happened in recent years?"*, one requiring arithmetic across two facts, one whose answer is "It is arguable."

Three more were scorer artifacts — the right chunk retrieved, the answer phrased differently, or sitting just under my 80% threshold at 71% and 67%.

That leaves four genuine retrieval failures out of 100.

So the raw benchmark says 83%. Excluding questions with no answer in the corpus, it's closer to **93%**. Both numbers are true and the gap between them is the story: benchmarks contain junk, and a number you haven't inspected the failures of is not a measurement.

## What I'd tell myself at the start

1. **Read the misses before you optimize anything.** Every one of my findings came from reading failures, not from watching the aggregate move.
2. **Bound the improvement before you build it.** The complementarity check cost ten minutes and closed off a day of work.
3. **Distrust the metric first.** It was wrong twice, in the same direction, and it changed a decision.
4. **Match on cost, not on the knob you're turning.** Fixed k is not fixed context.
5. **n=20 is a smoke test, not an eval.**

Three of four experiments failed. The system is where it started — plain vector search, k=5 — and I now know that's the right configuration, which is worth more than a 2% gain I couldn't explain.

Code: [github.com/JQ100/ask-my-notes](https://github.com/JQ100/ask-my-notes). The harness is `scripts/eval-retrieval.ts`; `--mode vector|keyword|hybrid` and `--expand N` reproduce every table above.
