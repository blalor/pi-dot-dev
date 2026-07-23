# my pi.dev setup

This is my personal [Pi](https://pi.dev) harness.  It's intended to be fully self-contained, something I can clone on a new machine and immediately have up and running. [Flox](https://flox.dev) is used to capture all environment dependencies and shell setup; see `.flox/env/manifest.toml` for the implementation, but generally speaking, if you have Flox installed, you should be able to `cd` into this directory, `flox activate`, and be ready to go.

The entrypoint to the agent harness is `bin/pi`; put that on your path, or (what I do) make a symlink from `~/bin/pi` to it.  It will take care of activating the Flox environment, so you can use it anywhere on your system.

## setup

1. install Flox
2. `git clone git@github.com:blalor/pi-dot-dev.git ~/.pi`
3. there is no step 3

## maintenance

* `npm update`
* `pi update --extensions`

## showing what's installed

* `pi list`
* `npm --prefix "${HOME}/.pi/agent/npm" ls --depth=0`

## extensions

### pi-subagents

in AGENTS.md:

> When you finish implementing, run a reviewer subagent before summarizing.

