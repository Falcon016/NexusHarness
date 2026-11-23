import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AuthStore } from '../config/auth.js';
import { loadConfig } from '../config/load.js';
import type { PartialConfig } from '../config/schema.js';
import { ProviderRegistry } from '../llm/registry.js';
import { editUserConfig, patchUserConfig } from '../setup/plan.js';
import { BIN } from '../version.js';
import { formatNodes, Mesh } from './mesh.js';
import { newNodeKey, startNodeService } from './telemetry.js';

/**
 * `nexus node`: run on each machine of the mesh, to report its hardware (read-only, signed).
 * `nexus mesh`: on the machine you work on, to add, list and remove those machines.
 */

const PORT = 7878;

const keyFile = (configDir: string) => join(configDir, 'node-key');

function lanAddress(): string {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return hostname();
}

export async function nodeCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string' }, host: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const { paths } = loadConfig({ cwd: process.cwd() });
  const file = keyFile(paths.config);
  const port = values.port ? Number(values.port) : PORT;
  if (values.help) {
    console.log(
      `Usage:\n  ${BIN} node pair          Make this machine's pairing key (replaces any earlier one)\n` +
        `  ${BIN} node [--port ${PORT}] [--host 0.0.0.0]   Report this machine's GPU, RAM and CPU to the mesh\n\n` +
        'The service is read-only: it answers one signed request with hardware numbers and runs nothing.',
    );
    return 0;
  }
  if (positionals[0] === 'pair') {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(file, newNodeKey() + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(
      `Pairing key saved (owner-only) in ${file}.\n\n` +
        `Show it once with:  cat "${file}"\n` +
        `then, on the machine you run ${BIN} on:\n\n` +
        `  ${BIN} mesh add ${hostname().split('.')[0]!.toLowerCase()} http://${lanAddress()}:${port} --providers <provider>\n\n` +
        'and paste the key when asked. Then start the service here with:  ' +
        `${BIN} node${values.port ? ` --port ${port}` : ''}`,
    );
    return 0;
  }
  if (!existsSync(file)) {
    console.error(`No pairing key yet. Run \`${BIN} node pair\` first.`);
    return 1;
  }
  const key = readFileSync(file, 'utf8').trim();
  const host = values.host ?? '0.0.0.0';
  await startNodeService({ key, port, host });
  console.log(
    `Reporting this machine's hardware on http://${host === '0.0.0.0' ? lanAddress() : host}:${port} ` +
      '(read-only, signed). Ctrl+C to stop.',
  );
  return new Promise(() => {});
}

export async function meshCommand(
  args: string[],
  readSecret: (prompt: string) => Promise<string>,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { providers: { type: 'string' }, 'not-sensitive': { type: 'boolean' } },
  });
  const loaded = loadConfig({ cwd: process.cwd() });
  const auth = new AuthStore(loaded.paths);
  const [sub, name, url] = positionals;
  const usage =
    `Usage:\n  ${BIN} mesh list\n` +
    `  ${BIN} mesh add <name> [<http://host:${PORT}>] --providers a,b [--not-sensitive]\n` +
    `  ${BIN} mesh remove <name>`;

  if (sub === 'list') {
    const config = { ...loaded.config, mesh: { ...loaded.config.mesh, enabled: true } };
    const registry = new ProviderRegistry(config, auth);
    const mesh = new Mesh({ config, provider: (id) => registry.get(id), key: (k) => auth.get(k) });
    for (const w of mesh.warnings) console.error(w);
    await mesh.probe();
    console.log(formatNodes(mesh.nodes(), (m) => mesh.speedOf(m)));
    if (!loaded.config.mesh.enabled)
      console.log(`\nThe mesh is off. Turn it on with "mesh": { "enabled": true }.`);
    return 0;
  }

  if (sub === 'add' && name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(name)) {
      console.error('A node name is letters, digits, dots, dashes and underscores (up to 32).');
      return 2;
    }
    const providers = (values.providers ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const unknown = providers.filter((p) => !loaded.config.providers[p]);
    if (!providers.length || unknown.length) {
      console.error(
        (unknown.length
          ? `Not configured: ${unknown.join(', ')}. `
          : 'Name the model servers on that machine. ') +
          `Providers: ${Object.keys(loaded.config.providers).join(', ') || 'none yet (add one with /login)'}`,
      );
      return 2;
    }
    if (url) {
      try {
        new URL(url);
      } catch {
        console.error(`"${url}" is not a URL, e.g. http://192.168.1.20:${PORT}`);
        return 2;
      }
      const key = (await readSecret(`Pairing key from \`${BIN} node pair\` on ${name}: `)).trim();
      if (!key) {
        console.error('No key entered.');
        return 1;
      }
      auth.set(`node:${name}`, key);
    }
    patchUserConfig(
      {
        mesh: {
          enabled: true,
          nodes: {
            [name]: { providers, ...(url ? { agent: url } : {}), sensitive: !values['not-sensitive'] },
          },
        },
      } as PartialConfig,
      loaded.paths,
    );
    console.log(`Added ${name} to the mesh and turned the mesh on. Check it with \`${BIN} mesh list\`.`);
    return 0;
  }

  if (sub === 'remove' && name) {
    let found = false;
    editUserConfig((c) => {
      const mesh = (c as { mesh?: { nodes?: Record<string, unknown> } }).mesh;
      if (mesh?.nodes && name in mesh.nodes) {
        found = true;
        delete mesh.nodes[name];
      }
      return c;
    }, loaded.paths);
    const key = auth.remove(`node:${name}`);
    console.log(found || key ? `Removed ${name} from the mesh.` : `No node called ${name}.`);
    return 0;
  }

  console.error(usage);
  return 2;
}
