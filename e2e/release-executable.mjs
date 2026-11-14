// Validate the declared target's executable header without executing foreign code.
export function validateExecutable(bytes, os, arch) {
  let valid = false;
  if (bytes.length >= 64 && os === 'linux') {
    valid = bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
      bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(16) === 2 &&
      bytes.readUInt16LE(18) === (arch === 'amd64' ? 62 : 183);
  }
  if (bytes.length >= 32 && os === 'darwin') {
    valid = bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === (arch === 'amd64' ? 0x01000007 : 0x0100000c) &&
      bytes.readUInt32LE(12) === 2;
  }
  if (bytes.length >= 64 && os === 'windows' && bytes.toString('ascii', 0, 2) === 'MZ') {
    const offset = bytes.readUInt32LE(60);
    valid = offset <= bytes.length - 24 &&
      bytes.readUInt32LE(offset) === 0x00004550 &&
      bytes.readUInt16LE(offset + 4) === (arch === 'amd64' ? 0x8664 : 0xaa64) &&
      (bytes.readUInt16LE(offset + 22) & 2) !== 0;
  }
  if (!valid) throw new Error(`RELEASE_STAGING: invalid executable ${os}/${arch}`);
}
