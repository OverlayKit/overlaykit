const expected = Number(process.argv[2]);
const actual = Number(process.versions.node.split('.')[0]);

if (!Number.isSafeInteger(expected) || expected < 1) {
  throw new Error('Expected Node major version must be a positive integer');
}

if (actual !== expected) {
  throw new Error(`Expected Node ${expected}, received ${process.version}`);
}
