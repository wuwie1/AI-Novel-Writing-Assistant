import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// KERN_PROCARGS2 exposes argc/argv followed by environment. Return only argc entries.
const READ_ARGV = String.raw`
import ctypes,json,struct,sys
lib=ctypes.CDLL(None,use_errno=True)
mib=(ctypes.c_int*3)(1,49,int(sys.argv[1]))
size=ctypes.c_size_t(262144)
buf=ctypes.create_string_buffer(size.value)
if lib.sysctl(mib,3,buf,ctypes.byref(size),None,0): raise OSError(ctypes.get_errno())
raw=buf.raw[:size.value]
argc=struct.unpack_from('i',raw)[0]
if not 1<=argc<=8192: raise ValueError('Invalid argc')
pos=raw.index(b'\0',4)
while pos<len(raw) and raw[pos]==0: pos+=1
print(json.dumps([item.decode() for item in raw[pos:].split(b'\0')[:argc]]))
`;

export async function readProcessArgv(pid, { exec = execute } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      return raw.replace(/\0$/, '').split('\0');
    }
    const result = await exec('/usr/bin/python3', ['-c', READ_ARGV, String(pid)], { timeout: 5000, maxBuffer: 300_000 });
    const argv = JSON.parse(result.stdout);
    return Array.isArray(argv) && argv.every((arg) => typeof arg === 'string') ? argv : null;
  } catch { return null; }
}
