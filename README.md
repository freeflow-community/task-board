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

Left pane is the backlog in board order, with search and a status filter. Right
pane maps onto the same data: whatever item has Status `In Progress` renders as
ACTIVE, and the next four in queue order are UP NEXT.

Responses are cached for 20s so a reload doesn't re-hit the API.

## Not built yet

- **Priority.** The board has no Priority field, so rows show queue rank rather
  than P1/P2/P3.
- **Live progress.** Elapsed time, a progress bar, `14/22 passing` — none of it
  has a source. GitHub Projects is the wrong place to write ticking state; that
  belongs to whatever actually runs the agent.
- **Writes.** Read-only. No reordering, no status changes, no claiming.
- **Draft items and PRs** are filtered out; only issues render.
