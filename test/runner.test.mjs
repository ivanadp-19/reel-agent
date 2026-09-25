import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

// The headless agent can only act through the reel MCP server: the runner
// allows exactly those tools plus Read and Skill, loads only .mcp.json, and the
// server itself exposes nothing that runs commands or writes arbitrary files.
test('the headless runner allows only the reel MCP tools, Read and Skill', () => {
  const sh = fs.readFileSync('scripts/claude-edit.sh', 'utf8');
  assert.match(sh, /--allowedTools "mcp__reel__\*,Read,Skill"/);
  assert.match(sh, /--strict-mcp-config/);
  assert.match(sh, /--mcp-config \.mcp\.json/);
  assert.doesNotMatch(sh, /Bash|Write|Edit|--dangerously/);
  const mcp = JSON.parse(fs.readFileSync('.mcp.json', 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['reel']);
});

test('the reel MCP server has no shell, file-write or network-fetch tool', async () => {
  const client = new Client({name: 'test', version: '0'});
  await client.connect(new StdioClientTransport({command: 'node', args: ['mcp/server.mjs'], cwd: process.cwd()}));
  try {
    const {tools} = await client.listTools();
    assert.ok(tools.length > 30);
    for (const t of tools) assert.doesNotMatch(t.name, /bash|shell|exec|command|write_file|fetch_url|eval/i, t.name);
    // the only tools that take file paths copy media INTO public/ through the backend
    const pathTools = tools.filter((t) => /absolute (file )?path/i.test(JSON.stringify(t))).map((t) => t.name).sort();
    assert.deepEqual(pathTools, ['add_broll', 'add_broll_assets', 'add_clips', 'create_lut', 'set_brand', 'set_music']);
  } finally { await client.close(); }
});

test('the Codex runner ignores the user config, pre-approves only the reel server and keeps the shell read-only', () => {
  const sh = fs.readFileSync('scripts/codex-edit.sh', 'utf8');
  for (const flag of ['--ignore-user-config', '-s read-only', '--ephemeral', `approval_policy="never"`, `mcp_servers.reel.default_tools_approval_mode="approve"`]) assert.ok(sh.includes(flag), flag);
  assert.doesNotMatch(sh, /approve-for-me|danger-full-access|workspace-write|dangerously/);
  assert.equal((sh.match(/mcp_servers\.(\w+)\.command/g) ?? []).length, 1);
});
