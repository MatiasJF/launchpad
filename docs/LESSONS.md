# Lessons — what has gone wrong here

`DECISIONS.md` records *why things are the way they are*. This file is the other shape: **distilled and read
before you start**, so a mistake made once is not made again.

**This file is for findings specific to the Launchpad.** Anything about the chain, an SDK or the toolchain
that would help *any* BSV project belongs in **`~/.claude/bsv-field-notes.md`** — it lives outside every
repository and is loaded in all of them. Putting a general lesson in a project file is how the next project
rediscovers it.

Add an entry with **`/lesson`**, and only when something **surprised** you: a symptom that pointed at the
wrong cause, a tool behaving differently than documented, a test that passed while wrong, money moving
unexpectedly, or a fix that needed a second attempt. Routine work does not belong here — this file dies the
day it fills with things everyone already knew.

Write **symptom first**, because the symptom is what the next person has in front of them and the cause is
what they cannot see. Include what it cost.

---

## Already true here, carried over

These were verified on mainnet in the sibling prediction-market project. They are listed because this
codebase shares the chain, the wallet stack and the toolchain — not because they have been hit here yet.
The detail is in `~/.claude/bsv-field-notes.md`; read that before touching anything that spends.

- **`Missing inputs`** means the output does not exist. **`258: txn-mempool-conflict`** means something
  already spends it. Neither is a signing problem — look at the UTXO.
- **WhatsOnChain's `/address/{addr}/unspent` returns outputs that are already spent**, including ones
  confirmed in a block long ago, with no flag. Verify candidates against `/tx/{txid}/{vout}/spent` before
  spending them, or the first broadcast of a fresh process is refused as a double spend.
- **A rejected transaction pays no fee.** Failed broadcasts cost nothing — worth saying to anyone who thinks
  they just burned money.
- **`@bsv/wallet-toolbox` runs `dotenv.config({ override: true })` at import**, silently overwriting the
  running process's environment — including variables set on the command line.
- **Node 22 is a floor** wherever `better-sqlite3` is involved: on Node 20 it segfaults (exit 139) rather
  than failing cleanly. `pnpm rebuild -r` after any Node switch.
- **Check a process's age before believing its output.** `ps -o etime= -p $(lsof -ti :PORT | head -1)`.
  Anything older than your last change is not running your last change, and `EADDRINUSE` is silent from
  outside — the health check passes because *something* is answering.

---

## Launchpad-specific

*(Nothing yet. First entry goes here — use `/lesson`.)*
