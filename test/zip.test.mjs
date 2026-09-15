import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { crc32, createZip } from "../web/zip.mjs";

// A minimal reader: walks the central directory and inflates each entry, checking its CRC-32.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  assert.equal(view.getUint32(endAt, true), 0x06054b50, "end of central directory");
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const entries = {};
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, "central header");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(localAt, true), 0x04034b50, "local header");
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const body = bytes.subarray(dataAt, dataAt + compressedSize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    assert.equal(crc32(data), crc, `crc of ${name}`);
    entries[name] = { method, text: new TextDecoder().decode(data) };
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("entries round-trip, compressible ones deflated and tiny ones stored", async () => {
  const bytes = await createZip([
    { path: "summary.md", data: "# Report\n" + "line of text\n".repeat(500) },
    { path: "fuzz-report/tunic/0.0.0/default/fuzz_output/report.json", data: '{"stats":{}}' },
    { path: "unittest-report/ünïcode/1.0/a.toml", data: new Uint8Array([1, 2, 3]) },
    { path: "empty.txt", data: "" },
  ]);
  const entries = readZip(bytes);
  assert.deepEqual(Object.keys(entries), [
    "summary.md",
    "fuzz-report/tunic/0.0.0/default/fuzz_output/report.json",
    "unittest-report/ünïcode/1.0/a.toml",
    "empty.txt",
  ]);
  assert.equal(entries["summary.md"].method, 8);
  assert.match(entries["summary.md"].text, /^# Report\nline of text/);
  assert.equal(entries["fuzz-report/tunic/0.0.0/default/fuzz_output/report.json"].text, '{"stats":{}}');
  assert.equal(entries["empty.txt"].text, "");
});
