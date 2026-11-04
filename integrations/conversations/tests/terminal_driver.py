#!/usr/bin/env python3
"""Bounded host-side terminal control; all workloads and assertions run in the container."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import select
import shlex
import subprocess
import sys

os.umask(0o077)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('mode', choices=['start', 'run'])
parser.add_argument('--workspace', type=Path, required=True)
parser.add_argument('--name', required=True)
parser.add_argument('--container', required=True)
parser.add_argument('--expected-container-id', required=True)
parser.add_argument('--approvals', required=True)
parser.add_argument('--project', required=True)
parser.add_argument('--confirm-development-channel', action='store_true')
args = parser.parse_args()
if not args.confirm_development_channel:
    parser.error('Explicit consent for the two Delta Chat development-channel confirmations is required')
if not re.fullmatch(r'[A-Za-z0-9_-]+', args.name):
    parser.error('Evidence name must be a simple unique name')
root = args.workspace.resolve()
source = root / 'source'
evidence = root / 'evidence'
runtime = root / 'tools/deno-2.9.6'
if not all(p.exists() for p in [source, evidence, root / '.tmp', runtime]):
    parser.error('Prepared disk workspace, source, evidence and runtime are required')
name = args.name
state = evidence / (name + '-controller.json')

def save(**value):
    state.write_text(json.dumps(dict(time=datetime.datetime.now(datetime.timezone.utc).isoformat(), **value), indent=2) + '\n')

if args.mode == 'start':
    if state.exists() or (evidence / name).exists():
        parser.error('Inspect the existing attempt; never replay an uncertain or active run')
    with (evidence / (name + '-controller.log')).open('xb') as log:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'run', *sys.argv[2:]],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    print(json.dumps({'controllerPID': child.pid, 'state': str(state)}))
    raise SystemExit(0)

identity = subprocess.check_output(['podman', 'inspect', args.container, '--format', '{{.Id}}'], timeout=10).decode().strip()
if identity != args.expected_container_id:
    raise SystemExit('Execution container identity mismatch; no host fallback')
terminal_config = evidence / (name + '-terminal')
terminal_config.mkdir(mode=0o700)
(terminal_config / 'deno.json').write_text(json.dumps({'nodeModulesDir': 'auto'}) + '\n')
environment = ['--env', 'TMPDIR=' + str(root / '.tmp'), '--env', 'DENO_DIR=' + str(root / '.deno'),
               '--env', 'OPENCODE_V2_BIN=/opt/claude-experiments/bin/opencode',
               '--env', 'CLAUDE_CODE_BIN=/opt/claude-experiments/bin/claude',
               '--env', 'CHANNEL_DENO_BIN=' + str(runtime), '--env', 'CHATMAIL_DOMAIN=ci-chatmail.testrun.org',
               '--env', 'CONVERSATION_EVIDENCE_DIR=' + str(evidence / name),
               '--env', 'CLAUDE_TEST_PROJECT=' + args.project, '--env', 'CLAUDE_TEST_APPROVALS=' + args.approvals,
               '--env', 'CLAUDE_TEST_TRACE=' + str(source / 'integrations/claude-code/tests/support/trace_hook.ts')]
native = ['timeout', '--signal=TERM', '--kill-after=15s', '900', str(runtime), 'task', 'test:conversation-handoff']
command = ['podman', 'exec', '-i', *environment, '--workdir', str(source), args.container,
           'script', '--quiet', '--return', '--flush', '--command',
           'stty rows 40 cols 120; exec ' + shlex.join(native) + ' >' +
           shlex.quote(str(evidence / (name + '-driver.log'))) + ' 2>&1', str(evidence / (name + '.typescript'))]
process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
save(phase='starting', controllerPID=os.getpid(), execPID=process.pid)
text = ''
answered = False
generation = None
phase = {}
inputs = set()
typed = set()
consents = []
with (evidence / (name + '-pty.log')).open('xb') as log:
    while process.poll() is None:
        phase_path = evidence / name / 'phase.json'
        if phase_path.exists():
            phase = json.loads(phase_path.read_text())
            if generation != phase.get('generation'):
                generation = phase.get('generation')
                text = ''
                answered = False
                (evidence / name / 'controller-generation.json').write_text(json.dumps({'generation': generation}) + '\n')
        ready, _, _ = select.select([process.stdout], [], [], 0.1)
        if ready:
            chunk = os.read(process.stdout.fileno(), 65536)
            if chunk:
                log.write(chunk)
                log.flush()
                text = (text + chunk.decode(errors='replace'))[-200000:]
        flat = ' '.join(re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', ' ', text).split())
        channel = phase.get('expectedChannel', 'plugin:delta-chat@inline')
        if channel not in ['server:delta-chat', 'plugin:delta-chat@inline']:
            raise RuntimeError('Unexpected native channel scope')
        if not answered and all(value in flat for value in ['Loading development channels', channel,
                                                            'I am using this for local development', 'Enter to confirm']):
            consents.append({'channel': channel, 'generation': generation, 'nativeDialog': flat[-12000:],
                             'basis': 'explicit --confirm-development-channel supplied for this isolated qualification'})
            (evidence / (name + '-consent.json')).write_text(json.dumps(consents, indent=2) + '\n')
            process.stdin.write(b'\r')
            process.stdin.flush()
            answered = True
        if phase.get('phase') == 'send-key' and phase['inputKey'] not in inputs:
            if phase['key'] != 'Escape':
                raise RuntimeError('Unexpected fixture key')
            process.stdin.write(b'\x1b')
            process.stdin.flush()
            inputs.add(phase['inputKey'])
        if phase.get('phase') == 'send-input' and phase['inputKey'] not in typed:
            process.stdin.write(phase['text'].encode())
            process.stdin.flush()
            typed.add(phase['inputKey'])
        elif phase.get('phase') == 'send-input' and phase['inputKey'] not in inputs:
            observer = ['podman', 'exec', '--env', 'TMPDIR=' + str(root / '.tmp'), '--env', 'DENO_DIR=' + str(root / '.deno'),
                        '--workdir', str(terminal_config), args.container, str(runtime), 'run', '--allow-all',
                        '--config=' + str(terminal_config / 'deno.json'),
                        str(source / 'integrations/conversations/tests/support/terminal_screen.ts'), str(evidence / (name + '-pty.log'))]
            screen = json.loads(subprocess.check_output(observer, timeout=15))
            if phase['text'] in screen['screen']:
                (evidence / (name + '-composer.json')).write_text(json.dumps(screen, indent=2) + '\n')
                process.stdin.write(b'\r')
                process.stdin.flush()
                inputs.add(phase['inputKey'])
        save(phase=phase, controllerPID=os.getpid(), execPID=process.pid, confirmations=len(consents), inputs=sorted(inputs))
    remaining = process.stdout.read()
    if remaining:
        log.write(remaining)
process.stdin.close()
save(phase='exited', exit=process.returncode, confirmations=len(consents))
raise SystemExit(process.returncode)
