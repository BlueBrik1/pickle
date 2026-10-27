# Checkout requirements

## REQ-CHK-1: Prevent duplicate order submissions

Checkout must never submit the same order twice. The Place order button
(`src/checkout/CheckoutButton.tsx`) must stay disabled while an order is submitting,
and `createCheckout().placeOrder` must ignore calls while one is in flight.

Origin: GitHub issue #42 (customers were double-charged after double-clicking).

## REQ-CHK-2: Orders require a signed-in session

`submitOrder` sends the session token; checkout must not be reachable without a session.
