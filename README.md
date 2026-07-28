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
| `BOARD_REPO` | `freeflow-community/flow` | where **New task** files issues |

The project needs a `Status` single-select and a `Batch` NUMBER field.

## What it shows

Single column. The **active queue** is defined by Status, not by position: it
holds everything marked `Queued for Dev` or `In Progress`, plus anything moved
to `Done` within the last 15 minutes so you see work land before it drops off.
Each row shows its status as a pill and how long ago that status was set.
Everything else is the **backlog**, where rows show their queue rank — except
anything not `Todo`, which shows its status pill instead, so a `Done` item that
aged out of the window or a `Blocked` one doesn't read as ordinary backlog.

Status is polled every 5s from `GET /api/status`, which fetches ids, status and
`updatedAt` only, and is cached 3s server-side so several open tabs cost one API
call. The poll patches status in place and never touches order, so it can't
fight an unsaved local reorder. It re-renders only when queue membership or a
status actually changed — which also covers a `Done` item ageing out of the
window without anything else having changed.

Backlog rows carry a **queue** button that sets `Queued for Dev`; queue rows
still marked `Queued for Dev` carry a **cancel** link that sets `Todo` again.
Both go through `POST /api/set-status` and are applied optimistically, reverting
if GitHub rejects the write. A written status is held against the poll until the
server reports the same value (or 30s passes) — otherwise a poll that started
before the write, or one reading the 3s status cache, returns the pre-click
value and snaps the row back. Only staged tasks can be cancelled: once an agent
has started or finished one, pulling it out from under them isn't a UI decision.

**New task** in the header opens a form (title, body, "queue it immediately")
that files a real issue in `BOARD_REPO` and adds it to the project — not a
project draft, since the board only renders issues and an agent needs an issue
number for a PR to close. A freshly-added item takes a few seconds to become
visible to the project query, so `POST /api/new-task` waits until it is before
replying; creating therefore takes ~5-8s, spent on the Create button.

### Batches

Two or more tasks that belong in one branch and one PR are **linked** into a
batch: tick their checkboxes **in the active queue** and press **Link** — the
batch is a decision about what to work on next, so it's made where you're
looking at what's queued. They get a
shared `Batch` number (a NUMBER field on the project), a coloured left edge and
a `B<n>` chip, and are pulled adjacent in the queue order so a batch reads as
one block. **Unlink** clears it.

Queueing or cancelling any member moves the whole batch — half a batch in the
queue would misrepresent the work to the agent. The `Batch` value survives a
cancel, so a batch sent back to the backlog stays intact and re-queues as one.

**The agent's contract:** group project items by `Batch` where
`Status = "Queued for Dev"`. Each group is one job — one branch, one PR closing
every issue in it. Items with no `Batch` are a group of one.

Linking is the slowest action here (~5s): it writes a field value per member and
then reorders, which is several mutations.

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
- **Other writes.** No claiming, no editing, no assignment.
- **Draft items and PRs** are filtered out; only issues render.
- **Markdown** in issue bodies is rendered by ~6 lines of regex — fences,
  inline code, bold, links, headings. Tables and nested lists come out flat.
