# Ghostlight

Ghostlight finds commitments you made in GitHub threads and saves them in a follow-up inbox. Recheck the inbox to see which promises changed, which have new evidence, and which still need attention.

Select **Replay a real merge**, then **Next scan** to follow a real commitment from a linked open PR to a matching merge. Both steps use the [original GitHub comment](https://github.com/superfly/flyctl/issues/5381#issuecomment-6711617537) and [pull request #5395](https://github.com/superfly/flyctl/pull/5395). The replay runs independently of your saved inbox.

## Run locally

Node.js 22 or later is required. Ghostlight has no npm dependencies.

```sh
npm start
```

Open <http://127.0.0.1:8080>. The GitHub history replay works without an account.

To investigate a public repository via GitHub’s unauthenticated API from your own machine, use the explicit local mode.

```sh
GHOSTLIGHT_LOCAL_PUBLIC_GITHUB=1 npm start
```

## Run on a Sprite

1. Create a Sprite and copy this repository’s tracked files into `/home/sprite/ghostlight`.
2. In the Fly dashboard, create a GitHub Connector and authorize its use by this Sprite. Use the narrowest repository access you can. For a public demo, a Custom API Connector can forward the public GitHub API with a custom header that carries no GitHub credential.
3. Copy the exact gateway base URL from the Connector. Start Ghostlight inside the Sprite using that base URL.

```sh
cd /home/sprite/ghostlight
GHOSTLIGHT_GATEWAY=https://api.sprites.dev/v1/gateway/github/conn_REPLACE_ME \
GHOSTLIGHT_HOST=0.0.0.0 npm start
```

The inbox saves locally under the project’s .ghostlight directory, or under the Sprite user’s .ghostlight directory when a Connector is configured. Set GHOSTLIGHT_DATA_DIR to choose a durable directory explicitly. Back up the inbox.json file to preserve saved state.

For a persistent, on-demand service, register `node /home/sprite/ghostlight/server.mjs` as a Sprite Service on port 8080, with those same environment variables. Keep Sprite URL authentication enabled for personal investigations. For a public instance, set `GHOSTLIGHT_ALLOWED_REPO=owner/repository` to restrict live scans to one public repository, and use the Connector policy to restrict upstream paths to `/repos/owner/repository/*`.

See the [Sprites Connector documentation](https://docs.fly.io/sprites/concepts/connectors) and [Sprite Services documentation](https://docs.fly.io/sprites/working-with-sprites).

## Evidence and limits

- The agent scans up to 30 recently updated issue entries, 50 issue or pull request conversation comments, and 30 pull requests. It revisits up to four saved commitments outside the recent window, can fetch five missing parent threads and four issue timelines, and follows up to seven targeted PRs. Inline review comments and release and deployment records are outside this scan.
- Ghostlight requires a direct first-person commitment with a concrete action. A linked merge with matching language is evidence for a promise. A merged PR opened by the same person can also support a promise to open that PR. A merge date alone cannot establish that a change reached a release. Drafts, unlinked similarities, and possible reversals are marked for review.
- Read requests stay on the configured gateway in Connector mode. The runtime uses deterministic language and evidence rules, with no model API calls or GitHub writes.

## Tests

```sh
npm test
```

Ralph F. Blood’s 1931 photograph [Portland Head Light](https://www.loc.gov/item/90715540/) is from the Library of Congress, which lists no known publication restrictions. The bundled Newsreader and DM Sans font files are distributed under their respective [SIL Open Font Licenses](licences).
