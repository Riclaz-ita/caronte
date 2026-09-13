# Answer Bank — example

Copy this file to `data/answer-bank.md` (this template lives in `templates/` because everything under `data/` is yours and is never auto-updated) and replace the answers with your own.
`data/answer-bank.md` is gitignored and never committed.

Standing answers to recurring application-form questions. Every entry names the
source its content comes from. An entry with no source is not usable: the
resolver skips it, and the field is raised to you instead of being filled.

Format: `## <question, lowercased, as the matcher sees it>` then the answer, then
a `**Source:**` line.

## how did you hear about us

Through the company careers page.

**Source:** factual, confirmed by the candidate

## are you available to start immediately

Yes, I am available immediately.

**Source:** config/profile.yml:cover_letter.notice_period_days

## where are you based

Replace with your location and your working arrangement.

**Source:** config/profile.yml:candidate.location

## why are you interested in this role

ROLE-SPECIFIC. Never answer from this bank. Generate it from the role's report in
`reports/` and the job description on screen, or raise the question to the
candidate.

**Source:** none — intentionally not answerable generically
