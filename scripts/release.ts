import { spawnSync } from 'node:child_process'

const version = process.argv[2]

if (!version) {
  console.error('❌ Please provide a version number. Example: pnpm run release 1.0.1')
  process.exit(1)
}

const versionTag = `v${version}`

function runCommand(cmd: string[], description: string) {
  console.log(`\n🚀 ${description}...`)
  const [command, ...args] = cmd
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) {
    console.error(`❌ Failed: ${description} — ${result.error.message}`)
    process.exit(1)
  }
  // status is null when the child was killed by a signal; treat that as failure
  // rather than exiting 0 and letting a half-done release look successful.
  if (result.status !== 0) {
    console.error(`❌ Failed: ${description}`)
    process.exit(result.status ?? 1)
  }
}

runCommand(['pnpm', 'run', 'version:bump', version], 'Bumping version')
runCommand(['pnpm', 'run', 'version:check'], 'Checking version integrity')

runCommand(
  [
    'git',
    'add',
    'package.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
  ],
  'Staging release files',
)

runCommand(['git', 'commit', '-m', `chore: release ${versionTag}`], 'Committing changes')
runCommand(['git', 'push', 'origin', 'master'], 'Pushing to master')
runCommand(['git', 'tag', versionTag], `Creating tag ${versionTag}`)
runCommand(['git', 'push', 'origin', versionTag], 'Pushing tag to origin')

console.log(`\n🎉 Successfully released ${versionTag}!`)
