# Contributing to dsh-anywhere

Thanks for your interest! This is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. Issues, ideas, and PRs are all welcome.

## Project layout

```
lib/
  fleet.js              # entry: fleet mode (routes + /fleet panel + agent guidance)
  world.js              # entry: world mode (registers ctx.fs + ctx.subprocess)
  ssh-conn.js           # shared SSH layer (ControlMaster connection reuse)
  ssh-fs-core.js        # FileSystem contract over ssh
  ssh-subprocess-core.js# SubprocessRuntime over ssh
  fs-ssh.js / subprocess-ssh.js   # thin dsh Service wrappers (import the peers)
  <fleet modules>       # fleet-store, token, ports, routes, enroll, provisioner, …
scripts/relay-init.sh   # one-time relay VPS bootstrap
examples/               # composition patches
cordis.patch.yml        # dsh.bundle patch — mounts fleet when the plugin is added
test/                   # node:test suites
```

Two package entry points: `.` → `lib/fleet.js`, `./world` → `lib/world.js`.

## Dev setup

- Node **22.19+** or **24+**. No `npm install` needed — the plugin has **zero runtime dependencies** (`@deepseek-ai/dsh-fs` / `dsh-subprocess` are peers provided by the dsh runtime).
- Clone, then run the tests.

## Running tests

```sh
node --test                 # unit + hermetic tests (integration auto-skips)
```

Integration tests talk to a **real** remote host and skip unless you point them at one:

```sh
DSH_ANYWHERE_RELAY=user@host DSH_ANYWHERE_KEY=~/.ssh/id_rsa node --test
```

CI runs `node --test` with no relay configured, so those suites report as *skipped*, not failed.

## Code conventions

- **ESM, plain JavaScript, no build step.** Keep it runnable straight from source.
- **fleet half stays zero-dependency** (only `node:` built-ins + the system `ssh` CLI). This is deliberate: `link:` installs resolve from the repo realpath, where hoisted deps aren't found.
- **SSH safety:** never interpolate paths/content into a shell string. Base64-encode them into the remote script (see `ssh-conn.js` / `ssh-fs-core.js`) so there's no quoting or injection surface.
- **No personal data in the repo.** No hard-coded hosts, IPs, usernames, or home paths — take them from config or env (integration tests use `DSH_ANYWHERE_RELAY`).
- Match the surrounding style; keep files small and single-purpose.

## Pull requests

1. Fork and branch from `main`.
2. Add or update tests for behavior changes; keep `node --test` green.
3. Keep PRs focused; describe the *why*, not just the *what*.
4. By contributing you agree your work is licensed under the project's [MIT License](LICENSE).

## A recording is welcome

The README uses an architecture diagram as its hero. A short screen recording (GIF or asciinema) of the `/fleet` **add-machine → approve** flow, or of an agent editing files on a remote host, would make a great addition — open a PR that drops it under `docs/` and references it from the README.
