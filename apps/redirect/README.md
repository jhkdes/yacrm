# yacrm-redirect

The public tracked-link endpoint for yaCRM campaigns — deployed separately
from the main app so the main app (and your data) can stay local/private
while this one small, public-facing piece is reachable by real email/
LinkedIn recipients.

`GET /<token>` looks up the token against `campaign_recipient` (joined with
`campaign` for its `destination_url`), advances the recipient's status to
`clicked` if appropriate, and redirects. An unknown token, or a campaign
with no `destination_url`, redirects to this app's own `/` instead of
erroring.

It shares the main app's database — see [`../../src/db/schema.ts`](../../src/db/schema.ts)
for the real schema; the query logic here (`src/click-tracking.ts`) is a
deliberately small, hand-duplicated raw-SQL copy of
[`../../src/lib/click-tracking.ts`](../../src/lib/click-tracking.ts), not a
shared package — see the comment at the top of that file for why.

## Local development

```
npm install
cp .env.local.example .env.local   # fill in DATABASE_URL
npm run dev
```

There's no local fallback database here — `DATABASE_URL` must point at the
same hosted Postgres the main app's `DATABASE_URL` points at (run the main
app's migrations against that database first).

## Deploying

1. Create a new Vercel project from this same GitHub repo, with **Root
   Directory** set to `apps/redirect`.
2. Set the `DATABASE_URL` environment variable on that Vercel project to
   the same hosted Postgres connection string the main app uses.
3. Deploy, then attach whichever domain/subdomain you want recipients'
   links to use.
4. Point the main app's own `DATABASE_URL` at the same database too (see
   the main repo's `.env.local.example`) — this app and the main app need
   to see the same rows for click tracking to actually work end to end.
