# Broken bet route

Route: POST /bet

Current behavior:
The route returns HTTP 500 when a bet contains more than 10 guesses.

Error:
Undefined array key "position" in BetService.php:184

Expected behavior:

- valid payload creates the bet;
- invalid quantity returns HTTP 422;
- the public response contract must remain unchanged;
- migrations must not be modified;
- a regression test must be added.
