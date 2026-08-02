import type { TestPlan } from "./testplan.js";

/**
 * A fixed test plan used when GREENLIGHT_MOCK_PLAN=1, so the pipeline
 * (comment → preview resolution → browser execution) can be exercised
 * deterministically without spending LLM credits or depending on the model's
 * output. Edit these items to match whatever the preview under test
 * actually serves — they drive both the posted comment and the browser run.
 */
// Captured from a real model run against a test repo's promo-code PR so
// the pipeline is exercised against representative model output. Swap these
// items whenever the preview changes.
export const MOCK_PLAN: TestPlan = {
  summary:
    "This PR adds a promo code input to the landing page pricing section that discounts both credit packages when a valid code is entered.",
  confidence: "high",
  items: [
    {
      intent:
        "A valid promo code applies a 20% discount to both packages and shows a success confirmation.",
      route: "/",
      steps: [
        "Scroll down to the 'Purchase AI Credits' pricing section.",
        "Type 'PIXAR20' into the 'Promo code' input field.",
        "Click the 'Apply' button next to the promo code field.",
      ],
      expected:
        "A success message '20% off applied' appears, the Basic Package shows '$3.99' with '$4.99' struck through, and the Premium Package shows '$7.99' with '$9.99' struck through.",
    },
    {
      intent:
        "An invalid promo code shows an error message and leaves the original prices unchanged.",
      route: "/",
      steps: [
        "Scroll down to the 'Purchase AI Credits' pricing section.",
        "Type 'NOTACODE' into the 'Promo code' input field.",
        "Click the 'Apply' button next to the promo code field.",
      ],
      expected:
        "An error message 'Invalid promo code' appears, and both packages still display their original prices of '$4.99' and '$9.99' without any struck-through discount.",
    },
  ],
};
