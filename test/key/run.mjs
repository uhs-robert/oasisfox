// The key test: real key presses in a nested session, results read from pages that report to a local server.
// Needs SHADOW_SH, a script with `up|spawn|keys|down <name>` subcommands for a nested, invisible compositor.
// `status` is optional. The sweep reads its stdout for lines that start `<name>: ` and skips the sweep if the verb fails.
// The cleanup of killed runs works only for drivers that keep sessions in /tmp/shadow-<uid>-<name>.
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect_rdp, evaluate_in_background, evaluate_in_chrome, install_temporary_addon } from "./rdp.mjs";
import { p1_cases } from "./p1.mjs";
import { start_server } from "./server.mjs";
import { create_timings, default_timings_path } from "./timings.mjs";

const run_execfile = promisify(execFile);
const key_test_dir = dirname(fileURLToPath(import.meta.url));
const repo_dir = resolve(key_test_dir, "../..");
const dist_dir = join(repo_dir, "dist");
const EXTENSION_ID = "desertfox@uhs-robert";
// shadow.sh caps names at 8 characters. "ok" plus a base-36 pid is at most 8 and unique among live runs.
const SHADOW_NAME = `ok${process.pid.toString(36)}`;
if (SHADOW_NAME.length > 8) throw new Error(`shadow name ${SHADOW_NAME} is longer than 8 characters`);
const FRESH_LOAD_COUNT = 24;
const PADDED_BUNDLE_BYTES = 20 * 1024;

const shadow_sh = process.env.SHADOW_SH;
if (!shadow_sh) {
  console.error("key-test: set SHADOW_SH to a script that runs `<script> {up|spawn|keys|down} <name> ...` in a nested session, and optionally `status` (lines `<name>: up|down ...`).");
  process.exit(2);
}

const timings = create_timings();
const raw_sleep = (ms) => new Promise((resolve_sleep) => setTimeout(resolve_sleep, ms));
const sleep = (ms) => timings.time("sleeps", () => raw_sleep(ms));
const shadow = (...args) => run_execfile(shadow_sh, args, { maxBuffer: 1 << 24 });
const timed_shadow = (...args) => timings.time("driver", () => shadow(...args));
// The pause lets a switched-to tab take keyboard focus before the next press.
const KEY_SETTLE_MS = 350;
async function send_keys(...wtype_args) {
  await timings.time("keys", () => shadow("keys", SHADOW_NAME, ...wtype_args));
  await timings.time("settle", () => raw_sleep(KEY_SETTLE_MS));
}

const ALT = (key) => ["-M", "alt", key, "-m", "alt"];
const CTRL = (key) => ["-M", "ctrl", key, "-m", "ctrl"];
const SHIFT_ESCAPE = ["-M", "shift", "-k", "Escape", "-m", "shift"];

function process_is_alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// shadow.sh keeps a session's runtime dir here (a literal /tmp, not TMPDIR), and `down` removes the dir with the marker in it.
const OWNER_MARKER = "desertfox-key-owner";
const marker_path = (name) => join("/tmp", `shadow-${process.getuid()}-${name}`, OWNER_MARKER);

function read_owner_pid(name) {
  try {
    const text = readFileSync(marker_path(name), "utf8").trim();
    return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

// A killed run leaves its session behind. Stop each session whose marker names a dead owner.
// A live run is never touched. This run's own pid counts as dead, since a recycled pid can match an old leftover.
// A session with no marker is skipped, whatever its name. That includes one killed between `up` and the marker write, which errs toward safety.
async function sweep_dead_sessions() {
  let stdout;
  try {
    ({ stdout } = await shadow("status"));
  } catch (error) {
    console.error(`sweep skipped: shadow status failed: ${error.message}`);
    return;
  }
  for (const [, name] of stdout.matchAll(/^([a-z0-9][a-z0-9-]*): /gm)) {
    const owner_pid = read_owner_pid(name);
    if (!Number.isInteger(owner_pid) || (owner_pid !== process.pid && process_is_alive(owner_pid))) continue;
    console.log(`sweep: stopping ${name}, left by dead run ${owner_pid}`);
    await shadow("down", name).catch((error) => console.error(`sweep: down ${name} failed: ${error.message}`));
  }
}

async function free_port() {
  const probe = net.createServer();
  await new Promise((resolve_listen) => probe.listen(0, "127.0.0.1", resolve_listen));
  const { port } = probe.address();
  await new Promise((resolve_close) => probe.close(resolve_close));
  return port;
}

// Runs the real install script into the session's throwaway HOME. A curl stand-in copies the host from this checkout, so the run needs no network and tests this branch's host.
function install_native_host(work_dir, session_home) {
  // realpath and the passwd entry catch a HOME override on this runner and a session HOME that links to the real one.
  const real_homes = new Set([homedir(), userInfo().homedir].map((home) => realpathSync(home)));
  if (session_home === "" || real_homes.has(realpathSync(session_home))) throw new Error(`refusing a host install into the real HOME: "${session_home}"`);
  const stub_dir = join(work_dir, "install_stub");
  mkdirSync(stub_dir, { recursive: true });
  writeFileSync(join(stub_dir, "curl"), `#!/bin/sh\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; http*) url=$1; shift;; *) shift;; esac; done\nexec cp "${join(repo_dir, "host")}/$(basename "$url")" "$out"\n`);
  chmodSync(join(stub_dir, "curl"), 0o755);
  const { XDG_DATA_HOME: _ignored, ...env } = process.env;
  const result = spawnSync("sh", [join(repo_dir, "host", "install.sh"), "main"], { env: { ...env, HOME: session_home, PATH: `${stub_dir}:${process.env.PATH}` }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`host install failed: ${result.stderr}${result.stdout}`);
}

function build_test_config(config_dir, out_file) {
  const result = spawnSync("node", ["tools/build-config/cli.ts", config_dir, "--out", out_file], { cwd: repo_dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`build-config failed: ${result.stderr}${result.stdout}`);
}

// Valid script text of about PADDED_BUNDLE_BYTES, so the bundle timings include a real parse and run.
function padded_bundle_text() {
  const lines = [];
  let size = 0;
  for (let index = 0; size < PADDED_BUNDLE_BYTES; index++) {
    const line = `function pad_${index}(left, right) { return left * ${index} + right; }`;
    lines.push(line);
    size += line.length + 1;
  }
  return `(() => {\n${lines.join("\n")}\n})();\n`;
}

const results = [];
const measurements = {};

// KEY_TEST_ONLY=<regex> runs only the cases whose name matches, for a quick repro.
// A case passed { setup: true } leaves state that later cases read (a reloaded config, an open page,
// the command history), so it runs under any filter and is reported as "SETUP".
async function run_case(name, body, { setup = false } = {}) {
  const selected = !process.env.KEY_TEST_ONLY || new RegExp(process.env.KEY_TEST_ONLY).test(name);
  if (!selected && !setup) return;
  const label = selected ? "" : "SETUP ";
  await timings.time_case(name, { setup: !selected }, async () => {
    try {
      await body();
      results.push({ name, pass: true, setup: !selected });
      console.log(`${label}PASS ${name}`);
    } catch (error) {
      results.push({ name, pass: false, reason: error.message, setup: !selected });
      console.log(`${label}FAIL ${name}: ${error.message}`);
    }
  });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const work_dir = mkdtempSync(join(tmpdir(), "desertfox-key-"));
  const profile_dir = join(work_dir, "profile");
  const managed_dir = join(work_dir, "managed");
  const config_dir = join(work_dir, "config");
  cpSync(join(key_test_dir, "config"), config_dir, { recursive: true });
  mkdirSync(profile_dir);
  cpSync(join(key_test_dir, "user.js"), join(profile_dir, "user.js"), { recursive: true });
  const managed_file = join(managed_dir, `${EXTENSION_ID}.json`);
  // DESERTFOX_CONFIG_DIR points the native host here (launch_firefox.sh). load_config_dir moves the link.
  const active_config = join(work_dir, "active_config");
  symlinkSync(config_dir, active_config);
  const server = await start_server();
  // The built-in duck engine is replaced by this server, so a search from the keys lands on a page the test can read.
  // The keyfam.site engine is for p9_completion.mjs. The keysite, keyrepo, keysub, keypage, keyhere and keyother engines are for p8_engines.mjs (keyhere belongs to the test host, keyother to a host no test page has): the test page has a host but is no GitHub repo or subreddit.
  const engine_url = (id, slot) => `http://127.0.0.1:${server.port}/page?id=${id}&q=${slot}+{query}`;
  writeFileSync(
    join(config_dir, "search_engines.toml"),
    [
      `duck = { url = "http://127.0.0.1:${server.port}/page?id=search_result&q=%s", label = "Test server" }`,
      `[keysite]\nlabel = "Key site"\nurl = "${engine_url("engine_site", "{host}")}"`,
      `[keyrepo]\nlabel = "Key repo"\nurl = "${engine_url("engine_repo", "{repo}")}"`,
      `[keysub]\nlabel = "Key sub"\nurl = "${engine_url("engine_sub", "{subreddit}")}"\nfallback = "duck"`,
      `[keypage]\nlabel = "Key page"\nurl = "http://127.0.0.1:${server.port}/page?id=engine_page&q={query|url}"`,
      `[keyhere]\nlabel = "Key here"\nhosts = ["127.0.0.1"]\nurl = "${engine_url("engine_here", "{host}")}"`,
      `[keyother]\nlabel = "Key other"\nhosts = ["other.invalid"]\nurl = "${engine_url("engine_other", "{host}")}"`,
      `[keyfam]\nlabel = "Key family"\nurl = "${engine_url("engine_family", "{host}")}"`,
      `[keyfam.site]\nlabel = "Key family: site"\nurl = "${engine_url("engine_family", "{host}")}"`,
      "",
    ].join("\n"),
  );
  // Written here, not kept in config/, because a copy of config/ has no engines and a site key must name real ones. h picks keyhere on the test host, n has an engine for another host only.
  writeFileSync(join(config_dir, "keymap.d", "80-site.toml"), '[site_keys]\nh = ["keyother", "keyhere"]\nn = ["keyother"]\n');
  build_test_config(config_dir, managed_file);
  const events = server.events;
  const debug_port = await free_port();
  let rdp;
  // A signal can arrive during the normal teardown, so every path shares this one run of the cleanup.
  let teardown_started;
  const teardown = () => {
    teardown_started ??= (async () => {
      rdp?.close();
      await shadow("down", SHADOW_NAME).catch((error) => console.error(`shadow down failed: ${error.message}`));
      server.close();
      rmSync(work_dir, { recursive: true, force: true });
    })();
    return teardown_started;
  };
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(signal, () => {
      // Written before the teardown, so a hung teardown loses nothing and is not charged to the case.
      timings.finish_active_case();
      write_timings();
      teardown().finally(() => process.exit(code));
    });
  }

  const url_of = (kind, id) => `http://127.0.0.1:${server.port}/${kind}?id=${id}`;
  const since = (mark) => events.slice(mark);
  const find_event = (mark, predicate) => since(mark).find(predicate);
  const wait_event = (...args) => timings.time("waits", () => wait_event_untimed(...args));
  async function wait_event_untimed(mark, predicate, what, timeout_ms = 8000) {
    const deadline = Date.now() + timeout_ms;
    for (;;) {
      const found = find_event(mark, predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await raw_sleep(50);
    }
  }
  const became_visible = (page_id) => (event) => event.type === "visibility" && event.state === "visible" && event.page_id === page_id;
  const visible_events = (mark) => since(mark).filter((event) => event.type === "visibility" && event.state === "visible");
  const scroll_of = (page_id) => (event) => event.type === "scroll" && event.page_id === page_id;
  const last_scroll_y = (page_id) => events.filter(scroll_of(page_id)).at(-1)?.y ?? 0;

  const open_page = (...args) => timings.time("page_opens", () => open_page_untimed(...args));
  async function open_page_untimed(kind, id, { new_tab }) {
    const mark = events.length;
    if (new_tab) {
      await send_keys(...CTRL("t"));
      await sleep(500);
    }
    // A lost keystroke in the address bar leaves the page unloaded, so one retry keeps the test steady.
    for (let attempt = 0; ; attempt++) {
      await send_keys(...CTRL("l"), "-d", "5", url_of(kind, id), "-k", "Return");
      try {
        await wait_event(mark, (event) => event.type === "tree_read" && event.page_id === id, `content script ready on ${id}`, 6000);
        break;
      } catch (error) {
        if (attempt >= 1) throw error;
        measurements.navigation_retries = (measurements.navigation_retries ?? 0) + 1;
      }
    }
    await sleep(150);
  }

  async function scroll_delta_after(page_id, keys) {
    const before = last_scroll_y(page_id);
    const mark = events.length;
    await send_keys(...keys);
    const reported = await wait_event(mark, scroll_of(page_id), `scroll on ${page_id} after ${keys.join(" ")}`);
    return reported.y - before;
  }

  async function expect_no_scroll(mark, page_id) {
    await sleep(700);
    expect(!find_event(mark, scroll_of(page_id)), `page ${page_id} scrolled`);
  }

  // The active tab comes from the background, so a switch that landed on the wrong tab fails by name. A page report cannot say that.
  async function expect_exactly_one_visible(mark, expected_page_id) {
    await sleep(1500);
    const active_url = await evaluate_in_background(rdp, EXTENSION_ID, `browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]?.url)`);
    expect(String(active_url).endsWith(`id=${expected_page_id}`), `expected the active tab to be ${expected_page_id}, it is ${active_url}`);
    const visible = visible_events(mark);
    expect(visible.length <= 1, `expected one switch to ${expected_page_id}, saw [${visible.map((event) => event.page_id).join(", ")}]`);
  }

  const timings_path = default_timings_path(repo_dir);
  // Called after each piece, from the signal path and at the end, so a run killed at the time cap still leaves its numbers. A failed write must not hide the run's own error.
  function write_timings({ print_summary = true } = {}) {
    try {
      const timings_report = timings.report();
      timings.write_json(timings_path, timings_report);
      if (!print_summary) return;
      console.log(timings.summary_text(timings_report));
      console.log(`key-test timings written to ${timings_path}`);
    } catch (error) {
      console.error(`key-test timings not written: ${error.message}`);
    }
  }

  // Piled-up tabs may slow later steps, so the count is sampled between pieces. A failed sample is recorded as null.
  async function sample_tabs(label) {
    const tab_count = await evaluate_in_background(rdp, EXTENSION_ID, `browser.tabs.query({}).then((tabs) => tabs.length)`).catch(() => null);
    timings.record_tab_count(label, tab_count);
  }

  try {
    await sweep_dead_sessions();
    await timed_shadow("up", SHADOW_NAME);
    // A driver that keeps sessions elsewhere has no such dir. Its sessions are never swept, which is safe.
    if (existsSync(dirname(marker_path(SHADOW_NAME)))) writeFileSync(marker_path(SHADOW_NAME), String(process.pid));
    else console.error(`no runtime dir for ${SHADOW_NAME} under /tmp: skipping the owner marker, so a killed run's session will not be swept`);
    await timed_shadow("spawn", SHADOW_NAME, join(key_test_dir, "launch_firefox.sh"), work_dir, profile_dir, String(debug_port), managed_file);
    for (let attempt = 0; ; attempt++) {
      try {
        rdp = timings.wrap_rdp(await connect_rdp(debug_port));
        break;
      } catch (error) {
        if (attempt > 60) throw new Error(`Firefox debugger never answered: ${error.message}`);
        await sleep(500);
      }
    }
    // The padded bundles stand in for a 20 KB hints or caret bundle. They go into a copy, so dist/ stays as built.
    const extension_dir = join(work_dir, "extension");
    cpSync(dist_dir, extension_dir, { recursive: true });
    // The caret bundle keeps its real code and gains the padding after it, so the caret cases run the real sinks. The which-key bundle stays real.
    writeFileSync(join(extension_dir, "caret.js"), readFileSync(join(dist_dir, "caret.js"), "utf8") + padded_bundle_text());
    await install_temporary_addon(rdp, extension_dir);
    // The first new tab of the extension's page shows Firefox's "Your new tab has changed" notice. Once shown, its closed
    // panel keeps the access key K of "Keep Changes" for the session, and that eats Alt+K on pages Firefox draws itself,
    // such as about:support. Confirming the notice the way "Keep Changes" does keeps it from ever showing.
    const notice_confirmation = await evaluate_in_chrome(rdp, `(async () => {
      const { ExtensionSettingsStore } = ChromeUtils.importESModule("resource://gre/modules/ExtensionSettingsStore.sys.mjs");
      await ExtensionSettingsStore.initialize();
      await ExtensionSettingsStore.addSetting("${EXTENSION_ID}", "newTabNotification", "${EXTENSION_ID}", true, () => false);
    })()`);
    if (notice_confirmation?.error) throw new Error(`confirming the new tab notice failed: ${notice_confirmation.error}`);
    // config.reload reads the files through the native host. Firefox grants nativeMessaging only from a click, so the test grants it from chrome code.
    install_native_host(work_dir, readFileSync(join(work_dir, "session_home"), "utf8").trim());
    const permission_grant = await evaluate_in_chrome(rdp, `(async () => {
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      // The third argument tells the running extension, as permissions.request does, so its background gains sendNativeMessage at once.
      const { extension } = WebExtensionPolicy.getByID("${EXTENSION_ID}");
      await ExtensionPermissions.add("${EXTENSION_ID}", { permissions: ["nativeMessaging"], origins: [] }, extension);
    })()`);
    if (permission_grant?.error) throw new Error(`granting nativeMessaging failed: ${permission_grant.error}`);
    const native_api = await evaluate_in_background(rdp, EXTENSION_ID, `typeof browser.runtime.sendNativeMessage`);
    if (native_api !== "function") throw new Error(`the background has no sendNativeMessage after the grant: ${native_api}`);
    await sleep(1500);
    const read_injections = async (file) => {
      const all = await evaluate_in_background(rdp, EXTENSION_ID, `(async () => (await browser.storage.local.get("desertfox_bundle_loads")).desertfox_bundle_loads ?? [])()`);
      if (!Array.isArray(all)) throw new Error(`injection log unreadable: ${JSON.stringify(all)}`);
      return all.filter((entry) => entry.file === file);
    };
    // The log is written after the injection answers, so a read can come first. Wait up to 1 s for the expected count.
    const injections_of = async (file, at_least = 0) => {
      let entries = await read_injections(file);
      for (let waited = 0; entries.length < at_least && waited < 1000; waited += 100) {
        await sleep(100);
        entries = await read_injections(file);
      }
      return entries;
    };
    // A write from the previous case may still be on its way, so the baseline is taken after the log holds still.
    const settled_injection_count = async (file) => {
      await sleep(300);
      return (await read_injections(file)).length;
    };

    await open_page("page", "a", { new_tab: false });
    await open_page("page", "b", { new_tab: true });
    await open_page("page", "c", { new_tab: true });

    let single_j_pixels = 0;

    await run_case("J and K switch tabs", async () => {
      for (const [keys, expected] of [["K", "b"], ["K", "a"], ["J", "b"], ["J", "c"]]) {
        const mark = events.length;
        await send_keys(keys);
        await wait_event(mark, became_visible(expected), `tab ${expected} after ${keys}`);
      }
    });

    await run_case("j scrolls, 3j scrolls three times as far", async () => {
      single_j_pixels = await scroll_delta_after("c", ["j"]);
      expect(single_j_pixels > 0, "j did not scroll down");
      const triple = await scroll_delta_after("c", ["3j"]);
      expect(Math.abs(triple - 3 * single_j_pixels) <= 3, `3j moved ${triple}px, j moved ${single_j_pixels}px`);
    }, { setup: true });

    await run_case("G jumps to the bottom and gg to the top", async () => {
      await scroll_delta_after("c", ["G"]);
      const bottom = events.filter(scroll_of("c")).at(-1);
      expect(bottom.y >= bottom.max_y - 2, `G stopped at ${bottom.y} of ${bottom.max_y}`);
      await scroll_delta_after("c", ["gg"]);
      expect(last_scroll_y("c") === 0, `gg stopped at ${last_scroll_y("c")}`);
    });

    await run_case("ignore mode passes keys to the page and leaves again", async () => {
      await send_keys(...SHIFT_ESCAPE);
      await sleep(300);
      let mark = events.length;
      await send_keys("j");
      await wait_event(mark, (event) => event.type === "keydown" && event.key === "j", "the page to see j in ignore mode");
      await expect_no_scroll(mark, "c");
      await send_keys(...SHIFT_ESCAPE);
      await sleep(300);
      mark = events.length;
      await send_keys("j");
      await wait_event(mark, scroll_of("c"), "scroll after leaving ignore mode");
      expect(!find_event(mark, (event) => event.type === "keydown" && event.key === "j"), "the page saw j in normal mode");
    });

    await run_case("the mode badge shows NORMAL, then IGNORE, then NORMAL", async () => {
      const is_label = (label) => (event) => event.type === "indicator" && event.page_id === "c" && event.label === label;
      expect(events.some(is_label("NORMAL")), "no NORMAL badge at start");
      let mark = events.length;
      await send_keys(...SHIFT_ESCAPE);
      await wait_event(mark, is_label("IGNORE"), "the IGNORE badge");
      mark = events.length;
      await send_keys(...SHIFT_ESCAPE);
      await wait_event(mark, is_label("NORMAL"), "the NORMAL badge after leaving ignore");
    });

    await open_page("field", "f", { new_tab: true });
    await run_case("typing in a field is not swallowed", async () => {
      const typed = "jkxGddqrgg 3j";
      const mark = events.length;
      await send_keys(typed);
      await sleep(800);
      const inputs = since(mark).filter((event) => event.type === "input");
      expect(inputs.at(-1)?.value === typed, `field holds "${inputs.at(-1)?.value}", typed "${typed}"`);
      expect(!find_event(mark, (event) => event.type === "visibility"), "a tab switch happened while typing");
    });

    await run_case("Escape leaves the field and keys act again", async () => {
      await send_keys("-k", "Escape");
      await sleep(300);
      const mark = events.length;
      await send_keys("K");
      await wait_event(mark, became_visible("c"), "tab c after K");
      await send_keys("J");
      await wait_event(mark, became_visible("f"), "tab f after J");
    });

    await open_page("swallow", "s", { new_tab: true });
    await run_case("J and K work on a page that cancels keys in its own capture listener", async () => {
      let mark = events.length;
      await send_keys("K");
      await wait_event(mark, became_visible("f"), "tab f after K");
      await send_keys("J");
      await wait_event(mark, became_visible("s"), "tab s after J");
    });

    await run_case("chord on a cancelling page acts exactly once", async () => {
      let mark = events.length;
      await send_keys(...ALT("j"));
      await expect_exactly_one_visible(mark, "a");
      mark = events.length;
      await send_keys(...ALT("k"));
      await expect_exactly_one_visible(mark, "s");
    });

    await run_case("chord on a normal page acts exactly once", async () => {
      await send_keys("gg");
      await send_keys("K");
      await sleep(500);
      let mark = events.length;
      await send_keys(...ALT("k"));
      await expect_exactly_one_visible(mark, "c");
      mark = events.length;
      await send_keys(...ALT("j"));
      await expect_exactly_one_visible(mark, "f");
    });

    await send_keys(...CTRL("t"));
    await send_keys(...CTRL("l"), "about:support", "-k", "Return");
    await sleep(1500);

    await run_case("Alt+J and Alt+K work on an about: page", async () => {
      let mark = events.length;
      await send_keys(...ALT("k"));
      await expect_exactly_one_visible(mark, "s");
      await send_keys(...ALT("j"));
      await sleep(500);
      mark = events.length;
      await send_keys(...ALT("j"));
      await expect_exactly_one_visible(mark, "a");
    }, { setup: true });

    await run_case("focus_page from the address bar returns keys to the page", async () => {
      const before = last_scroll_y("a");
      const mark = events.length;
      await send_keys(...CTRL("l"));
      await sleep(300);
      await send_keys(...ALT(","));
      await sleep(700);
      await send_keys("j");
      measurements.focus_page_works = Boolean(await wait_event(mark, scroll_of("a"), "j to scroll page a after focus_page", 3000).catch(() => undefined));
      if (!measurements.focus_page_works) {
        await send_keys("-k", "Escape", "-k", "Escape");
        throw new Error(`j after the chord did not reach the page (scroll stayed at ${before})`);
      }
    }, { setup: true });

    // The debugger answers null for undefined, so the checks below compare with == null.
    const read_background = (code) => evaluate_in_background(rdp, EXTENSION_ID, code).catch(() => undefined);
    const read_local = (key) => read_background(`(async () => (await browser.storage.local.get("${key}"))["${key}"])()`);
    // Presses qr and waits until the reload stores the files config. The key is removed first, so an earlier reload does not count.
    async function reload_in_place() {
      await read_background(`browser.storage.local.remove("desertfox_files_config")`);
      await send_keys("qr");
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(250);
        if ((await read_local("desertfox_files_config")) != null) return;
      }
      // The host call made by hand tells a missing permission or host from a refused build.
      const probe = await read_background(`(async () => ({ granted: await browser.permissions.contains({ permissions: ["nativeMessaging"] }), host: await browser.runtime.sendNativeMessage("desertfox_host", { cmd: "read_config" }).then((reply) => ({ ok: reply.ok, error: reply.error, files: Object.keys(reply.files ?? {}).length }), (error) => String(error)) }))()`);
      throw new Error(`qr stored no files config after 10 s: ${JSON.stringify(probe)}`);
    }
    // Waits for the restart that debug.restart starts: the new background writes its tab repair report.
    async function wait_reinject_report() {
      let report;
      for (let attempt = 0; attempt < 60 && !report; attempt++) {
        await sleep(500);
        report = await read_local("desertfox_reinject_report");
      }
      expect(report, "no desertfox_reinject_report after 30 s");
      return report;
    }

    await run_case("config.reload applies the files in place, keeps a temp edit and keeps keys working in open tabs", async () => {
      writeFileSync(join(config_dir, "keymap.toml"), [
        "[normal]",
        'm = "scroll.to 50"',
        'go = ":open"',
        "[browser]",
        '"<A-,>" = "browser.focus_page"',
        '"<A-.>" = "cmdline.open"',
        "",
      ].join("\n"));
      await send_keys(":set -t which_key_delay_ms 777", "-k", "Return");
      await sleep(800);
      const temp_before = await read_background(`(async () => (await browser.storage.session.get("desertfox_temp_settings")).desertfox_temp_settings)()`);
      expect(temp_before?.which_key_delay_ms === 777, `the temp edit did not land: ${JSON.stringify(temp_before)}`);

      await send_keys("gg");
      await sleep(500);
      await read_background(`browser.storage.local.remove("desertfox_reinject_report")`);
      await reload_in_place();
      await sleep(500);
      expect((await read_local("desertfox_reinject_report")) == null, "qr restarted the extension: a tab repair report was written");
      const status = await read_local("desertfox_config_status");
      expect(status?.source === "files", `the config source is ${status?.source}, expected files`);
      expect(status?.temp?.includes("which_key_delay_ms") && status?.settings?.which_key_delay_ms === 777, `the temp edit did not survive the reload: ${JSON.stringify(status?.temp)} ${status?.settings?.which_key_delay_ms}`);

      const one_j = await scroll_delta_after("a", ["j"]);
      expect(one_j === single_j_pixels, `after reload j moved ${one_j}px, before it moved ${single_j_pixels}px (double or missing action)`);
      const mark = events.length;
      await send_keys("m");
      const halfway = await wait_event(mark, scroll_of("a"), "scroll to 50 percent");
      expect(Math.abs(halfway.y - halfway.max_y / 2) <= 2, `m stopped at ${halfway.y} of ${halfway.max_y}`);
      const switch_mark = events.length;
      await send_keys("J");
      await expect_exactly_one_visible(switch_mark, "b");
      const other_tab_delta = await scroll_delta_after("b", ["j"]);
      expect(other_tab_delta === single_j_pixels, `in an untouched tab j moved ${other_tab_delta}px, expected ${single_j_pixels}px`);
    }, { setup: true });

    await run_case("debug.restart restarts the extension, keeps keys working in open tabs and keeps the reloaded files over managed storage", async () => {
      await read_background(`browser.storage.local.remove("desertfox_reinject_report")`);
      await send_keys(":debug.restart", "-k", "Return");
      const report = await wait_reinject_report();
      measurements.reinject_report = report;
      console.log(`reinject report ${JSON.stringify(report)}`);
      await sleep(1000);
      expect((await read_local("desertfox_config_status"))?.source === "files", "after the restart the config no longer comes from the files");
      const one_j = await scroll_delta_after("b", ["j"]);
      expect(one_j === single_j_pixels, `after the restart j moved ${one_j}px, expected ${single_j_pixels}px`);
      const mark = events.length;
      await send_keys("m");
      const halfway = await wait_event(mark, scroll_of("b"), "scroll to 50 percent after the restart");
      expect(Math.abs(halfway.y - halfway.max_y / 2) <= 2, `m stopped at ${halfway.y} of ${halfway.max_y}`);
    }, { setup: true });

    await run_case("keys work on a fresh load after the reload", async () => {
      await open_page("page", "after_reload", { new_tab: true });
      expect((await scroll_delta_after("after_reload", ["j"])) === single_j_pixels, "j moved a different distance");
    });

    // P0: bundles load on first use
    await run_case("a bundle loads on the first key, once, and no key typed during the load is lost", async () => {
      await open_page("page", "bundle_a", { new_tab: true });
      const loads_before = await settled_injection_count("hints.js");
      // f starts the load. The three keys behind it arrive within a few milliseconds, before the injection can finish.
      // Held in order they scroll to the bottom. Reversed or dropped they would end at the top.
      const mark = events.length;
      await send_keys("fggG");
      await wait_event(mark, (event) => event.type === "scroll" && event.page_id === "bundle_a" && event.y > 0 && event.y >= event.max_y - 2, "the page to end at the bottom after fggG");
      const hint_loads = await injections_of("hints.js", loads_before + 1);
      expect(hint_loads.length === loads_before + 1, `expected one hints.js injection, saw ${hint_loads.length - loads_before}`);
      measurements.stub_bundle_inject_ms = hint_loads.at(-1).ms;
      await sleep(500);
      const again = events.length;
      await send_keys("gg");
      await wait_event(again, scroll_of("bundle_a"), "gg to scroll after the load");
      expect(last_scroll_y("bundle_a") === 0, "keys did not work after the load");
      await send_keys("f");
      await sleep(800);
      expect((await injections_of("hints.js")).length === loads_before + 1, "a second f injected the bundle again");
    });

    await run_case("a count typed during the load keeps its meaning", async () => {
      await open_page("page", "bundle_b", { new_tab: true });
      const single = await scroll_delta_after("bundle_b", ["j"]);
      await scroll_delta_after("bundle_b", ["gg"]);
      const mark = events.length;
      await send_keys("f3j");
      const reported = await wait_event(mark, scroll_of("bundle_b"), "scroll after f3j");
      expect(Math.abs(reported.y - 3 * single) <= 3, `f3j moved ${reported.y}px, j moves ${single}px`);
    });

    await run_case("V loads the padded caret bundle and enters caret mode, Escape leaves it", async () => {
      await open_page("page", "bundle_c", { new_tab: true });
      const is_label = (label) => (event) => event.type === "indicator" && event.page_id === "bundle_c" && event.label === label;
      const mark = events.length;
      await send_keys("gV");
      await wait_event(mark, is_label("CARET"), "the CARET badge");
      const caret_loads = await injections_of("caret.js", 1);
      expect(caret_loads.length >= 1 && caret_loads.at(-1).ok, "caret.js was not injected");
      measurements.padded_bundle_inject_ms = caret_loads.at(-1).ms;
      await send_keys("-k", "Escape");
      await wait_event(mark, is_label("NORMAL"), "the NORMAL badge after Escape");
      expect(await scroll_delta_after("bundle_c", ["j"]) > 0, "the page stopped taking keys after V and Escape");
    });

    await run_case("executeScript of a 20 KB file takes this long", async () => {
      const timings = await evaluate_in_background(rdp, EXTENSION_ID, `(async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        const ms = [];
        for (let run = 0; run < 15; run++) {
          const started = performance.now();
          await browser.tabs.executeScript(tab.id, { file: "caret.js", runAt: "document_start" });
          ms.push(performance.now() - started);
        }
        return ms;
      })()`);
      const sorted_ms = [...timings].sort((left, right) => left - right);
      measurements.execute_script_20kb_ms = { runs: sorted_ms.length, min: sorted_ms[0], median: sorted_ms[sorted_ms.length >> 1], max: sorted_ms.at(-1) };
    });

    // P9: snippets, from test/key/config/snippets
    const snippet_events = (mark, type) => since(mark).filter((event) => event.type === type);
    await open_page("page", "snip", { new_tab: true });

    await run_case("a snippet runs on a matching page, in the top frame, with its default arg", async () => {
      const mark = events.length;
      await send_keys(",s");
      const ran = await wait_event(mark, (event) => event.type === "snippet_ran" && event.page_id === "snip", "the snippet report");
      expect(ran.word === "hi" && ran.top === true, `snippet reported word=${ran.word} top=${ran.top}`);
    });

    await run_case("a snippet limited to another site does not run here", async () => {
      const mark = events.length;
      await send_keys(",x");
      await sleep(1000);
      expect(snippet_events(mark, "snippet_wrong_site").length === 0, "the snippet ran on a site its matches do not name");
      expect(find_event(mark, (event) => event.type === "toast"), "no toast for the refusal");
    });

    await run_case("an error in a snippet shows a toast and keys keep working", async () => {
      await sleep(3500);
      const mark = events.length;
      await send_keys(",e");
      await wait_event(mark, (event) => event.type === "toast", "the error toast");
      expect(await scroll_delta_after("snip", ["j"]) > 0, "j did not scroll after the snippet error");
    });

    await run_case("a snippet that calls itself stops after 5 levels with a toast", async () => {
      await sleep(3500);
      const mark = events.length;
      await send_keys(",l");
      await wait_event(mark, (event) => event.type === "toast", "the depth limit toast");
      await sleep(500);
      const levels = snippet_events(mark, "snippet_level").length;
      expect(levels === 5, `the looping snippet ran ${levels} times`);
    });

    await run_case("a snippet key pressed inside an iframe runs in the top frame only", async () => {
      const focus_mark = events.length;
      await open_page("framed", "framed", { new_tab: true });
      await wait_event(focus_mark, (event) => event.type === "window_focus" && event.page_id === "inner", "the iframe to take focus");
      const mark = events.length;
      await send_keys(",s");
      await wait_event(mark, (event) => event.type === "snippet_ran" && event.page_id === "framed", "the snippet report from the top frame");
      await sleep(500);
      const in_frame = snippet_events(mark, "snippet_ran").filter((event) => event.page_id === "inner" || event.top !== true);
      expect(in_frame.length === 0, "the snippet ran inside the iframe");
    });

    // part C: help page
    // The pages are extension pages, so the test reads them through the background's view list.
    const extension_view = (name) => `(browser.extension.getViews({ type: "tab" }).find((view) => view.location.pathname === "/${name}"))`;

    await run_case("the help page takes j, gg and ignore mode", async () => {
      await send_keys("qh");
      let state;
      for (let attempt = 0; attempt < 40 && !state?.ready; attempt++) {
        await sleep(250);
        state = await evaluate_in_background(rdp, EXTENSION_ID, `(() => { const view = ${extension_view("home.html")}; return { ready: !!view && !!view.document.querySelector("h1") }; })()`).catch(() => undefined);
      }
      expect(state?.ready, "the help page never rendered");
      // Home is too short to scroll, so move to the long Commands page.
      await evaluate_in_background(rdp, EXTENSION_ID, `(() => { ${extension_view("home.html")}.location.hash = "#/commands"; })()`);
      await sleep(800);
      const probe = () => evaluate_in_background(rdp, EXTENSION_ID, `(() => { const view = ${extension_view("home.html")}; return { y: view.scrollY, badge: view.document.querySelector("[data-desertfox-mode]")?.getAttribute("data-desertfox-mode") ?? null }; })()`);
      await send_keys("j", "j", "j");
      await sleep(600);
      const scrolled = await probe();
      expect(scrolled.y > 0, `j did not scroll the help page (y=${scrolled.y})`);
      await send_keys("gg");
      await sleep(600);
      expect((await probe()).y === 0, "gg did not return to the top");
      await send_keys(...SHIFT_ESCAPE);
      await sleep(600);
      const ignored = await probe();
      expect(ignored.badge === "IGNORE", `badge after <S-Escape> was ${ignored.badge}`);
      await send_keys(...SHIFT_ESCAPE);
      await sleep(300);
    }, { setup: true });

    // caret.js loads on the help page by script tag, so the caret keys work there. Escape must still leave the page in normal mode.
    await run_case("V on the help page enters caret mode and Escape returns to normal", async () => {
      const badge = () => evaluate_in_background(rdp, EXTENSION_ID, `${extension_view("home.html")}?.document.querySelector("[data-desertfox-mode]")?.getAttribute("data-desertfox-mode") ?? null`);
      const loads_before = await settled_injection_count("caret.js");
      await send_keys("gV");
      await sleep(1500);
      const loads = (await injections_of("caret.js")).slice(loads_before);
      measurements.help_page_caret_load = loads.length === 0 ? "not requested" : loads.at(-1).ok ? "executeScript ok" : "executeScript refused";
      const entered = await badge();
      expect(entered === "CARET" || entered === "VISUAL", `the help page badge after V was ${entered}`);
      for (let step = 0; step < 2; step++) {
        await send_keys("-k", "Escape");
        await sleep(400);
      }
      expect(await badge() === "NORMAL", `the help page badge after Escape was ${await badge()}`);
    });

    // The new tab page loads every key script by tag, since executeScript cannot reach an extension page.
    await run_case("the new tab page takes : and f without asking executeScript", async () => {
      const hints_before = await settled_injection_count("hints.js");
      const cmdline_before = await settled_injection_count("cmdline.js");
      await evaluate_in_background(rdp, EXTENSION_ID, `browser.tabs.create({ url: browser.runtime.getURL("newtab.html") })`);
      let ready = false;
      for (let attempt = 0; attempt < 40 && !ready; attempt++) {
        await sleep(250);
        ready = await evaluate_in_background(rdp, EXTENSION_ID, `!!${extension_view("newtab.html")}?.document.querySelector(".desertfox-newtab")`).catch(() => false);
      }
      expect(ready, "the new tab page never rendered");
      await sleep(800);
      const mode = () => evaluate_in_background(rdp, EXTENSION_ID, `${extension_view("newtab.html")}?.desertfox_host?.get_mode() ?? null`);
      await send_keys(":");
      await sleep(800);
      expect(await mode() === "cmdline", `the mode after : was ${await mode()}`);
      // The first Escape closes the completion list, the second closes the line.
      await send_keys("-k", "Escape");
      await send_keys("-k", "Escape");
      await sleep(500);
      expect(await mode() === "normal", `the mode after Escape was ${await mode()}`);
      await evaluate_in_background(rdp, EXTENSION_ID, `(() => { const view = ${extension_view("newtab.html")}; const link = view.document.createElement("a"); link.href = "https://example.com/"; link.textContent = "link"; link.style.cssText = "position:fixed;top:20px;left:20px;color:white;"; view.document.body.append(link); })()`);
      await send_keys("f");
      await sleep(1500);
      expect(await mode() === "hint", `the mode after f was ${await mode()}`);
      await send_keys("-k", "Escape");
      await sleep(500);
      expect((await injections_of("hints.js")).length === hints_before, "hints.js went through executeScript");
      expect((await injections_of("cmdline.js")).length === cmdline_before, "cmdline.js went through executeScript");
      await evaluate_in_background(rdp, EXTENSION_ID, `(async () => { for (const tab of await browser.tabs.query({})) if (tab.url.endsWith("/newtab.html")) await browser.tabs.remove(tab.id); })()`);
    });

    await run_case("the add-on preferences open the settings page", async () => {
      // Firefox focuses an open help tab instead of opening Settings, so the earlier help case's tab goes first.
      // The answer is a short summary: a whole page of text is too long to come back over RDP.
      const settings = await evaluate_in_background(rdp, EXTENSION_ID, `(async () => {
        for (const tab of await browser.tabs.query({})) if (new URL(tab.url).pathname === "/home.html") await browser.tabs.remove(tab.id);
        await browser.runtime.openOptionsPage();
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const view = ${extension_view("home.html")};
          if (view?.document.querySelector("[data-setting]")) return { hash: view.location.hash, rows: view.document.querySelectorAll("[data-setting]").length };
        }
        return { hash: "", rows: 0 };
      })()`);
      expect(settings?.hash === "#/settings" && settings?.rows > 20, `settings page after openOptionsPage: ${JSON.stringify(settings)}`);
    });

    // part A: scroll align
    await run_case("scroll.align puts the field just left at the top, center and bottom", async () => {
      await open_page("aligned", "align", { new_tab: true });
      const field_top_after = async (keys) => {
        const mark = events.length;
        await send_keys(...keys);
        const reported = await wait_event(mark, scroll_of("align"), `scroll after ${keys.join(" ")}`);
        await sleep(300);
        return events.filter(scroll_of("align")).at(-1).field_top ?? reported.field_top;
      };
      await field_top_after(["gi"]);
      await send_keys("-k", "Escape");
      await sleep(300);
      const top = await field_top_after(["zt"]);
      expect(Math.abs(top) <= 2, `zt left the field at ${top}`);
      const center = await field_top_after(["zz"]);
      expect(center > 100, `zz left the field at ${center}`);
      const bottom = await field_top_after(["zb"]);
      expect(bottom > center, `zb left the field at ${bottom}, zz at ${center}`);
      measurements.align_field_tops = { top, center, bottom };
    });

    await run_case("scroll.align with nothing focused leaves the scroll position alone", async () => {
      await open_page("page", "align_plain", { new_tab: true });
      const mark = events.length;
      await send_keys("zt");
      await expect_no_scroll(mark, "align_plain");
    });

    await run_case("z= resets the zoom to 100 percent", async () => {
      const active_zoom = `(async () => { const [tab] = await browser.tabs.query({ active: true, currentWindow: true }); return browser.tabs.getZoom(tab.id); })()`;
      await send_keys("zI");
      await sleep(500);
      expect(await evaluate_in_background(rdp, EXTENSION_ID, active_zoom) === 3, "zI did not zoom to 300 percent");
      await send_keys("z=");
      await sleep(500);
      expect(await evaluate_in_background(rdp, EXTENSION_ID, active_zoom) === 1, "z= did not reset the zoom");
    });

    // The default t, x and r groups. Plain t, x and r are prefixes only.
    await open_page("page", "d_reload", { new_tab: true });
    await run_case("rr reloads the page", async () => {
      const mark = events.length;
      await send_keys("rr");
      await wait_event(mark, (event) => event.type === "tree_read" && event.page_id === "d_reload", "d_reload to load again after rr");
    });

    await run_case("tt opens the command line for its prompt without opening a tab", async () => {
      const mark = events.length;
      await send_keys("tt");
      await sleep(1000);
      // The first Escape closes the completion list and keeps the line. The second closes the line.
      await send_keys("-k", "Escape");
      await sleep(400);
      await send_keys("-k", "Escape");
      await sleep(400);
      expect(visible_events(mark).length === 0, "tt switched tabs");
      expect(!find_event(mark, (event) => event.type === "tree_read"), "tt loaded a page");
    });

    await run_case("x alone does nothing", async () => {
      const mark = events.length;
      await send_keys("x");
      await sleep(1000);
      expect(visible_events(mark).length === 0, "x closed or switched a tab");
      await send_keys("-k", "Escape");
      expect(await scroll_delta_after("d_reload", ["j"]) > 0, "the page stopped taking keys after x");
    });

    await run_case("xx closes the tab", async () => {
      await open_page("page", "d_close", { new_tab: true });
      const mark = events.length;
      await send_keys("xx");
      const shown = await wait_event(mark, (event) => event.type === "visibility" && event.state === "visible" && event.page_id !== "d_close", "another tab after xx");
      expect(shown.page_id !== "d_close", "d_close is still the visible tab");
      expect(await scroll_delta_after(shown.page_id, ["j"]) > 0, "the tab left after xx does not take keys");
    });

    await run_case("Ctrl+A adds one to the number in the address, and 3 then Ctrl+X takes three off", async () => {
      await open_page("page", "num_5", { new_tab: true });
      let mark = events.length;
      await send_keys(...CTRL("a"));
      await wait_event(mark, (event) => event.type === "tree_read" && event.page_id === "num_6", "the page num_6 after Ctrl+A");
      mark = events.length;
      await send_keys("3", ...CTRL("x"));
      await wait_event(mark, (event) => event.type === "tree_read" && event.page_id === "num_3", "the page num_3 after 3 Ctrl+X");
    });

    // Points the native host at a config folder and reloads it in place with qr. The which-key shots use it to show a copy of the user config.
    const load_config_dir = async (dir) => {
      rmSync(active_config);
      symlinkSync(dir, active_config);
      await reload_in_place();
      await sleep(500);
    };

    // Pieces keep their cases in test/key/p<number>_*.mjs, each exporting run_cases(context).
    const case_context = { config_dir, load_config_dir, take_shot: (path) => timed_shadow("shot", SHADOW_NAME, "--out", path), run_case, expect, open_page, send_keys, sleep, events, wait_event, since, find_event, url_of, rdp, extension_id: EXTENSION_ID, scroll_delta_after, became_visible, scroll_of, last_scroll_y };
    await sample_tabs("before pieces");
    for (const file of readdirSync(key_test_dir).filter((name) => /^p\d+_.*\.mjs$/.test(name)).sort()) {
      await timings.time_piece(file, async () => {
        await sample_tabs(`before ${file}`);
        await (await import(`./${file}`)).run_cases(case_context);
      });
      write_timings({ print_summary: false });
    }
    await sample_tabs("after pieces");

    const tree_read_ms = [];
    for (let index = 0; index < FRESH_LOAD_COUNT; index++) {
      const id = `fresh_${String(index).padStart(2, "0")}`;
      const mark = events.length;
      await open_page("page", id, { new_tab: false });
      tree_read_ms.push(find_event(mark, (event) => event.type === "tree_read" && event.page_id === id).ms);
    }
    measurements.tree_read_ms = tree_read_ms;
    const sorted = [...tree_read_ms].sort((left, right) => left - right);
    measurements.tree_read_summary = { loads: sorted.length, min: sorted[0], median: (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2, max: sorted.at(-1) };

    await timings.time_piece("p1.mjs", () => p1_cases({ run_case, expect, send_keys, sleep, open_page, events, wait_event, scroll_of, last_scroll_y, find_event, evaluate_in_background, rdp, EXTENSION_ID }));
    await sample_tabs("after p1.mjs");
  } finally {
    await teardown();
    console.log(JSON.stringify(measurements));
    write_timings();
  }

  const failed = results.filter((result) => !result.pass);
  const setup_ran = results.filter((result) => result.setup).length;
  if (setup_ran > 0) console.log(`${setup_ran} setup cases ran only because KEY_TEST_ONLY filtered the run`);
  console.log(`${results.length - failed.length} of ${results.length} cases passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`key-test aborted: ${error.stack}`);
  await shadow("down", SHADOW_NAME).catch(() => undefined);
  process.exit(1);
});
