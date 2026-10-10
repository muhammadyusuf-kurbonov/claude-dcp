# dcp

A Claude Code mod that drops tool outputs from the context without
summarizing the conversation. Prompts, replies and tool calls stay as they
were; only the output bodies are replaced with `[tool output dropped by /prune]`.

## Use

| Command | What it does |
| --- | --- |
| `/prune` | Drops every tool output. |
| `/prune -i` | Opens a list of tool outputs, all marked `drop`. Enter toggles a row between `drop` and `keep`, `a` marks all, `n` marks none, `y` or `Apply` runs it, Esc cancels. |

A prune shows up in the transcript as a `/compact dcp-prune` run: the mod
records what to drop, runs that marked `/compact`, and answers it itself, so
no summary is written. A `/compact` you type yourself is untouched.

## Install

At the prompt of a terminal session:

```
/plugin install dcp --marketplace muhammadyusuf-kurbonov/claude-dcp
```

Answer `y` to add the marketplace, then pick a scope.

To run it from a clone instead:

```
claude --plugin-dir path/to/claude-dcp
```

## What it costs

- A prune rewrites history, so the prompt cache is invalidated and the next
  request is billed uncached.
- Dropped outputs are gone from the model's view for good.
- A dropped output goes whole: its text and any image it carried.
- Only the main conversation is pruned, not subagents' transcripts.
- It needs an interactive session; under `claude -p` the command says so and
  does nothing.
- Token figures are estimates: characters divided by four.

## Develop

```
claude plugin validate .
claude plugin test .
```

The mod is written against the early-access plugin API of Claude Code
2.1.296, which may change between releases.

## License

MIT. See [LICENSE](LICENSE).
