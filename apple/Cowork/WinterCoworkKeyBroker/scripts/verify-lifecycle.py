#!/usr/bin/env python3
"""Run already-built, fixed synthetic fixtures; never accepts a child PID."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--artifacts', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
artifacts = args.artifacts.resolve(strict=True)
report = {'scope': 'synthetic-native-fixtures-only', 'wallClockOSGuarantee': False}
for name, argv, bound in [
    ('timeout', [str(artifacts / 'cowork-child-lifecycle-fixture')], 8),
    ('key_delivery', [str(artifacts / 'cowork-key-broker-fixture'), '--fixture', str(artifacts)], 30),
]:
    with tempfile.TemporaryDirectory(prefix='winter-key-lifecycle-' + name + '-') as scratch:
        root = Path(scratch)
        for child in ['home', 'tmp']:
            (root / child).mkdir(mode=0o700)
        env = {'HOME': str(root / 'home'), 'TMPDIR': str(root / 'tmp'),
               'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'LANG': 'C'}
        start = time.monotonic()
        try:
            result = subprocess.run(argv, env=env, cwd=scratch, capture_output=True,
                                    timeout=bound)
            receipt = {'exitCode': result.returncode, 'elapsedSeconds': time.monotonic()-start,
                       'timeoutSeconds': bound, 'stderrEmpty': not result.stderr,
                       'stderrSha256': hashlib.sha256(result.stderr).hexdigest(),
                       'stdoutSha256': hashlib.sha256(result.stdout).hexdigest()}
            try:
                receipt['receipt'] = json.loads(result.stdout)
            except (json.JSONDecodeError, UnicodeDecodeError):
                receipt['receipt'] = None
        except subprocess.TimeoutExpired:
            receipt = {'exitCode': None, 'elapsedSeconds': time.monotonic()-start,
                       'timeoutSeconds': bound, 'runnerTimeout': True, 'receipt': None}
        report[name] = receipt
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True)+'\n')
        if receipt.get('exitCode') != 0 or not receipt.get('stderrEmpty') or receipt['receipt'] is None:
            raise SystemExit('fixture failed; nonsecret metadata preserved; no retry')
print(json.dumps(report, sort_keys=True))
