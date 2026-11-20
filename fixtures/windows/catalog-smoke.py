"""Exercise both supported formats against a separate native host and a synthetic MCP server."""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


def framed(message):
    data = json.dumps(message).encode()
    return struct.pack('<I', len(data)) + data


def roundtrip(binary, messages):
    reply = subprocess.run([str(binary)], input=b''.join(map(framed, messages)), capture_output=True, timeout=20, check=True)
    position = 0
    results = []
    while position < len(reply.stdout):
        length, = struct.unpack_from('<I', reply.stdout, position)
        position += 4
        result = json.loads(reply.stdout[position:position + length])
        assert 'error' not in result, result.get('error')
        results.append(result['data'])
        position += length
    assert len(results) == len(messages)
    return results


def run():
    installed = Path(os.environ['LOCALAPPDATA']) / 'NanobrowserWorkspace/NativeHost/WorkspaceHost.exe'
    with tempfile.TemporaryDirectory(prefix='nanobrowser-catalog-fixture-') as temporary:
        root = Path(temporary)
        host = root / 'WorkspaceHost.exe'
        shutil.copyfile(installed, host)
        server = root / 'mock server.py'
        server.write_text('''import json, sys
assert sys.argv[1:] == ['argument with spaces', 'literal"quote', '']
for line in sys.stdin:
    req = json.loads(line)
    if 'id' not in req: continue
    result = {'initialize': {'protocolVersion':'2025-06-18'}, 'tools/list': {'tools':[{'name':'list_records'}]}, 'tools/call': {'content':[{'text':'fixture-ok'}]}}[req['method']]
    print(json.dumps({'jsonrpc':'2.0', 'id':req['id'], 'result':result}), flush=True)
''', encoding='utf-8')
        args = [str(server), 'argument with spaces', 'literal"quote', '']
        for catalog in ({'fixture': {'executable':sys.executable, 'arguments':subprocess.list2cmdline(args)}},
                        {'mcpServers': {'fixture': {'command':sys.executable, 'args':args, 'env':{'FIXTURE_TOKEN':'never-return-this'}}}}):
            (root / 'servers.json').write_text(json.dumps(catalog), encoding='utf-8')
            requests = [{'op':'mcp-installed'}]
            for index, method in enumerate(['initialize','notifications/initialized','tools/list','tools/call']):
                message = {'jsonrpc':'2.0','method':method,'params':{'name':'list_records'} if method == 'tools/call' else {}}
                if not method.startswith('notifications/'): message['id'] = index
                requests.append({'op':'mcp','server':'fixture','message':json.dumps(message)})
            requests.append({'op':'mcp-close'})
            replies = roundtrip(host, requests)
            assert replies[0] == ['fixture']
            assert replies[3]['result']['tools'][0]['name'] == 'list_records'
            assert replies[4]['result']['content'][0]['text'] == 'fixture-ok'
            assert replies[5] is True
    print('PASS both local server catalogues: names only, initialize, list, call, close')


if __name__ == '__main__':
    run()
