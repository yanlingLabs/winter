"""Read-only audit of the recorded stream run; never launches a process or VM.

Independent of stream_fixture_oracle.py and the original receipt summaries.
Writes a separate audit receipt; never changes the recorded run.
"""
from collections import Counter
import hashlib
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / 'out/stream-fixture-v3-o32btt1i'
EXPECTED_BUILD = 'b4e5b6908ecfa6eb220f478c4d0c27e59e28900c4d697ef9527d30b52e93d139'


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def one(rows, kind, **fields):
    found = [r for r in rows if r.get('kind') == kind and all(r.get(k) == v for k, v in fields.items())]
    assert len(found) == 1, (kind, fields, len(found))
    return found[0]


def binary(path, salt):
    count = 0
    with path.open('rb') as source:
        while chunk := source.read(65536):
            assert len(chunk) % 256 == 0
            blocks = []
            for offset in range(count, count + len(chunk), 256):
                block = offset // 256
                rotation = (37 * block + 13 * (block // 256)) % 256
                blocks.append(bytes(((byte + rotation) % 256) ^ salt for byte in range(256)))
            assert chunk == b''.join(blocks), ('binary mismatch', path.name, count)
            count += len(chunk)
    assert 0 < count <= 16777216
    return {'bytes': count, 'sha256': sha(path), 'everyBytePassed': True}


def main():
    original_hashes = {name: sha(RUN / name) for name in ['result.json', 'events.jsonl', 'stdout.log', 'stderr.log']}
    result = json.loads((RUN / 'result.json').read_text())
    rows = [json.loads(line) for line in (RUN / 'events.jsonl').read_text().splitlines()]
    receipt = ROOT / 'results/2026-10-12-stream-hvc-prelaunch-build.json'
    assert sha(receipt) == EXPECTED_BUILD == result['buildSha256']
    build = json.loads(receipt.read_text())
    for name in ['cowork-hvf-stream-worker', 'kernel', 'initramfs.cpio']:
        assert sha(RUN / name) == build['artifacts'][name]
    raw_rows = {}
    for channel in ['stdout', 'stderr']:
        extracted = []
        for line in (RUN / (channel + '.log')).read_text().splitlines():
            try:
                row = json.loads(line[line.index('{'):])
            except (ValueError, json.JSONDecodeError):
                continue
            if isinstance(row, dict):
                extracted.append(row)
        recorded = [{k: v for k, v in row.items() if k not in ['channel', 'hostElapsedSeconds']}
                    for row in rows if row.get('channel') == channel]
        assert extracted == recorded, ('raw channel/event discrepancy', channel)
        raw_rows[channel] = extracted
    assert result['exitCode'] == 0 and result['exitVerified'] and result['ownedChildReaped']
    assert result['ownersQuiescent'] and result['readerThreadsJoined'] and result['streamOracle']['threadJoined']
    assert not result['timedOut'] and result['captureComplete'] and not result['captureOverflow']
    assert result['fixtureChecksPassed'] is False and result['activeReturnVerified'] is False
    assert result['streamAudit']['errors'] == ['guest TX readiness stall absent']
    captures = {name: binary(RUN / name, salt) for name, salt in
                [('stream-guest-to-host.bin', 0xa7), ('stream-host-to-guest.bin', 0x5c)]}
    for name, item in captures.items():
        assert item['sha256'] == result['rawCaptureHashes'][name]
    tx = one(rows, 'guest_stream_complete', direction='guest-to-host')
    rx = one(rows, 'guest_stream_complete', direction='host-to-guest')
    assert tx['bytes'] == captures['stream-guest-to-host.bin']['bytes'] == result['streamOracle']['receivedBytes']
    assert 0 < rx['bytes'] <= captures['stream-host-to-guest.bin']['bytes'] == result['streamOracle']['sentBytes']
    assert all(r['integrity'] and r['raw'] and r['bytes'] == r['frames'] * 65536 for r in [tx, rx])
    assert sorted(r['device'] for r in rows if r['kind'] == 'virtio_device') == ['0x0002', '0x0003', '0x0004', '0x0005']
    ready = one(rows, 'guest_stream_ready')
    assert ready['rawReadback'] and ready['connectedHvcCount'] == 1 and ready['registeredClassSlots'] == 8
    assert one(rows, 'guest_complete')['cycles'] == 3
    assert not any(r['kind'] in ['guest_failure', 'reclaim_failure', 'block_trace_overflow'] for r in rows)

    # Native stderr order is preserved independently of merged host timestamps.
    native = raw_rows['stderr']
    epochs = sorted({r['epoch'] for r in native if 'epoch' in r})
    assert epochs == list(range(1, 19))
    mappings = []
    frozen_stream = []
    for epoch in epochs:
        events = [r for r in native if r.get('epoch') == epoch]
        assert events[0]['kind'] == 'reclaim_parked' and events[-1]['kind'] == 'reclaim_resumed'
        assert one(events, 'reclaim_parked')['roster'] == one(events, 'reclaim_resumed')['roster'] == [0, 1]
        exclusions = [(r['gpa'], r['gpa'] + r['len']) for r in events if r['kind'] == 'reclaim_exclusion']
        frozen = [r for r in events if r['kind'] == 'block_freeze_pin']
        assert 0 < len(frozen) <= 32
        for pin in frozen:
            assert pin['device'] in [0, 1] and pin['generation'] == 1 and pin['ranges']
            for span in pin['ranges']:
                assert span['len'] > 0 and any(a <= span['gpa'] and span['gpa'] + span['len'] <= b for a, b in exclusions)
        frozen_stream.extend(r for r in frozen if r['device'] == 1)
        operations = [r for r in events if r['kind'] in ['reclaim_unmap', 'reclaim_replace', 'reclaim_map']]
        assert len(operations) % 3 == 0
        total = 0
        for i in range(0, len(operations), 3):
            unmap, replace, remap = operations[i:i + 3]
            assert [r['kind'] for r in [unmap, replace, remap]] == ['reclaim_unmap', 'reclaim_replace', 'reclaim_map']
            assert unmap['gpa'] == replace['gpa'] == remap['gpa']
            assert unmap['len'] > 0 and all(unmap[k] % 16384 == 0 for k in ['gpa', 'hva', 'len'])
            assert unmap['return'] == remap['return'] == replace['errnoIfFailed'] == 0
            assert replace['sameHVA'] and remap['sameHVA'] and remap['flags'] == 'RWX'
            assert not any(unmap['gpa'] < b and a < unmap['gpa'] + unmap['len'] for a, b in exclusions)
            total += unmap['len']
            mappings.append(unmap)
        assert one(events, 'reclaim_resumed')['spanCount'] == len(operations) // 3
        disposition = one(events, 'reclaim_disposition')
        assert disposition['disposition'] == 'replaced' and disposition['bytes'] == total
        ack = one(events, 'reclaim_used_ack')
        assert ack['indices'] and len(ack['indices']) == len(set(ack['indices']))
        assert events.index(operations[-1]) < events.index(ack) < events.index(disposition) < len(events) - 1
    assert len(frozen_stream) == 38 and len(mappings) == 299
    requests = [r for r in native if r['kind'] == 'block_request_capture']
    assert len(requests) == len({r['request'] for r in requests}) == 1589
    for request in requests:
        assert request['leaseReleased'] and request['length'] <= 1048576
        chain = [r for r in native if r.get('request') == request['request']]
        begin = one(chain, 'block_owned_io_begin')
        end = one(chain, 'block_owned_io_end')
        ack = one(chain, 'block_used_ack')
        assert chain[0] == request and chain[-1] == ack
        assert request['clockMicros'] <= begin['clockMicros'] <= end['clockMicros'] <= ack['clockMicros']
        assert end['success'] and ack['success'] and ack['head'] == request['head']
    windows = []
    for cycle in [1, 2, 3]:
        freed = one(rows, 'guest_freed', cycle=cycle)['hostElapsedSeconds']
        intact = one(rows, 'guest_integrity', cycle=cycle)
        reused = one(rows, 'guest_reuse', cycle=cycle)
        assert intact['retained'] and intact['progress'] and reused['anonymousZeroFill'] and reused['writtenIntegrity']
        window = [r for r in rows if freed < r['hostElapsedSeconds'] < intact['hostElapsedSeconds']]
        streams = [r for r in window if r['kind'] == 'guest_stream_progress']
        assert {r['direction'] for r in streams} == {'guest-to-host', 'host-to-guest'}
        assert all(r['integrity'] and r['raw'] and r['cycle'] == cycle for r in streams)
        assert {r['thread'] for r in window if r['kind'] == 'guest_block_progress'} == {0, 1}
        hearts = [r for r in window if r['kind'] == 'guest_heartbeat']
        returned = [r for r in window if r['kind'] == 'reclaim_unmap']
        assert len(hearts) >= 8 and returned
        windows.append({'cycle': cycle, 'streamProgressRows': len(streams), 'heartbeats': len(hearts),
                        'replacementSpans': len(returned), 'cumulativeReplacementBytes': sum(r['len'] for r in returned)})
    source_pin = json.loads((ROOT / 'results/2026-10-12-stream-hvc-kernel-source-audit.json').read_text())
    archive = ROOT / source_pin['cachedSourceArchive']
    assert sha(archive) == source_pin['sourceArchiveSha256']
    with tarfile.open(archive) as source_tar:
        for member, expected in source_pin['sourceMembers'].items():
            extracted = ROOT / 'out/stream-hvc-source' / Path(member).name
            assert sha(extracted) == expected
            assert hashlib.sha256(source_tar.extractfile('linux-6.18.35/' + member).read()).hexdigest() == expected
    assert original_hashes == {name: sha(RUN / name) for name in original_hashes}
    output = {'fixture': RUN.name, 'buildSha256': EXPECTED_BUILD, 'vmLaunchedByAudit': False,
              'originalArtifactsUnchanged': original_hashes, 'captures': captures,
              'guestTxBytes': tx['bytes'], 'guestRxBytes': rx['bytes'],
              'hostSentUnconsumedSuffixBytes': captures['stream-host-to-guest.bin']['bytes'] - rx['bytes'],
              'rawLogEventCorrespondencePassed': True, 'rawTelemetryRows': sum(map(len, raw_rows.values())),
              'epochCount': len(epochs), 'mappingTriples': len(mappings), 'streamFrozenPinObservations': len(frozen_stream),
              'allFrozenPinsExcludedAndMappingsDisjoint': True, 'mappingAckOrderPassed': True,
              'rawRequestsWithSuccessfulOrderedAck': len(requests), 'freedWindows': windows,
              'upstreamKernelSourceHashesVerified': True, 'measuredKernelSourceBuildEquivalenceVerified': False,
              'originalFixtureChecksPassed': result['fixtureChecksPassed'],
              'originalStreamAuditErrors': result['streamAudit']['errors'],
              'diskAndFootprintAuditScope': 'Root independently audits final disk and footprint; not reclassified here',
              'productionReady': False, 'fullResourceGatePassed': False}
    target = ROOT / 'results/2026-10-12-stream-postrun-independent-audit.json'
    target.write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
