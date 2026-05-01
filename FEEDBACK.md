# FEEDBACK.md — Builder Experience Report

> Required for **Uniswap API** and **KeeperHub** prize eligibility.  
> SwarmNet — Open Agents Hackathon, April 24 – May 3, 2026.

---

## Uniswap Developer Platform Feedback

### What worked well

- [ ] *Fill in during development*

### Friction points / DX issues

- [ ] *Fill in during development*

### Bugs encountered

| Bug | Steps to reproduce | Expected | Actual |
|---|---|---|---|
| *Fill in* | | | |

### Documentation gaps

- [ ] *Fill in during development*

### Missing endpoints / features I wished existed

- [ ] *Fill in during development*

### Overall experience

*1-2 paragraphs — fill in at the end of the hackathon*

---

## KeeperHub Feedback

### What worked well

- Webhook trigger is clean and straightforward — POST a JSON payload, get back `{ executionId, status }` immediately
- Execution status polling API (`GET /executions/{id}/status`) with `progress.percentage` is exactly what an agent needs to track async workflows
- The workflow builder UI is intuitive once you understand the variable system

### UX / UI friction

- **Dynamic variables are not documented**: there is no mention in the docs of how to reference webhook payload fields inside workflow actions. I had to ask on Discord and was told to use `@<myvar>` syntax. This should be prominently documented in the webhook / workflow action docs.
- **Required fields validation has no effect**: marking a webhook field as "required" in the workflow configuration does not prevent the webhook from returning HTTP 200 when that field is absent. The validation is silently ignored — this makes it impossible to catch misconfigured payloads early.

### Reproducible bugs

| Bug | Steps to reproduce | Severity |
|---|---|---|
| `@<var>` in action field causes validation error | Reference a webhook variable (e.g. `@recipient`) in an address field of a workflow action → action throws `Invalid address (expected 0x + 40 hex characters)` even when the value passed in the webhook payload is a valid checksummed address | High — blocks dynamic address usage in actions |
| Required fields not enforced | Mark a field as required in workflow webhook config, POST without that field → returns HTTP 200, workflow starts anyway | Medium — misleading for debugging |

### Documentation gaps that slowed you down

- No documentation on `@<variable>` syntax for referencing webhook payload fields in action parameters — discovered only via Discord
- No example showing an end-to-end webhook → action with dynamic parameters (token addresses, amounts)
- The distinction between user API key and org API key is not explained in context — unclear which one to use for webhook auth vs. status polling

### Feature requests

- Document `@<variable>` syntax in the webhook integration guide with examples
- Enforce required fields at webhook ingestion and return HTTP 400 with field names when validation fails
- Fix variable interpolation for address fields — `@recipient` should pass through a valid `0x...` string without triggering address format validation

### Overall experience

*Fill in at the end of the hackathon*

---

## Notes

> **Reminder to self:** Fill this file progressively during development.  
> Do not fill it all at the end — honest real-time notes are more valuable and more credible to judges.  
> Each section for Uniswap and KeeperHub is worth up to $250 in bonus prizes (Builder Feedback Bounty).
