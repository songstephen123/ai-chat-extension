# Lark CLI Gateway

The extension exposes Lark CLI through the native host in two layers:

1. High-frequency tools such as `lark_search_docs`, `lark_create_doc`, and
   `lark_calendar`.
2. Generic gateway tools that can discover and call the wider CLI surface:
   `lark_cli_help`, `lark_cli_schema`, `lark_cli_api`,
   `lark_cli_api_command`, `lark_cli_shortcut`, `lark_cli_run`, and
   `lark_cli_passthrough`.

The generic tools mirror Lark CLI's own three-layer model:

- Shortcuts: `lark_cli_run({ argv: ["calendar", "+agenda"] })`
- API commands: `lark_cli_run({ argv: ["calendar", "events", "instance_view", "--params", "{...}"] })`
- Raw API: `lark_cli_api({ method: "GET", path: "/open-apis/calendar/v4/calendars" })`
- Full passthrough: `lark_cli_passthrough({ argv_json: "[\"base\",\"records\",\"list\",\"--page-all\"]" })`

Before using unfamiliar commands, the assistant should call `lark_cli_help` or
`lark_cli_schema` to inspect command parameters, scopes, identity requirements,
and risk level.

## Safety

The native host executes Lark CLI with an argument array and never through a
shell string. It also blocks `--yes`, so high-risk writes cannot silently bypass
Lark CLI's confirmation gate. When the CLI returns `confirmation_required`, the
assistant must explain the risk to the user and wait for explicit confirmation.

The generic runner intentionally allows Lark business domains and discovery
commands, but not credential/profile management commands such as `auth`,
`config`, `profile`, or `update`.

`lark_cli_passthrough` is the least restrictive gateway. It accepts a JSON array
string containing the arguments after `lark-cli` and executes it as an argv
array, never as a shell command. This keeps newly added Lark CLI business
features usable without changing the extension each time. Its safety boundary is
root-command and confirmation control: only Lark business/discovery roots are
allowed, and `--yes` or `--yes=<value>` are blocked so high-risk writes must
surface the CLI's `confirmation_required` envelope to the user.

## Runtime Configuration

Generated files are written under `~/ai-chat-extension/output` by default. Set
`AI_CHAT_EXTENSION_OUTPUT_DIR` in the native host environment to redirect both
basic HTML slides and frontend-slides work packages.

## Frontend Slides From Lark Docs

`lark_doc_to_frontend_slides` bridges Lark docs into the installed
`frontend-slides` skill.

Flow:

1. Fetch the Lark doc as Markdown through `docs +fetch`.
2. Save a work package under
   `~/ai-chat-extension/output/frontend-slides/<title>-<timestamp>/`.
3. Write `source.md` and `frontend-slides-prompt.md`.
4. In `mode: "generate"`, invoke Claude Code non-interactively with the
   `/frontend-slides` prompt and ask it to create `slides.html`.

Use `mode: "prepare"` when the user wants a reliable handoff package or when
interactive style selection is desirable. Use `mode: "generate"` when the user
explicitly asks the extension to directly create the deck and accepts that the
local Claude Code environment must be authenticated and able to run tools.
