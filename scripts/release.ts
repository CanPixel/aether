import { spawnSync } from "bun"

const version = Bun.argv[2]

if (!version) {
  console.error("❌ Please provide a version number. Example: bun run release 1.0.1")
  process.exit(1)
}

const versionTag = `v${version}`

function runCommand(cmd: string[], description: string) {
  console.log(`\n🚀 ${description}...`)
  const result = spawnSync(cmd, { stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) {
    console.error(`❌ Failed: ${description}`)
    process.exit(result.exitCode)
  }
}

runCommand(["bun", "run", "version:bump", version], "Bumping version")
runCommand(["bun", "run", "version:check"], "Checking version integrity")

runCommand([
  "git", "add", 
  "package.json", 
  "src-tauri/Cargo.toml", 
  "src-tauri/Cargo.lock", 
  "src-tauri/tauri.conf.json"
], "Staging release files")

runCommand(["git", "commit", "-m", `chore: release ${versionTag}`], "Committing changes")
runCommand(["git", "push", "origin", "master"], "Pushing to master")
runCommand(["git", "tag", versionTag], `Creating tag ${versionTag}`)
runCommand(["git", "push", "origin", versionTag], "Pushing tag to origin")

console.log(`\n🎉 Successfully released ${versionTag}!`)