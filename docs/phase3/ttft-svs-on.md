# Text Time-to-First-Token Benchmark

> Reference for the PRD rule "text replies get no slower" (FR-1). Phase 3 must show TTFT with the suggestion path on is not significantly worse than this.

- **Measured:** 2026-11-16T16:33:35.712Z
- **Server:** http://127.0.0.1:8787
- **Suggestions:** ON (dogfood cohort: suggestion path runs on every message)
- **Chat model:** primary `openai/gpt-oss-120b` (reasoning effort low), fallback `openai/gpt-oss-20b`
- **Runs:** 10 (10 succeeded), each in a fresh conversation, sequential

## Summary
| Metric | p50 | p90 | max |
|---|---|---|---|
| Client TTFT (request → first token at client) | 498 ms | 596 ms | 823 ms |
| Server TTFT (S2 → first Groq token) | 478 ms | 580 ms | 804 ms |
| Total answer time | 1174 ms | 1991 ms | 2505 ms |

## Runs
| # | Prompt | Client TTFT | Server TTFT | Total | Chars | Card | OK |
|---|---|---|---|---|---|---|---|
| 1 | Explain normalization in DBMS with an example | 498 ms | 478 ms | 2505 ms | 3770 | — | ✔ |
| 2 | Mera kal TCS ka interview hai, kya kya padhna chahiye? | 823 ms | 804 ms | 1991 ms | 2144 | — | ✔ |
| 3 | What is the difference between TCP and UDP? | 533 ms | 516 ms | 1247 ms | 1303 | — | ✔ |
| 4 | Give me 5 tips to improve my spoken English | 523 ms | 507 ms | 1110 ms | 1046 | — | ✔ |
| 5 | Newton ke teen laws simple language mein samjhao | 464 ms | 445 ms | 1708 ms | 1914 | — | ✔ |
| 6 | How do I prepare for a project viva in 3 days? | 596 ms | 580 ms | 1719 ms | 1898 | — | ✔ |
| 7 | Write a short self-introduction for a fresher interview | 463 ms | 438 ms | 1174 ms | 1227 | — | ✔ |
| 8 | What is a deadlock in operating systems? | 349 ms | 316 ms | 1097 ms | 1435 | — | ✔ |
| 9 | Python mein list aur tuple ka difference kya hai? | 393 ms | 376 ms | 1157 ms | 1289 | — | ✔ |
| 10 | Summarize the causes of the French Revolution in 5 points | 547 ms | 529 ms | 1076 ms | 1137 | — | ✔ |
