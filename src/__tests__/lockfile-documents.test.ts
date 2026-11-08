import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { parseLockfile } from '../core/lockfile.js';

const multiDocumentFixture = fileURLToPath(
  new URL('./fixtures/pnpm-lock-multi-document.yaml', import.meta.url)
);

describe('parseLockfile documents', () => {
  let tempDir: string;
  let fileIndex: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pnpm-airgap-lockfile-'));
    fileIndex = 0;
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  async function writeDocuments(documents: unknown[]): Promise<string> {
    const filename = path.join(tempDir, `${fileIndex++}.yaml`);
    await fs.writeFile(filename, documents.map((document) => yaml.dump(document)).join('---\n'));
    return filename;
  }

  it('collects both boot and project dependencies from a pnpm lockfile', async () => {
    const result = await parseLockfile(multiDocumentFixture);

    expect(result.lockfileVersion).toBe('9.0');
    expect([...result.packages.keys()]).toEqual(['pnpm@12.16.1', 'chalk@5.6.2']);
    expect(result.skipped).toEqual({ nonRegistry: 0, invalid: 0, duplicate: 0, optional: 0 });

    const documents = yaml.loadAll(await fs.readFile(multiDocumentFixture, 'utf8'));
    const separatePackages = new Map();
    for (const document of documents) {
      const separate = await parseLockfile(await writeDocuments([document]));
      for (const [id, pkg] of separate.packages) separatePackages.set(id, pkg);
    }
    expect(result.packages).toEqual(separatePackages);
  });

  it.each([
    ['5.4', '/chalk/5.6.2'],
    ['6.0', '/chalk@5.6.2'],
    ['9.0', 'chalk@5.6.2'],
  ])('preserves single-document lockfile version %s', async (version, key) => {
    const filename = await writeDocuments([
      {
        lockfileVersion: version,
        packages: { [key]: { resolution: { integrity: 'sha512-single' }, dev: true } },
      },
    ]);

    const result = await parseLockfile(filename, { registryUrl: 'https://registry.example.com/' });
    expect(result.lockfileVersion).toBe(version);
    expect([...result.packages.values()]).toEqual([
      {
        name: 'chalk',
        version: '5.6.2',
        tarballUrl: 'https://registry.example.com/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-single',
        dev: true,
        optional: false,
      },
    ]);
  });

  it('keeps the first full record when documents repeat a package version', async () => {
    const first = {
      resolution: { tarball: 'https://boot.example.com/shared.tgz', integrity: 'sha512-first' },
      dev: true,
      optional: true,
    };
    const second = {
      resolution: { tarball: 'https://project.example.com/shared.tgz', integrity: 'sha512-second' },
    };
    const filename = await writeDocuments([
      { lockfileVersion: '9.0', packages: { 'shared@1.0.0': first } },
      { lockfileVersion: '9.0', packages: { 'shared@1.0.0(peer@2.0.0)': second } },
    ]);

    const result = await parseLockfile(filename);
    expect(result.packages.size).toBe(1);
    expect(result.packages.get('shared@1.0.0')).toEqual({
      name: 'shared',
      version: '1.0.0',
      tarballUrl: first.resolution.tarball,
      integrity: first.resolution.integrity,
      dev: true,
      optional: true,
    });
    expect(result.skipped.duplicate).toBe(1);
  });

  it('prefers a later full record over an earlier snapshot and includes snapshot-only packages', async () => {
    const filename = await writeDocuments([
      {
        lockfileVersion: '9.0',
        snapshots: {
          'shared@1.0.0': {},
          'boot-only@1.0.0': { resolution: { integrity: 'sha512-boot' } },
        },
      },
      {
        lockfileVersion: '9.0',
        packages: {
          'shared@1.0.0': {
            resolution: { tarball: 'https://example.com/shared.tgz', integrity: 'sha512-full' },
          },
        },
        snapshots: { 'project-only@2.0.0': {} },
      },
    ]);

    const result = await parseLockfile(filename, { registryUrl: 'https://registry.example.com' });
    expect(result.packages.size).toBe(3);
    expect(result.packages.get('shared@1.0.0')).toMatchObject({
      tarballUrl: 'https://example.com/shared.tgz',
      integrity: 'sha512-full',
    });
    expect(result.packages.get('shared@1.0.0')).not.toHaveProperty('fromSnapshots');
    expect(result.packages.get('boot-only@1.0.0')).toMatchObject({
      integrity: 'sha512-boot',
      fromSnapshots: true,
    });
    expect(result.packages.get('project-only@2.0.0')).toMatchObject({
      tarballUrl: 'https://registry.example.com/project-only/-/project-only-2.0.0.tgz',
      fromSnapshots: true,
    });
  });

  it('applies existing package filtering in both documents', async () => {
    const filename = await writeDocuments([
      {
        lockfileVersion: '9.0',
        packages: { 'boot-optional@1.0.0': { optional: true }, 'file:../local': {} },
      },
      {
        lockfileVersion: '9.0',
        packages: { 'project-optional@1.0.0': { optional: true }, 'required@1.0.0': {} },
      },
    ]);

    const result = await parseLockfile(filename, { skipOptional: true });
    expect([...result.packages.keys()]).toEqual(['required@1.0.0']);
    expect(result.skipped.optional).toBe(2);
    expect(result.skipped.nonRegistry).toBe(1);
  });

  it('rejects documents with different lockfile versions', async () => {
    const filename = await writeDocuments([
      { lockfileVersion: '9.0', packages: {} },
      { lockfileVersion: '6.0', packages: {} },
    ]);

    await expect(parseLockfile(filename)).rejects.toThrow(
      'Inconsistent lockfileVersion: document 1 uses 9.0, document 2 uses 6.0'
    );
  });

  it.each([null, 'invalid', []])('rejects a non-mapping document: %j', async (document) => {
    const filename = await writeDocuments([{ lockfileVersion: '9.0' }, document]);
    await expect(parseLockfile(filename)).rejects.toThrow(
      'Invalid lockfile document 2: expected a YAML mapping'
    );
  });
});
