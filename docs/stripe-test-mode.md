# Stripe test-mode billing

MiRoadmap uses Stripe-hosted Checkout for payment-method collection. Card numbers
and CVCs are never sent to or stored by the MiRoadmap frontend, API, or database.
The backend intentionally rejects non-test secret keys while this integration is
in product testing.

## Configure

1. In a Stripe test-mode account, create recurring monthly and yearly Prices for
   Premium and Ultimate.
2. Copy `.env.example` values into the backend `.env` and set:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - the four `STRIPE_PRICE_*` values
3. Alternatively, store each Stripe Price identifier in `Plan.providerPriceId`.
   A database value takes precedence over its environment-variable fallback.
4. Forward local webhooks:

   ```sh
   stripe listen --forward-to localhost:5001/api/billing/webhook
   ```

   Use the `whsec_...` signing secret printed by the Stripe CLI.

## Tester flow

1. Sign in and choose Premium or Ultimate from `/pricing`.
2. Review the plan at `/user-dashboard/checkout`.
3. Continue to Stripe Checkout and use Stripe test cards there.
4. Return to the success page and verify the current plan and invoice under
   subscription settings.
5. Use Stripe's standard successful test card to test activation and its generic
   declined test card to exercise `invoice.payment_failed` and past-due access.
6. Use **Manage billing securely** to open Stripe's Customer Portal for payment
   method changes and cancellation/reactivation.

Webhook events are signature-checked and stored in `WebhookEvent` using the
unique `(provider, externalId)` key before subscription or invoice state changes
are applied. Retried events therefore do not apply billing mutations twice.
