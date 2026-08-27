#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

type ManifestVersions = {
  packageJson: string
  cargoToml: string
  cargoLock: string
  tauriConfig: string
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const versionArg = args.find((arg: string) => !arg.startsWith('-'))

function usage(): void {
  console.error('Usage:')
  console.error('  pnpm run version:bump 1.2.3')
  console.error('  pnpm run version:check')
  process.exit(1)
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    console.error(
      `Invalid version "${version}". Use SemVer without a leading "v", for example 1.2.3.`,
    )
    process.exit(1)
  }
}

function readCargoPackageVersion(content: string): string {
  const match = content.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('Could not find [package] version in src-tauri/Cargo.toml')
  return match[1]
}

function updateCargoPackageVersion(content: string, version: string): string {
  const lines = content.split('\n')
  let inPackage = false
  let updated = false

  const nextLines = lines.map((line) => {
    if (/^\[[^\]]+\]/.test(line)) {
      inPackage = line === '[package]'
    }
    if (inPackage && !updated && /^version\s*=/.test(line)) {
      updated = true
      return `version = "${version}"`
    }
    return line
  })

  if (!updated) throw new Error('Could not update [package] version in src-tauri/Cargo.toml')
  return nextLines.join('\n')
}

function updateJsonVersion(content: string, version: string, filename: string): string {
  const parsed = JSON.parse(content) as { version?: unknown }
  if (typeof parsed.version !== 'string') {
    throw new Error(`${filename} is missing version`)
  }

  let found = false
  const next = content.replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, (_match, prefix: string) => {
    found = true
    return `${prefix}"${version}"`
  })
  if (!found) throw new Error(`Could not update version in ${filename}`)
  return next
}

function readCargoLockPackageVersion(content: string): string {
  const match = content.match(
    /^\[\[package\]\]\s*\nname\s*=\s*"aether"\s*\nversion\s*=\s*"([^"]+)"/m,
  )
  if (!match) throw new Error('Could not find aether package version in src-tauri/Cargo.lock')
  return match[1]
}

function updateCargoLockPackageVersion(content: string, version: string): string {
  let found = false
  const next = content.replace(
    /^(\[\[package\]\]\s*\nname\s*=\s*"aether"\s*\nversion\s*=\s*)"([^"]+)"/m,
    (_match, prefix: string) => {
      found = true
      return `${prefix}"${version}"`
    },
  )
  if (!found) {
    throw new Error('Could not update aether package version in src-tauri/Cargo.lock')
  }
  return next
}

async function readVersions(): Promise<ManifestVersions> {
  const [packageRaw, cargoRaw, cargoLockRaw, tauriRaw] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('src-tauri/Cargo.toml', 'utf8'),
    readFile('src-tauri/Cargo.lock', 'utf8'),
    readFile('src-tauri/tauri.conf.json', 'utf8'),
  ])
  const packageJson = JSON.parse(packageRaw) as { version?: string }
  const tauriConfig = JSON.parse(tauriRaw) as { version?: string }

  if (!packageJson.version) throw new Error('package.json is missing version')
  if (!tauriConfig.version) throw new Error('src-tauri/tauri.conf.json is missing version')

  return {
    packageJson: packageJson.version,
    cargoToml: readCargoPackageVersion(cargoRaw),
    cargoLock: readCargoLockPackageVersion(cargoLockRaw),
    tauriConfig: tauriConfig.version,
  }
}

function assertSynced(versions: ManifestVersions, expectedVersion: string): void {
  const entries = Object.entries(versions)
  const mismatches = entries.filter(([, version]) => version !== expectedVersion)
  if (mismatches.length > 0) {
    console.error(`Version mismatch. Expected ${expectedVersion}:`)
    for (const [manifest, version] of entries) {
      console.error(`  ${manifest}: ${version}`)
    }
    process.exit(1)
  }
}

async function bumpVersion(version: string): Promise<void> {
  assertVersion(version)

  const [packageRaw, cargoRaw, cargoLockRaw, tauriRaw] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('src-tauri/Cargo.toml', 'utf8'),
    readFile('src-tauri/Cargo.lock', 'utf8'),
    readFile('src-tauri/tauri.conf.json', 'utf8'),
  ])

  // Finish every parse and transformation before starting any asynchronous
  // writes. A validation failure must never leave a subset of manifests empty.
  const packageNext = updateJsonVersion(packageRaw, version, 'package.json')
  const cargoNext = updateCargoPackageVersion(cargoRaw, version)
  const cargoLockNext = updateCargoLockPackageVersion(cargoLockRaw, version)
  const tauriNext = updateJsonVersion(tauriRaw, version, 'src-tauri/tauri.conf.json')

  await Promise.all([
    writeFile('package.json', packageNext),
    writeFile('src-tauri/Cargo.toml', cargoNext),
    writeFile('src-tauri/Cargo.lock', cargoLockNext),
    writeFile('src-tauri/tauri.conf.json', tauriNext),
  ])

  console.log(`Synced app version to ${version}`)
}

async function main(): Promise<void> {
  if (checkOnly) {
    const versions = await readVersions()
    const expectedVersion = versionArg ?? versions.packageJson
    assertVersion(expectedVersion)
    assertSynced(versions, expectedVersion)
    console.log(`App versions are synced at ${expectedVersion}`)
    return
  }

  if (!versionArg) {
    usage()
    return
  }
  await bumpVersion(versionArg)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
