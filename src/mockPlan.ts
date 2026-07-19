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
        "Verify the landing page header shows a new 'Say hi bro' navigation button.",
      route: "/",
      steps: [
        "Set the browser viewport to at least 768px wide so the desktop navigation is visible.",
        "Navigate to the root route '/'.",
        "Wait for the landing page to fully load.",
        "Look at the top navigation bar to the right of the 'Pricing' link.",
      ],
      expected:
        "A button with the text 'Say hi bro' is visible in the header between 'Pricing' and 'Get Started'.",
    },
    {
      intent:
        "Verify clicking the button changes its label to 'I said hi bro'.",
      route: "/",
      steps: [
        "Set the browser viewport to at least 768px wide so the desktop navigation is visible.",
        "Navigate to the root route '/'.",
        "Wait for the landing page to fully load.",
        "Click the 'Say hi bro' button in the header.",
      ],
      expected:
        "The button's text now reads 'I said hi bro' instead of 'say hi bro'.",
    },
  ],
};
