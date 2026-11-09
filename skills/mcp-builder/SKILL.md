---
name: mcp-builder
description: Build a Model Context Protocol (MCP) server that gives agents new tools (an API, a database, a device), in TypeScript or Python, and connect it to NexusHarness. Use when asked to make an MCP server, wrap an API as tools, or add a tool the agent does not have.
---

An MCP server is a small program that lists tools (name, description, input schema) and runs them when called.
NexusHarness starts it and offers its tools to the agent next to the built-in ones. Good tools are few, clearly
named, and return compact, useful text.

## 1. Design the tools first

- List the jobs the agent needs done, not the API's endpoints. Two or three well-chosen tools usually beat a tool
  per endpoint (`search_tickets` with filters, rather than `list_tickets`, `get_ticket`, `filter_by_status`).
- For each tool: a `verb_noun` name, a description that says when to use it and what it returns, and an input
  schema with a description on every field and sensible defaults.
- Return text the model can use: a short summary first, then the details; trimmed to what matters, with ids it
  can pass to other tools. Paginate big results.
- Errors should say what went wrong and how to fix the call ("No project 'web'. Projects: api, app").
- Read-only tools by default. Anything that changes or deletes data should say so in its description.
- Secrets (API keys) come from environment variables, never from tool arguments or code.

## 2. Build it

**TypeScript** (Node 18+):

```sh
npm init -y && npm i @modelcontextprotocol/sdk zod
```

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'weather', version: '1.0.0' });

server.tool(
  'get_forecast',
  'Forecast for a city for the next days. Returns one line per day.',
  { city: z.string().describe('City name, e.g. "Lisbon"'), days: z.number().int().min(1).max(7).default(3) },
  async ({ city, days }) => {
    const text = await forecast(city, days); // your code
    return { content: [{ type: 'text', text }] };
  },
);

await server.connect(new StdioServerTransport());
```

**Python** (3.10+):

```sh
pip install "mcp[cli]"
```

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("weather")

@mcp.tool()
def get_forecast(city: str, days: int = 3) -> str:
    """Forecast for a city for the next days. Returns one line per day."""
    return forecast(city, days)  # your code

if __name__ == "__main__":
    mcp.run()
```

A stdio server must never print to stdout except protocol messages: send logs to stderr.

Check the SDK's README for the installed version if an import fails; the APIs above are the common ones, but
details change between releases.

## 3. Connect it to NexusHarness

Add it to your user `config.json` (`nexus doctor` prints where it is), or a trusted project's
`.nexusharness/config.json`:

```json
{
  "mcpServers": {
    "weather": { "command": "node", "args": ["/abs/path/to/server.js"], "env": { "WEATHER_API_KEY": "..." } }
  }
}
```

For Python: `"command": "python", "args": ["/abs/path/to/server.py"]` (use the venv's python). A remote server:
`{ "url": "https://...", "headers": { "Authorization": "Bearer ..." } }`. Restart NexusHarness, then `/mcp` shows
the server and `/tools` its tools.

## 4. Test it

- Run it once by hand to catch start-up errors (it should wait for input without printing anything).
- `npx @modelcontextprotocol/inspector <command> <args>` opens an inspector where you can call each tool.
- Then ask the agent a question that needs the tool, and check it picks the right one and reads the result well.
  Rewrite descriptions that it misuses.

## Report

The tools you built (name and one line each), how to configure it, and what you tested.
