/**
 * Environment for every Git that works in a task's folder. On Windows a worktree path can push files
 * over 260 characters; without `core.longpaths` Git fails to create them, or reports them as deleted.
 * It travels by environment, so neither the repository's nor the user's configuration is changed.
 */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return { ...source };
  // The variable Git itself uses to hand `git -c` settings to its children.
  return { ...source, GIT_CONFIG_PARAMETERS: [source.GIT_CONFIG_PARAMETERS, "'core.longpaths=true'"].filter(Boolean).join(" ") };
}
