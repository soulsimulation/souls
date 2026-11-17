// tools/ci/setup-runners.sh: the argument checks that run before it touches the host (no root needed for these), and the
// CPU pinning (--cpus, --cpus-from, --dry-run) on a fake host: systemctl, apt-get, id, uname and nproc are stubs on PATH,
// and SETUP_RUNNERS_SYSROOT stands in for / (os-release, /proc, /sys, the systemd unit directory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./setup-runners.sh', import.meta.url));
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });

test('setup-runners.sh parses, prints its usage and refuses bad arguments before touching the host', () => {
  assert.equal(spawnSync('bash', ['-n', script]).status, 0, 'bash -n');
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--token <registration token>/);
  assert.match(help.stdout, /--cpus <list> \| --cpus-from <instance>/);
  for (const [args, why] of [[[], /--token is required/], [['--token', 't', '--count', '0'], /--count must be 1-99/],
    [['--token', 't', '--user', 'Bad User'], /--user must be a plain user name/], [['--token', 't', '--label', 'a b'], /--prefix and --label/],
    [['--token', 't', '--repo', 'nope'], /--repo must be owner\/name/], [['--bogus'], /unknown argument/],
    [['--token', 't', '--cpus', '0-3', '--cpus-from', 'a'], /one or the other/], [['--token', 't', '--cpus', '0-'], /--cpus must be a CPU list/],
    [['--token', 't', '--cpus', '0;id'], /--cpus must be a CPU list/], [['--token', 't', '--cpus-from', 'a b'], /--cpus-from must be instance names/],
    [['--token', 't', '--cpus-from', 'a,,b'], /--cpus-from must be instance names/]]) {
    const r = run(...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, why, args.join(' '));
  }
});

const REPO_UNIT = (name) => `actions.runner.soulsimulation-souls.${name}.service`;
const stub = (dir, name, body) => { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };

/** A fake 48-CPU host (24 physical cores, CPU c and c+24 are one core) with six souls-timed instances on three cores each
 *  (souls-timed-k: cores 3(k-1) to 3(k-1)+2), each pinned a different way. Returns its paths and an env to run under. */
function fakeHost() {
  const d = mkdtempSync(join(tmpdir(), 'setup-runners-')), bin = join(d, 'bin'), sys = join(d, 'sys'), state = join(d, 'state'), root = join(d, 'opt'), log = join(d, 'calls.log');
  for (const p of [bin, state, root, join(sys, 'etc/systemd/system'), join(sys, 'proc')]) mkdirSync(p, { recursive: true });
  writeFileSync(join(sys, 'etc/os-release'), 'ID=ubuntu\nVERSION_ID="20.04"\nPRETTY_NAME="Ubuntu 20.04 LTS"\nVERSION="20.04 LTS (Focal Fossa)"\n');
  writeFileSync(join(sys, 'proc/loadavg'), '0.10 0.20 0.30 1/100 1\n');
  mkdirSync(join(sys, 'sys/devices/system/cpu'), { recursive: true });
  writeFileSync(join(sys, 'sys/devices/system/cpu/online'), '0-47\n');
  for (let c = 0; c < 48; c++) {
    mkdirSync(join(sys, `sys/devices/system/cpu/cpu${c}/topology`), { recursive: true });
    writeFileSync(join(sys, `sys/devices/system/cpu/cpu${c}/topology/thread_siblings_list`), `${c % 24},${(c % 24) + 24}\n`);
  }
  const cores = (k) => `${3 * (k - 1)}-${3 * (k - 1) + 2}`, sib = (k) => `${3 * (k - 1) + 24}-${3 * (k - 1) + 26}`;
  const units = [], prop = (name, p, v) => writeFileSync(join(state, `${REPO_UNIT(name)}.${p}`), v);
  for (let k = 1; k <= 6; k++) units.push(REPO_UNIT(`souls-timed-${k}`));
  // souls-timed-1: running and not pinned (every CPU); 2: not set up here; 3: running, pinned (its live affinity);
  // 4: stopped, CPUAffinity=; 5: stopped, AllowedCPUs=; 6: registered under --root, running, pinned
  const proc = (pid, cpus) => { mkdirSync(join(sys, `proc/${pid}`)); writeFileSync(join(sys, `proc/${pid}/status`), `Name:\trunsvc.sh\nCpus_allowed:\tffff\nCpus_allowed_list:\t${cpus}\n`); };
  prop('souls-timed-1', 'MainPID', '101'); proc(101, '0-47'); prop('souls-timed-1', 'active', '');
  prop('souls-timed-3', 'MainPID', '103'); proc(103, `${cores(3)},${sib(3)}`); prop('souls-timed-3', 'active', '');
  prop('souls-timed-4', 'CPUAffinity', `${cores(4)} ${sib(4)}`);
  prop('souls-timed-5', 'AllowedCPUs', `${cores(5)},${sib(5)}`);
  prop('souls-timed-6', 'MainPID', '106'); proc(106, `${sib(6)},${cores(6)}`); prop('souls-timed-6', 'active', '');
  writeFileSync(join(state, 'units'), units.filter((u) => !u.includes('timed-2') && !u.includes('timed-6')).join('\n') + '\n');
  const t6 = join(root, 'elsewhere-6'); mkdirSync(t6);
  writeFileSync(join(t6, '.runner'), '﻿{"agentName": "souls-timed-6"}'); writeFileSync(join(t6, '.service'), REPO_UNIT('souls-timed-6'));
  // systemctl: list-units/list-unit-files by glob, show -p <prop> --value, is-active, and mutations logged
  stub(bin, 'systemctl', `S=${JSON.stringify(state)}; echo "systemctl $*" >> ${JSON.stringify(log)}
case "$1" in
  list-units|list-unit-files) pat="\${@: -1}"; while read -r u; do [ -n "$u" ] && [[ "$u" == $pat ]] && echo "$u loaded active running x"; done < "$S/units" ;;
  show) [ -f "$S/$5.$3" ] && cat "$S/$5.$3" && echo; [ -f "$S/$5.$3" ] || { [ "$3" = MainPID ] && echo 0 || echo; } ;;
  is-active) [ -f "$S/\${@: -1}.active" ] ;;
  *) : ;;
esac`);
  for (const c of ['apt-get', 'apt-cache', 'useradd', 'curl', 'runuser', 'chown']) stub(bin, c, `echo "${c} $*" >> ${JSON.stringify(log)}`);
  stub(bin, 'uname', 'case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  stub(bin, 'id', 'case "$1" in -u) echo 0 ;; -un) echo root ;; -nG) echo runners ;; *) exit 0 ;; esac');
  stub(bin, 'nproc', 'echo 48');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SETUP_RUNNERS_SYSROOT: sys };
  return { d, sys, root, state, log, env, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}
const WIDE = ['--token', 'tok-FAKE', '--count', '1', '--prefix', 'souls-wide', '--label', 'souls-wide', '--user', 'runner'];
const FROM = ['--cpus-from', 'souls-timed-3,souls-timed-4,souls-timed-5,souls-timed-6'];

test('--cpus-from: the union of four instances\' CPUs (live affinity, CPUAffinity=, AllowedCPUs=, a registered install); --dry-run changes nothing', () => {
  const h = fakeHost();
  try {
    const r = spawnSync('bash', [script, ...WIDE, '--root', h.root, ...FROM, '--dry-run'], { encoding: 'utf8', env: h.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /== souls-timed-3: CPUs 6-8,30-32 \(3 physical cores; read from the running service's affinity\)/);
    assert.match(r.stdout, /== souls-timed-4: CPUs 9-11,33-35 \(3 physical cores; read from the unit's CPUAffinity=\)/);
    assert.match(r.stdout, /== souls-timed-5: CPUs 12-14,36-38 \(3 physical cores; read from the unit's AllowedCPUs=\)/);
    assert.match(r.stdout, /== souls-timed-6: CPUs 15-17,39-41 \(3 physical cores; read from the running service's affinity\)/);
    assert.match(r.stdout, /== pinning to CPUs 6-17,30-41: 12 physical cores, 24 logical/);
    assert.match(r.stdout, /== dry run: nothing is changed/);
    assert.match(r.stdout, /would run: \(in .*actions-runner-souls-wide-1, as runner\) \.\/config\.sh --unattended --url https:\/\/github\.com\/soulsimulation\/souls --token <token> --name souls-wide-1 --labels souls-wide --work _work --replace/);
    assert.ok(!r.stdout.includes('tok-FAKE'), 'the token is never printed');
    assert.match(r.stdout, new RegExp(`${REPO_UNIT('souls-wide-1').replace(/\./g, '\\.')}: CPUAffinity=6-17,30-41 \\(new, `));
    assert.match(r.stdout, /would write: CPUAffinity=6-17 30-41/);
    assert.match(r.stdout, /would run: systemctl daemon-reload/);
    assert.match(r.stdout, /would run: \(in .*actions-runner-souls-wide-1\) \.\/svc\.sh start/);
    assert.match(r.stdout, /== dry run done: nothing was changed/);
    // nothing changed: no unit drop-in, no install, no package or service mutation; only reads of systemd
    assert.deepEqual(readdirSync(join(h.sys, 'etc/systemd/system')), []);
    assert.deepEqual(readdirSync(h.root).sort(), ['elsewhere-6']);
    assert.ok(h.calls().split('\n').filter(Boolean).every((l) => /^systemctl (show|list-units|list-unit-files|is-active) /.test(l)), h.calls());
  } finally { rmSync(h.d, { recursive: true, force: true }); }
});

test('--cpus-from refuses an instance that is not pinned or not there; --cpus refuses a CPU the host lacks', () => {
  const h = fakeHost();
  try {
    for (const [args, why] of [[['--cpus-from', 'souls-timed-3,souls-timed-1'], /souls-timed-1 \(actions\.runner\.soulsimulation-souls\.souls-timed-1\.service\) is not pinned to CPUs of its own; pass --cpus/],
      [['--cpus-from', 'souls-timed-2'], /no runner service named souls-timed-2/], [['--cpus', '40-50'], /there is no CPU 48 on this host/]]) {
      const r = spawnSync('bash', [script, ...WIDE, '--root', h.root, ...args, '--dry-run'], { encoding: 'utf8', env: h.env });
      assert.notEqual(r.status, 0, args.join(' '));
      assert.match(r.stderr, why, args.join(' '));
      assert.ok(!r.stdout.includes('would run'), 'it stops before any step');
    }
  } finally { rmSync(h.d, { recursive: true, force: true }); }
});

test('--cpus on a registered, running instance: one drop-in and a restart; run again, nothing changes (idempotent)', () => {
  const h = fakeHost();
  try {
    const dir = join(h.root, 'actions-runner-souls-wide-1'), unit = REPO_UNIT('souls-wide-1');
    mkdirSync(dir); writeFileSync(join(dir, '.runner'), '{"agentName":"souls-wide-1"}'); writeFileSync(join(dir, '.service'), unit);
    stub(dir, 'svc.sh', `echo "svc.sh $*" >> ${JSON.stringify(h.log)}`);
    writeFileSync(join(h.state, `${unit}.active`), '');
    mkdirSync(join(h.root, '.actions-runner-cache')); writeFileSync(join(h.root, '.actions-runner-cache/actions-runner-linux-x64-2.330.0.tar.gz'), 'x');
    const args = [script, ...WIDE, '--root', h.root, '--version', '2.330.0', '--no-playwright', '--cpus', '30-32,6-8,9-11,33-35'];
    const first = spawnSync('bash', args, { encoding: 'utf8', env: h.env });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(h.sys, `etc/systemd/system/${unit}.d/cpus.conf`), 'utf8'), '# setup-runners.sh --cpus/--cpus-from\n[Service]\nCPUAffinity=6-11 30-35\n');
    assert.match(first.stdout, /pinning to CPUs 6-11,30-35: 6 physical cores, 12 logical/);
    assert.match(first.stdout, /is running: restarting it so the CPUs apply/);
    assert.deepEqual(h.calls().split('\n').filter((l) => /daemon-reload|restart|svc\.sh/.test(l)), ['systemctl daemon-reload', `systemctl restart ${unit}`]);
    assert.ok(!h.calls().includes('svc.sh install'), 'an installed service is not reinstalled');
    writeFileSync(h.log, '');
    const again = spawnSync('bash', args, { encoding: 'utf8', env: h.env });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /CPUAffinity=6-11,30-35 \(unchanged\)/);
    assert.ok(!/daemon-reload|restart/.test(h.calls()), h.calls());
    assert.match(h.calls(), /svc\.sh start/);
  } finally { rmSync(h.d, { recursive: true, force: true }); }
});

/** The arguments of the dry run in the PR's command for the host; the real run is the same without --dry-run. */
export const GENE_DRY = '--token $TOKEN --count 1 --prefix souls-wide --label souls-wide --user <runner user> --cpus-from souls-timed-3,souls-timed-4,souls-timed-5,souls-timed-6 --dry-run';

// The exact argument string of the command in the PR for the host (the documented form: ssh <host> "sudo bash -s -- …"
// < tools/ci/setup-runners.sh), with the runner user's placeholder filled and without sudo or ssh: the script read from
// stdin, its arguments parsed by a shell from the one string, as the remote shell does.
test('the host command: the dry-run string parses and plans souls-wide-1 on the union of souls-timed-3 to 6', () => {
  const h = fakeHost();
  try {
    writeFileSync(join(h.state, 'units'), `${readFileSync(join(h.state, 'units'), 'utf8')}${REPO_UNIT('souls-timed-6')}\n`);   // no --root: found by systemd alone
    const line = `bash -s -- ${GENE_DRY.replace('<runner user>', 'runner')}`;
    const r = spawnSync('bash', ['-c', line], { encoding: 'utf8', env: { ...h.env, TOKEN: 'tok-FAKE' }, input: readFileSync(script) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pinning to CPUs 6-17,30-41: 12 physical cores, 24 logical/);
    assert.match(r.stdout, /--name souls-wide-1 --labels souls-wide /);
  } finally { rmSync(h.d, { recursive: true, force: true }); }
});
