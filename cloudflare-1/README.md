# cloudflare-1

The lobby from the `cloudflare/` folder of branch `phase2/cloudflare` (commit 39f722f), with the
browser build in `public/`, ready to deploy to Cloudflare's free Workers plan. The page and engine
are the same files as `lobby-1`. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

No game files are here.
