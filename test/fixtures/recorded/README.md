# Recorded staging answers (step 72, T14)

Real JSON answers of the staging server (X-Api-Version 0.5), captured by `node tools/livecheck/record_answers.mjs`
(one cash trip in Tunis: Avenue Habib Bourguiba → Aéroport Tunis-Carthage; the trip is completed or cancelled and the
driver set offline at the end). Cleaned before writing: every id → stable fake (`00000000-0000-4000-8000-…` or
`<prefix>_fakeNNNN`), tokens/secrets → `[REDACTED]`, phone numbers → `+10000000000`, e-mails → `user@example.test`,
names/plates → `[REDACTED]`, photo URLs → `https://example.test/redacted`. Zone ids, prices and the scripted test
route are kept. Checked by `test/contract/recorded_answers.test.ts` (one test per file) against `contracts/openapi.yaml`.
