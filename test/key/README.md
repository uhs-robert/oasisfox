# test/key

Key tests. Each run builds the extension, starts Firefox in its own nested, invisible session, sends real key presses and checks what the page and the background report. `run.mjs` holds the cases, `timings.mjs` measures where the time goes, `server.mjs` and `rdp.mjs` read the results, `launch_firefox.sh` starts Firefox, and `user.js` and `config/` set up the test profile.

## Run

```bash
just key-test
KEY_TEST_ONLY=<regex> just key-test
```

It takes about a minute and needs a nested Hyprland.

- `KEY_TEST_ONLY` runs only the cases whose name matches. It also runs the cases marked `{ setup: true }`, which leave state that later cases read. The output tags those as `SETUP`.
- `SHADOW_SH` must name a script that runs `up|spawn|keys|down <name>` for a nested, invisible compositor session. It can also answer `status` with one `<name>: up|down ...` line per session, which the sweep reads.
  Cleanup of killed runs works only for drivers that keep a session's runtime dir in `/tmp/shadow-<uid>-<name>`.
  When `SHADOW_SH` is unset, the recipe uses `$HOME/dotfiles/.claude/skills/shadow/shadow.sh` if it is executable. With neither, it exits.
- Each run starts its own shadow session, so runs from different worktrees go in parallel with no lock.

## Timings

Every run times itself and prints a summary at the end: time by category, time outside cases, the 20 slowest cases and the open tab count. It also writes the full numbers as JSON.

- The file is `.logs/key-test-timings-<timestamp>.json` in the checkout. `KEY_TEST_TIMINGS_FILE=<path>` sets another path.
- Each moment of the run goes to one category: `keys` (a `shadow keys` call), `settle` (the pause after each key call), `sleeps` (other sleeps), `waits` (`wait_event`), `rdp` (debugger calls), `page_opens` (all of `open_page`, keys and waits inside it included), `driver` (`up`, `spawn`, `shot`) and `other` (everything untracked, such as test logic).
- The JSON holds `categories` and `outside_cases` (ms and call counts), `pieces` (wall time per piece file), `cases` (wall time and categories per case) and `tab_samples` (open tab count before and after each piece). Setup between cases counts as `(outside cases)`.
- The file is rewritten after each piece and when SIGINT or SIGTERM arrives, so a run killed at the time cap still leaves its numbers (the summary prints only at a normal end or on a signal).
- Piece files need no hooks: they get the timed `sleep`, `open_page`, `wait_event` and `rdp` from the case context.

## Native host

`config.reload` reads the config through the native host, so each run installs it. `run.mjs` runs `host/install.sh main` with `HOME` set to the session's throwaway HOME and a `curl` stand-in that copies the host from this checkout. It refuses the real HOME. It grants `nativeMessaging` from chrome code, because Firefox grants it only from a click. `launch_firefox.sh` sets `DESERTFOX_CONFIG_DIR` to a link in the run folder, and `load_config_dir` points that link at another folder before it presses `qr`. Managed storage still gives the config at startup.

## Traps

- Run key tests only in your own worktree. Never run two from one worktree: each `just key-test` rebuilds and clears that worktree's `dist/`.
- Do not wrap `just key-test` in `timeout`. The recipe already runs in a systemd scope with a memory cap of 8 GB, no swap and a time limit of 1800 seconds. Without a systemd user session it runs uncapped and says so.
- On the first run after a build, an early setup case can fail. Rerun once before you debug.
- Add-ons force-installed through the Firefox policy file can eat modifier chords in the shadow session. Disable them before you trust a chord result.
- The first-install Quick Start tab opens beside the first tab and shifts the tab order. That was the cause of #123: Alt+J wrapped to an empty tab instead of page a. The test config now sets `open_quick_start_on_install = false`, and `expect_exactly_one_visible` also checks the active tab URL, so an empty tab fails the case (#155).
- The sweep of leftover sessions stops only a session that carries the run's owner marker file, `desertfox-key-owner`, naming a dead run. A session with no marker is skipped, whatever its name, so cleanup never stops another tool's session. Keep that rule when you change cleanup code.
