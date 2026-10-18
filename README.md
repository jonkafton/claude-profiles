# Claude Profiles

An unofficial macOS app for running several Claude accounts side by side, each in its own isolated, signed-in workspace (Claude Code or Claude Design), with your Claude Code Remote Control servers managed from the same place.

> **Not affiliated with Anthropic.** Claude and Claude Code are trademarks of Anthropic. This is an independent tool that wraps claude.ai in a desktop shell and drives the official `claude` CLI.

> [!IMPORTANT]
> **Sign in by email, not Google or Apple.** Google and Apple block sign-in from inside apps like this one ("Couldn't sign you in. This browser or app may not be secure"). On the Claude sign-in page choose **Continue with email**, then **open the link in the email**: it opens in your normal browser and shows a **verification code**. Type that code into Claude Profiles. Details in [Signing in](#signing-in-by-email).

## Why this exists

If you use more than one Claude account on one Mac (a work seat and a personal plan, two subscriptions to cover your usage, a client's organisation), the existing options all break down somewhere:

- **The Claude desktop app is one account per Mac.** Only one copy runs at a time, and every Claude Code session it starts bills whichever account it is signed in to. Switching means signing out and back in.
- **Remote Control sessions never go away.** Each Remote Control session is a process on your Mac that stays alive after its last turn, holding 150 to 500 MB plus its MCP servers. They pile up: dozens of sessions holding over 10 GB is easy to reach. Nothing lists them, clears the idle ones, or brings one back when you want it again.
- **Every account looks the same.** Several Claude windows mean identical icons in the Dock and in ⌘Tab, so switching to the right account is guesswork.
- **Web apps don't fill the gap.** Safari web apps keep each login separate, but links from Claude either stay trapped inside the web app or are silently dropped instead of opening in your browser. Chrome merges every claude.ai install across all your Chrome profiles into one Dock app with a profile-switching menu, so you can't give each account its own app.
- **Folders and accounts get crossed.** Nothing stops a project's Claude Code sessions from running under the wrong account.

Claude Profiles fixes all of these in one app.

## Features

- **Multiple windows, one per desktop.** Open as many windows as you like (⌘N), each showing its own profile, and put one on each macOS desktop so a three-finger swipe moves between accounts. Two windows on the same account share its sign-in.
- **The app icon becomes the active profile's icon.** In the Dock and the ⌘Tab switcher you see exactly which account you are switching to.
- **Isolated sign-in per profile.** Each profile has its own cookies, storage and cache, so each stays signed in to its own account with no crossover.
- **A sidebar of your accounts**, with your own icons. Click one or press ⌘1 to ⌘9.
- **Create profiles in the app.** Give a profile a name, the email of its Claude subscription, an icon, and the working folders on your Mac its Claude Code sessions use. A setup checklist on each profile tells you what is done and what is left.
- **Claude Design profiles too.** Add a profile that opens claude.ai/design instead of Claude Code. It can share the sign-in of a Claude Code profile on the same account, so you sign in once for both.
- **No icon design needed.** Pick a colour from a preset or the macOS colour wheel and the app makes an icon: a white spark (Code) or sparkle (Design) on that colour. Or use any image you like. The marks are original, not Anthropic's logos.
- **Remote Control servers, managed for you.** Each profile's folders get a `claude remote-control` server that runs as a launchd job, so it keeps running when the app is closed and comes back after a restart. Start, stop and restart from the **Servers** screen.
- **See and clear sessions.** Every open session is listed by its title (the same one claude.ai's sidebar shows), with its last activity and memory, **End** to free it and **Keep** to protect it.
- **Automatic cleanup (optional).** Once an hour, end sessions that have been idle for 3 hours or more.
- **Links behave.** Links to anything outside Claude open in your default browser. Claude links stay in the profile. Right-click any link for **Open Link in Browser** or **Copy Link**.
- **Guard rails.** Warns when a profile's Claude Code login is a different account from the profile's, refuses to start a server in a folder Claude Code hasn't trusted, and can pin folders to accounts (for example, a client's folders may only run under that client's account).
- **Status at a glance.** A dot on each profile's icon shows whether its servers are running, and a badge shows how many sessions are open.

## Requirements

- macOS (built and tested on macOS 15; Intel and Apple Silicon builds come from the same source).
- [Node.js](https://nodejs.org/) 20 or later, to build the app.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, with `claude` on your shell's `PATH`, and a version that supports `claude remote-control`.
- A Claude subscription for each account that includes Claude Code and Remote Control.

## Install

```bash
git clone https://github.com/jonkafton/claude-profiles.git
cd claude-profiles
npm install
npm run package
```

`npm run package` builds the app and installs it as `~/Applications/Claude Profiles.app`, signed ad hoc for your own Mac. Open it from there and pin it to the Dock. To update later, `git pull` and run `npm run package` again; your Dock pin keeps pointing at the new version, and the previous build is kept in `dist/` (delete it whenever you like).

## Setting up a profile

When the app opens for the first time it shows the **Profiles** screen with a new profile form. Later, use **Add** at the bottom of the sidebar or **Profiles → Add Profile…**.

1. **Fill in the profile.**
   - **Name**: what the sidebar shows, for example "Work".
   - **Claude account email**: the email of the Claude subscription this profile uses, on the web and in Claude Code.
   - **Icon**: pick a colour (a preset swatch, or any colour from the colour wheel) to get a white spark on that colour, or choose any image. It is used in the sidebar and as the app icon while the profile is active. A new profile without one gets a coloured spark automatically.
   - **Working folders**: choose the project folders on your Mac that this account's Claude Code sessions work in. Each folder gets its own Remote Control server.
   - **Advanced**: the **Claude Code config folder** (`CLAUDE_CONFIG_DIR`) holds this account's Claude Code login and settings. Leave it empty to get a new, separate one at `~/.claude-<profile-id>`, or choose an existing folder, such as `~/.claude`, to reuse a login you already have. You can also change the start page (default `https://claude.ai/code`).
2. **Press Create profile.** The profile now shows a setup checklist. Each step ticks itself off when it is done.
3. **Sign in to Claude in the profile.** Press **Open profile** and sign in **by email** ([how](#signing-in-by-email)).
4. **Sign Claude Code in to the same account.** Press **Sign in in Terminal**. Terminal opens Claude Code with this profile's config folder. Choose the Claude account option. When Claude Code shows a sign-in link, copy it, switch to Claude Profiles with this profile selected and press **⇧⌘V**: the link opens inside the profile, so the right account approves it. Paste the code it gives you back into Terminal, then type `/exit`.
5. **Trust each folder and allow Remote Control.** Press **Set up in Terminal** next to each folder. Answer `y` to "Trust this folder?" and to "Enable Remote Control?", wait for **Ready**, then press Ctrl+C.
6. **Start the servers.** Press **Open Servers** and **Start** each folder's server.

Now open the profile, start a new Claude Code session, and choose the environment named after your folder, shown as `<folder> · <your Mac's name>`. The same sessions are reachable from the Claude app on your phone or any browser signed in to that account.

## Claude Design profiles

Use **Add Design profile** on the Profiles screen (or choose **Claude Design** as the type in the new profile form). A Design profile opens `https://claude.ai/design` in its own window slot, with its own icon. It is web only: there are no working folders, servers or Claude Code setup.

- **Sign-in:** either its own (sign in by email as usual), or **Share <profile>'s sign-in** to reuse a Claude Code profile on the same account. Sharing means one sign-in for both; the two profiles then always use the same account. A profile that shares a sign-in can't itself be shared, and a profile whose sign-in is shared can't be deleted until the profiles using it are changed.
- **Icon:** pick a colour for a white sparkle on that colour, or choose any image.

## Signing in by email

Google and Apple refuse to sign anyone in from an app that embeds a browser, whatever it presents itself as. If you press **Continue with Google** by habit, Claude Profiles recognises the "Couldn't sign you in" page, takes you back to Claude's sign-in page, and explains this. Email sign-in works for every Claude account, including ones you created with Google.

1. In the profile, choose **Continue with email** and enter the account's address.
2. Claude emails you a sign-in link. **Open the link.** It opens in your normal browser, and because that is not the browser that asked for it, Claude shows a **verification code** there instead of signing you in.
3. Back in Claude Profiles, **type that code** into the box under "If the link shows a verification code instead of signing you in, enter it here" and press **Verify email address**.

Alternatively, right-click the link in your email, choose **Copy Link**, then press **⇧⌘V** in Claude Profiles with the profile selected (**View → Open Copied Link in This Profile**). The link opens inside the profile and signs it straight in.

Do not paste the link itself into the code box: it expects the short code, and rejects the link with "There was an error verifying your code".

## Everyday use

| Shortcut | Does |
|---|---|
| ⌘1 to ⌘9 | Switch to a profile |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous profile |
| ⌘N | New window on the current profile |
| ⇧⌘1 to ⇧⌘9 | New window on that profile |
| ⌘, | Profiles screen |
| ⇧⌘S | Servers screen |
| ⌘R | Reload |
| ⌘[ / ⌘] | Back / forward |
| ⇧⌘H | Back to the profile's start page |
| ⇧⌘O | Open the current page in your browser |
| ⇧⌘C | Copy the current page's link |
| ⇧⌘V | Open a copied link in the current profile |

Windows and their active profiles are restored when you reopen the app.

## Servers and cleanup

The **Servers** screen lists every profile's folders and their Remote Control servers.

- **Start / Stop / Restart** a server. Servers are launchd jobs, so they keep running when Claude Profiles is closed and start again after you log in. Stopping takes that server's sessions offline.
- **Sessions** are listed by title, with their last activity and how much memory they hold (including their MCP servers). Titles and last activity come from claude.ai using that profile's sign-in; this uses claude.ai's internal web API, so if it ever changes the screen falls back to session IDs. **End** stops a session and frees its memory. **Keep** protects a session from automatic cleanup.
- **Also running from a Terminal window**: if you already run `claude remote-control` by hand in a profile's folder, it shows here. When its sessions are done, press **Stop it**, then **Start** to hand the folder over to the app.
- **Other servers** lists Remote Control servers that match no profile, so you can stop strays.
- **Automatic cleanup** is off until you switch it on. Once an hour it ends sessions that have been idle for `idleHours` (default 3), where idle means the session and everything it started used less than `idleCpuPerHour` CPU seconds per hour (default 30; an idle session uses about 10 to 20). A tool that finished since the last check counts as activity. **Preview** shows what it would end; **Run now** ends them immediately. Claude desktop app sessions are left alone unless you set `includeDesktop`.

About ended sessions: Claude Code's documentation says a crashed Remote Control session is served again when you next message it, and cleanup ends sessions the way a crash would. This has not been reliably confirmed in testing, so treat **End** as closing the session. You can always continue one from Terminal with `claude --resume` in the folder, using that profile's `CLAUDE_CONFIG_DIR`.

## Configuration

Everything the Profiles screen does is saved to `profiles.json` in the app's data folder (**Profiles → Show Data Folder**). You can edit it by hand; restart the app afterwards. See [`profiles.example.json`](profiles.example.json).

| Key | Meaning |
|---|---|
| `profiles[].id` | Fixed when the profile is created. It names the profile's sign-in storage, so changing it signs that profile out. |
| `profiles[].kind` | `code` (default) or `design`. Design profiles have no `configDir` or `servers`. |
| `profiles[].name`, `account`, `icon`, `url` | Sidebar name, Claude account email, icon file (relative to the data folder), start page (default `https://claude.ai/code`, or `https://claude.ai/design` for Design). |
| `profiles[].shareSignIn` | Optional id of another profile whose sign-in this one reuses. |
| `profiles[].configDir` | The profile's Claude Code config folder (`CLAUDE_CONFIG_DIR`). Must be signed in to `account`. |
| `profiles[].servers[]` | One entry per working folder: `id`, `folder`, and optional extra `args` for `claude remote-control` (for example `["--capacity", "100"]`). |
| `dockIconFollowsProfile` | `false` keeps the app's own icon instead of the active profile's. |
| `cleanup` | `idleHours`, `idleCpuPerHour`, `includeDesktop`. Switching cleanup on or off is done on the Servers screen. |
| `pairings` | Optional guard rails: `[{ "folderContains": "client-x", "configDir": "~/.claude-client-x" }]` means any folder whose path contains `client-x` may only run under that Claude Code config. |
| `launchdLabelPrefix` | Optional prefix for the launchd job labels (default `io.github.jonkafton.claude-profiles`). |

## Files and locations

| What | Where |
|---|---|
| Profiles, icons, settings, logs | `~/Library/Application Support/Claude Profiles/` (`profiles.json`, `icons/`, `state/`, `logs/`) |
| Each profile's web sign-in | `~/Library/Application Support/Claude Profiles/Partitions/profile-<id>/` |
| Server and cleanup jobs | `~/Library/LaunchAgents/io.github.jonkafton.claude-profiles.*.plist` |
| Claude Code logins | each profile's `configDir`, for example `~/.claude-work` |
| Server logs | `~/Library/Application Support/Claude Profiles/logs/<profile>-<folder>.err` and `manager.log` |

## Troubleshooting

- **"Couldn't sign you in. This browser or app may not be secure."** That is Google's block on embedded browsers. Sign in [by email](#signing-in-by-email).
- **"There was an error verifying your code."** You pasted the sign-in link into the code box. Open the link to get the code, or copy the link and press ⇧⌘V.
- **"<folder> · <your Mac> is offline" in a session.** The session is pointed at a folder whose server is stopped, or at an old environment. Start the server on the Servers screen, or pick another environment under the message box.
- **A server shows "Problem: folder not trusted for this profile".** Run step 5 of [Setting up a profile](#setting-up-a-profile) for that folder.
- **"This profile expects A, but its Claude config is signed in as B".** Sessions would land in the wrong account. Run `/logout` in Claude Code with that config, then sign in again (step 4).
- **A server stays on "Starting…".** Check its `.err` log. The usual cause is `claude` not being found: the app takes `PATH` from your login shell, so make sure `claude` works in a new Terminal window.
- **Nothing happens when a setup step opens Terminal.** The first time, macOS asks whether Claude Profiles may control Terminal. If you declined, the command is copied to your clipboard instead; paste it into Terminal. You can change this in **System Settings → Privacy & Security → Automation**.

## How it works

- **Electron** (`BaseWindow` with one `WebContentsView` for the sidebar and one per profile or screen). Each profile uses a persistent session partition, `persist:profile-<id>`, which keeps its cookies and storage apart from every other profile.
- **Profile pages run sandboxed** with no Node.js access and no preload script, so claude.ai cannot reach the app's internals. Only the app's own screens can call the main process.
- **Servers** are launchd agents that run the app's own binary in Node mode (`ELECTRON_RUN_AS_NODE`) with `helper.js serve <key>`. The helper starts `claude remote-control` in the folder under the profile's `CLAUDE_CONFIG_DIR`, inside `script(1)` because `remote-control` needs a terminal. Each server's sessions are titled with its key so the app can tell its servers from hand-started ones.
- **Status** comes from `ps` and `lsof`: servers are `claude remote-control` processes, sessions are their children.
- **Cleanup** compares each session's CPU time between hourly runs and ends idle ones with `SIGKILL`.

## Privacy and security

- No telemetry. The app talks only to the sites you open in it.
- To show setup progress it checks whether a profile's storage holds claude.ai's sign-in cookie; it never reads the cookie's value. It reads each Claude Code config's `.claude.json` for the signed-in email and folder trust, and never writes to it.
- Web permissions are limited to notifications, clipboard, fullscreen and microphone (for voice input).

## Uninstall

1. On the Servers screen, stop every server, and switch cleanup off.
2. Quit the app and delete `~/Applications/Claude Profiles.app`.
3. Delete any remaining `~/Library/LaunchAgents/io.github.jonkafton.claude-profiles.*.plist` files (stopped servers are parked in `state/launchd/` and are not loaded).
4. Delete `~/Library/Application Support/Claude Profiles/` to remove profiles and sign-ins, and any `~/.claude-<profile>` folders you no longer need.

## Development

```bash
npm install
npm start           # run from source
npm run package     # build and install ~/Applications/Claude Profiles.app
```

Servers started from a source run point at the development copy of Electron, so start your real servers from the installed app. Environment variables for testing:

| Variable | Effect |
|---|---|
| `CLAUDE_PROFILES_DIR` | Use another data folder for `profiles.json`, icons, state and logs. |
| `CLAUDE_PROFILES_USER_DATA` | Use another folder for sign-ins and window state. |
| `CLAUDE_PROFILES_LABEL_PREFIX` | Use another launchd label prefix, so test servers never touch real ones. |
| `CLAUDE_PROFILES_DEBUG=1` | Log the sidebar's console. With `CLAUDE_PROFILES_DEBUG_CLICK=<id>`, `CLAUDE_PROFILES_DEBUG_EVAL=<js>`, `CLAUDE_PROFILES_DEBUG_SHOT=<path>` and `CLAUDE_PROFILES_DEBUG_CLOSE_FIRST=1`, click a sidebar item, run a script in the active view, save screenshots, and close the first window. |
| `CLAUDE_PROFILES_DEBUG_NET=1` | Log claude.ai API requests made by profile pages. |

## License

[MIT](LICENSE)

---

Built by the team behind [1Presence](https://1presence.com/?utm_source=github&utm_medium=readme&utm_campaign=claude-profiles).
