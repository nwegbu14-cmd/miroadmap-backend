import assert from "node:assert/strict";
import test from "node:test";

import { getStripeMode, stripeConfigured } from "./stripe.ts";

test("Stripe accepts both test and live secret keys", () => {
  const original = process.env.STRIPE_SECRET_KEY;
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    assert.equal(getStripeMode(), "STRIPE_TEST");
    assert.equal(stripeConfigured(), true);

    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    assert.equal(getStripeMode(), "STRIPE_LIVE");
    assert.equal(stripeConfigured(), true);

    process.env.STRIPE_SECRET_KEY = "pk_live_publishable_is_not_a_secret";
    assert.equal(getStripeMode(), "NOT_CONFIGURED");
    assert.equal(stripeConfigured(), false);
  } finally {
    if (original === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = original;
  }
});
