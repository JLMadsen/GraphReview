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
    if (process.env.GRAPHREVIEW_NO_WORKER !== "1") {
      const { startWorker } = await import("./worker");
      await startWorker();
    }
  }
}
