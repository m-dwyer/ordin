# software-delivery.yaml ai-sdk model mismatch

`workflows/software-delivery.yaml:12` pins `model: qwen3.6:latest`, but
`litellm/config.yaml`'s `model_list` only declares `qwen3:*` variants (`qwen3-4b`,
`qwen3-8b`, `qwen3-14b`, `qwen3-32b`, `qwen3-coder-30b`). No `qwen3.6:*` entry.

## Symptom

Tier-S Plan run via `--workflow software-delivery` over-explores and fails
post-flight: declared output `docs/rfcs/<slug>-rfc.md` not written. 1m wall,
~3.6k input / ~1k output, hits `max_steps`.

## Root cause options

- **Typo / dead model name.** No `qwen3.6` was ever pulled, requests fail or get
  routed to a fallback that doesn't tool-call well.
- **LiteLLM passthrough.** Proxy accepts the name and forwards directly to Ollama,
  which may or may not have a `qwen3.6:latest` tag locally.
- **Stale workflow config.** Picked when `qwen3.6` was a candidate; never updated
  after settling on `qwen3:*`.

## Triage

```sh
ollama list | grep -i qwen3.6     # is the tag actually pulled?
docker logs litellm 2>&1 | tail   # what does the proxy do with this name?
mise exec -- bun src/cli/index.ts run "x" --workflow software-delivery \
  --tier S --only plan --slug debug   # reproduce
```

## Likely fix

Either align the workflow to a real model (`qwen3-8b` or `qwen3-coder-30b`) or
add `qwen3.6:latest` to `litellm/config.yaml` if that's a model we actually want
to use. Don't ship `qwen3.6:latest` references in workflow YAML without the
backing entry.

## Out of scope

- ai-sdk runtime behavior (correct).
- Composer skill catalog (correct — same shape as provider).
- The over-exploration is downstream of the model; pick a working model first,
  re-evaluate prompt shape only if it persists.
