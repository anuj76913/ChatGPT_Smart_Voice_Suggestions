# Phase 1 Baseline: Text Time-to-First-Token (P1.10)

> Reference for the PRD rule "text replies get no slower" (FR-1). Phase 3 must show TTFT with the suggestion path on is not significantly worse than this.

- **Measured:** 2026-11-16T14:48:49.166Z
- **Server:** http://127.0.0.1:8787
- **Suggestions:** off (Phase 1 has no suggestion path)
- **Chat model:** primary `openai/gpt-oss-120b` (reasoning effort low), fallback `openai/gpt-oss-20b`
- **Runs:** 10 (10 succeeded), each in a fresh conversation, sequential

## Summary
| Metric | p50 | p90 | max |
|---|---|---|---|
| Client TTFT (request → first token at client) | 435 ms | 911 ms | 1022 ms |
| Server TTFT (S2 → first Groq token) | 424 ms | 894 ms | 1010 ms |
| Total answer time | 1384 ms | 2075 ms | 2328 ms |

## Runs
| # | Prompt | Client TTFT | Server TTFT | Total | Chars | OK |
|---|---|---|---|---|---|---|
| 1 | Explain normalization in DBMS with an example | 411 ms | 385 ms | 2075 ms | 3168 | ✔ |
| 2 | Mera kal TCS ka interview hai, kya kya padhna chahiye? | 911 ms | 894 ms | 2328 ms | 2649 | ✔ |
| 3 | What is the difference between TCP and UDP? | 347 ms | 334 ms | 903 ms | 1142 | ✔ |
| 4 | Give me 5 tips to improve my spoken English | 1022 ms | 1010 ms | 1644 ms | 1266 | ✔ |
| 5 | Newton ke teen laws simple language mein samjhao | 547 ms | 538 ms | 1578 ms | 1754 | ✔ |
| 6 | How do I prepare for a project viva in 3 days? | 435 ms | 424 ms | 1569 ms | 2176 | ✔ |
| 7 | Write a short self-introduction for a fresher interview | 392 ms | 380 ms | 997 ms | 1141 | ✔ |
| 8 | What is a deadlock in operating systems? | 515 ms | 503 ms | 1234 ms | 1544 | ✔ |
| 9 | Python mein list aur tuple ka difference kya hai? | 343 ms | 330 ms | 1384 ms | 1464 | ✔ |
| 10 | Summarize the causes of the French Revolution in 5 points | 447 ms | 433 ms | 880 ms | 983 | ✔ |
