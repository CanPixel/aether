import { spawnSync } from 'node:child_process'

const version = process.argv[2]

if (!version) {
  console.error('❌ Please provide a version number. Example: pnpm run release 1.0.1')
  process.exit(1)
}

const versionTag = `v${version}`
const releaseFiles = [
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
]

function runCommand(cmd: string[], description: string) {
  console.log(`\n🚀 ${description}...`)
  const [command, ...args] = cmd
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) {
    console.error(`❌ Failed: ${description}: ${result.error.message}`)
    process.exit(1)
  }
  // status is null when the child was killed by a signal; treat that as failure
  // rather than exiting 0 and letting a half-done release look successful.
  if (result.status !== 0) {
    console.error(`❌ Failed: ${description}`)
    process.exit(result.status ?? 1)
  }
}

function readCommand(cmd: string[], description: string): string {
  const [command, ...args] = cmd
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    console.error(`❌ Failed: ${description}${result.error ? `: ${result.error.message}` : ''}`)
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

function commandSucceeded(cmd: string[]): boolean {
  const [command, ...args] = cmd
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return !result.error && result.status === 0
}

const remoteDefaultRef = readCommand(
  ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
  'Finding the origin default branch',
)
const defaultBranch = remoteDefaultRef.replace(/^origin\//, '')
const currentBranch = readCommand(['git', 'branch', '--show-current'], 'Finding the current branch')

if (currentBranch !== defaultBranch) {
  console.error(
    `❌ Releases must run from ${defaultBranch}. Current branch: ${currentBranch || '(detached HEAD)'}`,
  )
  process.exit(1)
}

const trackedChanges = readCommand(
  ['git', 'status', '--porcelain', '--untracked-files=no'],
  'Checking the working tree',
)
if (trackedChanges) {
  console.error('❌ Commit or restore tracked working-tree changes before releasing.')
  process.exit(1)
}

if (commandSucceeded(['git', 'rev-parse', '--verify', '--quiet', `refs/tags/${versionTag}`])) {
  console.error(`❌ Tag ${versionTag} already exists locally.`)
  process.exit(1)
}

runCommand(['pnpm', 'run', 'version:bump', version], 'Bumping version')
runCommand(['pnpm', 'run', 'version:check'], 'Checking version integrity')

if (commandSucceeded(['git', 'diff', '--quiet', '--', ...releaseFiles])) {
  console.log(`\n✓ Version files are already at ${version}; no release commit is needed.`)
} else {
  runCommand(['git', 'add', ...releaseFiles], 'Staging release files')
  runCommand(['git', 'commit', '-m', `chore: release ${versionTag}`], 'Committing changes')
}

runCommand(['git', 'push', 'origin', defaultBranch], `Pushing to ${defaultBranch}`)
runCommand(['git', 'tag', versionTag], `Creating tag ${versionTag}`)
runCommand(
  ['git', 'push', 'origin', `refs/tags/${versionTag}:refs/tags/${versionTag}`],
  'Pushing tag to origin',
)

console.log(`\n🎉 Successfully released ${versionTag}!`)
