// Next.js calls `register()` once when the server starts. GraphReview uses
// it to load the user's settings file and run its background job workers
// inside the same process as the web server — there is no separate worker to
// start.
//
// Set GRAPHREVIEW_NO_WORKER=1 to serve the UI without processing jobs
// (jobs stay queued until a process with workers runs).
//
// The imports must sit inside the `NEXT_RUNTIME === "nodejs"` check (not
// after an early return): Next.js also compiles this file for the edge
// runtime, and only this shape lets that build drop the Node-only code.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The settings file (lib/runtime/config-env.mjs). `npx graphreview`
    // already applied it before starting this process; under `npm run dev`
    // this is where it's read (and created on first start).
    const { applyConfigEnv, loadConfigEnv } = await import("./lib/runtime/config-env.mjs");
    const { getDataDir } = await import("./lib/runtime/paths");
    const config = loadConfigEnv(getDataDir());
    const applied = applyConfigEnv(process.env, config.values);
    if (applied.includes("NODE_EXTRA_CA_CERTS")) {
      // Node reads NODE_EXTRA_CA_CERTS only at process start; add it to the
      // default CAs now (Node 22.19+/24.5+), so a dev server trusts it too.
      const { addCaFileToDefaults } = await import("./lib/runtime/ca");
      addCaFileToDefaults(process.env.NODE_EXTRA_CA_CERTS!);
    }
    if (config.created) console.log(`[graphreview] created ${config.file} — edit it for self-hosted GitLab/GitHub, mirrors or certificates`);

    // Started by `npx graphreview` (bin/graphreview.mjs): exit with the
    // launcher. On Windows, killing a process doesn't kill its children, so
    // without this a crashed launcher would leave the server running.
    const launcher = Number(process.env.GRAPHREVIEW_LAUNCHER_PID);
    if (launcher > 0) {
      setInterval(() => {
        try {
          process.kill(launcher, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") process.exit(0);
        }
      }, 2000).unref();
    }

    if (process.env.GRAPHREVIEW_NO_WORKER !== "1") {
      const { startWorker } = await import("./worker");
      await startWorker();
    }
  }
}
