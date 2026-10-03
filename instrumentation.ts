// Next.js calls `register()` once when the server starts. GraphReview uses
// it to run its background job workers inside the same process as the web
// server — there is no separate worker to start.
//
// Set GRAPHREVIEW_NO_WORKER=1 to serve the UI without processing jobs
// (jobs stay queued until a process with workers runs).
//
// The import must sit inside the `NEXT_RUNTIME === "nodejs"` check (not
// after an early return): Next.js also compiles this file for the edge
// runtime, and only this shape lets that build drop the Node-only worker.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
