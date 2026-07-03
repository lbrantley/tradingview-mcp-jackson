# launchd — local brief scheduler

macOS LaunchAgents replacing the (unreliable) /schedule cloud routines.
Runs [scripts/run_brief.sh](../scripts/run_brief.sh) which sources nvm and
invokes [src/generate_brief.mjs](../src/generate_brief.mjs).

## Files

- `com.trading.brief.daily.plist` — fires 6:00 AM Central (= 7:00 AM Eastern) Mon-Fri
- `com.trading.brief.weekly.plist` — fires 2:00 PM Central (= 3:00 PM Eastern) Sunday

Both are DST-safe: America/Chicago and America/New_York shift together, so the
Eastern-time target stays stable year-round.

## One-time install

```bash
# From the repo root:
cp launchd/com.trading.brief.daily.plist ~/Library/LaunchAgents/
cp launchd/com.trading.brief.weekly.plist ~/Library/LaunchAgents/

# Load into launchd
launchctl load ~/Library/LaunchAgents/com.trading.brief.daily.plist
launchctl load ~/Library/LaunchAgents/com.trading.brief.weekly.plist
```

## Managing after install

```bash
# List jobs (verify loaded)
launchctl list | grep com.trading.brief

# Test-fire now (bypasses schedule)
launchctl start com.trading.brief.daily

# Unload (stop firing)
launchctl unload ~/Library/LaunchAgents/com.trading.brief.daily.plist

# View logs
tail -f logs/brief_daily_$(date +%Y-%m-%d).log     # per-run output
tail -f logs/launchd.daily.out                     # launchd stdout
tail -f logs/launchd.daily.err                     # launchd errors
```

## Required env (in `.env` at repo root)

```
ANTHROPIC_API_KEY=sk-ant-...   # from console.anthropic.com
PUSHOVER_ENABLED=1
PUSHOVER_TOKEN=...              # already set
PUSHOVER_USER=...               # already set
BRIEF_GIT_PUSH=1                # default; set to 0 to skip commit+push
```

## Notes on portability

- Paths in the plists are absolute (`/Users/leebrantley/...`). If the repo
  moves, update the plists AND the WorkingDirectory value.
- The wrapper (`run_brief.sh`) sources nvm, so upgrading node doesn't
  break scheduling — just make sure the new node is set as `nvm use` default.
- Same plist strategy works on the Azure VM later by swapping to a
  `systemd .service + .timer` pair — the Node script and env are unchanged.
