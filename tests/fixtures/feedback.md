# Broken bet route

Route: POST /bet

Current behavior:
The route returns HTTP 500 when a bet contains more than 10 guesses.

Observed error:
The service emits `internal_error` instead of the validation response.

Expected behavior:
- a valid payload creates the bet with HTTP 201;
- more than 10 guesses returns HTTP 422 with `too_many_guesses`;
- the public response contract in `contracts/bet-response.json` must remain unchanged;
- migrations must not be modified;
- the regression test must pass.

Suspected cause:
The quantity guard may have been changed in `src/bet-service.js`. Treat this as unverified until diagnosis.
