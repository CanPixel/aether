#!/usr/bin/env bun

import { readFile, writeFile } from 'node:fs/promises'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

type ManifestVersions = {
  packageJson: string
  cargoToml: string
  tauriConfig: string
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const versionArg = args.find((arg) => !arg.startsWith('-'))

function usage(): never {
  console.error('Usage:')
  console.error('  bun run version:bump 1.2.3')
  console.error('  bun run version:check')
  process.exit(1)
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    console.error(`Invalid version "${version}". Use SemVer without a leading "v", for example 1.2.3.`)
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

async function readVersions(): Promise<ManifestVersions> {
  const [packageRaw, cargoRaw, tauriRaw] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('src-tauri/Cargo.toml', 'utf8'),
    readFile('src-tauri/tauri.conf.json', 'utf8')
  ])
  const packageJson = JSON.parse(packageRaw) as { version?: string }
  const tauriConfig = JSON.parse(tauriRaw) as { version?: string }

  if (!packageJson.version) throw new Error('package.json is missing version')
  if (!tauriConfig.version) throw new Error('src-tauri/tauri.conf.json is missing version')

  return {
    packageJson: packageJson.version,
    cargoToml: readCargoPackageVersion(cargoRaw),
    tauriConfig: tauriConfig.version
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

  const [packageRaw, cargoRaw, tauriRaw] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('src-tauri/Cargo.toml', 'utf8'),
    readFile('src-tauri/tauri.conf.json', 'utf8')
  ])

  const packageJson = JSON.parse(packageRaw) as { version: string }
  const tauriConfig = JSON.parse(tauriRaw) as { version: string }
  packageJson.version = version
  tauriConfig.version = version

  await Promise.all([
    writeFile('package.json', `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile('src-tauri/Cargo.toml', updateCargoPackageVersion(cargoRaw, version)),
    writeFile('src-tauri/tauri.conf.json', `${JSON.stringify(tauriConfig, null, 2)}\n`)
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

  if (!versionArg) usage()
  await bumpVersion(versionArg)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
