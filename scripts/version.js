// The release version: manifest.json's version_name, or its version when there is none. A release is X.Y.Z; a release
// candidate is X.Y.Z-rc.N. Chrome only takes numbers in "version", so a candidate keeps its number there as a fourth
// part (0.3.0-rc.2 -> "version": "0.3.0.2", "version_name": "0.3.0-rc.2"); a release has just "version": "X.Y.Z".
// Run on its own it prints the release version (release.yml checks the tag against it).
//   node scripts/version.js
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export function releaseVersion(manifest) {
  const { version, version_name: name } = manifest
  const label = name || version
  const rc = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/.exec(label)
  if (rc) {
    if (version !== `${rc[1]}.${rc[2]}`)
      throw new Error(`manifest.json: version_name ${label} 이면 version 은 ${rc[1]}.${rc[2]} 이어야 합니다 (지금 ${version})`)
    return { label, prerelease: true }
  }
  if (!/^\d+\.\d+\.\d+$/.test(label) || version !== label)
    throw new Error(`manifest.json: 버전은 X.Y.Z 또는 version_name X.Y.Z-rc.N 이어야 합니다 (version ${version}, version_name ${name})`)
  return { label, prerelease: false }
}

export function readReleaseVersion(root = new URL('../', import.meta.url)) {
  return releaseVersion(JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8')))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  process.stdout.write(`${readReleaseVersion().label}\n`)
