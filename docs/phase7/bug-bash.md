# Bug Bash and Triage (P7.8)

> Sources: a full browser walkthrough (headless Chrome, fake mic, offline Groq), the security / privacy / chaos tests, the capacity plan, and code review of the voice path.
> **P0** = blocks dogfood or causes data loss / security exposure · **P1** = must fix before the A/B test · **P2** = can follow.

## Fixed in Phase 7
| ID | Pri | Bug | Fix · verified by |
|---|---|---|---|
| BB-01 | **P0** | **Every voice session crashed to a blank page** in current Chrome. `useEffect(() => el.scrollIntoView(…))` returned the Promise that `scrollIntoView` now returns; React called it as a cleanup ("destroy is not a function"). Unit tests couldn't see it | Block-bodied effects; a source-rule test (`apps/web/test/source-rules.test.ts`) fails on the pattern. The browser walkthrough now completes card → voice → summary → chat |
| BB-02 | P1 | `MediaRecorder.start()` can throw (mic unplugged, revoked, busy), leaving the session stuck on "Listening" | Caught: the session pauses with "Your microphone stopped working…"; the recorder refuses an ended track |
| BB-03 | P1 | If the browser never fires `end`/`error` for an utterance (no voice installed, Chrome's long-utterance bug), the session stayed on "Speaking" forever | Watchdog per sentence (expected speaking time + 3 s) |
| BB-04 | P1 | The Back-to-Chat / Continue-in-text recap showed 👍/👎. The vote was meaningless, and the event was rejected (a recap answers no question, so it has no language) | Recaps are marked (`kind: voice_recap`) and show no feedback; tested |
| BB-06 | P2 | The summary screen still showed the old "Session ended" status line | Hidden while the summary shows |
| BB-07 | P1 | Logout didn't revoke the session; a copied cookie stayed valid for 30 days | Session epoch; logout revokes; tested |
| BB-08 | P1 | 5xx responses could include internal error text (e.g. Postgres messages) | Error handler returns codes only; tested |
| BB-09 | P1 | No limit on spoken turns: a scripted client could burn Groq quota | `voice.maxTurnsPerMinute` (15); tested |
| BB-10 | P1 | Accessibility: no `<main>` landmark; card heading skipped a level; sidebar buttons at 36 px, feedback buttons and the Settings switch at 40 px | Fixed; 13 screens now pass axe WCAG 2.2 AA with no target under 44 px ([results](a11y-results.md)) |
| BB-11 | P1 | No security headers, CSP or Origin check | Added ([security.md](security.md)); tested |
| BB-12 | P1 | Voice transcripts were kept forever | Retention purge job ([privacy.md](privacy.md)); tested |

## Open
| ID | Pri | Item | Owner / next step |
|---|---|---|---|
| BB-05 | **P0** | **Groq capacity:** the current key can't serve dogfood (6.8× over tokens/day on gpt-oss-120b) | Upgrade the Groq tier before Phase 8 ([capacity-plan.md](capacity-plan.md)) |
| BB-13 | **P0 for public deploy** · P1 for private dogfood | Auth is dev login (anyone can pick any handle) | Real sign-in (ADR-010 open); dogfood only on a private network until then |
| BB-14 | P1 | Rate limiter and live voice sessions are in memory, so they only work on a single instance | One instance for dogfood; shared store (Redis/Postgres) before scaling out |
| BB-15 | ~~P1~~ fixed in Phase 8 | No general mic button (`entry_point = mic_button`) | Composer mic button + practice picker; needed for the baseline pre-period too |
| BB-16 | P1 | Hindi card copy is an unreviewed draft (cards in Hindi are off) | Native review + Legal, then device QA |
| BB-17 | P1 | Not tested by a person: TalkBack / VoiceOver walkthroughs, mid-range Android over 4G (voice start < 2 s p90), a real spoken turn in the browser (the headless fake mic produced no recognisable turn) | Device lab / QA session |
| BB-18 | P1 | Legal / T&S sign-offs (privacy copy, Groq terms, retention period) | Legal (dogfood gate) |
| BB-19 | P2 | The analytics report takes ~1.1 s at 4k users (correlated `EXISTS` queries) | Rollups or a warehouse before the A/B test's data volume |
| BB-20 | P2 | The Hinglish detector misses common words (*maine, kiya, kyunki, thi*), which affects the summary language | Extend the word list or combine it with Whisper's language tag |
| BB-21 | P2 | No barge-in (the mic is closed while the assistant speaks) | v2 |
| BB-22 | P2 | `npm audit` isn't in CI; no dependency-update policy | CI setup with hosting |

**No open P0 code bugs.** The two P0 items left are a commercial dependency (BB-05) and a deployment constraint (BB-13).
