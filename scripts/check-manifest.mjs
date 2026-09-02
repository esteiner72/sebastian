// Structural check of the plugin manifests. This is the only manifest gate in CI, because
// `claude plugin validate --strict` needs the claude binary; the release workflow runs that
// alongside this check. It therefore also asserts the project invariants no external validator
// knows: every hook event Sebastian needs is registered, and each command resolves to a real
// executable script. Zero dependencies; paths are repo-root relative, so run it from there.
// Exits 1 with one line per finding.
import { readFileSync, statSync } from 'node:fs';

const HOOK_EVENTS = ['PreCompact', 'PostCompact', 'SessionStart', 'UserPromptSubmit'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function checkPluginManifest(plugin, pkg) {
  const findings = [];
  for (const field of ['name', 'version', 'description', 'homepage', 'repository', 'license']) {
    if (typeof plugin[field] !== 'string' || plugin[field] === '') {
      findings.push(`plugin.json: "${field}" must be a non-empty string`);
    }
  }
  if (typeof plugin.author?.name !== 'string' || typeof plugin.author?.email !== 'string') {
    findings.push('plugin.json: "author" must carry name and email');
  }
  if (!Array.isArray(plugin.keywords) || plugin.keywords.some((k) => typeof k !== 'string')) {
    findings.push('plugin.json: "keywords" must be an array of strings');
  }
  if (plugin.version !== pkg.version) {
    findings.push(`plugin.json version ${plugin.version} != package.json version ${pkg.version}`);
  }
  return findings;
}

// A hook command is a shell line: the quoted script path first, then its argument. Claude Code
// expands `${CLAUDE_PLUGIN_ROOT}` to the plugin root, which is this repository, so the target has
// to exist here and carry the executable bit — a hook wired to a missing script fails open and is
// otherwise silent at runtime.
function checkCommandTarget(event, index, command) {
  const where = `hooks.json: ${event}[${index}]`;
  const match = /\$\{CLAUDE_PLUGIN_ROOT\}(\/[^"'\s]+)/.exec(command);
  if (match === null) return [`${where} command must resolve a path via \${CLAUDE_PLUGIN_ROOT}`];
  const target = `.${match[1]}`;
  try {
    if ((statSync(target).mode & 0o111) === 0) {
      return [`${where} command target ${target} is not executable`];
    }
  } catch {
    return [`${where} command target ${target} does not exist`];
  }
  return [];
}

function checkHookEntry(event, entry, index) {
  const where = `hooks.json: ${event}[${index}]`;
  const hooks = entry?.hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) {
    return [`${where} must carry a non-empty "hooks" array`];
  }
  const findings = [];
  for (const hook of hooks) {
    if (hook?.type !== 'command') findings.push(`${where} hook type must be "command"`);
    if (typeof hook?.command !== 'string') {
      findings.push(`${where} command must be a string`);
    } else {
      findings.push(...checkCommandTarget(event, index, hook.command));
    }
    if (hook?.timeout !== undefined && typeof hook.timeout !== 'number') {
      findings.push(`${where} timeout must be a number`);
    }
  }
  return findings;
}

function checkHooks(hooksFile) {
  const events = hooksFile?.hooks;
  if (typeof events !== 'object' || events === null || Array.isArray(events)) {
    return ['hooks.json: "hooks" must be an object keyed by hook event'];
  }
  const findings = HOOK_EVENTS
    .filter((event) => !(event in events))
    .map((event) => `hooks.json: no "${event}" hook registered`);
  for (const [event, entries] of Object.entries(events)) {
    if (!HOOK_EVENTS.includes(event)) {
      findings.push(`hooks.json: unknown hook event "${event}"`);
    } else if (!Array.isArray(entries) || entries.length === 0) {
      findings.push(`hooks.json: "${event}" must be a non-empty array of hook entries`);
    } else {
      entries.forEach((entry, i) => findings.push(...checkHookEntry(event, entry, i)));
    }
  }
  return findings;
}

const findings = [
  ...checkPluginManifest(readJson('.claude-plugin/plugin.json'), readJson('package.json')),
  ...checkHooks(readJson('hooks/hooks.json')),
];

for (const finding of findings) process.stderr.write(`${finding}\n`);
if (findings.length > 0) process.exit(1);
process.stdout.write('manifest check passed\n');
