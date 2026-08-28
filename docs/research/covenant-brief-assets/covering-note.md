# Covering note — send this with the brief

Paste as the email body. The .docx is the attachment.

---

Subject: **Bitcoin Script review — one covenant, ~200 lines, holding live funds**

Hi [name],

I'd like your eyes on a Bitcoin Script covenant we've built and are running on mainnet. Attached is
an 8-page brief written specifically for this — it doesn't tour the architecture, it states the
question and hands you the attack surface.

The question is one line: **can anyone take satoshis they are not owed, or lock satoshis so that
nobody can retrieve them?** Everything else in the document exists to get you to that faster.

The covenant is under 200 lines of sCrypt. It holds the entire reserve of a token sale — buyers pay
into it, sellers are refunded out of it, and at the end the whole balance releases to an address
fixed at deploy. There is no operator key anywhere on that path, which is the design's whole claim:
we cannot stop, redirect, reprice or seize a trade, and neither can the project running the sale. If
a satoshi can be stolen, it's because the script permits it.

The brief gives you:

- **8 invariants** we believe hold, with why each one matters
- **7 drain vectors ranked** by where we think the risk actually is, with what to try for each
- **mainnet transaction IDs throughout**, so you can pull the bytes rather than take our word
- **what we have NOT tested** — no fuzzing, no formal argument for one equivalence, two boundaries
  unexercised. We'd rather you start from an accurate picture of our coverage than a flattering one.
- **one weakness we know about and have accepted**, with the constraint that forced it

Out of scope, and we'd rather you didn't spend time there: the web application, code style,
architecture preferences, the database. None of them can move funds — a bug there produces a rejected
transaction, not a loss.

What we'd like back:

1. A finding-by-finding response to the invariants and drain vectors
2. Explicit coverage of the untested areas — especially fuzzing, which we can't credibly do on our
   own code
3. A go / no-go, with a maximum reserve size you'd be comfortable with
4. A re-audit trigger list: which changes should send this back to you

No deadline pressure and no commercial dependency on a positive answer. If the covenant is unsound
we would much rather learn it now, while the only money at risk is roughly ninety thousand satoshis
of our own test funds.

Happy to walk through anything, or leave you to it — whichever you prefer.

[sign-off]
