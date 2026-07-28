# Task board

A small read-only web frontend over a GitHub Project (v2), built as the first
cut of an agent work-queue UI.

```sh
node server.mjs        # → http://localhost:8787
```

No dependencies, no build step, no install. Two files: `server.mjs` and
`index.html`.

## GitHub access

The server shells out to the `gh` CLI, so it inherits whatever account is
already logged in on this machine. **No token is read, copied or stored by this
code.** The tradeoff is that `gh` must be authenticated with the `project`
scope:

```sh
gh auth status                 # want: Token scopes include 'project'
gh auth login --web --scopes 'repo,read:org,workflow,project'
```

## Config

| env | default | |
|---|---|---|
| `PORT` | `8787` | |
| `BOARD_OWNER` | `freeflow-community` | org login |
| `BOARD_NUMBER` | `1` | project number |

## What it shows

Single column. The **active queue** is the top 3 items in board order, with
anything marked `In Progress` floated to the top and badged `RUN`. Everything
below is the **backlog**, with search and a status filter.

Click any row to expand the issue body inline. Backlog rows carry ▲/▼ buttons —
moving an item up out of the backlog promotes it into the active queue.

Reordering is **optimistic**: the click reorders locally and renders at once,
and the whole resulting order is pushed to GitHub 700ms after the last click.
A round trip costs ~2.5s, far too slow to sit behind a button press, and a run
of clicks now costs one request instead of one each. The backlog bar shows
`unsaved` → `saving…`, and a failed save reloads from GitHub rather than
leaving the UI showing an order that was never accepted.

`POST /api/reorder` reconciles a desired order against a freshly-fetched board:
only positions that actually differ are mutated, and items the client didn't
know about are preserved rather than dropped.

Reads are cached for 20s; a successful reorder busts the cache.

Reordering is hidden while a search or status filter is active — ▲/▼ on a
filtered list would move an item relative to rows you can't see.

## Not built yet

- **Priority.** The board has no Priority field, so rows show queue rank rather
  than P1/P2/P3.
- **Live progress.** Elapsed time, a progress bar, `14/22 passing` — none of it
  has a source. GitHub Projects is the wrong place to write ticking state; that
  belongs to whatever actually runs the agent.
- **Drag and drop.** ▲/▼ only; one slot per click.
- **Other writes.** No status changes, no claiming, no editing.
- **Draft items and PRs** are filtered out; only issues render.
- **Markdown** in issue bodies is rendered by ~6 lines of regex — fences,
  inline code, bold, links, headings. Tables and nested lists come out flat.
