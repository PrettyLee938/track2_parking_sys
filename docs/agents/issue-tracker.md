# Issue tracker: GitHub

Issues and specs live in:
https://github.com/PrettyLee938/track2_parking_sys/issues

Use the `gh` CLI. Pass `--repo PrettyLee938/track2_parking_sys`
explicitly, since this workspace may not be a Git clone.

## Conventions

- Create: `gh issue create --repo PrettyLee938/track2_parking_sys --title "..." --body-file <path>`
- Read: `gh issue view <number> --repo PrettyLee938/track2_parking_sys --comments`
- List: `gh issue list --repo PrettyLee938/track2_parking_sys --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --repo PrettyLee938/track2_parking_sys --body-file <path>`
- Apply or remove labels: `gh issue edit <number> --repo PrettyLee938/track2_parking_sys --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --repo PrettyLee938/track2_parking_sys`

For multiline content, write the exact text to a temporary UTF-8 file
and pass it with `--body-file`.

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read the issue and its comments.

## Pull requests as a triage surface

PRs as a request surface: no.

GitHub issues and PRs share a number space. If a reference is ambiguous,
check whether it is a PR before treating it as an issue.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Children: separate issues labelled `wayfinder:<type>`, where type is
  research, prototype, grilling, or task.
- Link children using GitHub sub-issues. If unavailable, use a task list
  in the map and `Part of #<map>` in each child.
- Blocking: use native GitHub issue dependencies. The blocked-by API
  takes the blocker's numeric database ID, not its issue number.
  If unavailable, use `Blocked by: #<number>` lines.
- Frontier: choose the first open child in map order with no open
  blockers and no assignee.
- Claim: assign the ticket to the driving developer before work.
- Resolve: comment with the answer, close the ticket, then add a brief
  finding and link to Decisions-so-far in the map.
