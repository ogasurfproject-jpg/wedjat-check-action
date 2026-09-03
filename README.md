# wedjat-check

A GitHub Action that measures your MCP server against the five WEDJAT conduct conditions on every push, recomputes the verdict hash inside your own job, and fails the build by a policy you choose.

Read only. Free. No account, no API key, nothing to sign up for. The gate calls no tool on your server unless you say so.

The same measurement, without this action, is one curl:

```
curl -s -X POST https://gate.horizonshield.dev/check \
  -H 'content-type: application/json' \
  -d '{"endpoint":"https://your-server/mcp"}'
```

This action only adds three things: it runs that on a schedule you control, it recomputes `record_sha256` locally so a verdict altered in transit fails loudly, and it turns the result into an exit code.

## Use it

```yaml
name: mcp conduct
on:
  push:
    branches: [main]
  schedule:
    - cron: "17 3 * * *"   # once a day, your clock, your runner
jobs:
  wedjat:
    runs-on: ubuntu-latest
    steps:
      - uses: ogasurfproject-jpg/wedjat-check-action@v1
        with:
          endpoint: https://your-server/mcp
```

That fails the job if any condition the gate actually measured comes back as a fail. Conditions the gate did not measure are reported, not counted, because a checker that paints unmeasured things green is decoration.

## Policies

| `require`       | Fails the job when                                                                 |
|-----------------|-------------------------------------------------------------------------------------|
| `measured-pass` | any measured condition fails (default)                                              |
| `verified`      | the gate's status is anything other than `verified`                                 |
| `none`          | never; the verdict is printed and exposed as outputs only                           |

Independently of the policy, the job always fails if `record_sha256` does not recompute. That is not a conduct failure, it is a sign the bytes you received are not the bytes the gate hashed, and nothing else in the run can be trusted.

`must_pass` adds named conditions that must be measured and pass whatever the policy says:

```yaml
      - uses: ogasurfproject-jpg/wedjat-check-action@v1
        with:
          endpoint: https://your-server/mcp
          require: measured-pass
          must_pass: agent_card,compensation_disclosure
```

Condition keys: `mcp_endpoint`, `agent_card`, `compensation_disclosure`, `determinism`, `self_verification`.

## Determinism is off unless you turn it on

Condition 04 asks whether identical input returns identical output. Measuring it means executing one of your tools, twice, with empty arguments. The gate will not do that to a server it does not own, so by default that condition comes back `not measured` and your status will usually read `pending` rather than `verified`. For a server you own:

```yaml
        with:
          endpoint: https://your-server/mcp
          allow_tool_call: "true"
          require: verified
```

## Outputs

| output                  | meaning                                                            |
|-------------------------|--------------------------------------------------------------------|
| `status`                | `verified`, `pending`, `held`, or whatever the gate returned       |
| `record_sha256`         | the verdict hash as issued                                         |
| `recompute_match`       | `true` when the hash recomputed in this job equals `record_sha256` |
| `failed_conditions`     | comma separated keys of measured failures                          |
| `unmeasured_conditions` | comma separated keys the gate did not measure                      |
| `record`                | the full verdict JSON, verbatim                                    |

A step summary is written to the job page with one row per condition and a link that reruns the same check in a browser, so a reviewer can redo it without trusting your CI either:

```
https://shield.the-horizons-innovation.com/verify-directory/?endpoint=https%3A%2F%2Fyour-server%2Fmcp
```

## Exit codes

| code | meaning                                                                                  |
|------|------------------------------------------------------------------------------------------|
| 0    | passed under the chosen policy                                                           |
| 1    | a conduct condition or the hash failed the policy                                        |
| 2    | bad inputs                                                                               |
| 3    | the gate could not be reached or answered with an error. Not a verdict about your server |

Exit 3 is deliberately separate so a network blip on the runner never reads as your server misbehaving. If you want to ignore gate outages, add `continue-on-error: true` and read `status` afterwards.

## What a passing run does not mean

The same limits as the directory page. It does not mean any number your server returns is correct, that your disclosure is true, or that the business behind it is any good. It means five mechanical conditions were measured at that moment and came back the way the log says, and that anyone can recompute the record and get the same hash.

## How the hash is recomputed

Drop `record_sha256` and `recompute_note` from the verdict, `JSON.stringify` the rest in the order received, SHA-256 the string. That is the whole arithmetic, it is the same arithmetic the directory page runs in your browser and the gate's own `verify_verdict` tool runs, and it is thirty lines you can read in `check.mjs`.

## Run it anywhere

`check.mjs` has no dependencies beyond Node 18 or newer. Outside GitHub:

```
WEDJAT_ENDPOINT=https://your-server/mcp node check.mjs
```

## Operator

The HORIZONs Co., Ltd. Verdicts, scores and listing order are not for sale. Zero referral fees.
Directory: https://shield.the-horizons-innovation.com/verify-directory/
Spec: https://gate.horizonshield.dev/spec
The checker's verdict on itself: https://gate.horizonshield.dev/self

MIT licensed.
