# gp-github-review

The session's side of a key service's GitHub review action: a reviewer agent posts a review on a pull request as its GitHub App, without ever holding the App's key, a JWT or a token. The key service's [GitHub App slot](../../README.md#the-github-app-slot) holds the key and does the work; this client holds no key, sends one request to the key service's socket and prints the answer.

```sh
gp-github-review [--socket <folder>] [--json] review <owner/repo> <pr> <head-sha> <APPROVE|REQUEST_CHANGES|COMMENT> [<body> | -]
gp-github-review [--socket <folder>] [--json] fingerprint
gp-github-review [--socket <folder>] [--json] app
```

- `review` posts one review, pinned to `<head-sha>`, the full 40-character id of the head commit the reviewer read. With `-`, the body is read from stdin. `REQUEST_CHANGES` and `COMMENT` need a body. The key service decides what may be posted, and a refusal names its check (below). If the head moves while the review is being posted, or the pull request becomes held or a draft, the answer is not ok ("the head moved while the review was posted"), and it names the review that was posted: the repo's branch rules dismiss it, or the lead deals with it.
- `fingerprint` prints the App key's fingerprint, as GitHub shows it. It makes no request to GitHub.
- `app` asks GitHub about the App (`GET /app`): its id, slug, owner and permissions.
- `--socket` names the key service's socket folder, `/run/ghost-protocol-key/<name>`. Without it, `GP_KEY_SOCKET` does, or else the one key service on this machine with a GitHub socket.
- `--json` prints the key service's answer as it came: `{"ok":true,...}` or `{"ok":false,"error":"..."}`.

A body on stdin over 60,000 bytes is refused here, before anything is sent.

Exit codes: 0 done; 1 refused (the reason on stderr); 2 usage.

**A refusal is one line on stderr, `refused: <check>: <clause>`.** The checks the key service holds a review to, in the order it runs them:

| Check | Refused when |
|---|---|
| `repo` | the repo is not on the key service's list (or the pull request is in another repo) |
| `event` | `COMMENT`, unless the key service's settings allow it: post `APPROVE` or `REQUEST_CHANGES` |
| `open` | the pull request is not open |
| `head` | the head is not `<head-sha>`: read the pull request again |
| `hold` | the title starts with `HOLD:` (any case, after leading spaces) or the pull request has the `hold` label |
| `draft` | the pull request is a draft |
| `own-pr` | the pull request is the reviewer's own (its author is the reviewer's App) |
| `own-commit` | a commit is authored by the reviewer's own identity; also when it has more than 100 commits, or the commits could not be read |
| `public-text` | in a repo that is not private, the body fails the public-text rules (the clause names the rule, a neutral word, never the text that matched), or checking it took too long |

A failure that is no limit (no token, no answer from GitHub) names no check: `refused: <clause>`. The client repeats none of this: the settings and the facts are on the key service's side. The key service posts nothing on a refusal.

The checks cannot tell a reviewer's own commit from a builder's when they share one author, so keeping a reviewer off its own pair's work stays a matter of who is asked to review.

It needs node 22 or later, and only the module beside it in this checkout ([`adapters/buzz/src/github-review.mjs`](../../adapters/buzz/src/github-review.mjs)). A link to it from a folder on `PATH` works too. The key service checks every field again, and decides alone.
