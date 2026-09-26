// Translate native cache events without exposing cached instructions, URLs,
// selectors, file paths, or errors from Stagehand's auxiliary log fields.
export function cacheProgress(
  line: { category?: string; message: string },
  report: (message: string) => void,
): void {
  if (line.category !== "cache") return;
  if (line.message === "act cache hit") {
    report("Action cache HIT: replaying a saved action.");
  } else if (line.message === "act cache stored") {
    report("Action cache MISS: learned an action with the model and saved it.");
  } else if (line.message.startsWith("act cache miss:")) {
    report("Action cache MISS: fresh model inference required.");
  } else if (line.message.startsWith("failed to read act cache entry")) {
    report("Action cache unavailable for this action: using fresh model inference.");
  } else if (line.message.startsWith("unable to initialize")) {
    report("Action cache unavailable: could not initialize cache storage.");
  } else if (line.message.startsWith("failed to write act cache entry")) {
    report("Action cache MISS: action ran, but its cache entry could not be saved.");
  } else if (line.message.startsWith("failed to update act cache entry")) {
    report("Action cache: could not save the repaired action.");
  }
}
