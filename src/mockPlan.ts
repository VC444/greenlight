import type { TestPlan } from "./testplan.js";

/**
 * A fixed test plan used when GREENLIGHT_MOCK_PLAN=1, so the pipeline
 * (comment → preview resolution → browser execution) can be exercised
 * deterministically without spending Fireworks credits or depending on the
 * model's output. Edit these items to match whatever the preview under test
 * actually serves — they drive both the posted comment and the browser run.
 */
// Captured from a real Fireworks run so the pipeline is exercised against
// representative model output. Swap these items whenever the preview changes.
export const MOCK_PLAN: TestPlan = {
  summary:
    "Adds a 'Say hi bro' navigation button to the landing page header whose label changes to 'I said hi bro' when clicked.",
  confidence: "high",
  items: [
    {
      intent:
        "Verify the header's 'Say hi bro' button appears and toggles its label to 'I said hi bro' when clicked.",
      route: "/",
      steps: [
        "Click the 'Say hi bro' button in the header, to the right of the 'Pricing' link.",
      ],
      expected:
        "The button, initially labelled 'Say hi bro', reads 'I said hi bro' after being clicked.",
    },
  ],
};
