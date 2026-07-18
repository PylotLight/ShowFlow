import { backgroundJobs } from "../core/background_jobs";
import { json, errorResponse } from "./_shared";

/**
 * Feeds the header-level Background Activity popover
 * (design-brief-platform-ux-systems.md §2). Any job registered via
 * core/background_jobs.ts shows up here - this route doesn't know or care
 * what kind of job it is, that's the point of the registry.
 */
export function backgroundJobRoutes() {
  return {
    "/api/background-jobs": {
      async GET() {
        try {
          return json(backgroundJobs.list());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/background-jobs/:id": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const job = backgroundJobs.get(req.params.id!);
          if (!job) return errorResponse("Job not found", 404);
          return json(job);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  };
}
